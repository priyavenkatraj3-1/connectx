import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../../components/common/EmptyState";
import { ErrorState } from "../../components/common/ErrorState";
import { LoadingState } from "../../components/common/LoadingState";
import { CreateStatusModal } from "../../components/status/CreateStatusModal";
import { StatusPrivacyModal } from "../../components/status/StatusPrivacyModal";
import { formatStatusAge, isExpired } from "../../components/status/statusStyles";
import { StatusViewer } from "../../components/status/StatusViewer";
import { Avatar } from "../../components/ui/Avatar";
import { LockIcon, PlusIcon, StatusIcon } from "../../components/ui/icons";
import { useAuth } from "../../context/AuthContext";
import { useRealtime } from "../../context/RealtimeContext";
import { statusService } from "../../services/statusService";
import type { StatusFeedEntry, StatusListResponse } from "../../types/status";

/** How often to re-check expiry locally. The server is the authority; this just hides what it would no longer return. */
const EXPIRY_CHECK_MS = 30_000;

type OpenViewer = { kind: "mine" } | { kind: "user"; userId: string };

function withoutExpired(data: StatusListResponse, now = Date.now()): StatusListResponse {
  return {
    mine: data.mine.filter((s) => !isExpired(s.expiresAt, now)),
    feed: data.feed
      .map((entry) => ({ ...entry, statuses: entry.statuses.filter((s) => !isExpired(s.expiresAt, now)) }))
      .filter((entry) => entry.statuses.length > 0),
  };
}

function StatusRing({ name, avatarUrl, seen, count }: { name: string; avatarUrl: string | null; seen: boolean; count: number }) {
  return (
    <span
      className={`rounded-full p-0.5 ${seen ? "bg-slate-300 dark:bg-slate-600" : "bg-gradient-to-br from-brand-500 to-accent-500"}`}
      aria-label={`${count} ${count === 1 ? "update" : "updates"}${seen ? "" : ", unseen"}`}
    >
      <span className="block rounded-full bg-white p-0.5 dark:bg-surface-dark">
        <Avatar name={name} imageUrl={avatarUrl ?? undefined} size="md" />
      </span>
    </span>
  );
}

