import type {
  AppNotification,
  BusinessProfile,
  CalendarEvent,
  DeviceSession,
  PinnedMessage,
  Priority,
  QuickReply,
  Reminder,
  SavedMessage,
  ScheduledMessage,
  ScheduledStatus,
  SharedNote,
  SourceInput,
  Task,
  TaskStatus,
  TodoItem,
  TodoList,
  TodoListWithItems,
  UserPreferences,
} from "../types/productivity";
import { apiRequest, buildQueryString } from "./apiClient";

/**
 * Phase 6 REST clients. The server authorizes every call (ownership,
 * conversation membership, group roles); these only transport data.
 *
 * Dates: pass `…Local` wall-clock strings ("2026-10-01T09:00", as produced
 * by <input type="datetime-local">) together with `timezone`, and the
 * server converts them to UTC in that timezone.
 */

export interface TaskInput extends SourceInput {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: Priority;
  dueAt?: string | null;
  dueAtLocal?: string | null;
  reminderAt?: string | null;
  reminderAtLocal?: string | null;
  timezone?: string | null;
  assigneeId?: string | null;
}

export interface TaskQuery {
  status?: TaskStatus | "open";
  priority?: Priority;
  scope?: "all" | "mine" | "assigned";
  conversationId?: string;
  q?: string;
  sort?: "due" | "priority" | "created" | "updated";
  order?: "asc" | "desc";
}

export interface ReminderInput extends SourceInput {
  title?: string;
  notes?: string | null;
  remindAt?: string;
  remindAtLocal?: string;
  timezone?: string | null;
  taskId?: string;
}

export interface EventInput extends SourceInput {
  title?: string;
  description?: string | null;
  location?: string | null;
  startsAt?: string;
  startsAtLocal?: string;
  endsAt?: string | null;
  endsAtLocal?: string | null;
  allDay?: boolean;
  timezone?: string | null;
}

const del = (path: string, accessToken: string) => apiRequest<void>(path, { method: "DELETE", accessToken });

export const taskService = {
  async list(accessToken: string, query: TaskQuery = {}): Promise<Task[]> {
    return (await apiRequest<{ tasks: Task[] }>(`/tasks${buildQueryString({ ...query })}`, { accessToken })).tasks;
  },
  async create(accessToken: string, input: TaskInput & { title: string }): Promise<Task> {
    return (await apiRequest<{ task: Task }>("/tasks", { method: "POST", body: input, accessToken })).task;
  },
  async update(accessToken: string, id: string, input: TaskInput): Promise<Task> {
    return (await apiRequest<{ task: Task }>(`/tasks/${id}`, { method: "PATCH", body: input, accessToken })).task;
  },
  async complete(accessToken: string, id: string): Promise<Task> {
    return (await apiRequest<{ task: Task }>(`/tasks/${id}/complete`, { method: "POST", accessToken })).task;
  },
  async reopen(accessToken: string, id: string): Promise<Task> {
    return (await apiRequest<{ task: Task }>(`/tasks/${id}/reopen`, { method: "POST", accessToken })).task;
  },
  remove: (accessToken: string, id: string) => del(`/tasks/${id}`, accessToken),
};

export const reminderService = {
  async list(accessToken: string, status?: Reminder["status"] | "active"): Promise<Reminder[]> {
    return (await apiRequest<{ reminders: Reminder[] }>(`/reminders${buildQueryString({ status })}`, { accessToken })).reminders;
  },
  async create(accessToken: string, input: ReminderInput & { title: string }): Promise<Reminder> {
    return (await apiRequest<{ reminder: Reminder }>("/reminders", { method: "POST", body: input, accessToken })).reminder;
  },
  async update(accessToken: string, id: string, input: ReminderInput): Promise<Reminder> {
    return (await apiRequest<{ reminder: Reminder }>(`/reminders/${id}`, { method: "PATCH", body: input, accessToken })).reminder;
  },
  async setStatus(accessToken: string, id: string, action: "complete" | "dismiss"): Promise<Reminder> {
    return (await apiRequest<{ reminder: Reminder }>(`/reminders/${id}/${action}`, { method: "POST", accessToken })).reminder;
  },
  remove: (accessToken: string, id: string) => del(`/reminders/${id}`, accessToken),
};

export const eventService = {
  async list(accessToken: string, range: { from?: string; to?: string } = {}): Promise<CalendarEvent[]> {
    return (await apiRequest<{ events: CalendarEvent[] }>(`/events${buildQueryString(range)}`, { accessToken })).events;
  },
  async create(accessToken: string, input: EventInput & { title: string }): Promise<CalendarEvent> {
    return (await apiRequest<{ event: CalendarEvent }>("/events", { method: "POST", body: input, accessToken })).event;
  },
  async update(accessToken: string, id: string, input: EventInput): Promise<CalendarEvent> {
    return (await apiRequest<{ event: CalendarEvent }>(`/events/${id}`, { method: "PATCH", body: input, accessToken })).event;
  },
  remove: (accessToken: string, id: string) => del(`/events/${id}`, accessToken),
};

