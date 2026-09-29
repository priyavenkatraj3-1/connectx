import { useNavigate } from "react-router-dom";
import { useWorkspace } from "../../context/WorkspaceContext";
import type { AppNotification } from "../../types/productivity";
import { formatTimestamp } from "../../utils/formatTime";
import { Button } from "../ui/Button";
import { CloseIcon } from "../ui/icons";

/** Where clicking a notification takes you. */
function targetOf(notification: AppNotification): string | null {
  const { conversationId, taskId, reminderId, sessionId } = notification.payload;
  if (sessionId) return "/app/settings?section=devices";
  if (taskId && !conversationId) return "/app/work?tab=tasks";
  if (reminderId && !conversationId) return "/app/work?tab=reminders";
  if (conversationId) return `/app/chat/${conversationId}`;
  return null;
}

/**
 * In-app notification center. These are stored server-side and pushed over
 * the WebSocket to open devices; there are no OS/push notifications yet.
 */
export function NotificationCenter({ onClose }: { onClose(): void }) {
  const { notifications, unreadNotifications, markNotificationRead, markAllNotificationsRead, removeNotification } = useWorkspace();
  const navigate = useNavigate();

  return (
    <div
      className="absolute bottom-0 left-full z-40 ml-2 flex max-h-[70vh] w-80 flex-col rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-surface-dark-subtle"
      role="dialog"
      aria-label="Notifications"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Notifications</h2>
        <div className="flex items-center gap-1">
          {unreadNotifications > 0 && (
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => void markAllNotificationsRead().catch(() => undefined)}>
              Mark all read
            </Button>
          )}
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close notifications">
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {notifications.length === 0 && <li className="px-4 py-8 text-center text-sm text-slate-400">You’re all caught up.</li>}
        {notifications.map((notification) => {
          const target = targetOf(notification);
          return (
            <li key={notification.id} className={`group flex gap-2 border-b border-slate-50 px-4 py-2.5 last:border-0 dark:border-slate-800 ${notification.readAt ? "" : "bg-brand-50/60 dark:bg-brand-950/40"}`}>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  if (!notification.readAt) void markNotificationRead(notification.id).catch(() => undefined);
                  if (target) {
                    navigate(target);
                    onClose();
                  }
                }}
              >
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{notification.title}</p>
                {notification.body && <p className="truncate text-xs text-slate-500">{notification.body}</p>}
                <p className="text-[11px] text-slate-400">{formatTimestamp(notification.createdAt)}</p>
              </button>
              <button
                type="button"
                onClick={() => void removeNotification(notification.id).catch(() => undefined)}
                className="h-6 w-6 shrink-0 text-slate-300 opacity-0 hover:text-slate-600 group-hover:opacity-100"
                aria-label="Delete notification"
              >
                <CloseIcon width={14} height={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
