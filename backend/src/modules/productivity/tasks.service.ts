import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { resolveDateInput } from "../../utils/datetime";
import { generateId } from "../../utils/id";
import type { ConversationAccessService } from "../collaboration/conversation-access";
import type { NotificationsService } from "../notifications/notifications.service";
import type { PreferencesService } from "../preferences/preferences.service";
import type { CreateTaskInput, ListTasksQuery, UpdateTaskInput } from "./productivity.validation";
import { PRIORITY_RANK, type Priority, type TaskDTO, type TaskStatus } from "./productivity.types";
import { assertFuture, type RemindersService } from "./reminders.service";
import { sourceExcerptJoin, toSourceReference, type SourceResolver } from "./source";

interface TaskRow {
  id: string;
  owner_id: string;
  owner_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  due_at: Date | null;
  reminder_at: Date | null;
  timezone: string | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_action_id: string | null;
  source_excerpt: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function toDTO(row: TaskRow): TaskDTO {
  return {
    id: row.id,
    ownerId: row.owner_id,
    owner: { id: row.owner_id, displayName: row.owner_name },
    assignee: row.assignee_id ? { id: row.assignee_id, displayName: row.assignee_name ?? "" } : null,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    reminderAt: row.reminder_at,
    timezone: row.timezone,
    source: toSourceReference(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function selectTasks(viewerParam: string): string {
  const excerpt = sourceExcerptJoin("t", viewerParam);
  return `SELECT t.*, ou.display_name AS owner_name, au.display_name AS assignee_name, ${excerpt.select}
          FROM tasks t
          JOIN users ou ON ou.id = t.owner_id
          LEFT JOIN users au ON au.id = t.assignee_id
          ${excerpt.joins}`;
}

const TIME_OF = (date: Date | null) => (date ? new Date(date).getTime() : null);

/** Sorts in JS so "no due date" consistently sorts last, whatever the direction. */
export function sortTasks(tasks: TaskDTO[], sort: ListTasksQuery["sort"] = "due", order: ListTasksQuery["order"] = "asc"): TaskDTO[] {
  const direction = order === "desc" ? -1 : 1;
  const keyOf = (task: TaskDTO): number | null => {
    switch (sort) {
      case "priority":
        return PRIORITY_RANK[task.priority];
      case "created":
        return TIME_OF(task.createdAt);
      case "updated":
        return TIME_OF(task.updatedAt);
      default:
        return TIME_OF(task.dueAt);
    }
  };
  return [...tasks].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === null && kb === null) return TIME_OF(b.createdAt)! - TIME_OF(a.createdAt)!;
    if (ka === null) return 1;
    if (kb === null) return -1;
    if (ka !== kb) return (ka - kb) * direction;
    return TIME_OF(b.createdAt)! - TIME_OF(a.createdAt)!;
  });
}

/**
 * Personal tasks. Visible to the owner and (if set) the assignee only.
 * The owner can change everything; the assignee may only move the task
 * through its statuses (start / complete / reopen).
 *
 * An assignee must be the owner or an active member of the task's source
 * conversation — you can't assign tasks to strangers.
 */
export class TasksService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly access: ConversationAccessService,
    private readonly preferences: PreferencesService,
    private readonly sources: SourceResolver,
    private readonly reminders: RemindersService,
    private readonly notifications: NotificationsService
  ) {}

  async findForViewer(viewerId: string, taskId: string): Promise<TaskDTO | null> {
    const result = await this.db.query<TaskRow>(
      `${selectTasks("$2")} WHERE t.id = $1 AND (t.owner_id = $2 OR t.assignee_id = $2)`,
      [taskId, viewerId]
    );
    const row = result.rows[0];
    return row ? toDTO(row) : null;
  }

  private async requireVisible(userId: string, taskId: string): Promise<TaskDTO> {
    const task = await this.findForViewer(userId, taskId);
    if (!task) throw new AppError("Task not found", 404);
    return task;
  }

  async get(userId: string, taskId: string): Promise<TaskDTO> {
    return this.requireVisible(userId, taskId);
  }

  async list(userId: string, query: ListTasksQuery): Promise<TaskDTO[]> {
    const params: unknown[] = [userId];
    const where: string[] = [];
    const scope = query.scope ?? "all";
    if (scope === "mine") where.push("t.owner_id = $1");
    else if (scope === "assigned") where.push("t.assignee_id = $1 AND t.owner_id <> $1");
    else where.push("(t.owner_id = $1 OR t.assignee_id = $1)");

    if (query.status === "open") where.push("t.status IN ('todo', 'in_progress')");
    else if (query.status) {
      params.push(query.status);
      where.push(`t.status = $${params.length}`);
    }
    if (query.priority) {
      params.push(query.priority);
      where.push(`t.priority = $${params.length}`);
    }
    if (query.conversationId) {
      params.push(query.conversationId);
      where.push(`t.source_conversation_id = $${params.length}`);
    }
    if (query.dueBefore) {
      params.push(new Date(query.dueBefore));
      where.push(`t.due_at IS NOT NULL AND t.due_at <= $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
    }

    const result = await this.db.query<TaskRow>(`${selectTasks("$1")} WHERE ${where.join(" AND ")} LIMIT 500`, params);
    return sortTasks(result.rows.map(toDTO), query.sort, query.order);
  }

  /** Assignee must be the owner, or an active member of the source conversation. */
  private async validateAssignee(ownerId: string, assigneeId: string, conversationId: string | null): Promise<void> {
    if (assigneeId === ownerId) return;
    if (!conversationId) throw new AppError("Only tasks linked to a conversation can be assigned to someone else", 400);
    if (!(await this.access.isActiveMember(conversationId, assigneeId))) {
      throw new AppError("The assignee must be a member of this conversation", 400);
    }
  }

  async create(userId: string, input: CreateTaskInput): Promise<TaskDTO> {
    const timezone = input.timezone ?? (await this.preferences.getTimezone(userId));
    const dueAt = resolveDateInput("dueAt", input.dueAt, input.dueAtLocal, timezone) ?? null;
    const reminderAt = resolveDateInput("reminderAt", input.reminderAt, input.reminderAtLocal, timezone) ?? null;
    if (reminderAt) assertFuture(reminderAt, "reminderAt");

    const source = await this.sources.resolve(userId, input);
    const assigneeId = input.assigneeId ?? null;
    if (assigneeId) await this.validateAssignee(userId, assigneeId, source.conversationId);

    const status = input.status ?? "todo";
    const id = generateId();
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO tasks (id, owner_id, assignee_id, title, description, status, priority, due_at, reminder_at, timezone,
                            source_conversation_id, source_message_id, source_action_id, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ${status === "completed" ? "now()" : "NULL"})`,
        [id, userId, assigneeId, input.title, input.description ?? null, status, input.priority ?? "medium", dueAt, reminderAt,
         timezone ?? null, source.conversationId, source.messageId, source.actionId]
      );
      if (source.actionId) await this.sources.claimAction(tx, userId, source.actionId, "task", id);
      if (reminderAt) {
        await this.reminders.upsertForTask(tx, { id, ownerId: userId, title: input.title, timezone: timezone ?? null, source }, reminderAt);
      }
    });

    const task = await this.publish(id);
    await this.publishReminder(userId, id);
    if (assigneeId && assigneeId !== userId) await this.notifyAssigned(task);
    return (await this.findForViewer(userId, id))!;
  }

  async update(userId: string, taskId: string, input: UpdateTaskInput): Promise<TaskDTO> {
    const existing = await this.requireVisible(userId, taskId);
    const isOwner = existing.ownerId === userId;
    const changedFields = Object.keys(input);
    if (!isOwner && changedFields.some((field) => field !== "status")) {
      throw new AppError("Only the task's creator can change anything other than its status", 403);
    }

    const timezone = input.timezone !== undefined ? input.timezone : (existing.timezone ?? (await this.preferences.getTimezone(userId)));
    const dueAt = resolveDateInput("dueAt", input.dueAt, input.dueAtLocal, timezone);
    const reminderAt = resolveDateInput("reminderAt", input.reminderAt, input.reminderAtLocal, timezone);
    if (reminderAt) assertFuture(reminderAt, "reminderAt");
    if (input.assigneeId) await this.validateAssignee(existing.ownerId, input.assigneeId, existing.source.conversationId);

    const sets: string[] = [];
    const params: unknown[] = [taskId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.title !== undefined) push("title", input.title);
    if (input.description !== undefined) push("description", input.description);
    if (input.priority !== undefined) push("priority", input.priority);
    if (input.timezone !== undefined) push("timezone", input.timezone);
    if (input.assigneeId !== undefined) push("assignee_id", input.assigneeId);
    if (dueAt !== undefined) {
      push("due_at", dueAt);
      sets.push("due_notified_at = NULL");
    }
    if (reminderAt !== undefined) push("reminder_at", reminderAt);
    if (input.status !== undefined && input.status !== existing.status) {
      push("status", input.status);
      sets.push(input.status === "completed" ? "completed_at = now()" : "completed_at = NULL");
    }

    const title = input.title ?? existing.title;
    const priorReminderId = reminderAt === null ? await this.reminders.idForTask(taskId) : null;
    await this.db.withTransaction(async (tx) => {
      if (sets.length > 0) await tx.query(`UPDATE tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);

      if (reminderAt) {
        await this.reminders.upsertForTask(
          tx,
          { id: taskId, ownerId: existing.ownerId, title, timezone: timezone ?? null, source: existing.source },
          reminderAt
        );
      } else if (reminderAt === null) {
        await tx.query("DELETE FROM reminders WHERE task_id = $1", [taskId]);
      } else if (input.title !== undefined) {
        await tx.query("UPDATE reminders SET title = $2, updated_at = now() WHERE task_id = $1", [taskId, title]);
      }
      // Finishing a task settles its reminder so it doesn't fire afterwards.
      if (input.status === "completed" || input.status === "cancelled") {
        await tx.query(
          `UPDATE reminders SET status = 'completed', completed_at = now(), updated_at = now()
           WHERE task_id = $1 AND status IN ('pending', 'fired')`,
          [taskId]
        );
      }
    });

    if (priorReminderId) this.gateway.sendToUser(existing.ownerId, { type: "reminder:deleted", reminderId: priorReminderId });
    const task = await this.publish(taskId, existing.assignee?.id ?? null);
    await this.publishReminder(existing.ownerId, taskId);
    if (input.assigneeId && input.assigneeId !== existing.assignee?.id && input.assigneeId !== existing.ownerId) {
      await this.notifyAssigned(task);
    }
    return (await this.findForViewer(userId, taskId))!;
  }

  complete(userId: string, taskId: string): Promise<TaskDTO> {
    return this.update(userId, taskId, { status: "completed" });
  }

  reopen(userId: string, taskId: string): Promise<TaskDTO> {
    return this.update(userId, taskId, { status: "todo" });
  }

  async remove(userId: string, taskId: string): Promise<void> {
    const existing = await this.requireVisible(userId, taskId);
    if (existing.ownerId !== userId) throw new AppError("Only the task's creator can delete it", 403);
    const reminderId = await this.reminders.idForTask(taskId);
    await this.db.query("DELETE FROM tasks WHERE id = $1", [taskId]); // cascades to its reminder
    broadcast(this.gateway, [existing.ownerId, existing.assignee?.id].filter((id): id is string => !!id), {
      type: "task:deleted",
      taskId,
    });
    if (reminderId) this.gateway.sendToUser(existing.ownerId, { type: "reminder:deleted", reminderId });
  }

  /**
   * Pushes the task to everyone who can see it. Each recipient gets their
   * own view (the source excerpt depends on what *they* can read). A
   * previous assignee who lost access gets task:deleted.
   */
  private async publish(taskId: string, previousAssigneeId: string | null = null): Promise<TaskDTO> {
    const ownerView = await this.db.query<TaskRow>(`${selectTasks("t.owner_id")} WHERE t.id = $1`, [taskId]);
    const task = toDTO(ownerView.rows[0]!);
    this.gateway.sendToUser(task.ownerId, { type: "task:updated", task });
    if (task.assignee && task.assignee.id !== task.ownerId) {
      const assigneeView = await this.findForViewer(task.assignee.id, taskId);
      if (assigneeView) this.gateway.sendToUser(task.assignee.id, { type: "task:updated", task: assigneeView });
    }
    if (previousAssigneeId && previousAssigneeId !== task.assignee?.id && previousAssigneeId !== task.ownerId) {
      this.gateway.sendToUser(previousAssigneeId, { type: "task:deleted", taskId });
    }
    return task;
  }

  private async publishReminder(ownerId: string, taskId: string): Promise<void> {
    const reminderId = await this.reminders.idForTask(taskId);
    if (reminderId) await this.reminders.publish(ownerId, reminderId);
  }

  private async notifyAssigned(task: TaskDTO): Promise<void> {
    if (!task.assignee) return;
    await this.notifications.notify({
      userId: task.assignee.id,
      type: "task_assigned",
      title: `${task.owner.displayName} assigned you a task`,
      body: task.title,
      payload: { taskId: task.id, ...(task.source.conversationId ? { conversationId: task.source.conversationId } : {}) },
    });
  }
}
