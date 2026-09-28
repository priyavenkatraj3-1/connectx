import type { CallDTO, IceCandidatePayload } from "./call";
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
  // --- Calls (Phase 4) ---
  | { type: "call:invite"; call: CallDTO }
  | { type: "call:ring"; callId: string; userId: string }
  | { type: "call:accept"; call: CallDTO; userId: string }
  | { type: "call:decline"; call: CallDTO; userId: string }
  | { type: "call:cancel"; call: CallDTO }
  | { type: "call:end"; call: CallDTO; userId: string | null }
  | { type: "call:failed"; call: CallDTO; userId: string }
  | { type: "call:participant_left"; call: CallDTO; userId: string }
  | { type: "call:updated"; call: CallDTO }
  | { type: "call:offer"; callId: string; fromUserId: string; sdp: string }
  | { type: "call:answer"; callId: string; fromUserId: string; sdp: string }
  | { type: "call:ice_candidate"; callId: string; fromUserId: string; candidate: IceCandidatePayload }
  | { type: "call:error"; callId: string | null; message: string }
  // --- Status (Phase 4) ---
  | { type: "status:created"; statusId: string; userId: string }
  | { type: "status:deleted"; statusId: string; userId: string }
  | { type: "status:expired"; statusIds: string[]; userId: string }
  | {
      type: "status:viewed";
      statusId: string;
      viewer: { userId: string; displayName: string; avatarUrl: string | null };
      viewedAt: string;
      viewCount: number;
    }
  | { type: "error"; message: string };

/** Server events that belong to a conversation's timeline (have a top-level conversationId). */
export type ConversationServerEvent = Extract<ServerEvent, { conversationId: string }>;

export type CallClientEvent =
  | { type: "call:ring"; callId: string }
  | { type: "call:accept"; callId: string }
  | { type: "call:decline"; callId: string }
  | { type: "call:cancel"; callId: string }
  | { type: "call:end"; callId: string }
  | { type: "call:offer"; callId: string; toUserId: string; sdp: string }
  | { type: "call:answer"; callId: string; toUserId: string; sdp: string }
  | { type: "call:ice_candidate"; callId: string; toUserId: string; candidate: IceCandidatePayload }
  | { type: "call:connected"; callId: string }
  | { type: "call:failed"; callId: string; reason: "connection_failed" | "media_error" }
  | { type: "call:media_state"; callId: string; audioEnabled: boolean; videoEnabled: boolean };

export type ClientEvent =
  | { type: "ping" }
  | { type: "message:read"; conversationId: string; upToMessageId: string }
  | CallClientEvent;
