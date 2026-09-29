import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { businessService, notificationService, preferencesService } from "../services/productivityService";
import type { AppNotification, QuickReply, UserPreferences } from "../types/productivity";
import { browserTimezone } from "../utils/datetime";
import { useAuth } from "./AuthContext";
import { useRealtime } from "./RealtimeContext";

interface WorkspaceContextValue {
  preferences: UserPreferences | null;
  updatePreferences(update: Partial<Omit<UserPreferences, "updatedAt">>): Promise<void>;
  /** The zone used to interpret times you type: your saved preference, else this browser's zone. */
  timezone: string;
  focusedConversationIds: string[];
  setFocused(conversationId: string, focused: boolean): Promise<void>;
  notifications: AppNotification[];
  unreadNotifications: number;
  reloadNotifications(): Promise<void>;
  markNotificationRead(id: string): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
  removeNotification(id: string): Promise<void>;
  /** Your business quick replies (empty without a business profile). */
  quickReplies: QuickReply[];
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

/**
 * Per-user Phase 6 state shared across the app shell: preferences
 * (Productivity Mode, timezone), focused conversations, the notification
 * center and quick replies. Kept in sync across devices by realtime events.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [focusedConversationIds, setFocusedIds] = useState<string[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadNotifications, setUnread] = useState(0);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);

  const reloadNotifications = useCallback(async () => {
    if (!accessToken) return;
    try {
      const result = await notificationService.list(accessToken);
      setNotifications(result.notifications);
      setUnread(result.unreadCount);
    } catch {
      // Keep what we have; the bell simply doesn't update.
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    preferencesService.get(accessToken).then(setPreferences, () => undefined);
    preferencesService.focused(accessToken).then(setFocusedIds, () => undefined);
    businessService.quickReplies(accessToken).then(setQuickReplies, () => undefined);
    void reloadNotifications();
  }, [accessToken, reloadNotifications]);

  useEffect(
    () =>
      subscribe((event) => {
        switch (event.type) {
          case "preferences:updated":
            setPreferences(event.preferences);
            break;
          case "focus:updated":
            setFocusedIds(event.conversationIds);
            break;
          case "quick_replies:updated":
            setQuickReplies(event.quickReplies);
            break;
          case "notification:new":
            setNotifications((prev) => [event.notification, ...prev.filter((n) => n.id !== event.notification.id)].slice(0, 100));
            setUnread((count) => count + 1);
            break;
          case "notification:read": {
            const ids = event.notificationIds;
            const now = new Date().toISOString();
            setNotifications((prev) => prev.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)));
            setUnread(event.unreadCount);
            break;
          }
          default:
            break;
        }
      }),
    [subscribe]
  );

  const updatePreferences = useCallback(
    async (update: Partial<Omit<UserPreferences, "updatedAt">>) => {
      if (!accessToken) return;
      setPreferences(await preferencesService.update(accessToken, update));
    },
    [accessToken]
  );

  const setFocused = useCallback(
    async (conversationId: string, focused: boolean) => {
      if (!accessToken) return;
      setFocusedIds(await preferencesService.setFocused(accessToken, conversationId, focused));
    },
    [accessToken]
  );

  const markNotificationRead = useCallback(
    async (id: string) => {
      if (!accessToken) return;
      await notificationService.markRead(accessToken, id);
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)));
    },
    [accessToken]
  );

  const markAllNotificationsRead = useCallback(async () => {
    if (!accessToken) return;
    await notificationService.markAllRead(accessToken);
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setUnread(0);
  }, [accessToken]);

  const removeNotification = useCallback(
    async (id: string) => {
      if (!accessToken) return;
      await notificationService.remove(accessToken, id);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    },
    [accessToken]
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      preferences,
      updatePreferences,
      timezone: preferences?.timezone ?? browserTimezone(),
      focusedConversationIds,
      setFocused,
      notifications,
      unreadNotifications,
      reloadNotifications,
      markNotificationRead,
      markAllNotificationsRead,
      removeNotification,
      quickReplies,
    }),
    [
      preferences,
      updatePreferences,
      focusedConversationIds,
      setFocused,
      notifications,
      unreadNotifications,
      reloadNotifications,
      markNotificationRead,
      markAllNotificationsRead,
      removeNotification,
      quickReplies,
    ]
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Optional, like the AI and call contexts: absent outside the app shell (and in isolated component tests). */
export function useOptionalWorkspace(): WorkspaceContextValue | undefined {
  return useContext(WorkspaceContext);
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within a WorkspaceProvider");
  return ctx;
}
