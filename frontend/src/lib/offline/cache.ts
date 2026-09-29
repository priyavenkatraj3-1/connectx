import type { ConversationSummary } from "../../types/conversation";
import type { MessageDTO } from "../../types/message";
import type { KeyValueStore } from "./storage";

/** Messages kept per conversation, and conversations whose messages are kept. Bounded so localStorage stays small. */
export const CACHED_MESSAGES_PER_CONVERSATION = 50;
export const CACHED_CONVERSATIONS = 20;

interface CachedMessages {
  savedAt: string;
  items: MessageDTO[];
}

/**
 * Read-only snapshot of recent conversations and messages, so the app can
 * show *something* while offline. It is refreshed from the server whenever
 * online and never treated as the source of truth — there is no offline
 * editing or conflict resolution.
 */
export class OfflineCache {
  constructor(private readonly store: KeyValueStore) {}

  async saveConversations(conversations: ConversationSummary[]): Promise<void> {
    await this.store.set("conversations", { savedAt: new Date().toISOString(), items: conversations });
    // Drop cached messages of conversations that fell out of the recent window (or that we left).
    const keep = new Set(conversations.slice(0, CACHED_CONVERSATIONS).map((c) => c.id));
    for (const key of await this.store.keys()) {
      if (key.startsWith("messages.") && !keep.has(key.slice("messages.".length))) await this.store.remove(key);
    }
  }

  async loadConversations(): Promise<{ savedAt: string; items: ConversationSummary[] } | null> {
    return this.store.get("conversations");
  }

  async saveMessages(conversationId: string, messages: MessageDTO[]): Promise<void> {
    // Attachment metadata is kept, but the files themselves are not cached (they need a live, authorized fetch).
    const items = messages.slice(-CACHED_MESSAGES_PER_CONVERSATION);
    await this.store.set<CachedMessages>(`messages.${conversationId}`, { savedAt: new Date().toISOString(), items });
  }

  async loadMessages(conversationId: string): Promise<CachedMessages | null> {
    return this.store.get<CachedMessages>(`messages.${conversationId}`);
  }

  async forgetConversation(conversationId: string): Promise<void> {
    await this.store.remove(`messages.${conversationId}`);
  }
}
