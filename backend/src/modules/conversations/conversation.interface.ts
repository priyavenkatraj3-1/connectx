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
 * Contract for conversation management. Implemented for real in Phase 2
 * (direct conversations only — group conversations remain a later phase,
 * see docs/development-phases.md) by ConversationsService, backed by
 * ConversationsRepository.
 */
export interface ConversationService {
  getOrCreateDirectConversation(userId: string, otherUserId: string): Promise<Conversation>;
  listConversationsForUser(userId: string): Promise<ConversationSummary[]>;
  getConversationById(conversationId: string, requestingUserId: string): Promise<Conversation | null>;
  isMember(conversationId: string, userId: string): Promise<boolean>;
}
