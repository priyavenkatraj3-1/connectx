/**
 * Semantic/natural-language search over a user's own message history.
 * Distinct from ChatAssistantService: search returns ranked message
 * matches, while the assistant returns a synthesized natural-language
 * answer (which may internally call search).
 */
export interface ChatSearchQuery {
  userId: string;
  queryText: string;
  limit?: number;
}

export interface ChatSearchResult {
  messageId: string;
  conversationId: string;
  snippet: string;
  relevanceScore: number;
}

export interface ChatSearchService {
  search(query: ChatSearchQuery): Promise<ChatSearchResult[]>;
}
