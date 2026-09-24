import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { conversationService } from "../services/conversationService";
import { messageService } from "../services/messageService";
import type { ConversationSummary } from "../types/conversation";
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
}

const ConversationsContext = createContext<ConversationsContextValue | undefined>(undefined);

function moveToFront(list: ConversationSummary[], id: string, updater: (c: ConversationSummary) => ConversationSummary) {
  const index = list.findIndex((c) => c.id === id);
  if (index === -1) return list;
  const updated = updater(list[index]!);
  const rest = list.filter((c) => c.id !== id);
  return [updated, ...rest];
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "message:new") {
        setConversations((prev) => {
          const exists = prev.some((c) => c.id === event.conversationId);
          if (!exists) {
            // A new conversation we don't know about yet (someone messaged us for the first time) — refetch.
            void refresh();
            return prev;
          }
          const isIncoming = event.message.senderId !== user?.id;
          return moveToFront(prev, event.conversationId, (conv) => ({
            ...conv,
            lastMessage: {
              id: event.message.id,
              body: event.message.body,
              contentType: event.message.contentType,
              senderId: event.message.senderId,
              createdAt: event.message.createdAt,
            },
            updatedAt: event.message.createdAt,
            unreadCount: isIncoming ? conv.unreadCount + 1 : conv.unreadCount,
          }));
        });
      }
    });
  }, [subscribe, refresh, user?.id]);

  const markConversationRead = useCallback(
    async (conversationId: string, upToMessageId: string) => {
      if (!accessToken) return;
      await messageService.markRead(accessToken, conversationId, upToMessageId);
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)));
    },
    [accessToken]
  );

  const getConversation = useCallback(
    (conversationId: string) => conversations.find((c) => c.id === conversationId),
    [conversations]
  );

  const totalUnreadCount = useMemo(() => conversations.reduce((sum, c) => sum + c.unreadCount, 0), [conversations]);

  const value = useMemo<ConversationsContextValue>(
    () => ({ conversations, isLoading, error, refresh, totalUnreadCount, getConversation, markConversationRead }),
    [conversations, isLoading, error, refresh, totalUnreadCount, getConversation, markConversationRead]
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
