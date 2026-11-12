import type { GroupRole } from "./group";
import type { PublicProfile } from "./user";

export interface LastMessagePreview {
  id: string;
  body: string | null;
  contentType: string;
  senderId: string;
  /** Present from Phase 3 on; used for "Alice: …" previews in groups. */
  senderDisplayName?: string;
  createdAt: string;
}

export interface ConversationGroupSummary {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  memberCount: number;
  myRole: GroupRole;
}

/** How long to mute: 8 hours, a week, until unmuted, or unmute now. */
export type MuteOption = "8h" | "1w" | "always" | "off";

export interface ChatPreferences {
  pinned: boolean;
  archived: boolean;
  mutedUntil: string | null;
}

export interface ConversationSummary {
  id: string;
  type: "direct" | "group";
  /** Set for direct conversations; null for groups. */
  otherParticipant: PublicProfile | null;
  /** Set for group conversations; null/absent for direct ones. */
  group?: ConversationGroupSummary | null;
  lastMessage: LastMessagePreview | null;
  unreadCount: number;
  updatedAt: string;
  /** Your own list preferences (optional: absent in chats cached before this existed). */
  pinned?: boolean;
  archived?: boolean;
  /** Muted until this time, or null/absent when not muted. */
  mutedUntil?: string | null;
}
