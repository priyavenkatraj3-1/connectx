import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { useAttachmentUrl } from "../../hooks/useAttachmentUrl";
import { statusService } from "../../services/statusService";
import type { OwnStatusDTO, StatusDTO, StatusViewerDTO } from "../../types/status";
import { formatMessageTime } from "../../utils/formatTime";
import { Avatar } from "../ui/Avatar";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, EyeIcon, TrashIcon } from "../ui/icons";
import { describePrivacy } from "./StatusPrivacyPicker";
import { formatStatusAge, isExpired, STATUS_BACKGROUND_CLASSES } from "./statusStyles";

/** How long a photo/text status shows before auto-advancing. Videos advance when they end. */
export const STATUS_DISPLAY_MS = 5000;

interface StatusViewerProps {
  owner: { name: string; avatarUrl: string | null };
  statuses: Array<StatusDTO | OwnStatusDTO>;
  startIndex?: number;
  isOwn: boolean;
  onClose(): void;
  /** Called once per status the first time it's shown (never for your own). */
  onViewed?(statusId: string): void;
  onDelete?(statusId: string): Promise<void>;
  /** Replies to someone else's status (sent as a direct message to them). Absent → no reply box. */
  onReply?(statusId: string, body: string): Promise<void>;
}

function StatusMedia({ status, onVideoEnded }: { status: StatusDTO; onVideoEnded(): void }) {
  const { status: loadState, url, error } = useAttachmentUrl(status.media!.attachmentId);
  if (loadState === "error") return <p className="text-sm text-white/70">{error ?? "Couldn't load this status"}</p>;
  if (loadState !== "ready" || !url) return <p className="text-sm text-white/70">Loading…</p>;
  return status.media!.kind === "image" ? (
    <img src={url} alt={status.text ?? "Status photo"} className="max-h-full max-w-full object-contain" />
  ) : (
    <video src={url} autoPlay playsInline controls onEnded={onVideoEnded} className="max-h-full max-w-full" />
  );
}

/** Fetched viewers plus ones reported live, one entry per user (the fetched copy wins), newest first. */
export function mergeViewers(fetched: StatusViewerDTO[], live: StatusViewerDTO[]): StatusViewerDTO[] {
  const byUser = new Map<string, StatusViewerDTO>();
  for (const viewer of [...live, ...fetched]) byUser.set(viewer.userId, viewer);
  return [...byUser.values()].sort((a, b) => b.viewedAt.localeCompare(a.viewedAt));
}

