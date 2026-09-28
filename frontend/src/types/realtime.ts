import type { GroupDTO, GroupRole } from "./group";
import type { MessageDTO, MessageStatus } from "./message";

/** Mirrors backend/src/realtime/events.ts — keep the two in sync. */
export type ServerEvent =
  | { type: "message:new"; conversationId: string; message: MessageDTO }
  | { type: "message:delivered"; conversationId: string; messageId: string; userId: string }
  | { type: "message:read"; conversationId: string; userId: string; upToMessageId: string }
  | { type: "conversation:updated"; conversationId: string }
  | { type: "message:updated"; conversationId: string; message: MessageDTO }
  | { type: "message:deleted"; conversationId: string; messageId: string }
  | { type: "message:status"; conversationId: string; messageIds: string[]; status: MessageStatus }
  | { type: "conversation:added"; conversationId: string }
  | { type: "conversation:removed"; conversationId: string; reason: "removed" | "left" }
  | { type: "conversation:unread"; conversationId: string; unreadCount: number }
  | { type: "group:updated"; conversationId: string; group: Omit<GroupDTO, "myRole"> }
  | { type: "group:member_added"; conversationId: string; groupId: string; userIds: string[]; addedBy: string }
  | { type: "group:member_removed"; conversationId: string; groupId: string; userId: string; removedBy: string }
  | { type: "group:member_left"; conversationId: string; groupId: string; userId: string; newOwnerId: string | null }
  | { type: "group:role_changed"; conversationId: string; groupId: string; userId: string; role: GroupRole; changedBy: string }
  | { type: "error"; message: string };

export type ClientEvent =
  | { type: "ping" }
  | { type: "message:read"; conversationId: string; upToMessageId: string };
