import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { resolveDateInput } from "../../utils/datetime";
import { generateId } from "../../utils/id";
import type { PreferencesService } from "../preferences/preferences.service";
import type { CreateReminderInput, UpdateReminderInput } from "./productivity.validation";
import type { ReminderDTO, ReminderStatus } from "./productivity.types";
import { sourceExcerptJoin, toSourceReference, type SourceResolver } from "./source";

/** A reminder must be at least this far in the future when set (allows for clock skew and slow typing). */
const PAST_GRACE_MS = 60_000;

interface ReminderRow {
  id: string;
  user_id: string;
  task_id: string | null;
  title: string;
  notes: string | null;
  remind_at: Date;
  timezone: string | null;
  status: ReminderStatus;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_action_id: string | null;
  source_excerpt?: string | null;
  fired_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toDTO(row: ReminderRow): ReminderDTO {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    notes: row.notes,
    remindAt: row.remind_at,
    timezone: row.timezone,
    status: row.status,
    source: toSourceReference(row),
    firedAt: row.fired_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function assertFuture(date: Date, field: string, now = Date.now()): void {
  if (date.getTime() < now - PAST_GRACE_MS) throw new AppError(`${field} must be in the future`, 400);
}

/**
 * Reminders are private to their owner. They are only ever created by an
 * explicit user request (directly, from a message, from a confirmed AI
 * suggestion, or by setting a task's reminder time) — never automatically.
 * Firing (→ notification) is done by the scheduler; see scheduler.service.ts.
 */
export class RemindersService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly preferences: PreferencesService,
    private readonly sources: SourceResolver
  ) {}

  async findForUser(userId: string, reminderId: string): Promise<ReminderDTO | null> {
    const excerpt = sourceExcerptJoin("r", "$2");
    const result = await this.db.query<ReminderRow>(
      `SELECT r.*, ${excerpt.select} FROM reminders r ${excerpt.joins} WHERE r.id = $1 AND r.user_id = $2`,
      [reminderId, userId]
    );
    const row = result.rows[0];
    return row ? toDTO(row) : null;
  }

  private async requireOwn(userId: string, reminderId: string): Promise<ReminderDTO> {
    const reminder = await this.findForUser(userId, reminderId);
    if (!reminder) throw new AppError("Reminder not found", 404);
    return reminder;
  }

  async list(userId: string, status?: ReminderStatus | "active"): Promise<ReminderDTO[]> {
    const excerpt = sourceExcerptJoin("r", "$1");
    const params: unknown[] = [userId];
    let filter = "";
    if (status === "active") filter = "AND r.status IN ('pending', 'fired')";
    else if (status) {
      params.push(status);
      filter = `AND r.status = $${params.length}`;
    }
    const result = await this.db.query<ReminderRow>(
      `SELECT r.*, ${excerpt.select} FROM reminders r ${excerpt.joins}
       WHERE r.user_id = $1 ${filter} ORDER BY r.remind_at ASC LIMIT 500`,
      params
    );
    return result.rows.map(toDTO);
  }

