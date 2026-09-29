import type { DatabaseClient } from "../../db/pool";
import { placeholders } from "../../db/errors";
import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { generateId } from "../../utils/id";
import type { NotificationsService } from "../notifications/notifications.service";
import type { Priority } from "../productivity/productivity.types";
import type { ConversationAccess, ConversationAccessService } from "./conversation-access";

export interface TodoItemDTO {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  assignee: { id: string; displayName: string } | null;
  priority: Priority;
  dueAt: Date | null;
  completed: boolean;
  completedAt: Date | null;
  completedBy: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TodoListDTO {
  id: string;
  conversationId: string;
  title: string;
  createdBy: { id: string; displayName: string };
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;
  completedCount: number;
}

export interface TodoListWithItemsDTO extends TodoListDTO {
  items: TodoItemDTO[];
}

interface ListRow {
  id: string;
  conversation_id: string;
  title: string;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  id: string;
  list_id: string;
  title: string;
  notes: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  priority: Priority;
  due_at: Date | null;
  completed_at: Date | null;
  completed_by: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const SELECT_LIST = `SELECT l.*, u.display_name AS created_by_name FROM shared_todo_lists l JOIN users u ON u.id = l.created_by`;
const SELECT_ITEM = `SELECT i.*, au.display_name AS assignee_name FROM shared_todo_items i LEFT JOIN users au ON au.id = i.assignee_id`;

function toItem(row: ItemRow): TodoItemDTO {
  return {
    id: row.id,
    listId: row.list_id,
    title: row.title,
    notes: row.notes,
    assignee: row.assignee_id ? { id: row.assignee_id, displayName: row.assignee_name ?? "" } : null,
    priority: row.priority,
    dueAt: row.due_at,
    completed: row.completed_at !== null,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ItemInput {
  title?: string;
  notes?: string | null;
  assigneeId?: string | null;
  priority?: Priority;
  dueAt?: string | null;
}

/**
 * Collaborative to-do lists attached to a conversation (typically a group).
 * Every operation requires active membership of that conversation — the
 * same rule as reading its messages. Any member can add, edit, assign and
 * tick items; deleting an item needs its creator, the list's creator or a
 * group admin; renaming/deleting a list needs its creator or a group admin.
 */
export class SharedTodosService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly access: ConversationAccessService,
    private readonly notifications: NotificationsService
  ) {}

  private async loadList(listId: string, userId: string): Promise<{ list: ListRow; access: ConversationAccess }> {
    const result = await this.db.query<ListRow>(`${SELECT_LIST} WHERE l.id = $1`, [listId]);
    const list = result.rows[0];
    const access = list ? await this.access.find(list.conversation_id, userId) : null;
    if (!list || !access) throw new AppError("To-do list not found", 404);
    return { list, access };
  }

  private async loadItem(itemId: string, userId: string): Promise<{ item: ItemRow; list: ListRow; access: ConversationAccess }> {
    const result = await this.db.query<ItemRow>(`${SELECT_ITEM} WHERE i.id = $1`, [itemId]);
    const item = result.rows[0];
    if (!item) throw new AppError("To-do item not found", 404);
    try {
      return { item, ...(await this.loadList(item.list_id, userId)) };
    } catch {
      throw new AppError("To-do item not found", 404);
    }
  }

  private async counts(listIds: string[]): Promise<Map<string, { total: number; done: number }>> {
    const counts = new Map<string, { total: number; done: number }>();
    if (listIds.length === 0) return counts;
    const result = await this.db.query<{ list_id: string; completed_at: Date | null }>(
      `SELECT list_id, completed_at FROM shared_todo_items WHERE list_id IN (${placeholders(listIds)})`,
      listIds
    );
    for (const row of result.rows) {
      const entry = counts.get(row.list_id) ?? { total: 0, done: 0 };
      entry.total += 1;
      if (row.completed_at) entry.done += 1;
      counts.set(row.list_id, entry);
    }
    return counts;
  }

  private toList(row: ListRow, count: { total: number; done: number } | undefined): TodoListDTO {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      title: row.title,
      createdBy: { id: row.created_by, displayName: row.created_by_name },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      itemCount: count?.total ?? 0,
      completedCount: count?.done ?? 0,
    };
  }

