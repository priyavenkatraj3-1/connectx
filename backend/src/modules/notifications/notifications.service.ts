import type { DatabaseClient } from "../../db/pool";
import { isUniqueViolation } from "../../db/errors";
import { AppError } from "../../middleware/errorHandler";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { generateId } from "../../utils/id";
import type { NotificationPreferenceKey, PreferencesService } from "../preferences/preferences.service";

export type NotificationType =
  | "mention"
  | "task_due"
  | "task_assigned"
  | "reminder"
  | "todo_assigned"
  | "scheduled_message_sent"
  | "scheduled_message_failed"
  | "session_new"
  | "system";

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  /** Navigation IDs only (conversationId, messageId, taskId, …) — never message content. */
  payload: Record<string, string>;
  readAt: Date | null;
  createdAt: Date;
}

export interface NewNotification {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  payload?: Record<string, string>;
  /** Makes creation idempotent: a second notification with the same key for the same user is skipped. */
  dedupeKey?: string;
}

/**
 * Where a created notification is delivered. The in-app channel (WebSocket
 * to the user's open devices) is the only one implemented. A push channel
 * (Web Push / APNs / FCM, using devices.push_token) would implement this
 * interface and be added to NotificationsService's channel list — see
 * docs/notifications.md.
 */
export interface NotificationChannel {
  readonly name: string;
  deliver(userId: string, notification: NotificationDTO): Promise<void> | void;
}

export class InAppNotificationChannel implements NotificationChannel {
  readonly name = "in_app";
  constructor(private readonly gateway: RealtimeGateway) {}
  deliver(userId: string, notification: NotificationDTO): void {
    this.gateway.sendToUser(userId, { type: "notification:new", notification });
  }
}

/** Which preference switch governs each type. Types not listed are always delivered. */
const PREFERENCE_FOR_TYPE: Partial<Record<NotificationType, NotificationPreferenceKey>> = {
  mention: "notifyMentions",
  task_due: "notifyTaskDue",
  reminder: "notifyReminders",
  scheduled_message_sent: "notifyScheduledMessages",
  scheduled_message_failed: "notifyScheduledMessages",
  task_assigned: "notifyAssignments",
  todo_assigned: "notifyAssignments",
};

interface NotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  payload: unknown;
  read_at: Date | null;
  created_at: Date;
}

function toDTO(row: NotificationRow): NotificationDTO {
  let payload: Record<string, string> = {};
  const raw = typeof row.payload === "string" ? (JSON.parse(row.payload) as unknown) : row.payload;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) payload = raw as Record<string, string>;
  return { id: row.id, type: row.type, title: row.title, body: row.body, payload, readAt: row.read_at, createdAt: row.created_at };
}

const LIST_LIMIT = 100;

export class NotificationsService {
  private readonly channels: NotificationChannel[];

  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly preferences: PreferencesService,
    extraChannels: NotificationChannel[] = []
  ) {
    this.channels = [new InAppNotificationChannel(gateway), ...extraChannels];
  }

  /**
   * Stores and delivers a notification, unless the user switched that
   * category off or an identical (same dedupeKey) one already exists.
   * Returns null when nothing was created. Never throws for delivery
   * problems — a failed channel must not break the action that caused it.
   */
  async notify(input: NewNotification): Promise<NotificationDTO | null> {
    const preferenceKey = PREFERENCE_FOR_TYPE[input.type];
    if (preferenceKey && !(await this.preferences.allows(input.userId, preferenceKey))) return null;

    const id = generateId();
    let row: NotificationRow | undefined;
    try {
      const result = await this.db.query<NotificationRow>(
        `INSERT INTO notifications (id, user_id, type, title, body, payload, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, type, title, body, payload, read_at, created_at`,
        [
          id,
          input.userId,
          input.type,
          input.title.slice(0, 200),
          input.body ? input.body.slice(0, 500) : null,
          JSON.stringify(input.payload ?? {}),
          input.dedupeKey ?? null,
        ]
      );
      row = result.rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    if (!row) return null;

    const notification = toDTO(row);
    for (const channel of this.channels) {
      try {
        await channel.deliver(input.userId, notification);
      } catch (err) {
        console.error(`[notification channel ${channel.name} failed]`, err);
      }
    }
    return notification;
  }

  async list(userId: string, options: { unreadOnly?: boolean } = {}): Promise<NotificationDTO[]> {
    const result = await this.db.query<NotificationRow>(
      `SELECT id, type, title, body, payload, read_at, created_at FROM notifications
       WHERE user_id = $1 ${options.unreadOnly ? "AND read_at IS NULL" : ""}
       ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
      [userId]
    );
    return result.rows.map(toDTO);
  }

  async unreadCount(userId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
      [userId]
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    const result = await this.db.query(
      "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id",
      [notificationId, userId]
    );
    if (result.rowCount === 0) throw new AppError("Notification not found", 404);
    this.gateway.sendToUser(userId, { type: "notification:read", notificationIds: [notificationId], unreadCount: await this.unreadCount(userId) });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [userId]);
    this.gateway.sendToUser(userId, { type: "notification:read", notificationIds: "all", unreadCount: 0 });
  }

  async remove(userId: string, notificationId: string): Promise<void> {
    const result = await this.db.query("DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id", [notificationId, userId]);
    if (result.rowCount === 0) throw new AppError("Notification not found", 404);
    this.gateway.sendToUser(userId, { type: "notification:read", notificationIds: [notificationId], unreadCount: await this.unreadCount(userId) });
  }
}
