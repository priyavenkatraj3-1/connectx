import { createHash, timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { generateId } from "../../utils/id";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../auth/token.service";

export type DevicePlatform = "web" | "ios" | "android" | "desktop";

export interface SessionDTO {
  id: string;
  deviceId: string | null;
  deviceName: string;
  platform: DevicePlatform;
  /** A short description of the browser/OS — never the raw token or IP. */
  userAgentSummary: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  /** True for the session making the request. */
  current: boolean;
}

export interface DeviceInfo {
  deviceName?: string;
  platform?: DevicePlatform;
  userAgent?: string;
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  device_name: string | null;
  platform: DevicePlatform | null;
  refresh_token_hash: string;
  user_agent: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  last_seen_at: Date | null;
}

/** How often (at most) a session's last_seen_at is written. Keeps the per-request cost to one indexed read. */
const TOUCH_INTERVAL_MS = 60_000;
/** Bound on the in-memory throttle map, so a long-running process can't grow it without limit. */
const MAX_TOUCH_CACHE = 10_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** "Chrome on Windows" from a User-Agent header. Best effort, only for display. */
export function describeUserAgent(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iPod/.test(userAgent)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? null;
}

function expiryOf(token: string): Date {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return new Date((decoded?.exp ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600) * 1000);
}

/**
 * Server-side sessions, one per signed-in device (Phase 6).
 *
 * Each login/signup registers a device and a session. The access token
 * carries the session ID (`sid`); every authenticated request and every
 * WebSocket connection checks that the session is still active, so
 * revoking a session takes effect immediately — its API calls fail with
 * 401 `session_revoked` and its sockets are closed. Refresh tokens are
 * rotated on every use; only their SHA-256 hash is stored, and reuse of an
 * already-rotated refresh token revokes the session (likely token theft).
 *
 * Device keys for future end-to-end encryption would hang off `devices`
 * (one row per physical client) — nothing here assumes a single device.
 */
export class SessionsService {
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway
  ) {}

  async createSession(userId: string, device: DeviceInfo): Promise<IssuedSession> {
    const deviceId = generateId();
    const sessionId = generateId();
    const summary = describeUserAgent(device.userAgent);
    const deviceName = (device.deviceName?.trim() || summary || "Unknown device").slice(0, 120);
    const refreshToken = signRefreshToken({ userId, sessionId });

    await this.db.withTransaction(async (tx) => {
      await tx.query("INSERT INTO devices (id, user_id, device_name, platform, last_active_at) VALUES ($1, $2, $3, $4, now())", [
        deviceId,
        userId,
        deviceName,
        device.platform ?? "web",
      ]);
      await tx.query(
        `INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, user_agent, expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [sessionId, userId, deviceId, hashToken(refreshToken), device.userAgent?.slice(0, 512) ?? null, expiryOf(refreshToken)]
      );
    });
    this.gateway.sendToUser(userId, { type: "sessions:updated" });
    return { sessionId, refreshToken, accessToken: signAccessToken({ userId, sid: sessionId }) };
  }

  private async findRow(sessionId: string): Promise<SessionRow | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT s.*, d.device_name, d.platform FROM sessions s LEFT JOIN devices d ON d.id = s.device_id WHERE s.id = $1`,
      [sessionId]
    );
    return result.rows[0] ?? null;
  }

  /** True if the session exists, belongs to `userId`, isn't revoked and hasn't expired. Also records activity (throttled). */
  async isActive(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      "SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3",
      [sessionId, userId, new Date()]
    );
    if (result.rowCount === 0) return false;
    await this.touch(sessionId);
    return true;
  }

  private async touch(sessionId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastTouched.get(sessionId) ?? 0) < TOUCH_INTERVAL_MS) return;
    // A throttle cache only: dropping it just means one extra UPDATE per session.
    if (this.lastTouched.size >= MAX_TOUCH_CACHE) this.lastTouched.clear();
    this.lastTouched.set(sessionId, now);
    await this.db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [sessionId]);
    await this.db.query("UPDATE devices SET last_active_at = now() WHERE id = (SELECT device_id FROM sessions WHERE id = $1)", [sessionId]);
  }

  /** Exchanges a refresh token for a new token pair, rotating the refresh token. */
  async refresh(refreshToken: string): Promise<IssuedSession & { userId: string }> {
    let payload: { userId: string; sessionId: string };
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw new AppError("Invalid or expired refresh token", 401, true, "session_expired");
    }
    const row = await this.findRow(payload.sessionId);
    if (!row || row.user_id !== payload.userId || row.revoked_at || new Date(row.expires_at) <= new Date()) {
      throw new AppError("This session has ended. Please sign in again.", 401, true, "session_revoked");
    }
    if (!hashesMatch(row.refresh_token_hash, hashToken(refreshToken))) {
      // An already-rotated token was presented again: assume it leaked and end the session.
      await this.revoke(row.user_id, row.id);
      throw new AppError("This session has ended. Please sign in again.", 401, true, "session_revoked");
    }

    // Keep the session's original expiry: refreshing extends access, not the absolute session lifetime.
    const nextRefresh = signRefreshToken({ userId: row.user_id, sessionId: row.id });
    const rotated = await this.db.query(
      "UPDATE sessions SET refresh_token_hash = $2, last_seen_at = now() WHERE id = $1 AND refresh_token_hash = $3 RETURNING id",
      [row.id, hashToken(nextRefresh), row.refresh_token_hash]
    );
    if (rotated.rowCount === 0) throw new AppError("This session has ended. Please sign in again.", 401, true, "session_revoked");
    return {
      userId: row.user_id,
      sessionId: row.id,
      refreshToken: nextRefresh,
      accessToken: signAccessToken({ userId: row.user_id, sid: row.id }),
    };
  }

  async list(userId: string, currentSessionId: string | undefined): Promise<SessionDTO[]> {
    const result = await this.db.query<SessionRow>(
      `SELECT s.*, d.device_name, d.platform FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
       WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
       ORDER BY s.created_at DESC`,
      [userId, new Date()]
    );
    return result.rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name ?? "Unknown device",
      platform: row.platform ?? "web",
      userAgentSummary: describeUserAgent(row.user_agent ?? undefined),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      current: row.id === currentSessionId,
    }));
  }

  async rename(userId: string, sessionId: string, deviceName: string): Promise<void> {
    const row = await this.findRow(sessionId);
    if (!row || row.user_id !== userId || row.revoked_at) throw new AppError("Session not found", 404);
    if (row.device_id) await this.db.query("UPDATE devices SET device_name = $2 WHERE id = $1", [row.device_id, deviceName]);
    this.gateway.sendToUser(userId, { type: "sessions:updated" });
  }

  /** Ends one of the user's sessions: its tokens stop working and its live connections are closed. */
  async revoke(userId: string, sessionId: string): Promise<void> {
    const result = await this.db.query(
      "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
      [sessionId, userId]
    );
    if (result.rowCount === 0) {
      const row = await this.findRow(sessionId);
      if (!row || row.user_id !== userId) throw new AppError("Session not found", 404);
      return; // already revoked — idempotent
    }
    this.lastTouched.delete(sessionId);
    this.gateway.sendToUser(userId, { type: "session:revoked", sessionId });
    this.gateway.disconnectSession?.(userId, sessionId);
    this.gateway.sendToUser(userId, { type: "sessions:updated" });
  }

  /** Signs out every other device. Returns how many sessions were ended. */
  async revokeOthers(userId: string, currentSessionId: string): Promise<number> {
    const others = await this.db.query<{ id: string }>(
      "SELECT id FROM sessions WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
      [userId, currentSessionId]
    );
    for (const row of others.rows) await this.revoke(userId, row.id);
    return others.rows.length;
  }
}
