import type { ConversationSummary } from "./conversations.types";

export type ConversationType = "direct" | "group";

export interface Conversation {
  id: string;
  type: ConversationType;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Contract for conversation management, implemented by ConversationsService.
 * Direct conversations are created here; group conversations are created
 * through GroupsService (Phase 3) and then listed/read through this same
 * service. Backed by ConversationsRepository.
 */
export interface ConversationService {
  getOrCreateDirectConversation(userId: string, otherUserId: string): Promise<Conversation>;
  listConversationsForUser(userId: string): Promise<ConversationSummary[]>;
  getConversationById(conversationId: string, requestingUserId: string): Promise<Conversation | null>;
  isMember(conversationId: string, userId: string): Promise<boolean>;
}