  private async listDTO(listId: string): Promise<TodoListDTO> {
    const result = await this.db.query<ListRow>(`${SELECT_LIST} WHERE l.id = $1`, [listId]);
    return this.toList(result.rows[0]!, (await this.counts([listId])).get(listId));
  }

  async listForConversation(conversationId: string, userId: string): Promise<TodoListDTO[]> {
    await this.access.require(conversationId, userId);
    const result = await this.db.query<ListRow>(`${SELECT_LIST} WHERE l.conversation_id = $1 ORDER BY l.created_at ASC LIMIT 100`, [
      conversationId,
    ]);
    const counts = await this.counts(result.rows.map((row) => row.id));
    return result.rows.map((row) => this.toList(row, counts.get(row.id)));
  }

  async getList(listId: string, userId: string): Promise<TodoListWithItemsDTO> {
    await this.loadList(listId, userId);
    const items = await this.db.query<ItemRow>(`${SELECT_ITEM} WHERE i.list_id = $1 ORDER BY i.created_at ASC`, [listId]);
    return { ...(await this.listDTO(listId)), items: items.rows.map(toItem) };
  }

  async createList(userId: string, conversationId: string, title: string): Promise<TodoListDTO> {
    await this.access.require(conversationId, userId);
    const id = generateId();
    await this.db.query("INSERT INTO shared_todo_lists (id, conversation_id, title, created_by) VALUES ($1, $2, $3, $4)", [
      id,
      conversationId,
      title,
      userId,
    ]);
    return this.publishList(id, conversationId);
  }

  async renameList(listId: string, userId: string, title: string): Promise<TodoListDTO> {
    const { list, access } = await this.loadList(listId, userId);
    if (list.created_by !== userId && !access.isAdmin) throw new AppError("Only the list's creator or group admins can rename it", 403);
    await this.db.query("UPDATE shared_todo_lists SET title = $2, updated_at = now() WHERE id = $1", [listId, title]);
    return this.publishList(listId, list.conversation_id);
  }

  async deleteList(listId: string, userId: string): Promise<void> {
    const { list, access } = await this.loadList(listId, userId);
    if (list.created_by !== userId && !access.isAdmin) throw new AppError("Only the list's creator or group admins can delete it", 403);
    await this.db.query("DELETE FROM shared_todo_lists WHERE id = $1", [listId]);
    broadcast(this.gateway, await this.access.activeMemberIds(list.conversation_id), {
      type: "todo:list_deleted",
      conversationId: list.conversation_id,
      listId,
    });
  }

  private async requireAssignable(conversationId: string, assigneeId: string): Promise<void> {
    if (!(await this.access.isActiveMember(conversationId, assigneeId))) {
      throw new AppError("The assignee must be a member of this conversation", 400);
    }
  }

