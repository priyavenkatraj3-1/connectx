import type { KeyValueStore } from "./storage";

export type OutboxState = "pending" | "sending" | "failed";

/** A text message the user wrote that the server hasn't confirmed yet. */
export interface OutboxItem {
  /** Idempotency key sent to the server on every attempt — the reason retries can't duplicate. */
  clientMessageId: string;
  conversationId: string;
  body: string;
  replyToMessageId?: string;
  mentionedUserIds?: string[];
  createdAt: string;
  state: OutboxState;
  attempts: number;
  /** Why the last attempt failed (shown on "failed" items). */
  error?: string;
}

/** Result of one send attempt, as classified by the caller's send function. */
export type SendOutcome<T> =
  | { kind: "sent"; message: T }
  /** No response (offline / dropped): keep the item pending and try again later. */
  | { kind: "retry"; error: string }
  /** The server refused it (e.g. 403 — you left the group): stop retrying; the user decides. */
  | { kind: "rejected"; error: string };

const STORAGE_KEY = "outbox";
/** After this many transient failures an item is marked failed (the user can still retry it). */
export const MAX_AUTO_ATTEMPTS = 5;

/**
 * Queue of outgoing text messages written while offline (or whose send was
 * interrupted). Guarantees:
 *   - each item is sent with the same clientMessageId every time, and the
 *     server de-duplicates on it, so a retry after an ambiguous failure
 *     never posts twice;
 *   - one item is never in flight twice at once (`inFlight` guard), even if
 *     flush() is triggered concurrently (online event + timer + button);
 *   - items are sent oldest-first per conversation, and a conversation's
 *     queue stops at its first unsent item so ordering is preserved.
 * Only text is queued — attachments need a live upload.
 */
export class Outbox<T = unknown> {
  private items: OutboxItem[] = [];
  private loaded = false;
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<(items: OutboxItem[]) => void>();

  constructor(private readonly store: KeyValueStore) {}

  async load(): Promise<OutboxItem[]> {
    if (!this.loaded) {
      const saved = (await this.store.get<OutboxItem[]>(STORAGE_KEY)) ?? [];
      // Anything left "sending" by a closed tab is pending again (the server de-duplicates if it did arrive).
      this.items = saved.map((item) => (item.state === "sending" ? { ...item, state: "pending" as const } : item));
      this.loaded = true;
    }
    return this.snapshot();
  }

  snapshot(): OutboxItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  forConversation(conversationId: string): OutboxItem[] {
    return this.snapshot().filter((item) => item.conversationId === conversationId);
  }

  subscribe(listener: (items: OutboxItem[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async commit(): Promise<void> {
    await this.store.set(STORAGE_KEY, this.items);
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  async enqueue(item: Omit<OutboxItem, "state" | "attempts" | "createdAt"> & { createdAt?: string }): Promise<OutboxItem> {
    await this.load();
    const existing = this.items.find((i) => i.clientMessageId === item.clientMessageId);
    if (existing) return { ...existing };
    const queued: OutboxItem = { ...item, createdAt: item.createdAt ?? new Date().toISOString(), state: "pending", attempts: 0 };
    this.items.push(queued);
    await this.commit();
    return { ...queued };
  }

  async remove(clientMessageId: string): Promise<void> {
    await this.load();
    this.items = this.items.filter((item) => item.clientMessageId !== clientMessageId);
    await this.commit();
  }

  /** Makes a failed item eligible for sending again. */
  async markPending(clientMessageId: string): Promise<void> {
    await this.load();
    this.items = this.items.map((item) =>
      item.clientMessageId === clientMessageId ? { ...item, state: "pending", attempts: 0, error: undefined } : item
    );
    await this.commit();
  }

  private async patch(clientMessageId: string, changes: Partial<OutboxItem>): Promise<void> {
    this.items = this.items.map((item) => (item.clientMessageId === clientMessageId ? { ...item, ...changes } : item));
    await this.commit();
  }

  /**
   * Tries to send every pending item. `send` performs one attempt and
   * classifies the outcome; `onSent` receives each confirmed message.
   * Returns how many items were sent.
   */
  async flush(send: (item: OutboxItem) => Promise<SendOutcome<T>>, onSent?: (item: OutboxItem, message: T) => void): Promise<number> {
    await this.load();
    let sent = 0;
    const blocked = new Set<string>(); // conversations whose head item didn't go out
    const queue = [...this.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const item of queue) {
      if (item.state !== "pending" || blocked.has(item.conversationId)) {
        if (item.state !== "pending") blocked.add(item.conversationId);
        continue;
      }
      if (this.inFlight.has(item.clientMessageId)) {
        blocked.add(item.conversationId);
        continue;
      }
      this.inFlight.add(item.clientMessageId);
      try {
        await this.patch(item.clientMessageId, { state: "sending", attempts: item.attempts + 1 });
        const outcome = await send(item);
        if (outcome.kind === "sent") {
          this.items = this.items.filter((i) => i.clientMessageId !== item.clientMessageId);
          await this.commit();
          sent += 1;
          onSent?.(item, outcome.message);
        } else if (outcome.kind === "rejected" || item.attempts + 1 >= MAX_AUTO_ATTEMPTS) {
          await this.patch(item.clientMessageId, { state: "failed", error: outcome.error });
          blocked.add(item.conversationId);
        } else {
          await this.patch(item.clientMessageId, { state: "pending", error: outcome.error });
          blocked.add(item.conversationId);
        }
      } finally {
        this.inFlight.delete(item.clientMessageId);
      }
    }
    return sent;
  }
}