function ViewersPanel({ statusId, onClose }: { statusId: string; onClose(): void }) {
  const { accessToken } = useAuth();
  const [fetched, setFetched] = useState<StatusViewerDTO[] | null>(null);
  /** Views reported over the socket since the panel opened — kept even if they arrive before the list does. */
  const [live, setLive] = useState<Array<StatusViewerDTO & { statusId: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    statusService
      .viewers(accessToken, statusId)
      .then((list) => {
        if (!cancelled) setFetched(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load viewers");
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, statusId]);

  // Someone views the status while this list is open: add them, as the "Seen by" count already does.
  const subscribe = useContext(RealtimeContext)?.subscribe;
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.type !== "status:viewed" || event.statusId !== statusId) return;
      setLive((current) => [...current, { ...event.viewer, viewedAt: event.viewedAt, statusId: event.statusId }]);
    });
  }, [subscribe, statusId]);

  const viewers = useMemo(
    () => (fetched ? mergeViewers(fetched, live.filter((v) => v.statusId === statusId)) : null),
    [fetched, live, statusId]
  );

  return (
    <div className="absolute inset-x-0 bottom-0 max-h-[60%] overflow-y-auto rounded-t-2xl bg-white p-4 text-slate-900 dark:bg-surface-dark-subtle dark:text-slate-100">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Viewed by {viewers?.length ?? "…"}</h3>
        <button type="button" onClick={onClose} aria-label="Close viewers" className="text-slate-400 hover:text-slate-600">
          <CloseIcon width={18} height={18} />
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {viewers?.length === 0 && <p className="text-sm text-slate-500">No views yet.</p>}
      <ul className="flex flex-col gap-2">
        {viewers?.map((v) => (
          <li key={v.userId} className="flex items-center gap-3">
            <Avatar name={v.displayName} imageUrl={v.avatarUrl ?? undefined} size="sm" />
            <span className="flex-1 text-sm">{v.displayName}</span>
            <span className="text-xs text-slate-400">{formatMessageTime(v.viewedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Full-screen story viewer: progress bars, tap/arrow navigation,
 * auto-advance, and — for your own statuses — privacy, viewers and delete.
 */
export function StatusViewer({ owner, statuses, startIndex = 0, isOwn, onClose, onViewed, onDelete, onReply }: StatusViewerProps) {
  const [index, setIndex] = useState(Math.min(startIndex, Math.max(0, statuses.length - 1)));
  const [showViewers, setShowViewers] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const reportedRef = useRef(new Set<string>());
  const current = statuses[index];
  const [replyText, setReplyText] = useState("");
  const [isReplyFocused, setIsReplyFocused] = useState(false);
  const [replyState, setReplyState] = useState<{ kind: "idle" | "sending" | "sent" } | { kind: "error"; message: string }>({ kind: "idle" });
  const canReply = !isOwn && !!onReply;
  // While writing (or sending) a reply the status stays put.
  const isReplying = canReply && (isReplyFocused || replyText.trim().length > 0 || replyState.kind === "sending");

  // A new status starts with an empty reply box.
  const currentId = current?.id;
  useEffect(() => {
    setReplyText("");
    setReplyState({ kind: "idle" });
  }, [currentId]);

  async function sendReply() {
    const body = replyText.trim();
    if (!onReply || !current || !body || replyState.kind === "sending") return;
    setReplyState({ kind: "sending" });
    try {
      await onReply(current.id, body);
      setReplyText("");
      setReplyState({ kind: "sent" });
    } catch (err) {
      setReplyState({ kind: "error", message: err instanceof Error ? err.message : "Couldn't send your reply" });
    }
  }

  const next = useCallback(() => {
    setShowViewers(false);
    if (index + 1 >= statuses.length) onClose();
    else setIndex(index + 1);
  }, [index, statuses.length, onClose]);

  const previous = useCallback(() => {
    setShowViewers(false);
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // Keep the index valid if statuses are removed (deleted/expired) while open.
  useEffect(() => {
    if (statuses.length === 0) onClose();
    else if (index >= statuses.length) setIndex(statuses.length - 1);
  }, [statuses.length, index, onClose]);

  // Report a view the first time each status is shown.
  useEffect(() => {
    if (!current || isOwn || current.viewedByMe || reportedRef.current.has(current.id)) return;
    reportedRef.current.add(current.id);
    onViewed?.(current.id);
  }, [current, isOwn, onViewed]);

  // Auto-advance photos and text (videos advance on end); pause while the viewer list is open or a reply is being written.
  useEffect(() => {
    if (!current || current.type === "video" || showViewers || isReplying) return;
    const timer = setTimeout(next, STATUS_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [current, next, showViewers, isReplying]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Arrow keys move the caret in the reply box, not between statuses.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && e.key !== "Escape") return;
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") previous();
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous, onClose]);

  if (!current) return null;
  const expired = isExpired(current.expiresAt);
  const own = isOwn ? (current as OwnStatusDTO) : null;

  async function handleDelete() {
    if (!onDelete || !current) return;
    setIsDeleting(true);
    try {
      await onDelete(current.id);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={`${owner.name}'s status`} className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex gap-1 px-3 pt-3" aria-hidden="true">
        {statuses.map((s, i) => (
          <div key={s.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
            <div className={`h-full bg-white ${i < index ? "w-full" : i === index ? "w-full animate-pulse" : "w-0"}`} />
          </div>
        ))}
      </div>

      <header className="flex items-center gap-3 px-4 py-3">
        <Avatar name={owner.name} imageUrl={owner.avatarUrl ?? undefined} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{isOwn ? "My status" : owner.name}</p>
          <p className="text-xs text-white/60">
            {formatStatusAge(current.createdAt)} · {index + 1} of {statuses.length}
          </p>
        </div>
        {own && onDelete && (
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={isDeleting}
            aria-label="Delete this status"
            className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-50"
          >
            <TrashIcon width={18} height={18} />
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close status" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10">
          <CloseIcon width={20} height={20} />
        </button>
      </header>

      <main className="relative flex flex-1 items-center justify-center overflow-hidden">
        {expired ? (
          <p className="text-sm text-white/70">This status has expired.</p>
        ) : current.type === "text" ? (
          <div className={`flex h-full w-full items-center justify-center p-8 ${STATUS_BACKGROUND_CLASSES[current.backgroundColor ?? "indigo"]}`}>
            <p className="max-w-lg whitespace-pre-wrap break-words text-center text-2xl font-medium">{current.text}</p>
          </div>
        ) : current.media ? (
          <StatusMedia key={current.id} status={current} onVideoEnded={next} />
        ) : (
          <p className="text-sm text-white/70">This media is no longer available.</p>
        )}

        <button
          type="button"
          onClick={previous}
          disabled={index === 0}
          aria-label="Previous status"
          className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/30 hover:bg-black/50 disabled:invisible"
        >
          <ChevronLeftIcon />
        </button>
        <button
          type="button"
          onClick={next}
          aria-label="Next status"
          className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/30 hover:bg-black/50"
        >
          <ChevronRightIcon />
        </button>

        {showViewers && own && <ViewersPanel statusId={own.id} onClose={() => setShowViewers(false)} />}
      </main>

      <footer className="flex flex-col items-center gap-2 px-4 pb-6 pt-3 text-center">
        {current.type !== "text" && current.text && <p className="max-w-lg text-sm">{current.text}</p>}
        {own && (
          <>
            <button
              type="button"
              onClick={() => setShowViewers(true)}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
            >
              <EyeIcon width={14} height={14} /> Seen by {own.viewCount}
            </button>
            <p className="text-xs text-white/50">Visible to: {describePrivacy({ visibility: own.visibility, userIds: own.audienceUserIds })}</p>
          </>
        )}
        {canReply && (
          <form
            className="flex w-full max-w-lg items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void sendReply();
            }}
          >
            <label className="sr-only" htmlFor="status-reply">
              Reply to {owner.name}
            </label>
            <input
              id="status-reply"
              value={replyText}
              maxLength={4000}
              onChange={(e) => {
                setReplyText(e.target.value);
                if (replyState.kind !== "sending") setReplyState({ kind: "idle" });
              }}
              onFocus={() => setIsReplyFocused(true)}
              onBlur={() => setIsReplyFocused(false)}
              placeholder={`Reply to ${owner.name}…`}
              className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-2 text-sm text-white placeholder:text-white/50 outline-none focus:bg-white/20"
            />
            <button
              type="submit"
              disabled={!replyText.trim() || replyState.kind === "sending"}
              className="rounded-full bg-white/20 px-4 py-2 text-sm font-medium hover:bg-white/30 disabled:opacity-40"
            >
              {replyState.kind === "sending" ? "Sending…" : "Send"}
            </button>
          </form>
        )}
        {replyState.kind === "sent" && (
          <p className="text-xs text-white/70" role="status">
            Reply sent — it's in your chat with {owner.name}.
          </p>
        )}
        {replyState.kind === "error" && (
          <p className="text-xs text-red-300" role="alert">
            {replyState.message}
          </p>
        )}
      </footer>
    </div>
  );
}
