/**
 * "Ask Your Chats" — lets a user ask natural-language questions about their
 * own conversation history (e.g. "What did Ravi say about the deadline?").
 *
 * Implementations MUST only search/read conversations the requesting user
 * is a member of. See docs/security.md and docs/ai-roadmap.md.
 */
export interface ChatAssistantQuery {
  userId: string;
  question: string;
  conversationId?: string; // optional scope to a single conversation
}

export interface ChatAssistantAnswer {
  answer: string;
  citedMessageIds: string[];
}

export interface ChatAssistantService {
  ask(query: ChatAssistantQuery): Promise<ChatAssistantAnswer>;
}