  async create(userId: string, input: CreateReminderInput): Promise<ReminderDTO> {
    const timezone = input.timezone ?? (await this.preferences.getTimezone(userId));
    const remindAt = resolveDateInput("remindAt", input.remindAt, input.remindAtLocal, timezone);
    if (!remindAt) throw new AppError("remindAt is required", 400);
    assertFuture(remindAt, "remindAt");

    if (input.taskId) {
      const task = await this.db.query("SELECT id FROM tasks WHERE id = $1 AND owner_id = $2", [input.taskId, userId]);
      if (task.rowCount === 0) throw new AppError("Task not found", 404);
      const existing = await this.db.query("SELECT id FROM reminders WHERE task_id = $1", [input.taskId]);
      if (existing.rowCount > 0) throw new AppError("This task already has a reminder — reschedule it instead", 409);
    }
    const source = await this.sources.resolve(userId, input);

    const id = generateId();
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO reminders (id, user_id, task_id, title, notes, remind_at, timezone,
                                source_conversation_id, source_message_id, source_action_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, userId, input.taskId ?? null, input.title, input.notes ?? null, remindAt, timezone ?? null,
         source.conversationId, source.messageId, source.actionId]
      );
      if (source.actionId) await this.sources.claimAction(tx, userId, source.actionId, "reminder", id);
    });
    return this.publish(userId, id);
  }

  /** Edit or reschedule. Rescheduling a fired/dismissed/completed reminder makes it pending again. */
  async update(userId: string, reminderId: string, input: UpdateReminderInput): Promise<ReminderDTO> {
    const existing = await this.requireOwn(userId, reminderId);
    const timezone = input.timezone !== undefined ? input.timezone : (existing.timezone ?? (await this.preferences.getTimezone(userId)));
    const remindAt = resolveDateInput("remindAt", input.remindAt, input.remindAtLocal, timezone);

    const sets: string[] = [];
    const params: unknown[] = [reminderId, userId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.title !== undefined) push("title", input.title);
    if (input.notes !== undefined) push("notes", input.notes);
    if (input.timezone !== undefined) push("timezone", input.timezone);
    if (remindAt) {
      assertFuture(remindAt, "remindAt");
      push("remind_at", remindAt);
      sets.push("status = 'pending'", "fired_at = NULL", "completed_at = NULL");
    }
    if (sets.length > 0) {
      await this.db.query(`UPDATE reminders SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`, params);
    }
    if (remindAt && existing.taskId) {
      await this.db.query("UPDATE tasks SET reminder_at = $2, updated_at = now() WHERE id = $1", [existing.taskId, remindAt]);
    }
    return this.publish(userId, reminderId);
  }

  async setStatus(userId: string, reminderId: string, status: "completed" | "dismissed"): Promise<ReminderDTO> {
    await this.requireOwn(userId, reminderId);
    await this.db.query(
      `UPDATE reminders SET status = $3, completed_at = ${status === "completed" ? "now()" : "NULL"}, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [reminderId, userId, status]
    );
    return this.publish(userId, reminderId);
  }

  async remove(userId: string, reminderId: string): Promise<void> {
    const existing = await this.requireOwn(userId, reminderId);
    await this.db.query("DELETE FROM reminders WHERE id = $1 AND user_id = $2", [reminderId, userId]);
    if (existing.taskId) {
      await this.db.query("UPDATE tasks SET reminder_at = NULL, updated_at = now() WHERE id = $1", [existing.taskId]);
    }
    this.gateway.sendToUser(userId, { type: "reminder:deleted", reminderId });
  }

  // --- Task-linked reminders (called by TasksService) ------------------------

  /** Creates or reschedules the reminder belonging to a task. Caller has validated ownership and the time. */
  async upsertForTask(
    tx: DatabaseClient,
    task: { id: string; ownerId: string; title: string; timezone: string | null; source: { conversationId: string | null; messageId: string | null } },
    remindAt: Date
  ): Promise<string> {
    const existing = await tx.query<{ id: string }>("SELECT id FROM reminders WHERE task_id = $1", [task.id]);
    const existingId = existing.rows[0]?.id;
    if (existingId) {
      await tx.query(
        `UPDATE reminders SET remind_at = $2, title = $3, timezone = $4, status = 'pending', fired_at = NULL, completed_at = NULL, updated_at = now()
         WHERE id = $1`,
        [existingId, remindAt, task.title, task.timezone]
      );
      return existingId;
    }
    const id = generateId();
    await tx.query(
      `INSERT INTO reminders (id, user_id, task_id, title, remind_at, timezone, source_conversation_id, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, task.ownerId, task.id, task.title, remindAt, task.timezone, task.source.conversationId, task.source.messageId]
    );
    return id;
  }

  async idForTask(taskId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>("SELECT id FROM reminders WHERE task_id = $1", [taskId]);
    return result.rows[0]?.id ?? null;
  }

  /** Sends the current state of a reminder to its owner's devices and returns it. */
  async publish(userId: string, reminderId: string): Promise<ReminderDTO> {
    const reminder = (await this.findForUser(userId, reminderId))!;
    this.gateway.sendToUser(userId, { type: "reminder:updated", reminder });
    return reminder;
  }
}
