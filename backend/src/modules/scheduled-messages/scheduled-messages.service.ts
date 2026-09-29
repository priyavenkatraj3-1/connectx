import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { resolveDateInput } from "../../utils/datetime";
import { generateId } from "../../utils/id";
import type { ConversationAccessService } from "../collaboration/conversation-access";
import type { MessagesService } from "../messages/messages.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { PreferencesService } from "../preferences/preferences.service";

export type ScheduledStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

export interface ScheduledMessageDTO {
  id: string;
  conversationId: string;
  body: string;
  scheduledFor: Date;
  timezone: string | null;
  status: ScheduledStatus;
  attempts: number;
  failureReason: string | null;
  sentMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ScheduledRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  scheduled_for: Date;
  timezone: string | null;
  status: ScheduledStatus;
  attempts: number;
  failure_reason: string | null;
  sent_message_id: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toDTO(row: ScheduledRow): ScheduledMessageDTO {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    body: row.body,
    scheduledFor: row.scheduled_for,
    timezone: row.timezone,
    status: row.status,
    attempts: Number(row.attempts),
    failureReason: row.failure_reason,
    sentMessageId: row.sent_message_id,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const MAX_PENDING_PER_USER = 100;
const MAX_AHEAD_MS = 366 * 24 * 3600_000;
/** Transient failures (DB hiccup, crash) are retried this many times before the message is marked failed. */
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 50;

export interface ScheduleInput {
  conversationId: string;
  body: string;
  scheduledFor?: string;
  scheduledForLocal?: string;
  timezone?: string | null;
}

/**
 * Messages the user explicitly scheduled for later (text only). Nothing is
 * ever sent without such a record, and every send goes through
 * MessagesService.sendMessage — so membership is re-checked at delivery
 * time: if the sender left the conversation meanwhile, the message fails
 * instead of being sent.
 *
 * Delivery is at-least-once in the worker but exactly-once in effect: the
 * scheduled message's ID is used as the message's client_message_id, so a
 * retry after a crash between "sent" and "marked sent" returns the
 * already-sent message instead of posting it twice.
 */
export class ScheduledMessagesService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly access: ConversationAccessService,
    private readonly preferences: PreferencesService,
    private readonly messages: MessagesService,
    private readonly notifications: NotificationsService
  ) {}

  private async requireOwn(userId: string, id: string): Promise<ScheduledRow> {
    const result = await this.db.query<ScheduledRow>("SELECT * FROM scheduled_messages WHERE id = $1 AND sender_id = $2", [id, userId]);
    const row = result.rows[0];
    if (!row) throw new AppError("Scheduled message not found", 404);
    return row;
  }

  private validateTime(date: Date, now = Date.now()): void {
    if (date.getTime() <= now) throw new AppError("scheduledFor must be in the future", 400);
    if (date.getTime() - now > MAX_AHEAD_MS) throw new AppError("Messages can be scheduled at most one year ahead", 400);
  }

  async list(userId: string, filters: { conversationId?: string; status?: ScheduledStatus }): Promise<ScheduledMessageDTO[]> {
    const params: unknown[] = [userId];
    let where = "sender_id = $1";
    if (filters.conversationId) {
      params.push(filters.conversationId);
      where += ` AND conversation_id = $${params.length}`;
    }
    if (filters.status) {
      params.push(filters.status);
      where += ` AND status = $${params.length}`;
    }
    const result = await this.db.query<ScheduledRow>(`SELECT * FROM scheduled_messages WHERE ${where} ORDER BY scheduled_for ASC LIMIT 200`, params);
    return result.rows.map(toDTO);
  }

  async create(userId: string, input: ScheduleInput): Promise<ScheduledMessageDTO> {
    await this.access.require(input.conversationId, userId);
    const timezone = input.timezone ?? (await this.preferences.getTimezone(userId));
    const scheduledFor = resolveDateInput("scheduledFor", input.scheduledFor, input.scheduledForLocal, timezone);
    if (!scheduledFor) throw new AppError("scheduledFor is required", 400);
    this.validateTime(scheduledFor);

    const pending = await this.db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM scheduled_messages WHERE sender_id = $1 AND status = 'scheduled'",
      [userId]
    );
    if (Number(pending.rows[0]?.count ?? "0") >= MAX_PENDING_PER_USER) {
      throw new AppError(`You can have at most ${MAX_PENDING_PER_USER} scheduled messages`, 409);
    }

