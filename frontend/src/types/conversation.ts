import type { PublicProfile } from "./user";

export interface LastMessagePreview {
  id: string;
  body: string | null;
  contentType: string;
  senderId: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  type: "direct" | "group";
  otherParticipant: PublicProfile;
  lastMessage: LastMessagePreview | null;
  unreadCount: number;
  updatedAt: string;
}
