import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { userService } from "../../services/userService";
import type { PublicProfile } from "../../types/user";
import { Avatar } from "../ui/Avatar";
import { CloseIcon, SearchIcon } from "../ui/icons";

interface MemberPickerProps {
  selected: PublicProfile[];
  onChange(selected: PublicProfile[]): void;
  /** Users who can't be picked (e.g. already in the group). */
  excludeIds?: string[];
  autoFocus?: boolean;
}

/** Search people by name/email and build up a multi-selection shown as removable chips. */
export function MemberPicker({ selected, onChange, excludeIds = [], autoFocus }: MemberPickerProps) {
  const { accessToken } = useAuth();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [results, setResults] = useState<PublicProfile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken || !debouncedQuery.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    setError(null);
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

  const selectedIds = new Set(selected.map((p) => p.id));
  const excluded = new Set(excludeIds);
  const visibleResults = results.filter((p) => !excluded.has(p.id));

  function toggle(person: PublicProfile) {
    onChange(selectedIds.has(person.id) ? selected.filter((p) => p.id !== person.id) : [...selected, person]);
  }

  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected people">
          {selected.map((person) => (
            <li
              key={person.id}
              className="flex items-center gap-1 rounded-full bg-brand-50 py-1 pl-2.5 pr-1 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-200"
            >
              {person.displayName}
              <button
                type="button"
                onClick={() => toggle(person)}
                className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-brand-100 dark:hover:bg-brand-900"
                aria-label={`Remove ${person.displayName}`}
              >
                <CloseIcon width={12} height={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="relative block">
        <span className="sr-only">Search people</span>
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          autoFocus={autoFocus}
          type="search"
          placeholder="Search by name or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark"
        />
      </label>

      <div className="max-h-56 overflow-y-auto">
        {error && <p className="p-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!error && isSearching && <p className="p-2 text-sm text-slate-400">Searching…</p>}
        {!error && !isSearching && query.trim() && visibleResults.length === 0 && (
          <p className="p-2 text-sm text-slate-400">No one found matching &ldquo;{query}&rdquo;.</p>
        )}
        {visibleResults.map((person) => {
          const isSelected = selectedIds.has(person.id);
          return (
            <button
              key={person.id}
              type="button"
              role="checkbox"
              aria-checked={isSelected}
              onClick={() => toggle(person)}
              className={`flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors ${
                isSelected ? "bg-brand-50 dark:bg-brand-950" : "hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              <Avatar name={person.displayName} imageUrl={person.avatarUrl ?? undefined} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {person.displayName}
              </span>
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs ${
                  isSelected ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 dark:border-slate-600"
                }`}
                aria-hidden="true"
              >
                {isSelected ? "✓" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
