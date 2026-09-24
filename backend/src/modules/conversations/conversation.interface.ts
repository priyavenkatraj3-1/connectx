export type ConversationType = "direct" | "group";

export interface Conversation {
  id: string;
  type: ConversationType;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Contract for conversation management. Implemented in a later phase once
 * the `conversations` and `conversation_members` tables (docs/database.md)
 * are backed by a real database.
 */
export interface ConversationService {
  createDirectConversation(userIdA: string, userIdB: string): Promise<Conversation>;
  listConversationsForUser(userId: string): Promise<Conversation[]>;
  getConversationById(conversationId: string, requestingUserId: string): Promise<Conversation | null>;
}
