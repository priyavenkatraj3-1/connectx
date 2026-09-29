export type TaskStatus = "todo" | "in_progress" | "completed" | "cancelled";
export type Priority = "low" | "medium" | "high" | "urgent";
export type ReminderStatus = "pending" | "fired" | "completed" | "dismissed";

export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Where an item came from. `messageExcerpt` is only filled when the viewer can still read that message. */
export interface SourceReference {
  conversationId: string | null;
  messageId: string | null;
  actionId: string | null;
  messageExcerpt: string | null;
}

export interface PersonRef {
  id: string;
  displayName: string;
}

export interface TaskDTO {
  id: string;
  ownerId: string;
  owner: PersonRef;
  assignee: PersonRef | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  dueAt: Date | null;
  reminderAt: Date | null;
  timezone: string | null;
  source: SourceReference;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface ReminderDTO {
  id: string;
  taskId: string | null;
  title: string;
  notes: string | null;
  remindAt: Date;
  timezone: string | null;
  status: ReminderStatus;
  source: SourceReference;
  firedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CalendarEventDTO {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  timezone: string | null;
  source: SourceReference;
  createdAt: Date;
  updatedAt: Date;
}

export interface SourceInput {
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceActionId?: string;
}

export interface ResolvedSource {
  conversationId: string | null;
  messageId: string | null;
  actionId: string | null;
}

export const EXCERPT_LENGTH = 160;
