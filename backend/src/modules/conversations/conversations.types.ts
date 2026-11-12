import type { GroupRole } from "../groups/groups.types";
import type { PublicProfile } from "../users/users.types";

export interface LastMessagePreview {
  id: string;
  body: string | null;
  contentType: string;
  senderId: string;
  /** Display name of the sender — shown as "Alice: …" in group previews. */
  senderDisplayName: string;
  createdAt: Date;
}

/** Group-specific fields of a conversation-list entry. */
export interface ConversationGroupSummary {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  memberCount: number;
  myRole: GroupRole;
}

export interface ConversationSummary {
  id: string;
  type: "direct" | "group";
  /** Set for direct conversations; null for groups. */
  otherParticipant: PublicProfile | null;
  /** Set for group conversations; null for direct ones. */
  group: ConversationGroupSummary | null;
  lastMessage: LastMessagePreview | null;
  unreadCount: number;
  updatedAt: Date;
  /** Your own list preferences for this chat (private to you). */
  pinned: boolean;
  archived: boolean;
  /** Muted until this time (in the future), or null when not muted. */
  mutedUntil: Date | null;
}

export interface ChatPreferences {
  pinned: boolean;
  archived: boolean;
  mutedUntil: Date | null;
}

/** How long to mute a chat: 8 hours, a week, until unmuted, or unmute now. */
export type MuteOption = "8h" | "1w" | "always" | "off";

/** An active member's row in conversation_members — what visibility and receipt logic needs. */
export interface ActiveMembership {
  userId: string;
  joinedAt: Date;
}
