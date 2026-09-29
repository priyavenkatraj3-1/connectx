import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useConversations } from "../../context/ConversationsContext";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { conversationService } from "../../services/conversationService";
import { userService } from "../../services/userService";
import type { PublicProfile } from "../../types/user";
import { Avatar } from "../ui/Avatar";
import { SearchIcon } from "../ui/icons";

export function NewConversationModal({ onClose }: { onClose: () => void }) {
  const { accessToken } = useAuth();
  const { refresh } = useConversations();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [results, setResults] = useState<PublicProfile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [startingChatWith, setStartingChatWith] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscapeKey(onClose);

  useEffect(() => {
    if (!accessToken || !debouncedQuery.trim()) {
      setResults([]);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    userService
      .search(accessToken, debouncedQuery)
      .then((found) => {
        if (!cancelled) setResults(found);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Search failed");
      })
      .finally(() => {
        if (!cancelled) setIsSearching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, debouncedQuery]);

  async function handleSelect(otherUserId: string) {
    if (!accessToken) return;
    setStartingChatWith(otherUserId);
    setError(null);
    try {
      const conversation = await conversationService.createDirect(accessToken, otherUserId);
      await refresh();
      onClose();
      navigate(`/app/chat/${conversation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start conversation");
      setStartingChatWith(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-20" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-conversation-title"
        className="w-full max-w-md rounded-xl2 bg-white shadow-xl dark:bg-surface-dark-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-100 p-4 dark:border-slate-800">
          <h2 id="new-conversation-title" className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">
            New conversation
          </h2>
          <label className="relative block">
            <span className="sr-only">Search people</span>
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              type="search"
              placeholder="Search by name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark"
            />
          </label>
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {error && <p className="p-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

          {!error && isSearching && <p className="p-3 text-sm text-slate-400">Searching…</p>}

          {!error && !isSearching && query.trim() && results.length === 0 && (
            <p className="p-3 text-sm text-slate-400">No one found matching &ldquo;{query}&rdquo;.</p>
          )}

          {results.map((person) => (
            <button
              key={person.id}
              type="button"
              disabled={startingChatWith !== null}
              onClick={() => void handleSelect(person.id)}
              className="flex w-full items-center gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-slate-100 disabled:opacity-60 dark:hover:bg-slate-800"
            >
              <Avatar name={person.displayName} imageUrl={person.avatarUrl ?? undefined} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {person.displayName}
                </p>
                {person.statusMessage && (
                  <p className="truncate text-xs text-slate-400">{person.statusMessage}</p>
                )}
              </div>
              {startingChatWith === person.id && (
                <span
                  className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
