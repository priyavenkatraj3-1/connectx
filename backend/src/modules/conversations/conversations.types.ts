import type { PublicProfile } from "../users/users.types";

export interface LastMessagePreview {
  id: string;
  body: string | null;
  contentType: string;
  senderId: string;
  createdAt: Date;
}

export interface ConversationSummary {
  id: string;
  type: "direct" | "group";
  otherParticipant: PublicProfile;
  lastMessage: LastMessagePreview | null;
  unreadCount: number;
  updatedAt: Date;
}
