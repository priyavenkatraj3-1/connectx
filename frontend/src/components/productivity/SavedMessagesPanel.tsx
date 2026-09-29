import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useRealtime } from "../../context/RealtimeContext";
import { savedService } from "../../services/productivityService";
import type { SavedMessage } from "../../types/productivity";
import { describeMessageContent } from "../../utils/conversationDisplay";
import { formatDateTime } from "../../utils/datetime";
import { StarIcon, TrashIcon } from "../ui/icons";
import { ErrorLine, fieldClass } from "./shared";

/** Your saved (bookmarked) messages: search, filter by label / starred, re-label, remove. Private to you. */
export function SavedMessagesPanel() {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const [saved, setSaved] = useState<SavedMessage[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debouncedQuery = useDebouncedValue(query, 250);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [items, allLabels] = await Promise.all([
        savedService.list(accessToken, { q: debouncedQuery.trim() || undefined, label: label || undefined, starred: starredOnly ? true : undefined }),
        savedService.labels(accessToken),
      ]);
      setSaved(items);
      setLabels(allLabels);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load saved messages");
    }
  }, [accessToken, debouncedQuery, label, starredOnly]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => subscribe((event) => (event.type === "saved:updated" || event.type === "message:deleted" ? void load() : undefined)), [subscribe, load]);

  async function update(messageId: string, change: { label?: string | null; starred?: boolean }) {
    if (!accessToken) return;
    try {
      await savedService.save(accessToken, messageId, change);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search saved messages" className={`${fieldClass} flex-1 py-1.5`} aria-label="Search saved messages" />
        <select value={label} onChange={(e) => setLabel(e.target.value)} className={`${fieldClass} w-auto py-1.5`} aria-label="Filter by label">
          <option value="">All labels</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-slate-500">
          <input type="checkbox" checked={starredOnly} onChange={(e) => setStarredOnly(e.target.checked)} /> Starred
        </label>
      </div>
      <ErrorLine message={error} />
      {saved.length === 0 && <p className="py-6 text-center text-sm text-slate-400">Nothing saved yet. Use a message’s menu to save it.</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800" aria-label="Saved messages">
        {saved.map((item) => (
          <li key={item.messageId} className="flex items-start gap-2 py-2.5">
            <button
              type="button"
              onClick={() => void update(item.messageId, { starred: !item.starred })}
              className={item.starred ? "text-amber-500" : "text-slate-300 hover:text-amber-500"}
              aria-label={item.starred ? "Unstar" : "Star"}
              aria-pressed={item.starred}
            >
              <StarIcon width={16} height={16} fill={item.starred ? "currentColor" : "none"} />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-500">
                {item.message.senderDisplayName} in <span className="font-medium">{item.conversationTitle}</span> · {formatDateTime(item.message.createdAt)}
              </p>
              <Link to={`/app/chat/${item.conversationId}`} className="block truncate text-sm text-slate-900 hover:underline dark:text-slate-100">
                {describeMessageContent(item.message.contentType, item.message.body) || "Message"}
              </Link>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <input
                  defaultValue={item.label ?? ""}
                  placeholder="Add label"
                  maxLength={40}
                  onBlur={(e) => {
                    const next = e.target.value.trim() || null;
                    if (next !== item.label) void update(item.messageId, { label: next });
                  }}
                  className="w-28 rounded border border-transparent bg-slate-100 px-1.5 py-0.5 hover:border-slate-200 dark:bg-slate-800"
                  aria-label="Label"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                if (!accessToken) return;
                await savedService.unsave(accessToken, item.messageId).catch(() => undefined);
                await load();
              }}
              className="text-slate-400 hover:text-red-600"
              aria-label="Remove from saved"
            >
              <TrashIcon width={15} height={15} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