export const noteService = {
  async list(accessToken: string, conversationId: string): Promise<SharedNote[]> {
    return (await apiRequest<{ notes: SharedNote[] }>(`/notes${buildQueryString({ conversationId })}`, { accessToken })).notes;
  },
  async create(
    accessToken: string,
    input: { conversationId: string; title: string; content?: string; editPolicy?: "members" | "admins" }
  ): Promise<SharedNote> {
    return (await apiRequest<{ note: SharedNote }>("/notes", { method: "POST", body: input, accessToken })).note;
  },
  async update(
    accessToken: string,
    id: string,
    input: { title?: string; content?: string; editPolicy?: "members" | "admins"; expectedVersion?: number }
  ): Promise<SharedNote> {
    return (await apiRequest<{ note: SharedNote }>(`/notes/${id}`, { method: "PATCH", body: input, accessToken })).note;
  },
  remove: (accessToken: string, id: string) => del(`/notes/${id}`, accessToken),
};

export interface TodoItemInput {
  title?: string;
  notes?: string | null;
  assigneeId?: string | null;
  priority?: Priority;
  dueAt?: string | null;
}

export const todoService = {
  async lists(accessToken: string, conversationId: string): Promise<TodoList[]> {
    return (await apiRequest<{ lists: TodoList[] }>(`/todo-lists${buildQueryString({ conversationId })}`, { accessToken })).lists;
  },
  async get(accessToken: string, listId: string): Promise<TodoListWithItems> {
    return (await apiRequest<{ list: TodoListWithItems }>(`/todo-lists/${listId}`, { accessToken })).list;
  },
  async createList(accessToken: string, conversationId: string, title: string): Promise<TodoList> {
    return (await apiRequest<{ list: TodoList }>("/todo-lists", { method: "POST", body: { conversationId, title }, accessToken })).list;
  },
  removeList: (accessToken: string, listId: string) => del(`/todo-lists/${listId}`, accessToken),
  async addItem(accessToken: string, listId: string, input: TodoItemInput & { title: string }): Promise<TodoItem> {
    return (await apiRequest<{ item: TodoItem }>(`/todo-lists/${listId}/items`, { method: "POST", body: input, accessToken })).item;
  },
  async updateItem(accessToken: string, itemId: string, input: TodoItemInput): Promise<TodoItem> {
    return (await apiRequest<{ item: TodoItem }>(`/todo-items/${itemId}`, { method: "PATCH", body: input, accessToken })).item;
  },
  async setCompleted(accessToken: string, itemId: string, completed: boolean): Promise<TodoItem> {
    const action = completed ? "complete" : "reopen";
    return (await apiRequest<{ item: TodoItem }>(`/todo-items/${itemId}/${action}`, { method: "POST", accessToken })).item;
  },
  removeItem: (accessToken: string, itemId: string) => del(`/todo-items/${itemId}`, accessToken),
};

export const pinService = {
  async list(accessToken: string, conversationId: string): Promise<PinnedMessage[]> {
    return (await apiRequest<{ pins: PinnedMessage[] }>(`/pins${buildQueryString({ conversationId })}`, { accessToken })).pins;
  },
  async pin(accessToken: string, messageId: string): Promise<PinnedMessage> {
    return (await apiRequest<{ pin: PinnedMessage }>("/pins", { method: "POST", body: { messageId }, accessToken })).pin;
  },
  unpin: (accessToken: string, messageId: string) => del(`/pins/${messageId}`, accessToken),
};

export const savedService = {
  async list(accessToken: string, filters: { q?: string; label?: string; starred?: boolean; conversationId?: string } = {}): Promise<SavedMessage[]> {
    const query = buildQueryString({ ...filters, starred: filters.starred === undefined ? undefined : String(filters.starred) });
    return (await apiRequest<{ saved: SavedMessage[] }>(`/saved${query}`, { accessToken })).saved;
  },
  async labels(accessToken: string): Promise<string[]> {
    return (await apiRequest<{ labels: string[] }>("/saved/labels", { accessToken })).labels;
  },
  async inConversation(accessToken: string, conversationId: string): Promise<Array<{ messageId: string; starred: boolean }>> {
    return (await apiRequest<{ saved: Array<{ messageId: string; starred: boolean }> }>(`/saved/conversation/${conversationId}`, { accessToken })).saved;
  },
  async save(accessToken: string, messageId: string, input: { label?: string | null; starred?: boolean; note?: string | null } = {}): Promise<SavedMessage> {
    return (await apiRequest<{ saved: SavedMessage }>(`/saved/${messageId}`, { method: "PUT", body: input, accessToken })).saved;
  },
  unsave: (accessToken: string, messageId: string) => del(`/saved/${messageId}`, accessToken),
};

