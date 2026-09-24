/**
 * "AI Chat Memory" — with explicit user consent, extracts and stores
 * durable, useful facts from conversations (e.g. "user's birthday is in
 * June"). Users must be able to view, edit, and delete every memory.
 *
 * Implementations MUST check `PrivacySettings.aiMemoryEnabled` (see
 * modules/privacy/privacy.interface.ts) before extracting or storing
 * anything. See docs/ai-roadmap.md and docs/security.md.
 */
export interface AIMemory {
  id: string;
  userId: string;
  sourceConversationId: string | null;
  content: string;
  createdAt: Date;
}

export interface MemoryExtractionService {
  extractFromConversation(conversationId: string, userId: string): Promise<AIMemory[]>;
  listMemories(userId: string): Promise<AIMemory[]>;
  deleteMemory(memoryId: string, userId: string): Promise<void>;
}
