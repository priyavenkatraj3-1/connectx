import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isNetworkError } from "../services/apiClient";
import { conversationService } from "../services/conversationService";
import { useOptionalOffline } from "./OfflineContext";
import { messageService } from "../services/messageService";
import type { ConversationSummary, MuteOption } from "../types/conversation";
import { isMuted } from "../utils/chatPreferences";
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
  /** True while showing the list saved on this device because the server is unreachable (Phase 6). */
  isShowingCached: boolean;
  /** Changes your pin/archive/mute settings for a chat; throws the server's error (e.g. too many pins). */
  updatePreferences(conversationId: string, changes: { pinned?: boolean; archived?: boolean; mute?: MuteOption }): Promise<void>;
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
  const { subscribe, onReconnect } = useRealtime();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const offline = useOptionalOffline();
  const cache = offline?.cache ?? null;
  const [isShowingCached, setIsShowingCached] = useState(false);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    try {
      const list = await conversationService.list(accessToken);
      setConversations(list);
      setIsShowingCached(false);
      void cache?.saveConversations(list);
    } catch (err) {
      // Offline (Phase 6): fall back to the list saved on this device, if any.
      const cached = isNetworkError(err) ? await cache?.loadConversations() : null;
      if (cached) {
        setConversations(cached.items);
        setIsShowingCached(true);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load conversations");
      }
    } finally {
      setIsLoading(false);
    }
  }, [accessToken, cache]);

  /** Re-fetches without flipping the list into its loading state (for background updates). */
  const refreshQuietly = useCallback(async () => {
    if (!accessToken) return;
    try {
      const list = await conversationService.list(accessToken);
      setConversations(list);
      setIsShowingCached(false);
      void cache?.saveConversations(list);
    } catch {
      // Keep showing the current list; the next event or manual refresh will retry.
    }
  }, [accessToken, cache]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Events missed while the socket was down (new chats, previews, unread counts) aren't replayed.
  useEffect(() => onReconnect?.(() => void refreshQuietly()), [onReconnect, refreshQuietly]);

  // Back online after showing a cached list: fetch the real one.
  const isOnline = offline?.isOnline ?? true;
  useEffect(() => {
    if (isOnline && isShowingCached) void refreshQuietly();
  }, [isOnline, isShowingCached, refreshQuietly]);

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

        case "user:updated":
          // New name/picture for someone you chat with: update their direct chats in place.
          setConversations((prev) =>
            prev.map((c) => (c.otherParticipant?.id === event.user.id ? { ...c, otherParticipant: { ...c.otherParticipant, ...event.user } } : c))
          );
          break;
        case "conversation:preferences":
          setConversations((prev) =>
            prev.map((c) =>
              c.id === event.conversationId ? { ...c, pinned: event.pinned, archived: event.archived, mutedUntil: event.mutedUntil } : c
            )
          );
          break;
        case "conversation:added":
          void refreshQuietly();
          break;

        case "conversation:removed":
          setConversations((prev) => prev.filter((c) => c.id !== event.conversationId));
          // No longer a member: don't keep its messages on this device.
          void cache?.forgetConversation(event.conversationId);
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
  }, [subscribe, refreshQuietly, user?.id, cache]);

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

  // Muted and archived chats keep their own unread badge but don't add to the total.
  const totalUnreadCount = useMemo(
    () => conversations.reduce((sum, c) => (c.archived || isMuted(c) ? sum : sum + c.unreadCount), 0),
    [conversations]
  );

  const updatePreferences = useCallback(
    async (conversationId: string, changes: { pinned?: boolean; archived?: boolean; mute?: MuteOption }) => {
      if (!accessToken) return;
      const preferences = await conversationService.updatePreferences(accessToken, conversationId, changes);
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, ...preferences } : c)));
    },
    [accessToken]
  );

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
      isShowingCached,
      updatePreferences,
    }),
    [conversations, isLoading, error, refresh, totalUnreadCount, getConversation, markConversationRead, removeConversation, isShowingCached, updatePreferences]
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
