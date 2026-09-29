import type { DatabaseClient } from "../../db/pool";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import type { NotificationsService } from "../notifications/notifications.service";
import type { RemindersService } from "../productivity/reminders.service";
import type { ScheduledMessagesService } from "../scheduled-messages/scheduled-messages.service";

export interface TickResult {
  remindersFired: number;
  tasksDue: number;
  scheduledSent: number;
}

const BATCH_SIZE = 100;

/**
 * The background worker for time-based Phase 6 features: firing reminders,
 * "task due" notifications and delivering scheduled messages.
 *
 * It is a simple in-process poller (server.ts calls `tick()` on an
 * interval). Every unit of work is *claimed* with a conditional UPDATE
 * before it is acted on, so overlapping ticks — or several backend
 * instances polling the same database — never double-fire a reminder or
 * double-send a message. Work that came due while the server was down is
 * picked up on the next tick after startup. Limitations (documented in
 * docs/productivity.md): granularity equals the poll interval, and there
 * is no dedicated job queue — a very large backlog is worked off in
 * batches of BATCH_SIZE per tick.
 */
export class SchedulerService {
  private running = false;

  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly notifications: NotificationsService,
    private readonly reminders: RemindersService,
    private readonly scheduledMessages: ScheduledMessagesService
  ) {}

  /** Runs one pass. Re-entrant calls while a pass is running are skipped (returns null). */
  async tick(now = new Date()): Promise<TickResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const remindersFired = await this.fireReminders(now);
      const tasksDue = await this.notifyDueTasks(now);
      const scheduledSent = await this.scheduledMessages.deliverDue(now);
      return { remindersFired, tasksDue, scheduledSent };
    } finally {
      this.running = false;
    }
  }

  private async fireReminders(now: Date): Promise<number> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM reminders WHERE status = 'pending' AND remind_at <= $1 ORDER BY remind_at ASC LIMIT ${BATCH_SIZE}`,
      [now]
    );
    let fired = 0;
    for (const { id } of due.rows) {
      const claimed = await this.db.query<{ id: string; user_id: string; title: string; remind_at: Date; task_id: string | null; source_conversation_id: string | null; source_message_id: string | null }>(
        "UPDATE reminders SET status = 'fired', fired_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
        [id]
      );
      const reminder = claimed.rows[0];
      if (!reminder) continue;
      fired += 1;
      const payload: Record<string, string> = { reminderId: reminder.id };
      if (reminder.task_id) payload.taskId = reminder.task_id;
      if (reminder.source_conversation_id) payload.conversationId = reminder.source_conversation_id;
      if (reminder.source_message_id) payload.messageId = reminder.source_message_id;
      await this.notifications.notify({
        userId: reminder.user_id,
        type: "reminder",
        title: "Reminder",
        body: reminder.title,
        payload,
        dedupeKey: `reminder:${reminder.id}:${new Date(reminder.remind_at).getTime()}`,
      });
      await this.reminders.publish(reminder.user_id, reminder.id);
    }
    return fired;
  }

  private async notifyDueTasks(now: Date): Promise<number> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM tasks
       WHERE due_notified_at IS NULL AND due_at <= $1 AND status IN ('todo', 'in_progress')
       ORDER BY due_at ASC LIMIT ${BATCH_SIZE}`,
      [now]
    );
    let count = 0;
    for (const { id } of due.rows) {
      const claimed = await this.db.query<{ id: string; owner_id: string; assignee_id: string | null; title: string; due_at: Date; source_conversation_id: string | null }>(
        "UPDATE tasks SET due_notified_at = now() WHERE id = $1 AND due_notified_at IS NULL RETURNING id, owner_id, assignee_id, title, due_at, source_conversation_id",
        [id]
      );
      const task = claimed.rows[0];
      if (!task) continue;
      count += 1;
      const recipients = [task.owner_id, task.assignee_id].filter((userId): userId is string => !!userId);
      for (const userId of new Set(recipients)) {
        await this.notifications.notify({
          userId,
          type: "task_due",
          title: "Task due",
          body: task.title,
          payload: { taskId: task.id, ...(task.source_conversation_id ? { conversationId: task.source_conversation_id } : {}) },
          dedupeKey: `task_due:${task.id}:${new Date(task.due_at).getTime()}`,
        });
      }
      broadcast(this.gateway, recipients, { type: "task:due", taskId: task.id });
    }
    return count;
  }
}
