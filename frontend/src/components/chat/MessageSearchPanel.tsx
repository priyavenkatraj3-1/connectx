import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../context/AuthContext";
import { messageService } from "../../services/messageService";
import type { MessageDTO } from "../../types/message";
import { describeMessageContent } from "../../utils/conversationDisplay";
import { formatMessageTime } from "../../utils/formatTime";
import { CloseIcon, SearchIcon } from "../ui/icons";

/** Wait this long after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 300;

interface MessageSearchPanelProps {
  conversationId: string;
  /** IDs of messages currently loaded in the thread (only those can be jumped to). */
  loadedMessageIds: ReadonlySet<string>;
  onJumpToMessage(messageId: string): void;
  onClose(): void;
}

/** Wraps each case-insensitive occurrence of `query` in <mark>. */
export function highlightMatches(text: string, query: string): ReactNode {
  const needle = query.toLowerCase();
  if (!needle) return text;
  const parts: ReactNode[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded bg-amber-200 px-0.5 text-inherit dark:bg-amber-700">
        {text.slice(at, at + needle.length)}
      </mark>
    );
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/** Side panel: search this chat's messages (server-side, members only). */
export function MessageSearchPanel({ conversationId, loadedMessageIds, onJumpToMessage, onClose }: MessageSearchPanelProps) {
  const { accessToken } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageDTO[] | null>(null);
  const [searchedFor, setSearchedFor] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const trimmed = query.trim();
    setError(null);
    if (!trimmed || !accessToken) {
      setResults(null);
      setIsSearching(false);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    const timer = setTimeout(() => {
      messageService
        .search(accessToken, conversationId, trimmed)
        .then((found) => {
          if (cancelled) return;
          setResults(found);
          setSearchedFor(trimmed);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Search failed");
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, accessToken, conversationId]);

  return (
    <aside
      className="flex w-full shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-surface-dark md:w-80"
      aria-label="Search messages"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Search messages</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Close search"
        >
          <CloseIcon width={18} height={18} />
        </button>
      </div>

      <div className="border-b border-slate-200 p-3 dark:border-slate-800">
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 focus-within:border-brand-400 dark:border-slate-700">
          <SearchIcon width={16} height={16} className="shrink-0 text-slate-400" />
          <span className="sr-only">Search this chat</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            maxLength={100}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="Search this chat"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto p-2" aria-live="polite">
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}
        {isSearching && <p className="p-2 text-sm text-slate-400">Searching…</p>}
        {!isSearching && results?.length === 0 && <p className="p-2 text-sm text-slate-500">No messages match “{searchedFor}”.</p>}
        {!isSearching && results && results.length > 0 && (
          <ul className="flex flex-col gap-1">
            {results.map((message) => {
              const canJump = loadedMessageIds.has(message.id);
              const text = describeMessageContent(message.contentType, message.body) || "Message";
              return (
                <li key={message.id}>
                  <button
                    type="button"
                    onClick={() => onJumpToMessage(message.id)}
                    disabled={!canJump}
                    className="w-full rounded-lg px-3 py-2 text-left enabled:hover:bg-slate-100 disabled:cursor-default dark:enabled:hover:bg-slate-800"
                    title={canJump ? "Show in chat" : "Older than the messages loaded in this chat"}
                  >
                    <span className="flex items-baseline justify-between gap-2 text-xs text-slate-400">
                      <span className="truncate font-medium text-slate-600 dark:text-slate-300">{message.sender?.displayName ?? "Unknown"}</span>
                      <span className="shrink-0">{formatMessageTime(message.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-100">
                      {highlightMatches(text, searchedFor)}
                    </span>
                    {!canJump && <span className="mt-0.5 block text-[11px] text-slate-400">Older message — not loaded in this view</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
