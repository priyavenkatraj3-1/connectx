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

export const LIVE_CALL_STATES: readonly CallState[] = ["ringing", "accepted", "connecting", "connected"];

export function isLiveState(state: CallState): boolean {
  return LIVE_CALL_STATES.includes(state);
}

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

export type CallParticipantRole = "initiator" | "invitee";
export type CallParticipantState = "invited" | "ringing" | "joined" | "declined" | "missed" | "left";

export type CallEventType =
  | "created"
  | "ringing"
  | "accepted"
  | "joined"
  | "declined"
  | "cancelled"
  | "connected"
  | "left"
  | "ended"
  | "missed"
  | "failed";

export interface CallParticipantDTO {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: CallParticipantRole;
  state: CallParticipantState;
  joinedAt: Date | null;
  leftAt: Date | null;
  /** Last mic/camera state the participant's client reported (live calls only; null if unknown). */
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
  createdAt: Date;
  answeredAt: Date | null;
  connectedAt: Date | null;
  endedAt: Date | null;
  /** Seconds between media connecting and the call ending; null while live or if media never connected. */
  durationSeconds: number | null;
  participants: CallParticipantDTO[];
}

/** How a finished (or live) call looks from one participant's point of view. */
export type CallOutcome = "ongoing" | "completed" | "missed" | "declined" | "cancelled" | "no_answer" | "failed";

export interface CallHistoryEntryDTO extends CallDTO {
  direction: "incoming" | "outgoing";
  outcome: CallOutcome;
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * Peer-to-peer mesh: every joined participant holds a WebRTC connection to
 * every other one, so upstream bandwidth grows with each participant. Past
 * a handful of people a media server (SFU) is required — see docs.
 */
export const MAX_MESH_PARTICIPANTS = 8;

/** How long an unanswered call rings before it becomes "missed". */
export const DEFAULT_RING_TIMEOUT_MS = 45_000;

/** How long a dropped signaling connection may take to come back before its call participation ends. */
export const DEFAULT_RECONNECT_GRACE_MS = 10_000;