    const id = generateId();
    await this.db.query(
      `INSERT INTO scheduled_messages (id, conversation_id, sender_id, body, scheduled_for, timezone)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.conversationId, userId, input.body, scheduledFor, timezone ?? null]
    );
    return this.publish(id);
  }

  /** Edits a message that is still waiting. Atomic against the worker picking it up. */
  async update(
    userId: string,
    id: string,
    input: { body?: string; scheduledFor?: string; scheduledForLocal?: string; timezone?: string | null }
  ): Promise<ScheduledMessageDTO> {
    const existing = await this.requireOwn(userId, id);
    if (existing.status !== "scheduled") throw new AppError(`This message is already ${existing.status}`, 409);
    const timezone = input.timezone !== undefined ? input.timezone : existing.timezone;
    const scheduledFor = resolveDateInput("scheduledFor", input.scheduledFor, input.scheduledForLocal, timezone);
    if (scheduledFor) this.validateTime(scheduledFor);

    const sets: string[] = [];
    const params: unknown[] = [id, userId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.body !== undefined) push("body", input.body);
    if (scheduledFor) push("scheduled_for", scheduledFor);
    if (input.timezone !== undefined) push("timezone", input.timezone);
    if (sets.length > 0) {
      const result = await this.db.query(
        `UPDATE scheduled_messages SET ${sets.join(", ")}, updated_at = now()
         WHERE id = $1 AND sender_id = $2 AND status = 'scheduled' RETURNING id`,
        params
      );
      if (result.rowCount === 0) throw new AppError("This message is already being sent", 409);
    }
    return this.publish(id);
  }

  async cancel(userId: string, id: string): Promise<ScheduledMessageDTO> {
    const existing = await this.requireOwn(userId, id);
    const result = await this.db.query(
      "UPDATE scheduled_messages SET status = 'cancelled', updated_at = now() WHERE id = $1 AND sender_id = $2 AND status = 'scheduled' RETURNING id",
      [id, userId]
    );
    if (result.rowCount === 0) throw new AppError(`This message is already ${existing.status}`, 409);
    return this.publish(id);
  }

  /** Deletes a finished (sent/failed/cancelled) record from the list. */
  async remove(userId: string, id: string): Promise<void> {
    const existing = await this.requireOwn(userId, id);
    if (existing.status === "scheduled" || existing.status === "sending") {
      throw new AppError("Cancel the scheduled message before removing it", 409);
    }
    await this.db.query("DELETE FROM scheduled_messages WHERE id = $1 AND sender_id = $2", [id, userId]);
    this.gateway.sendToUser(userId, { type: "scheduled_message:deleted", scheduledMessageId: id });
  }

  // --- Delivery (called by the scheduler) -----------------------------------

  /** After a crash, rows left in "sending" go back to "scheduled"; the idempotent send makes this safe. */
  async recoverStuck(): Promise<number> {
    const result = await this.db.query("UPDATE scheduled_messages SET status = 'scheduled', updated_at = now() WHERE status = 'sending' RETURNING id");
    return result.rowCount;
  }

  async deliverDue(now = new Date()): Promise<number> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM scheduled_messages WHERE status = 'scheduled' AND scheduled_for <= $1 ORDER BY scheduled_for ASC LIMIT ${BATCH_SIZE}`,
      [now]
    );
    let delivered = 0;
    for (const { id } of due.rows) {
      if (await this.deliverOne(id)) delivered += 1;
    }
    return delivered;
  }

  private async deliverOne(id: string): Promise<boolean> {
    // Claim: only one worker (or tick) can move a row from scheduled → sending.
    const claimed = await this.db.query<ScheduledRow>(
      `UPDATE scheduled_messages SET status = 'sending', attempts = attempts + 1, updated_at = now()
       WHERE id = $1 AND status = 'scheduled' RETURNING *`,
      [id]
    );
    const row = claimed.rows[0];
    if (!row) return false;

    try {
      const message = await this.messages.sendMessage({
        conversationId: row.conversation_id,
        senderId: row.sender_id,
        body: row.body,
        clientMessageId: row.id,
      });
      await this.db.query(
        "UPDATE scheduled_messages SET status = 'sent', sent_message_id = $2, sent_at = now(), failure_reason = NULL, updated_at = now() WHERE id = $1",
        [id, message.id]
      );
      await this.publish(id);
      await this.notifications.notify({
        userId: row.sender_id,
        type: "scheduled_message_sent",
        title: "Scheduled message sent",
        payload: { conversationId: row.conversation_id, messageId: message.id, scheduledMessageId: id },
        dedupeKey: `scheduled_sent:${id}`,
      });
      return true;
    } catch (err) {
      const permanent = err instanceof AppError && err.statusCode < 500;
      if (!permanent && Number(row.attempts) < MAX_ATTEMPTS) {
        await this.db.query("UPDATE scheduled_messages SET status = 'scheduled', updated_at = now() WHERE id = $1", [id]);
        return false;
      }
      const reason = permanent ? (err as AppError).message : "The message could not be sent";
      await this.db.query(
        "UPDATE scheduled_messages SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1",
        [id, reason.slice(0, 300)]
      );
      await this.publish(id);
      await this.notifications.notify({
        userId: row.sender_id,
        type: "scheduled_message_failed",
        title: "A scheduled message couldn't be sent",
        body: reason,
        payload: { conversationId: row.conversation_id, scheduledMessageId: id },
        dedupeKey: `scheduled_failed:${id}`,
      });
      return false;
    }
  }

  private async publish(id: string): Promise<ScheduledMessageDTO> {
    const result = await this.db.query<ScheduledRow>("SELECT * FROM scheduled_messages WHERE id = $1", [id]);
    const row = result.rows[0]!;
    const scheduledMessage = toDTO(row);
    this.gateway.sendToUser(row.sender_id, { type: "scheduled_message:updated", scheduledMessage });
    return scheduledMessage;
  }
}
