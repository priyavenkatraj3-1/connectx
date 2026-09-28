import type { CallDTO } from "../modules/calls/calls.types";
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
  // --- Calls (Phase 4) ---
  // Lifecycle events carry the full, current CallDTO so clients never have
  // to reconstruct call state from deltas. They go to every participant of
  // the call (all of each participant's devices).
  /** You are being called (sent to invitees). */
  | { type: "call:invite"; call: CallDTO }
  /** An invitee's device is ringing (sent to the caller / joined participants). */
  | { type: "call:ring"; callId: string; userId: string }
  /** `userId` accepted / joined. If that's you, another of your devices answered — stop ringing here. */
  | { type: "call:accept"; call: CallDTO; userId: string }
  | { type: "call:decline"; call: CallDTO; userId: string }
  | { type: "call:cancel"; call: CallDTO }
  /** The call is over (state "ended" or "missed"). */
  | { type: "call:end"; call: CallDTO; userId: string | null }
  /** A participant's media failed. For direct calls this ends the call (state "failed"). */
  | { type: "call:failed"; call: CallDTO; userId: string }
  /** Group calls: `userId` left; the call continues for the others. */
  | { type: "call:participant_left"; call: CallDTO; userId: string }
  /** Any other state change: media connected, mic/camera toggled, ring timeout for some invitees. */
  | { type: "call:updated"; call: CallDTO }
  // WebRTC signaling relays — delivered only to the one connection (device) that joined the call.
  | { type: "call:offer"; callId: string; fromUserId: string; sdp: string }
  | { type: "call:answer"; callId: string; fromUserId: string; sdp: string }
  | { type: "call:ice_candidate"; callId: string; fromUserId: string; candidate: IceCandidatePayload }
  /** A call-related client event was rejected (malformed, unauthorized, or invalid for the call's state). */
  | { type: "call:error"; callId: string | null; message: string }
  // --- Status (Phase 4) ---
  // Sent only to the owner and to users the status' privacy setting allows.
  /** A new status you're allowed to see was published — refetch the status list. */
  | { type: "status:created"; statusId: string; userId: string }
  | { type: "status:deleted"; statusId: string; userId: string }
  | { type: "status:expired"; statusIds: string[]; userId: string }
  /** Owner only: someone viewed your status. */
  | {
      type: "status:viewed";
      statusId: string;
      viewer: { userId: string; displayName: string; avatarUrl: string | null };
      viewedAt: Date;
      viewCount: number;
    }
  // --- AI (Phase 5) ---
  // Status only, sent solely to the user who made the AI request (all their
  // devices). Never carries prompts, message content or model output.
  | { type: "ai:processing"; requestId: string; feature: string }
  | { type: "ai:completed"; requestId: string; feature: string }
  | { type: "ai:failed"; requestId: string; feature: string; code: string }
  | { type: "error"; message: string };

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** Client → server events accepted over the WebSocket connection. Validated in client-events.ts before use. */
export type ClientEvent =
  | { type: "ping" }
  | { type: "message:read"; conversationId: string; upToMessageId: string }
  | CallClientEvent;

export type CallClientEvent =
  | { type: "call:ring"; callId: string }
  | { type: "call:accept"; callId: string }
  | { type: "call:decline"; callId: string }
  | { type: "call:cancel"; callId: string }
  | { type: "call:end"; callId: string }
  | { type: "call:offer"; callId: string; toUserId: string; sdp: string }
  | { type: "call:answer"; callId: string; toUserId: string; sdp: string }
  | { type: "call:ice_candidate"; callId: string; toUserId: string; candidate: IceCandidatePayload }
  /** The sender's WebRTC connection reached "connected". */
  | { type: "call:connected"; callId: string }
  | { type: "call:failed"; callId: string; reason: "connection_failed" | "media_error" }
  | { type: "call:media_state"; callId: string; audioEnabled: boolean; videoEnabled: boolean };
