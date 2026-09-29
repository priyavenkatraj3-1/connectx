import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useRealtime } from "../../context/RealtimeContext";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";
import { eventService, reminderService } from "../../services/productivityService";
import type { CalendarEvent, Reminder } from "../../types/productivity";
import { browserTimezone, formatDateTime, toLocalInputValue } from "../../utils/datetime";
import { Button } from "../ui/Button";
import { TrashIcon } from "../ui/icons";
import { ItemFormModal } from "./ItemFormModal";
import { ErrorLine, fieldClass, SourceLink } from "./shared";

const STATUS_LABEL: Record<Reminder["status"], string> = { pending: "Upcoming", fired: "Due now", completed: "Done", dismissed: "Dismissed" };

/** Reminders: create, reschedule, complete, dismiss, delete. Firing happens on the server (scheduler) and arrives as a notification. */
export function ReminderPanel() {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const timezone = useOptionalWorkspace()?.timezone ?? browserTimezone();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rescheduling, setRescheduling] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setReminders(await reminderService.list(accessToken, showDone ? undefined : "active"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load reminders");
    }
  }, [accessToken, showDone]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => subscribe((event) => (event.type === "reminder:updated" || event.type === "reminder:deleted" ? void load() : undefined)), [subscribe, load]);

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
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-slate-500">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed & dismissed
        </label>
        <Button variant="secondary" className="py-1.5" onClick={() => setCreating(true)}>
          New reminder
        </Button>
      </div>
      <ErrorLine message={error} />
      {reminders.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No reminders.</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800" aria-label="Reminders">
        {reminders.map((reminder) => (
          <li key={reminder.id} className="py-2.5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{reminder.title}</p>
                <p className={`text-xs ${reminder.status === "fired" ? "font-semibold text-amber-600" : "text-slate-500"}`}>
                  {STATUS_LABEL[reminder.status]} · {formatDateTime(reminder.remindAt, timezone)}
                  {reminder.taskId && " · task reminder"}
                </p>
                {reminder.notes && <p className="text-xs text-slate-500">{reminder.notes}</p>}
                <SourceLink excerpt={reminder.source.messageExcerpt} conversationId={reminder.source.conversationId} />
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
                {(reminder.status === "pending" || reminder.status === "fired") && accessToken && (
                  <>
                    <button type="button" className="text-emerald-600" onClick={() => void run(() => reminderService.setStatus(accessToken, reminder.id, "complete"))}>
                      Done
                    </button>
                    <button type="button" className="text-slate-500" onClick={() => void run(() => reminderService.setStatus(accessToken, reminder.id, "dismiss"))}>
                      Dismiss
                    </button>
                  </>
                )}
                <button type="button" className="text-slate-500" onClick={() => setRescheduling({ id: reminder.id, value: toLocalInputValue(reminder.remindAt, timezone) })}>
                  Reschedule
                </button>
                <button
                  type="button"
                  onClick={() => accessToken && void run(() => reminderService.remove(accessToken, reminder.id))}
                  className="text-slate-400 hover:text-red-600"
                  aria-label={`Delete reminder ${reminder.title}`}
                >
                  <TrashIcon width={15} height={15} />
                </button>
              </div>
            </div>
            {rescheduling?.id === reminder.id && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="datetime-local"
                  value={rescheduling.value}
                  onChange={(e) => setRescheduling({ id: reminder.id, value: e.target.value })}
                  className={fieldClass}
                  aria-label="New reminder time"
                />
                <Button
                  className="py-1.5"
                  disabled={!rescheduling.value}
                  onClick={() =>
                    accessToken &&
                    void run(async () => {
                      await reminderService.update(accessToken, reminder.id, { remindAtLocal: rescheduling.value, timezone });
                      setRescheduling(null);
                    })
                  }
                >
                  Save
                </Button>
                <Button variant="ghost" className="py-1.5" onClick={() => setRescheduling(null)}>
                  Cancel
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {creating && <ItemFormModal kind="reminder" onClose={() => setCreating(false)} onCreated={() => void load()} />}
    </div>
  );
}

/** Upcoming calendar events (private to you) with details and delete. */
export function EventPanel() {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const timezone = useOptionalWorkspace()?.timezone ?? browserTimezone();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      // From the start of today, so today's earlier events stay visible.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      setEvents(await eventService.list(accessToken, { from: startOfToday.toISOString() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load events");
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => subscribe((event) => (event.type.startsWith("calendar_event:") ? void load() : undefined)), [subscribe, load]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="secondary" className="py-1.5" onClick={() => setCreating(true)}>
          New event
        </Button>
      </div>
      <ErrorLine message={error} />
      {events.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No upcoming events.</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800" aria-label="Events">
        {events.map((event) => (
          <li key={event.id} className="py-2.5">
            <button type="button" className="w-full text-left" onClick={() => setOpenId(openId === event.id ? null : event.id)} aria-expanded={openId === event.id}>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{event.title}</p>
              <p className="text-xs text-slate-500">
                {formatDateTime(event.startsAt, timezone)}
                {event.endsAt && ` – ${formatDateTime(event.endsAt, timezone)}`}
                {event.location && ` · ${event.location}`}
              </p>
            </button>
            {openId === event.id && (
              <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
                {event.description && <p className="whitespace-pre-wrap">{event.description}</p>}
                <p>Timezone: {event.timezone ?? timezone}</p>
                <SourceLink excerpt={event.source.messageExcerpt} conversationId={event.source.conversationId} />
                <button
                  type="button"
                  className="font-medium text-red-600"
                  onClick={async () => {
                    if (!accessToken) return;
                    try {
                      await eventService.remove(accessToken, event.id);
                      await load();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Couldn't delete");
                    }
                  }}
                >
                  Delete event
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {creating && <ItemFormModal kind="event" onClose={() => setCreating(false)} onCreated={() => void load()} />}
    </div>
  );
}
