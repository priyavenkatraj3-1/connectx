import type { Server as HttpServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { AppError } from "../middleware/errorHandler";
import { verifyAccessToken } from "../modules/auth/token.service";
import { generateId } from "../utils/id";
import { isCallClientEvent, parseClientEvent } from "./client-events";
import { ConnectionRegistry } from "./connection-registry";
import type { CallClientEvent, ServerEvent } from "./events";
import type { RealtimeGateway } from "./gateway.interface";

export const WS_PATH = "/ws";

/** Largest inbound frame accepted. SDP offers are the biggest legitimate payload (≤64KB, see client-events.ts). */
const MAX_PAYLOAD_BYTES = 128 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who sent a client event: the authenticated user and the specific connection (tab/device) it came from. */
export interface ConnectionContext {
  userId: string;
  connectionId: string;
}

export interface WebSocketGatewayOptions {
  /** Called when a client reports it has read up to a given message in a conversation. */
  onClientRead: (userId: string, conversationId: string, upToMessageId: string) => Promise<void>;
  /** Called with every validated call:* event. Throwing an AppError sends its message back as `call:error`. */
  onCallEvent?: (ctx: ConnectionContext, event: CallClientEvent) => Promise<void>;
  onConnect?: (ctx: ConnectionContext) => void;
  onDisconnect?: (ctx: ConnectionContext) => void;
  /**
   * Phase 6: checks that the token's session hasn't been revoked. When
   * provided, tokens without a session ID are rejected too.
   */
  validateSession?: (userId: string, sessionId: string) => Promise<boolean>;
  /**
   * Phase 7: browser origins allowed to open a socket. A handshake carrying
   * any other Origin header gets 403 (cross-site WebSocket hijacking
   * defense, on top of the token requirement). Handshakes without an Origin
   * header (non-browser clients) are judged by their token alone.
   */
  allowedOrigins?: string[];
  /** Inbound frames allowed per connection per 10s; exceeding it closes the connection with 1008. Default 300. */
  maxMessagesPer10s?: number;
  /** Open connections allowed per user; further handshakes get 429. Default 20. */
  maxConnectionsPerUser?: number;
  /** Server ping interval; a connection that didn't answer the previous ping is terminated. Default 30s. */
  heartbeatIntervalMs?: number;
}

/** The live gateway plus lifecycle control for the server process. */
export interface WebSocketGateway extends RealtimeGateway {
  /** Stops the heartbeat, closes every connection (1001 "going away") and stops accepting new ones. */
  close(): Promise<void>;
}

interface AuthenticatedUpgradeRequest {
  url?: string;
  connectXUserId?: string;
  connectXConnectionId?: string;
  connectXSessionId?: string;
}

/** Close code sent to a connection whose session was signed out. */
export const SESSION_REVOKED_CLOSE_CODE = 4401;
/** Standard "policy violation" close code, used when a connection floods the server. */
export const RATE_LIMITED_CLOSE_CODE = 1008;

const RATE_WINDOW_MS = 10_000;

interface ConnectionState {
  /** Answered the last heartbeat ping (or sent something since). */
  alive: boolean;
  windowStart: number;
  framesInWindow: number;
}

/**
 * Attaches a WebSocket server to the given HTTP server at WS_PATH and
 * returns a RealtimeGateway for pushing server → client events. Clients
 * authenticate by passing their access token as a query parameter:
 * `ws://host/ws?token=<accessToken>` (WebSocket has no custom-header
 * support in browsers, so a query param is the standard workaround).
 *
 * Clients may also pass `cid=<uuid>`, a per-tab connection ID they
 * generate, so they know their own connection ID (needed to start a call
 * from this tab) and keep it across reconnects. Connection IDs are scoped
 * to the authenticated user, so reusing one can only ever take over your
 * *own* earlier connection (e.g. a reconnect racing the old socket's
 * close). A missing or malformed cid is replaced with a server-generated one.
 */
export function attachWebSocketGateway(httpServer: HttpServer, options: WebSocketGatewayOptions): WebSocketGateway {
  const registry = new ConnectionRegistry();
  const sessionBySocket = new WeakMap<WebSocket, string>();
  const stateBySocket = new WeakMap<WebSocket, ConnectionState>();
  const maxFrames = options.maxMessagesPer10s ?? 300;
  const maxConnections = options.maxConnectionsPerUser ?? 20;
  const allowedOrigins = options.allowedOrigins ? new Set(options.allowedOrigins) : null;

  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    maxPayload: MAX_PAYLOAD_BYTES,
    // Authenticate during the HTTP Upgrade handshake itself, so an invalid
    // token gets a real 401 and the WebSocket connection never opens on the
    // client side — accepting the socket first and closing it right after
    // would still fire the client's `open` event.
    verifyClient: (info, callback) => {
      const req = info.req as AuthenticatedUpgradeRequest;
      if (allowedOrigins && info.origin && !allowedOrigins.has(info.origin)) {
        callback(false, 403, "Forbidden");
        return;
      }
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");

      let payload: ReturnType<typeof verifyAccessToken>;
      try {
        if (!token) throw new Error("missing token");
        payload = verifyAccessToken(token);
      } catch {
        callback(false, 401, "Unauthorized");
        return;
      }
      req.connectXUserId = payload.userId;
      req.connectXSessionId = payload.sid;
      const requestedCid = url.searchParams.get("cid")?.toLowerCase();
      req.connectXConnectionId = requestedCid && UUID_PATTERN.test(requestedCid) ? requestedCid : generateId();

      // Cap concurrent connections per user. Re-using an existing connection
      // ID replaces that connection, so a reconnect is always allowed.
      const replacesExisting = !!registry.getSocket(payload.userId, req.connectXConnectionId);
      if (!replacesExisting && registry.getSockets(payload.userId).length >= maxConnections) {
        callback(false, 429, "Too Many Connections");
        return;
      }

      if (!options.validateSession) {
        callback(true);
        return;
      }
      if (!payload.sid) {
        callback(false, 401, "Unauthorized");
        return;
      }
      options.validateSession(payload.userId, payload.sid).then(
        (active) => (active ? callback(true) : callback(false, 401, "Unauthorized")),
        () => callback(false, 401, "Unauthorized")
      );
    },
  });

  wss.on("connection", (socket: WebSocket, request: AuthenticatedUpgradeRequest) => {
    const userId = request.connectXUserId;
    const connectionId = request.connectXConnectionId;
    if (!userId || !connectionId) {
      socket.close(4401, "Unauthorized");
      return;
    }
    const ctx: ConnectionContext = { userId, connectionId };

    if (request.connectXSessionId) sessionBySocket.set(socket, request.connectXSessionId);
    const state: ConnectionState = { alive: true, windowStart: Date.now(), framesInWindow: 0 };
    stateBySocket.set(socket, state);
    registry.add(userId, connectionId, socket);
    options.onConnect?.(ctx);

    socket.on("pong", () => {
      state.alive = true;
    });

    socket.on("message", (raw) => {
      state.alive = true;
      const now = Date.now();
      if (now - state.windowStart >= RATE_WINDOW_MS) {
        state.windowStart = now;
        state.framesInWindow = 0;
      }
      state.framesInWindow += 1;
      if (state.framesInWindow > maxFrames) {
        // A flooding client (buggy or hostile) is disconnected; a normal client reconnects with backoff.
        if (state.framesInWindow === maxFrames + 1) socket.close(RATE_LIMITED_CLOSE_CODE, "Rate limit exceeded");
        return;
      }
      void handleClientMessage(ctx, socket, raw.toString(), options).catch(() => {
        send(socket, { type: "error", message: "Failed to process message" });
      });
    });

    // Protocol violations (e.g. a frame over maxPayload) surface as socket
    // errors; ws closes the connection itself. Without a listener, an
    // 'error' event would be thrown and crash the process.
    socket.on("error", () => undefined);

    socket.on("close", () => {
      const wasCurrent = registry.getSocket(userId, connectionId) === socket;
      registry.remove(userId, connectionId, socket);
      if (wasCurrent) options.onDisconnect?.(ctx);
    });
  });

  // Heartbeat: detects connections that died without a close frame (network
  // drop, sleeping laptop), so their registry entries, presence and call
  // bindings are cleaned up instead of lingering until the OS times out.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = stateBySocket.get(socket);
      if (!state) continue;
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, options.heartbeatIntervalMs ?? 30_000);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.close(1001, "Server shutting down");
      return new Promise<void>((resolve) => {
        wss.close(() => resolve());
        // Don't let a peer that never completes the close handshake hold up shutdown.
        setTimeout(() => {
          for (const socket of wss.clients) socket.terminate();
        }, 2000).unref();
      });
    },
    sendToUser(userId: string, event: ServerEvent) {
      for (const socket of registry.getSockets(userId)) {
        send(socket, event);
      }
    },
    isUserOnline(userId: string) {
      return registry.isOnline(userId);
    },
    sendToConnection(userId: string, connectionId: string, event: ServerEvent) {
      const socket = registry.getSocket(userId, connectionId);
      if (!socket || socket.readyState !== socket.OPEN) return false;
      send(socket, event);
      return true;
    },
    hasConnection(userId: string, connectionId: string) {
      const socket = registry.getSocket(userId, connectionId);
      return !!socket && socket.readyState === socket.OPEN;
    },
    disconnectSession(userId: string, sessionId: string) {
      for (const socket of registry.getSockets(userId)) {
        // close() is queued after already-sent frames, so a preceding session:revoked event still arrives.
        if (sessionBySocket.get(socket) === sessionId) socket.close(SESSION_REVOKED_CLOSE_CODE, "Session revoked");
      }
    },
  };
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

async function handleClientMessage(
  ctx: ConnectionContext,
  socket: WebSocket,
  raw: string,
  options: WebSocketGatewayOptions
): Promise<void> {
  const parsed = parseClientEvent(raw);

  if (!parsed.ok) {
    if (parsed.kind === "invalid") {
      send(socket, { type: "call:error", callId: parsed.callId, message: parsed.message });
    }
    // Non-JSON frames and unrecognized event types are intentionally ignored.
    return;
  }

  const event = parsed.event;
  if (event.type === "message:read") {
    await options.onClientRead(ctx.userId, event.conversationId, event.upToMessageId);
    return;
  }

  if (isCallClientEvent(event)) {
    if (!options.onCallEvent) {
      send(socket, { type: "call:error", callId: event.callId, message: "Calls are not available" });
      return;
    }
    try {
      await options.onCallEvent(ctx, event);
    } catch (err) {
      // Only deliberate, client-safe errors are echoed; anything else is generic.
      const message = err instanceof AppError && err.statusCode < 500 ? err.message : "Failed to process call event";
      send(socket, { type: "call:error", callId: event.callId, message });
    }
  }
  // "ping" needs no reply — the connection itself proves liveness.
}
