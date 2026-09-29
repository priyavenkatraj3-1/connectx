import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useConversations } from "../../context/ConversationsContext";
import { useRealtime } from "../../context/RealtimeContext";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";
import { scheduledMessageService } from "../../services/productivityService";
import type { ScheduledMessage } from "../../types/productivity";
import { getConversationTitle } from "../../utils/conversationDisplay";
import { browserTimezone, formatDateTime, toLocalInputValue } from "../../utils/datetime";
import { Button } from "../ui/Button";
import { ErrorLine, fieldClass } from "./shared";

const STATUS_CLASS: Record<ScheduledMessage["status"], string> = {
  scheduled: "text-brand-600",
  sending: "text-brand-600",
  sent: "text-emerald-600",
  failed: "text-red-600",
  cancelled: "text-slate-400",
};

/** Messages you scheduled: edit or cancel while waiting; see sent/failed outcomes. Only you can see these. */
export function ScheduledMessagesPanel({ conversationId }: { conversationId?: string }) {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const { getConversation } = useConversations();
  const timezone = useOptionalWorkspace()?.timezone ?? browserTimezone();
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const [editing, setEditing] = useState<{ id: string; body: string; at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setItems(await scheduledMessageService.list(accessToken, { conversationId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load scheduled messages");
    }
  }, [accessToken, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => subscribe((event) => (event.type.startsWith("scheduled_message:") ? void load() : undefined)), [subscribe, load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="space-y-2">
      <ErrorLine message={error} />
      {items.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No scheduled messages.</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800" aria-label="Scheduled messages">
        {items.map((item) => {
          const conversation = getConversation(item.conversationId);
          return (
            <li key={item.id} className="py-2.5 text-sm">
              {!conversationId && (
                <Link to={`/app/chat/${item.conversationId}`} className="text-xs font-medium text-brand-600 hover:underline">
                  {conversation ? getConversationTitle(conversation) : "Conversation"}
                </Link>
              )}
              {editing?.id === item.id ? (
                <div className="mt-1 space-y-2">
                  <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={2} maxLength={4000} className={fieldClass} aria-label="Scheduled message text" />
                  <input type="datetime-local" value={editing.at} onChange={(e) => setEditing({ ...editing, at: e.target.value })} className={fieldClass} aria-label="Send at" />
                  <div className="flex gap-2">
                    <Button
                      className="py-1.5"
                      disabled={!editing.body.trim() || !editing.at}
                      onClick={() =>
                        accessToken &&
                        void run(async () => {
                          await scheduledMessageService.update(accessToken, item.id, { body: editing.body.trim(), scheduledForLocal: editing.at, timezone });
                          setEditing(null);
                        })
                      }
                    >
                      Save
                    </Button>
                    <Button variant="ghost" className="py-1.5" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-slate-900 dark:text-slate-100">{item.body}</p>
                  <p className="text-xs text-slate-500">
                    <span className={`font-medium ${STATUS_CLASS[item.status]}`}>{item.status === "scheduled" ? "Scheduled" : item.status[0]!.toUpperCase() + item.status.slice(1)}</span>
                    {" · "}
                    {item.status === "sent" && item.sentAt ? `sent ${formatDateTime(item.sentAt, timezone)}` : formatDateTime(item.scheduledFor, timezone)}
                    {item.failureReason && ` · ${item.failureReason}`}
                  </p>
                  <div className="mt-1 flex gap-3 text-xs font-medium">
                    {item.status === "scheduled" && accessToken && (
                      <>
                        <button type="button" className="text-slate-600 dark:text-slate-300" onClick={() => setEditing({ id: item.id, body: item.body, at: toLocalInputValue(item.scheduledFor, timezone) })}>
                          Edit
                        </button>
                        <button type="button" className="text-red-600" onClick={() => void run(() => scheduledMessageService.cancel(accessToken, item.id))}>
                          Cancel sending
                        </button>
                      </>
                    )}
                    {(item.status === "sent" || item.status === "failed" || item.status === "cancelled") && accessToken && (
                      <button type="button" className="text-slate-400" onClick={() => void run(() => scheduledMessageService.remove(accessToken, item.id))}>
                        Remove from list
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
