import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { aiService } from "../../services/aiService";
import type { AIAction, ActionType } from "../../types/ai";
import { ItemFormModal, type ItemKind } from "../productivity/ItemFormModal";
import { Button } from "../ui/Button";
import { AIErrorNotice, toAIError, type AIErrorInfo } from "./AIShared";

const TYPE_LABELS: Record<ActionType, string> = {
  task: "Task",
  reminder: "Reminder",
  deadline: "Deadline",
  event: "Event",
  follow_up: "Follow-up",
  action_item: "Action item",
};

function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function formatDue(action: AIAction): string | null {
  if (action.dueAt) {
    return new Date(action.dueAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  return action.dueText;
}

/**
 * Smart Action Extraction. The AI only *suggests*; each suggestion is
 * confirmed, edited or dismissed by the user. Phase 6: "Add as" opens a
 * pre-filled, editable form — a real task/reminder/event exists only after
 * the user presses Create there, and a suggestion can be used once.
 */
export function ActionsPanel({ conversationId }: { conversationId: string }) {
  const { accessToken } = useAuth();
  const [actions, setActions] = useState<AIAction[]>([]);
  const [error, setError] = useState<AIErrorInfo | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [lastRunFoundNone, setLastRunFoundNone] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [converting, setConverting] = useState<{ action: AIAction; kind: ItemKind } | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const all = await aiService.listActions(accessToken, { conversationId });
      setActions(all.filter((action) => action.status !== "dismissed"));
    } catch (err) {
      setError(toAIError(err));
    }
  }, [accessToken, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function extract() {
    if (!accessToken) return;
    setExtracting(true);
    setError(null);
    setLastRunFoundNone(false);
    try {
      const result = await aiService.extractActions(accessToken, conversationId, { timezone: browserTimezone() });
      setLastRunFoundNone(result.actions.length === 0);
      setActions((prev) => [...result.actions, ...prev.filter((a) => !result.actions.some((n) => n.id === a.id))]);
    } catch (err) {
      setError(toAIError(err));
    } finally {
      setExtracting(false);
    }
  }

  async function apply(action: AIAction, operation: "confirm" | "dismiss" | "save") {
    if (!accessToken) return;
    setError(null);
    try {
      const updated =
        operation === "confirm"
          ? await aiService.confirmAction(accessToken, action.id)
          : operation === "dismiss"
            ? await aiService.dismissAction(accessToken, action.id)
            : await aiService.updateAction(accessToken, action.id, { title: draftTitle.trim() });
      setActions((prev) =>
        updated.status === "dismissed" ? prev.filter((a) => a.id !== updated.id) : prev.map((a) => (a.id === updated.id ? updated : a))
      );
      setEditingId(null);
    } catch (err) {
      setError(toAIError(err));
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Finds possible tasks, reminders and deadlines in recent messages. Nothing is created or scheduled unless you add it.
      </p>
      <Button onClick={() => void extract()} isLoading={extracting} variant="secondary" className="w-full py-1.5">
        Find actions in this chat
      </Button>
      {error && <AIErrorNotice error={error} />}
      {lastRunFoundNone && <p className="text-sm text-slate-400">No new actions found.</p>}

      <ul className="space-y-2" aria-label="Suggested actions">
        {actions.map((action) => (
          <li key={action.id} className="rounded-lg border border-slate-200 p-2.5 text-sm dark:border-slate-700">
            <div className="flex items-center gap-2">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {TYPE_LABELS[action.type]}
              </span>
              {action.status === "confirmed" ? (
                <span className="text-[11px] font-semibold text-emerald-600">Confirmed</span>
              ) : (
                <span className="text-[11px] text-slate-400">Suggested{action.confidence ? ` · ${action.confidence} confidence` : ""}</span>
              )}
            </div>
            {editingId === action.id ? (
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                maxLength={200}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm dark:border-slate-700 dark:bg-surface-dark-subtle"
                aria-label="Action title"
              />
            ) : (
              <p className="mt-1 font-medium text-slate-800 dark:text-slate-100">{action.title}</p>
            )}
            {formatDue(action) && <p className="text-xs text-slate-500">Due: {formatDue(action)}</p>}
            {action.participants.length > 0 && <p className="text-xs text-slate-500">With: {action.participants.join(", ")}</p>}
            {action.explanation && <p className="mt-1 text-xs italic text-slate-400">{action.explanation}</p>}
            <div className="mt-2 flex gap-2 text-xs font-medium">
              {editingId === action.id ? (
                <>
                  <button type="button" onClick={() => void apply(action, "save")} disabled={!draftTitle.trim()} className="text-brand-600">
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} className="text-slate-500">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {action.status === "suggested" && (
                    <button type="button" onClick={() => void apply(action, "confirm")} className="text-emerald-600">
                      Confirm
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(action.id);
                      setDraftTitle(action.title);
                    }}
                    className="text-slate-600 dark:text-slate-300"
                  >
                    Edit
                  </button>
                  <button type="button" onClick={() => void apply(action, "dismiss")} className="text-slate-400 hover:text-red-600">
                    Dismiss
                  </button>
                </>
              )}
            </div>
            {action.convertedTo ? (
              <p className="mt-1.5 text-[11px] font-semibold text-emerald-600">Added as {action.convertedTo}</p>
            ) : (
              editingId !== action.id && (
                <div className="mt-1.5 flex items-center gap-2 text-[11px]" aria-label="Add as">
                  <span className="text-slate-400">Add as:</span>
                  {(["task", "reminder", "event"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setConverting({ action, kind })}
                      className="rounded border border-slate-200 px-1.5 py-0.5 font-medium text-slate-600 hover:border-brand-400 hover:text-brand-600 dark:border-slate-700 dark:text-slate-300"
                    >
                      {kind[0]!.toUpperCase() + kind.slice(1)}
                    </button>
                  ))}
                </div>
              )
            )}
          </li>
        ))}
      </ul>
      {converting && (
        <ItemFormModal
          kind={converting.kind}
          initial={{ title: converting.action.title, notes: converting.action.notes ?? "", at: converting.action.dueAt }}
          source={{ sourceActionId: converting.action.id }}
          onClose={() => setConverting(null)}
          onCreated={() => void load()}
        />
      )}
      {actions.length > 0 && (
        <p className="text-[11px] text-slate-400">Suggestions are AI-generated and may be inaccurate. Check dates before relying on them.</p>
      )}
    </div>
  );
}
