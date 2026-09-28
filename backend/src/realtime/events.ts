import type { GroupDTO, GroupRole } from "../modules/groups/groups.types";
import type { MessageDTO, MessageStatus } from "../modules/messages/messages.types";

/**
 * Server → client realtime events. Every event is a discriminated union on
 * `type` so the frontend can narrow payloads without casting. Mirrored in
 * frontend/src/types/realtime.ts — keep the two in sync.
 *
 * Every event is only ever sent to users who are authorized to see it:
 * active members of the conversation, plus (for removals/leaves) the user
 * who was just removed, so their client can drop the conversation.
 */
export type ServerEvent =
  // --- Messages (Phase 2) ---
  | { type: "message:new"; conversationId: string; message: MessageDTO }
  /** Direct conversations: the one recipient received the message. */
  | { type: "message:delivered"; conversationId: string; messageId: string; userId: string }
  /** Direct conversations: the one recipient read everything up to `upToMessageId`. */
  | { type: "message:read"; conversationId: string; userId: string; upToMessageId: string }
  | { type: "conversation:updated"; conversationId: string }
  // --- Messages (Phase 3) ---
  | { type: "message:updated"; conversationId: string; message: MessageDTO }
  | { type: "message:deleted"; conversationId: string; messageId: string }
  /** Group conversations: the aggregate status of the sender's messages changed (all recipients delivered/read). */
  | { type: "message:status"; conversationId: string; messageIds: string[]; status: MessageStatus }
  // --- Conversation list (Phase 3) ---
  /** You were added to a conversation (e.g. a new group) — fetch the conversation list. */
  | { type: "conversation:added"; conversationId: string }
  /** You are no longer a member (removed, or you left from another device). */
  | { type: "conversation:removed"; conversationId: string; reason: "removed" | "left" }
  /** Your unread count for a conversation changed (e.g. you read it on another device). */
  | { type: "conversation:unread"; conversationId: string; unreadCount: number }
  // --- Groups (Phase 3) ---
  | { type: "group:updated"; conversationId: string; group: Omit<GroupDTO, "myRole"> }
  | { type: "group:member_added"; conversationId: string; groupId: string; userIds: string[]; addedBy: string }
  | { type: "group:member_removed"; conversationId: string; groupId: string; userId: string; removedBy: string }
  | { type: "group:member_left"; conversationId: string; groupId: string; userId: string; newOwnerId: string | null }
  | { type: "group:role_changed"; conversationId: string; groupId: string; userId: string; role: GroupRole; changedBy: string }
  | { type: "error"; message: string };

/** Client → server events accepted over the WebSocket connection. */
export type ClientEvent =
  | { type: "ping" }
  | { type: "message:read"; conversationId: string; upToMessageId: string };