export function StatusView() {
  const { accessToken, user } = useAuth();
  const { subscribe } = useRealtime();
  const [data, setData] = useState<StatusListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditingPrivacy, setIsEditingPrivacy] = useState(false);
  const [viewer, setViewer] = useState<OpenViewer | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setData(withoutExpired(await statusService.list(accessToken)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load statuses");
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setData((current) => (current ? withoutExpired(current) : current)), EXPIRY_CHECK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return subscribe((event) => {
      switch (event.type) {
        case "status:created":
          void load();
          break;
        case "status:deleted":
        case "status:expired": {
          const removed = new Set(event.type === "status:deleted" ? [event.statusId] : event.statusIds);
          setData((current) =>
            current
              ? {
                  mine: current.mine.filter((s) => !removed.has(s.id)),
                  feed: current.feed
                    .map((entry) => ({ ...entry, statuses: entry.statuses.filter((s) => !removed.has(s.id)) }))
                    .filter((entry) => entry.statuses.length > 0),
                }
              : current
          );
          break;
        }
        case "status:viewed":
          setData((current) =>
            current
              ? { ...current, mine: current.mine.map((s) => (s.id === event.statusId ? { ...s, viewCount: event.viewCount } : s)) }
              : current
          );
          break;
        default:
          break;
      }
    });
  }, [subscribe, load]);

  const markViewed = useCallback(
    (statusId: string) => {
      if (!accessToken) return;
      setData((current) =>
        current
          ? {
              ...current,
              feed: current.feed.map((entry) => {
                const statuses = entry.statuses.map((s) => (s.id === statusId ? { ...s, viewedByMe: true } : s));
                return { ...entry, statuses, hasUnseen: statuses.some((s) => !s.viewedByMe) };
              }),
            }
          : current
      );
      void statusService.markViewed(accessToken, statusId).catch(() => undefined);
    },
    [accessToken]
  );

  const deleteMine = useCallback(
    async (statusId: string) => {
      if (!accessToken) return;
      await statusService.remove(accessToken, statusId);
      setData((current) => (current ? { ...current, mine: current.mine.filter((s) => s.id !== statusId) } : current));
    },
    [accessToken]
  );

  const closeViewer = useCallback(() => setViewer(null), []);

  const recent = data?.feed.filter((entry) => entry.hasUnseen) ?? [];
  const viewed = data?.feed.filter((entry) => !entry.hasUnseen) ?? [];
  const openEntry = viewer?.kind === "user" ? data?.feed.find((e) => e.user.id === viewer.userId) : undefined;

  function renderEntry(entry: StatusFeedEntry) {
    const latest = entry.statuses[entry.statuses.length - 1]!;
    return (
      <li key={entry.user.id}>
        <button
          type="button"
          onClick={() => setViewer({ kind: "user", userId: entry.user.id })}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <StatusRing name={entry.user.displayName} avatarUrl={entry.user.avatarUrl} seen={!entry.hasUnseen} count={entry.statuses.length} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">{entry.user.displayName}</span>
            <span className="block text-xs text-slate-500">{formatStatusAge(latest.createdAt)}</span>
          </span>
        </button>
      </li>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-6 py-4">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Status</h1>
        <button
          type="button"
          onClick={() => setIsEditingPrivacy(true)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <LockIcon width={16} height={16} /> Privacy
        </button>
      </div>

      {!data && !error && <LoadingState label="Loading statuses…" />}
      {error && <ErrorState message={error} />}

      {data && (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-3 pb-8 sm:px-6">
          <section aria-labelledby="my-status-heading">
            <h2 id="my-status-heading" className="sr-only">
              My status
            </h2>
            <div className="flex items-center gap-3 rounded-xl px-3 py-2">
              {data.mine.length > 0 ? (
                <button type="button" onClick={() => setViewer({ kind: "mine" })} aria-label="View my status">
                  <StatusRing name={user?.displayName ?? "Me"} avatarUrl={null} seen count={data.mine.length} />
                </button>
              ) : (
                <Avatar name={user?.displayName ?? "Me"} size="md" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">My status</p>
                <p className="text-xs text-slate-500">
                  {data.mine.length > 0
                    ? `${data.mine.length} ${data.mine.length === 1 ? "update" : "updates"} · ${formatStatusAge(
                        data.mine[data.mine.length - 1]!.createdAt
                      )} · ${data.mine.reduce((sum, s) => sum + s.viewCount, 0)} views`
                    : "Share a photo, video or text for 24 hours"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsCreating(true)}
                aria-label="Add status"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-white hover:bg-brand-700"
              >
                <PlusIcon />
              </button>
            </div>
          </section>

          {recent.length > 0 && (
            <section aria-labelledby="recent-heading">
              <h2 id="recent-heading" className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Recent updates
              </h2>
              <ul>{recent.map(renderEntry)}</ul>
            </section>
          )}
          {viewed.length > 0 && (
            <section aria-labelledby="viewed-heading">
              <h2 id="viewed-heading" className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Viewed updates
              </h2>
              <ul>{viewed.map(renderEntry)}</ul>
            </section>
          )}
          {data.feed.length === 0 && (
            <EmptyState
              icon={<StatusIcon width={28} height={28} />}
              title="No status updates"
              message="When people you chat with share a status they've made visible to you, it will show up here."
            />
          )}
        </div>
      )}

      {isCreating && (
        <CreateStatusModal
          onClose={() => setIsCreating(false)}
          onCreated={(status) => setData((current) => (current ? { ...current, mine: [...current.mine, status] } : current))}
        />
      )}
      {isEditingPrivacy && <StatusPrivacyModal onClose={() => setIsEditingPrivacy(false)} />}

      {viewer?.kind === "mine" && data && data.mine.length > 0 && (
        <StatusViewer
          owner={{ name: user?.displayName ?? "Me", avatarUrl: null }}
          statuses={data.mine}
          isOwn
          onClose={closeViewer}
          onDelete={deleteMine}
        />
      )}
      {openEntry && (
        <StatusViewer
          owner={{ name: openEntry.user.displayName, avatarUrl: openEntry.user.avatarUrl }}
          statuses={openEntry.statuses}
          startIndex={Math.max(0, openEntry.statuses.findIndex((s) => !s.viewedByMe))}
          isOwn={false}
          onClose={closeViewer}
          onViewed={markViewed}
        />
      )}
    </div>
  );
}
