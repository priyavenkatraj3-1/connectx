import { useState, type FormEvent } from "react";
import { useAuth } from "../../context/AuthContext";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";
import { eventService, reminderService, taskService } from "../../services/productivityService";
import type { CalendarEvent, Priority, Reminder, SourceInput, Task } from "../../types/productivity";
import { browserTimezone, toLocalInputValue } from "../../utils/datetime";
import { Button } from "../ui/Button";
import { ErrorLine, Field, fieldClass, Modal, PRIORITY_LABEL } from "./shared";

export type ItemKind = "task" | "reminder" | "event";

export interface ItemFormInitial {
  title?: string;
  notes?: string;
  /** ISO instant to pre-fill the date field with (e.g. an AI suggestion's due date). */
  at?: string | null;
}

interface ItemFormModalProps {
  kind: ItemKind;
  initial?: ItemFormInitial;
  source?: SourceInput;
  /** People the task can be assigned to (members of the source conversation). */
  assignees?: Array<{ userId: string; displayName: string }>;
  onClose(): void;
  onCreated?(item: { kind: "task"; task: Task } | { kind: "reminder"; reminder: Reminder } | { kind: "event"; event: CalendarEvent }): void;
}

const TITLES: Record<ItemKind, string> = { task: "New task", reminder: "New reminder", event: "New event" };

/**
 * Create a task / reminder / event — from scratch, from a chat message, or
 * from an AI suggestion. Nothing is created until the user presses Create:
 * AI output only ever pre-fills this form. Times are sent as wall-clock
 * values plus the user's timezone and converted on the server.
 */
export function ItemFormModal({ kind, initial, source, assignees = [], onClose, onCreated }: ItemFormModalProps) {
  const { accessToken } = useAuth();
  const workspace = useOptionalWorkspace();
  const timezone = workspace?.timezone ?? browserTimezone();
  const defaultAt = initial?.at ? toLocalInputValue(initial.at, timezone) : "";

  const [title, setTitle] = useState(initial?.title ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [at, setAt] = useState(defaultAt);
  const [endAt, setEndAt] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const [location, setLocation] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsDate = kind !== "task";
  const canSubmit = title.trim().length > 0 && (!needsDate || at !== "") && !saving;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!accessToken || !canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (kind === "task") {
        const task = await taskService.create(accessToken, {
          ...source,
          title: title.trim(),
          description: notes.trim() || null,
          priority,
          dueAtLocal: at || null,
          reminderAtLocal: reminderAt || null,
          timezone,
          assigneeId: assigneeId || null,
        });
        onCreated?.({ kind: "task", task });
      } else if (kind === "reminder") {
        const reminder = await reminderService.create(accessToken, { ...source, title: title.trim(), notes: notes.trim() || null, remindAtLocal: at, timezone });
        onCreated?.({ kind: "reminder", reminder });
      } else {
        const event = await eventService.create(accessToken, {
          ...source,
          title: title.trim(),
          description: notes.trim() || null,
          location: location.trim() || null,
          startsAtLocal: at,
          endsAtLocal: endAt || null,
          timezone,
        });
        onCreated?.({ kind: "event", event });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={TITLES[kind]} onClose={onClose} labelId="item-form-title">
      <form onSubmit={submit} className="flex flex-col gap-3 p-5">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={fieldClass} autoFocus />
        </Field>

        <Field label={kind === "task" ? "Due" : kind === "reminder" ? "Remind me at" : "Starts"} hint={`Times are in ${timezone}`}>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={fieldClass} aria-label={kind === "task" ? "Due" : kind === "reminder" ? "Remind me at" : "Starts"} />
        </Field>

        {kind === "event" && (
          <>
            <Field label="Ends (optional)">
              <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} className={fieldClass} aria-label="Ends" />
            </Field>
            <Field label="Location (optional)">
              <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} className={fieldClass} />
            </Field>
          </>
        )}

        {kind === "task" && (
          <>
            <Field label="Priority">
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={fieldClass}>
                {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Remind me (optional)">
              <input type="datetime-local" value={reminderAt} onChange={(e) => setReminderAt(e.target.value)} className={fieldClass} aria-label="Remind me" />
            </Field>
            {assignees.length > 0 && (
              <Field label="Assign to (optional)">
                <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className={fieldClass}>
                  <option value="">Me</option>
                  {assignees.map((a) => (
                    <option key={a.userId} value={a.userId}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}

        <Field label={kind === "reminder" ? "Notes (optional)" : "Details (optional)"}>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={kind === "reminder" ? 1000 : 2000} className={fieldClass} />
        </Field>

        {source?.sourceMessageId && <p className="text-xs text-slate-400">Linked to the message. The message itself isn’t changed.</p>}
        <ErrorLine message={error} />

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit} isLoading={saving}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
