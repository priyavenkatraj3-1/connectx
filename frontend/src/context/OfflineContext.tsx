import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { OfflineCache } from "../lib/offline/cache";
import { Outbox, type OutboxItem, type SendOutcome } from "../lib/offline/outbox";
import { storeForUser, type KeyValueStore } from "../lib/offline/storage";
import { ApiError, generateUuid, isNetworkError } from "../services/apiClient";
import { messageService } from "../services/messageService";
import type { MessageDTO } from "../types/message";
import { useAuth } from "./AuthContext";

export interface QueueMessageInput {
  conversationId: string;
  body: string;
  replyToMessageId?: string;
  mentionedUserIds?: string[];
  /** Reuse the key of an attempt that already failed mid-flight, so the server can de-duplicate. */
  clientMessageId?: string;
}

interface OfflineContextValue {
  isOnline: boolean;
  /** Every not-yet-confirmed outgoing message, in all conversations. */
  outbox: OutboxItem[];
  /** Queues a text message and tries to send it right away (if online). */
  queueMessage(input: QueueMessageInput): Promise<void>;
  retry(clientMessageId: string): Promise<void>;
  discard(clientMessageId: string): Promise<void>;
  /** Called whenever a queued message is confirmed by the server. */
  subscribeSent(listener: (item: OutboxItem, message: MessageDTO) => void): () => void;
  /** Read-only snapshot of recent chats for offline viewing (null until signed in). */
  cache: OfflineCache | null;
}

const OfflineContext = createContext<OfflineContextValue | undefined>(undefined);

const RETRY_INTERVAL_MS = 30_000;

function initialOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Classifies one send attempt for the outbox. */
export function classifySendError(err: unknown): SendOutcome<never> {
  if (isNetworkError(err)) return { kind: "retry", error: "Waiting for connection" };
  if (err instanceof ApiError && (err.status >= 500 || err.status === 429 || err.status === 401)) {
    return { kind: "retry", error: err.message };
  }
  return { kind: "rejected", error: err instanceof Error ? err.message : "Couldn't send" };
}

/**
 * Offline foundation (Phase 6): online/offline detection, the outgoing
 * message queue, and the recent-chats cache — all scoped to the signed-in
 * user (see lib/offline/storage.ts). This is *not* full offline sync:
 * only text messages can be queued, the cache is read-only, and anything
 * else (edits, uploads, tasks…) needs a connection.
 */
export function OfflineProvider({ children, store }: { children: ReactNode; store?: KeyValueStore }) {
  const { accessToken, user } = useAuth();
  const [isOnline, setIsOnline] = useState(initialOnline);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const sentListeners = useRef(new Set<(item: OutboxItem, message: MessageDTO) => void>());

  const userStore = useMemo(() => (user ? (store ?? storeForUser(user.id)) : null), [user, store]);
  const outbox = useMemo(() => (userStore ? new Outbox<MessageDTO>(userStore) : null), [userStore]);
  const cache = useMemo(() => (userStore ? new OfflineCache(userStore) : null), [userStore]);

  useEffect(() => {
    if (!outbox) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void outbox.load().then((loaded) => {
      if (!cancelled) setItems(loaded);
    });
    const unsubscribe = outbox.subscribe(setItems);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [outbox]);

  /** Sends pending items. Automatic flushes skip while the browser reports offline; an explicit retry (`force`) always tries. */
  const flush = useCallback(async (force = false) => {
    if (!outbox || !accessToken) return;
    if (!force && !initialOnline()) return;
    await outbox.flush(
      async (item) => {
        try {
          const message = await messageService.send(accessToken, item.conversationId, item.body, {
            clientMessageId: item.clientMessageId,
            replyToMessageId: item.replyToMessageId,
            mentionedUserIds: item.mentionedUserIds,
          });
          return { kind: "sent", message };
        } catch (err) {
          if (isNetworkError(err)) setIsOnline(false);
          return classifySendError(err);
        }
      },
      (item, message) => {
        setIsOnline(true);
        for (const listener of sentListeners.current) listener(item, message);
      }
    );
  }, [outbox, accessToken]);

  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      void flush();
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [flush]);

  // Retry pending items on load and periodically while any are waiting.
  const hasPending = items.some((item) => item.state === "pending");
  useEffect(() => {
    if (!hasPending) return;
    void flush();
    const timer = setInterval(() => void flush(), RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasPending, flush]);

  const queueMessage = useCallback(
    async (input: QueueMessageInput) => {
      if (!outbox) return;
      await outbox.enqueue({ ...input, clientMessageId: input.clientMessageId ?? generateUuid() });
      await flush();
    },
    [outbox, flush]
  );

  const retry = useCallback(
    async (clientMessageId: string) => {
      if (!outbox) return;
      await outbox.markPending(clientMessageId);
      await flush(true);
    },
    [outbox, flush]
  );

  const discard = useCallback(async (clientMessageId: string) => outbox?.remove(clientMessageId), [outbox]);

  const subscribeSent = useCallback((listener: (item: OutboxItem, message: MessageDTO) => void) => {
    sentListeners.current.add(listener);
    return () => sentListeners.current.delete(listener);
  }, []);

  const value = useMemo<OfflineContextValue>(
    () => ({ isOnline, outbox: items, queueMessage, retry, discard, subscribeSent, cache }),
    [isOnline, items, queueMessage, retry, discard, subscribeSent, cache]
  );
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

/** Offline features are optional: components render normally outside an OfflineProvider (e.g. in isolated tests). */
export function useOptionalOffline(): OfflineContextValue | undefined {
  return useContext(OfflineContext);
}
