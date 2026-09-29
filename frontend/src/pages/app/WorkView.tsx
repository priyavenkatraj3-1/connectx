import { useSearchParams } from "react-router-dom";
import { ReminderPanel, EventPanel } from "../../components/productivity/ReminderPanel";
import { SavedMessagesPanel } from "../../components/productivity/SavedMessagesPanel";
import { ScheduledMessagesPanel } from "../../components/productivity/ScheduledMessagesPanel";
import { TaskPanel } from "../../components/productivity/TaskPanel";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";

const TABS = [
  { id: "tasks", label: "Tasks" },
  { id: "reminders", label: "Reminders" },
  { id: "events", label: "Events" },
  { id: "saved", label: "Saved" },
  { id: "scheduled", label: "Scheduled" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** /app/work — your tasks, reminders, events, saved messages and scheduled messages in one place. */
export function WorkView() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : "tasks";
  const workspace = useOptionalWorkspace();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Work</h1>
          <p className="text-xs text-slate-500">Everything here is private to you unless it came from a shared list.</p>
        </div>
        {workspace?.preferences && (
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              role="switch"
              checked={workspace.preferences.productivityMode}
              onChange={(e) => void workspace.updatePreferences({ productivityMode: e.target.checked }).catch(() => undefined)}
              aria-label="Productivity Mode"
            />
            Productivity Mode
          </label>
        )}
      </header>
      <div className="flex gap-1 border-b border-slate-200 px-6 dark:border-slate-800" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams({ tab: t.id })}
            className={`px-3 py-2 text-sm font-medium ${tab === t.id ? "border-b-2 border-brand-600 text-brand-700 dark:text-brand-300" : "text-slate-500 hover:text-slate-800"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-3xl">
          {tab === "tasks" && <TaskPanel />}
          {tab === "reminders" && <ReminderPanel />}
          {tab === "events" && <EventPanel />}
          {tab === "saved" && <SavedMessagesPanel />}
          {tab === "scheduled" && <ScheduledMessagesPanel />}
        </div>
      </div>
    </div>
  );
}