  async addItem(listId: string, userId: string, input: ItemInput & { title: string }): Promise<TodoItemDTO> {
    const { list } = await this.loadList(listId, userId);
    if (input.assigneeId) await this.requireAssignable(list.conversation_id, input.assigneeId);
    const id = generateId();
    await this.db.query(
      `INSERT INTO shared_todo_items (id, list_id, title, notes, assignee_id, priority, due_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, listId, input.title, input.notes ?? null, input.assigneeId ?? null, input.priority ?? "medium",
       input.dueAt ? new Date(input.dueAt) : null, userId]
    );
    await this.touchList(listId);
    const item = await this.publishItem(id, list);
    if (item.assignee && item.assignee.id !== userId) await this.notifyAssigned(item, list, userId);
    return item;
  }

  async updateItem(itemId: string, userId: string, input: ItemInput): Promise<TodoItemDTO> {
    const { item, list } = await this.loadItem(itemId, userId);
    if (input.assigneeId) await this.requireAssignable(list.conversation_id, input.assigneeId);

    const sets: string[] = [];
    const params: unknown[] = [itemId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.title !== undefined) push("title", input.title);
    if (input.notes !== undefined) push("notes", input.notes);
    if (input.assigneeId !== undefined) push("assignee_id", input.assigneeId);
    if (input.priority !== undefined) push("priority", input.priority);
    if (input.dueAt !== undefined) push("due_at", input.dueAt ? new Date(input.dueAt) : null);
    if (sets.length > 0) await this.db.query(`UPDATE shared_todo_items SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
    await this.touchList(list.id);

    const updated = await this.publishItem(itemId, list);
    if (input.assigneeId && input.assigneeId !== item.assignee_id && input.assigneeId !== userId) {
      await this.notifyAssigned(updated, list, userId);
    }
    return updated;
  }

  async setCompleted(itemId: string, userId: string, completed: boolean): Promise<TodoItemDTO> {
    const { list } = await this.loadItem(itemId, userId);
    await this.db.query(
      completed
        ? "UPDATE shared_todo_items SET completed_at = COALESCE(completed_at, now()), completed_by = COALESCE(completed_by, $2), updated_at = now() WHERE id = $1"
        : "UPDATE shared_todo_items SET completed_at = NULL, completed_by = NULL, updated_at = now() WHERE id = $1",
      completed ? [itemId, userId] : [itemId]
    );
    await this.touchList(list.id);
    return this.publishItem(itemId, list);
  }

  async deleteItem(itemId: string, userId: string): Promise<void> {
    const { item, list, access } = await this.loadItem(itemId, userId);
    if (item.created_by !== userId && list.created_by !== userId && !access.isAdmin) {
      throw new AppError("Only the item's creator, the list's creator or group admins can delete it", 403);
    }
    await this.db.query("DELETE FROM shared_todo_items WHERE id = $1", [itemId]);
    await this.touchList(list.id);
    const memberIds = await this.access.activeMemberIds(list.conversation_id);
    broadcast(this.gateway, memberIds, { type: "todo:item_deleted", conversationId: list.conversation_id, listId: list.id, itemId });
    broadcast(this.gateway, memberIds, { type: "todo:list_updated", conversationId: list.conversation_id, list: await this.listDTO(list.id) });
  }

  private async touchList(listId: string): Promise<void> {
    await this.db.query("UPDATE shared_todo_lists SET updated_at = now() WHERE id = $1", [listId]);
  }

  private async publishList(listId: string, conversationId: string): Promise<TodoListDTO> {
    const list = await this.listDTO(listId);
    broadcast(this.gateway, await this.access.activeMemberIds(conversationId), { type: "todo:list_updated", conversationId, list });
    return list;
  }

  private async publishItem(itemId: string, list: ListRow): Promise<TodoItemDTO> {
    const result = await this.db.query<ItemRow>(`${SELECT_ITEM} WHERE i.id = $1`, [itemId]);
    const item = toItem(result.rows[0]!);
    const memberIds = await this.access.activeMemberIds(list.conversation_id);
    broadcast(this.gateway, memberIds, { type: "todo:item_updated", conversationId: list.conversation_id, listId: list.id, item });
    broadcast(this.gateway, memberIds, { type: "todo:list_updated", conversationId: list.conversation_id, list: await this.listDTO(list.id) });
    return item;
  }

  private async notifyAssigned(item: TodoItemDTO, list: ListRow, actorId: string): Promise<void> {
    const actor = await this.db.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [actorId]);
    await this.notifications.notify({
      userId: item.assignee!.id,
      type: "todo_assigned",
      title: `${actor.rows[0]?.display_name ?? "Someone"} assigned you a to-do in "${list.title}"`,
      body: item.title,
      payload: { conversationId: list.conversation_id, listId: list.id, itemId: item.id },
    });
  }
}
