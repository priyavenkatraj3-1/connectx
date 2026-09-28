/** Mirrors backend/src/modules/calls/calls.types.ts. */
export type CallMedia = "voice" | "video";
export type CallScope = "direct" | "group";
export type CallState =
  | "ringing"
  | "accepted"
  | "connecting"
  | "connected"
  | "declined"
  | "missed"
  | "ended"
  | "failed"
  | "cancelled";
export type CallEndReason =
  | "hangup"
  | "declined"
  | "no_answer"
  | "cancelled"
  | "connection_failed"
  | "media_error"
  | "disconnected"
  | "all_left"
  | "server_restart";
export type CallParticipantState = "invited" | "ringing" | "joined" | "declined" | "missed" | "left";

export interface CallParticipantDTO {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: "initiator" | "invitee";
  state: CallParticipantState;
  joinedAt: string | null;
  leftAt: string | null;
  audioEnabled: boolean | null;
  videoEnabled: boolean | null;
}

export interface CallDTO {
  id: string;
  conversationId: string;
  scope: CallScope;
  media: CallMedia;
  state: CallState;
  endReason: CallEndReason | null;
  initiatorId: string;
  createdAt: string;
  answeredAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  participants: CallParticipantDTO[];
}

export type CallOutcome = "ongoing" | "completed" | "missed" | "declined" | "cancelled" | "no_answer" | "failed";

export interface CallHistoryEntryDTO extends CallDTO {
  direction: "incoming" | "outgoing";
  outcome: CallOutcome;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export const LIVE_CALL_STATES: readonly CallState[] = ["ringing", "accepted", "connecting", "connected"];

export function isLiveCall(call: Pick<CallDTO, "state">): boolean {
  return LIVE_CALL_STATES.includes(call.state);
}
