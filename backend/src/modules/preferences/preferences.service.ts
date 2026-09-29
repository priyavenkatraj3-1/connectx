import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { isValidTimezone } from "../../utils/datetime";

export interface UserPreferencesDTO {
  timezone: string | null;
  productivityMode: boolean;
  notifyMentions: boolean;
  notifyTaskDue: boolean;
  notifyReminders: boolean;
  notifyScheduledMessages: boolean;
  notifyAssignments: boolean;
  updatedAt: Date | null;
}

export type PreferencesUpdate = Partial<Omit<UserPreferencesDTO, "updatedAt">>;

/** Notification categories a user can switch off. Keys match the notify* preferences. */
export type NotificationPreferenceKey = "notifyMentions" | "notifyTaskDue" | "notifyReminders" | "notifyScheduledMessages" | "notifyAssignments";

interface PreferencesRow {
  timezone: string | null;
  productivity_mode: boolean;
  notify_mentions: boolean;
  notify_task_due: boolean;
  notify_reminders: boolean;
  notify_scheduled_messages: boolean;
  notify_assignments: boolean;
  updated_at: Date;
}

const DEFAULTS: UserPreferencesDTO = {
  timezone: null,
  productivityMode: false,
  notifyMentions: true,
  notifyTaskDue: true,
  notifyReminders: true,
  notifyScheduledMessages: true,
  notifyAssignments: true,
  updatedAt: null,
};

const COLUMNS: Array<[keyof PreferencesUpdate, string]> = [
  ["timezone", "timezone"],
  ["productivityMode", "productivity_mode"],
  ["notifyMentions", "notify_mentions"],
  ["notifyTaskDue", "notify_task_due"],
  ["notifyReminders", "notify_reminders"],
  ["notifyScheduledMessages", "notify_scheduled_messages"],
  ["notifyAssignments", "notify_assignments"],
];

function toDTO(row: PreferencesRow): UserPreferencesDTO {
  return {
    timezone: row.timezone,
    productivityMode: row.productivity_mode,
    notifyMentions: row.notify_mentions,
    notifyTaskDue: row.notify_task_due,
    notifyReminders: row.notify_reminders,
    notifyScheduledMessages: row.notify_scheduled_messages,
    notifyAssignments: row.notify_assignments,
    updatedAt: row.updated_at,
  };
}

/** Per-user Phase 6 preferences: timezone, Productivity Mode, notification switches. Synced to all the user's devices. */
export class PreferencesService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway
  ) {}

  async get(userId: string): Promise<UserPreferencesDTO> {
    const result = await this.db.query<PreferencesRow>("SELECT * FROM user_preferences WHERE user_id = $1", [userId]);
    const row = result.rows[0];
    return row ? toDTO(row) : { ...DEFAULTS };
  }

  async getTimezone(userId: string): Promise<string | null> {
    return (await this.get(userId)).timezone;
  }

  async allows(userId: string, key: NotificationPreferenceKey): Promise<boolean> {
    return (await this.get(userId))[key];
  }

  async update(userId: string, update: PreferencesUpdate): Promise<UserPreferencesDTO> {
    if (update.timezone && !isValidTimezone(update.timezone)) throw new AppError("Unknown timezone", 400);

    await this.db.query("INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const sets: string[] = [];
    const params: unknown[] = [userId];
    for (const [key, column] of COLUMNS) {
      if (update[key] !== undefined) {
        params.push(update[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (sets.length > 0) {
      await this.db.query(`UPDATE user_preferences SET ${sets.join(", ")}, updated_at = now() WHERE user_id = $1`, params);
    }
    const preferences = await this.get(userId);
    this.gateway.sendToUser(userId, { type: "preferences:updated", preferences });
    return preferences;
  }

  async listFocused(userId: string): Promise<string[]> {
    const result = await this.db.query<{ conversation_id: string }>(
      `SELECT f.conversation_id FROM focused_conversations f
       JOIN conversation_members cm ON cm.conversation_id = f.conversation_id AND cm.user_id = f.user_id AND cm.left_at IS NULL
       WHERE f.user_id = $1 ORDER BY f.created_at`,
      [userId]
    );
    return result.rows.map((row) => row.conversation_id);
  }

  /** Caller must have checked conversation membership. */
  async setFocused(userId: string, conversationId: string, focused: boolean): Promise<string[]> {
    if (focused) {
      await this.db.query(
        "INSERT INTO focused_conversations (user_id, conversation_id) VALUES ($1, $2) ON CONFLICT (user_id, conversation_id) DO NOTHING",
        [userId, conversationId]
      );
    } else {
      await this.db.query("DELETE FROM focused_conversations WHERE user_id = $1 AND conversation_id = $2", [userId, conversationId]);
    }
    const conversationIds = await this.listFocused(userId);
    this.gateway.sendToUser(userId, { type: "focus:updated", conversationIds });
    return conversationIds;
  }
}
