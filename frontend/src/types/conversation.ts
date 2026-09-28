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
}
