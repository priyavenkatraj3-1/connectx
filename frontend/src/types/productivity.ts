/** Phase 6 types. Mirror backend DTOs (dates arrive as ISO strings). */

export type TaskStatus = "todo" | "in_progress" | "completed" | "cancelled";
export type Priority = "low" | "medium" | "high" | "urgent";
export type ReminderStatus = "pending" | "fired" | "completed" | "dismissed";

export interface SourceReference {
  conversationId: string | null;
  messageId: string | null;
  actionId: string | null;
  /** Only present while you can still read the source message. */
  messageExcerpt: string | null;
}

export interface PersonRef {
  id: string;
  displayName: string;
}

export interface Task {
  id: string;
  ownerId: string;
  owner: PersonRef;
  assignee: PersonRef | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  reminderAt: string | null;
  timezone: string | null;
  source: SourceReference;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Reminder {
  id: string;
  taskId: string | null;
  title: string;
  notes: string | null;
  remindAt: string;
  timezone: string | null;
  status: ReminderStatus;
  source: SourceReference;
  firedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  timezone: string | null;
  source: SourceReference;
  createdAt: string;
  updatedAt: string;
}

/** Where a new item comes from. The server verifies each reference against your access. */
export interface SourceInput {
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceActionId?: string;
}

export interface SharedNote {
  id: string;
  conversationId: string;
  title: string;
  content: string;
  editPolicy: "members" | "admins";
  version: number;
  createdBy: PersonRef;
  updatedBy: PersonRef | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
}

export interface TodoItem {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  assignee: PersonRef | null;
  priority: Priority;
  dueAt: string | null;
  completed: boolean;
  completedAt: string | null;
  completedBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TodoList {
  id: string;
  conversationId: string;
  title: string;
  createdBy: PersonRef;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  completedCount: number;
}

export interface TodoListWithItems extends TodoList {
  items: TodoItem[];
}

export interface MessagePreview {
  id: string;
  conversationId: string;
  senderId: string;
  senderDisplayName: string;
  contentType: string;
  body: string | null;
  createdAt: string;
}

export interface PinnedMessage {
  conversationId: string;
  messageId: string;
  pinnedBy: PersonRef | null;
  pinnedAt: string;
  message: MessagePreview;
}

export interface SavedMessage {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  label: string | null;
  starred: boolean;
  note: string | null;
  savedAt: string;
  updatedAt: string;
  message: MessagePreview;
}

export type ScheduledStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

export interface ScheduledMessage {
  id: string;
  conversationId: string;
  body: string;
  scheduledFor: string;
  timezone: string | null;
  status: ScheduledStatus;
  attempts: number;
  failureReason: string | null;
  sentMessageId: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  payload: Record<string, string>;
  readAt: string | null;
  createdAt: string;
}

export interface UserPreferences {
  timezone: string | null;
  productivityMode: boolean;
  notifyMentions: boolean;
  notifyTaskDue: boolean;
  notifyReminders: boolean;
  notifyScheduledMessages: boolean;
  notifyAssignments: boolean;
  updatedAt: string | null;
}

export interface DeviceSession {
  id: string;
  deviceId: string | null;
  deviceName: string;
  platform: "web" | "ios" | "android" | "desktop";
  userAgentSummary: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  current: boolean;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type BusinessHours = Partial<Record<Weekday, Array<{ open: string; close: string }>>>;

export interface BusinessProfile {
  userId: string;
  businessName: string;
  description: string | null;
  category: string | null;
  website: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  businessHours: BusinessHours;
  /** Always "unverified" today — ConnectX has no verification process yet. */
  verificationStatus: "unverified" | "pending" | "verified";
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