export const scheduledMessageService = {
  async list(accessToken: string, filters: { conversationId?: string; status?: ScheduledStatus } = {}): Promise<ScheduledMessage[]> {
    return (await apiRequest<{ scheduledMessages: ScheduledMessage[] }>(`/scheduled-messages${buildQueryString(filters)}`, { accessToken }))
      .scheduledMessages;
  },
  async create(
    accessToken: string,
    input: { conversationId: string; body: string; scheduledFor?: string; scheduledForLocal?: string; timezone?: string | null }
  ): Promise<ScheduledMessage> {
    return (await apiRequest<{ scheduledMessage: ScheduledMessage }>("/scheduled-messages", { method: "POST", body: input, accessToken }))
      .scheduledMessage;
  },
  async update(
    accessToken: string,
    id: string,
    input: { body?: string; scheduledFor?: string; scheduledForLocal?: string; timezone?: string | null }
  ): Promise<ScheduledMessage> {
    return (await apiRequest<{ scheduledMessage: ScheduledMessage }>(`/scheduled-messages/${id}`, { method: "PATCH", body: input, accessToken }))
      .scheduledMessage;
  },
  async cancel(accessToken: string, id: string): Promise<ScheduledMessage> {
    return (await apiRequest<{ scheduledMessage: ScheduledMessage }>(`/scheduled-messages/${id}/cancel`, { method: "POST", accessToken }))
      .scheduledMessage;
  },
  remove: (accessToken: string, id: string) => del(`/scheduled-messages/${id}`, accessToken),
};

export const notificationService = {
  list(accessToken: string, unreadOnly = false): Promise<{ notifications: AppNotification[]; unreadCount: number }> {
    return apiRequest(`/notifications${buildQueryString({ unreadOnly: unreadOnly ? "true" : undefined })}`, { accessToken });
  },
  markRead: (accessToken: string, id: string) => apiRequest<void>(`/notifications/${id}/read`, { method: "POST", accessToken }),
  markAllRead: (accessToken: string) => apiRequest<void>("/notifications/read-all", { method: "POST", accessToken }),
  remove: (accessToken: string, id: string) => del(`/notifications/${id}`, accessToken),
};

export const preferencesService = {
  async get(accessToken: string): Promise<UserPreferences> {
    return (await apiRequest<{ preferences: UserPreferences }>("/preferences", { accessToken })).preferences;
  },
  async update(accessToken: string, update: Partial<Omit<UserPreferences, "updatedAt">>): Promise<UserPreferences> {
    return (await apiRequest<{ preferences: UserPreferences }>("/preferences", { method: "PATCH", body: update, accessToken })).preferences;
  },
  async focused(accessToken: string): Promise<string[]> {
    return (await apiRequest<{ conversationIds: string[] }>("/preferences/focus", { accessToken })).conversationIds;
  },
  async setFocused(accessToken: string, conversationId: string, focused: boolean): Promise<string[]> {
    return (
      await apiRequest<{ conversationIds: string[] }>(`/preferences/focus/${conversationId}`, { method: focused ? "PUT" : "DELETE", accessToken })
    ).conversationIds;
  },
};

export const sessionService = {
  async list(accessToken: string): Promise<DeviceSession[]> {
    return (await apiRequest<{ sessions: DeviceSession[] }>("/sessions", { accessToken })).sessions;
  },
  async rename(accessToken: string, sessionId: string, deviceName: string): Promise<DeviceSession[]> {
    return (await apiRequest<{ sessions: DeviceSession[] }>(`/sessions/${sessionId}`, { method: "PATCH", body: { deviceName }, accessToken })).sessions;
  },
  revoke: (accessToken: string, sessionId: string) => del(`/sessions/${sessionId}`, accessToken),
  async revokeOthers(accessToken: string): Promise<number> {
    return (await apiRequest<{ revoked: number }>("/sessions/revoke-others", { method: "POST", accessToken })).revoked;
  },
};

export type BusinessProfileInput = Omit<BusinessProfile, "userId" | "verificationStatus" | "createdAt" | "updatedAt">;

export const businessService = {
  async get(accessToken: string): Promise<BusinessProfile | null> {
    return (await apiRequest<{ profile: BusinessProfile | null }>("/business/profile", { accessToken })).profile;
  },
  async save(accessToken: string, input: BusinessProfileInput): Promise<BusinessProfile> {
    return (await apiRequest<{ profile: BusinessProfile }>("/business/profile", { method: "PUT", body: input, accessToken })).profile;
  },
  remove: (accessToken: string) => del("/business/profile", accessToken),
  async quickReplies(accessToken: string): Promise<QuickReply[]> {
    return (await apiRequest<{ quickReplies: QuickReply[] }>("/business/quick-replies", { accessToken })).quickReplies;
  },
  async createQuickReply(accessToken: string, input: { shortcut: string; title: string; body: string }): Promise<QuickReply> {
    return (await apiRequest<{ quickReply: QuickReply }>("/business/quick-replies", { method: "POST", body: input, accessToken })).quickReply;
  },
  async updateQuickReply(accessToken: string, id: string, input: { shortcut?: string; title?: string; body?: string }): Promise<QuickReply> {
    return (await apiRequest<{ quickReply: QuickReply }>(`/business/quick-replies/${id}`, { method: "PATCH", body: input, accessToken })).quickReply;
  },
  removeQuickReply: (accessToken: string, id: string) => del(`/business/quick-replies/${id}`, accessToken),
};
