import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { conversationService } from "../services/conversationService";
import { messageService } from "../services/messageService";
import type { ConversationSummary } from "../types/conversation";
import type { MessageDTO } from "../types/message";
import { useAuth } from "./AuthContext";
import { useRealtime } from "./RealtimeContext";

interface ConversationsContextValue {
  conversations: ConversationSummary[];
  isLoading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  totalUnreadCount: number;
  getConversation(conversationId: string): ConversationSummary | undefined;
  markConversationRead(conversationId: string, upToMessageId: string): Promise<void>;
  /** Drops a conversation locally (e.g. right after leaving a group), without waiting for the server event. */
  removeConversation(conversationId: string): void;
}

const ConversationsContext = createContext<ConversationsContextValue | undefined>(undefined);

function moveToFront(list: ConversationSummary[], id: string, updater: (c: ConversationSummary) => ConversationSummary) {
  const index = list.findIndex((c) => c.id === id);
  if (index === -1) return list;
  const updated = updater(list[index]!);
  const rest = list.filter((c) => c.id !== id);
  return [updated, ...rest];
}

function toPreview(message: MessageDTO): NonNullable<ConversationSummary["lastMessage"]> {
  return {
    id: message.id,
    body: message.body,
    contentType: message.contentType,
    senderId: message.senderId,
    senderDisplayName: message.sender?.displayName,
    createdAt: message.createdAt,
  };
}

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const { accessToken, user } = useAuth();
  const { subscribe } = useRealtime();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    try {
      const list = await conversationService.list(accessToken);
      setConversations(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load conversations");
    } finally {
      setIsLoading(false);
    }
  }, [accessToken]);

  /** Re-fetches without flipping the list into its loading state (for background updates). */
  const refreshQuietly = useCallback(async () => {
    if (!accessToken) return;
    try {
      setConversations(await conversationService.list(accessToken));
    } catch {
      // Keep showing the current list; the next event or manual refresh will retry.
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return subscribe((event) => {
      switch (event.type) {
        case "message:new":
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === event.conversationId);
            if (!exists) {
              // A new conversation we don't know about yet (someone messaged us for the first time) — refetch.
              void refreshQuietly();
              return prev;
            }
            const isIncoming = event.message.senderId !== user?.id;
            return moveToFront(prev, event.conversationId, (conv) => ({
              ...conv,
              lastMessage: toPreview(event.message),
              updatedAt: event.message.createdAt,
              unreadCount: isIncoming ? conv.unreadCount + 1 : conv.unreadCount,
            }));
          });
          break;

        case "message:updated":
          setConversations((prev) =>
            prev.map((c) =>
              c.id === event.conversationId && c.lastMessage?.id === event.message.id
                ? { ...c, lastMessage: toPreview(event.message) }
                : c
            )
          );
          break;

        case "message:deleted":
          // The preview (and possibly unread count) changed — ask the server for the truth.
          void refreshQuietly();
          break;

        case "conversation:added":
          void refreshQuietly();
          break;

        case "conversation:removed":
          setConversations((prev) => prev.filter((c) => c.id !== event.conversationId));
          break;

        case "conversation:unread":
          setConversations((prev) =>
            prev.map((c) => (c.id === event.conversationId ? { ...c, unreadCount: event.unreadCount } : c))
          );
          break;

        case "group:updated":
          setConversations((prev) =>
            prev.map((c) =>
              c.id === event.conversationId && c.group
                ? {
                    ...c,
                    group: {
                      ...c.group,
                      name: event.group.name,
                      description: event.group.description,
                      avatarUrl: event.group.avatarUrl,
                      memberCount: event.group.memberCount,
                    },
                  }
                : c
            )
          );
          break;

        case "group:member_added":
        case "group:member_removed":
        case "group:member_left":
        case "group:role_changed":
          // Member count and/or my role may have changed.
          void refreshQuietly();
          break;

        default:
          break;
      }
    });
  }, [subscribe, refreshQuietly, user?.id]);

  const markConversationRead = useCallback(
    async (conversationId: string, upToMessageId: string) => {
      if (!accessToken) return;
      await messageService.markRead(accessToken, conversationId, upToMessageId);
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)));
    },
    [accessToken]
  );

  const removeConversation = useCallback((conversationId: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
  }, []);

  const getConversation = useCallback(
    (conversationId: string) => conversations.find((c) => c.id === conversationId),
    [conversations]
  );

  const totalUnreadCount = useMemo(() => conversations.reduce((sum, c) => sum + c.unreadCount, 0), [conversations]);

  const value = useMemo<ConversationsContextValue>(
    () => ({
      conversations,
      isLoading,
      error,
      refresh,
      totalUnreadCount,
      getConversation,
      markConversationRead,
      removeConversation,
    }),
    [conversations, isLoading, error, refresh, totalUnreadCount, getConversation, markConversationRead, removeConversation]
  );

  return <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>;
}

export function useConversations(): ConversationsContextValue {
  const ctx = useContext(ConversationsContext);
  if (!ctx) {
    throw new Error("useConversations must be used within a ConversationsProvider");
  }
  return ctx;
}
