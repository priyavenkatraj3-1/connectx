import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../context/AuthContext";
import { ACCEPTED_FILE_EXTENSIONS, formatFileSize, guessKind, mediaService, precheckFile, type UploadHandle } from "../../services/mediaService";
import { isNetworkError } from "../../services/apiClient";
import { messageService } from "../../services/messageService";
import type { AttachmentDTO, AttachmentKind } from "../../types/media";
import type { MessageDTO, MessageMention } from "../../types/message";
import type { QuickReply } from "../../types/productivity";
import { describeMessageContent } from "../../utils/conversationDisplay";
import { Button } from "../ui/Button";
import { BoltIcon, ClockIcon, CloseIcon, FileIcon, PaperclipIcon, SendIcon } from "../ui/icons";

export interface MentionCandidate {
  userId: string;
  displayName: string;
}

type PendingAttachment =
  | { status: "uploading"; file: File; kind: AttachmentKind; progress: number; previewUrl: string | null; handle: UploadHandle }
  | { status: "uploaded"; file: File; kind: AttachmentKind; previewUrl: string | null; attachment: AttachmentDTO }
  | { status: "error"; file: File; kind: AttachmentKind; previewUrl: string | null; error: string };

interface MessageComposerProps {
  conversationId: string;
  /** People who can be @mentioned (group members other than you). Empty disables mentions. */
  mentionCandidates: MentionCandidate[];
  replyingTo: MessageDTO | null;
  onCancelReply(): void;
  editing: MessageDTO | null;
  onCancelEdit(): void;
  onSent(message: MessageDTO): void;
  onEdited(message: MessageDTO): void;
  /** Phase 6: business quick-reply templates (insert with the ⚡ button or by typing their /shortcut). */
  quickReplies?: QuickReply[];
  /** Phase 6: schedules the current text for later; enables the clock button. `whenLocal` is a datetime-local value. */
  onSchedule?(body: string, whenLocal: string): Promise<void>;
  /**
   * Phase 6 offline outbox. When provided, text messages written while
   * offline — or whose send dropped mid-flight — are queued (and retried
   * with the same idempotency key) instead of failing.
   */
  offlineQueue?: {
    isOnline: boolean;
    queue(input: { body: string; replyToMessageId?: string; mentionedUserIds?: string[]; clientMessageId?: string }): Promise<void>;
  };
}

const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  document: "Document",
  file: "File",
};

/** The "@partial" token immediately before the caret, if any. */
function activeMentionQuery(text: string, caret: number): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? (match[1] ?? "") : null;
}

export function MessageComposer({
  conversationId,
  mentionCandidates,
  replyingTo,
  onCancelReply,
  editing,
  onCancelEdit,
  onSent,
  onEdited,
  quickReplies = [],
  onSchedule,
  offlineQueue,
}: MessageComposerProps) {
  const { accessToken } = useAuth();
  const [draft, setDraft] = useState("");
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mentions, setMentions] = useState<MessageMention[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAttachment | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset everything when switching conversations. Declared before the
  // edit effect so that, on mount, a message already being edited is
  // loaded *after* the reset rather than wiped by it.
  useEffect(() => {
    setDraft("");
    setMentions([]);
    setError(null);
    setPending(null);
    setScheduleAt(null);
    setShowQuickReplies(false);
    setNotice(null);
  }, [conversationId]);

  // Entering edit mode loads the message into the composer.
  useEffect(() => {
    if (editing) {
      setDraft(editing.body ?? "");
      setMentions(editing.mentions ?? []);
      setError(null);
      textareaRef.current?.focus();
    }
  }, [editing]);

  // Revoke image preview URLs when they're replaced or the composer unmounts.
  useEffect(() => {
    const url = pending?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [pending?.previewUrl]);

  const suggestions =
    mentionQuery === null
      ? []
      : mentionCandidates
          .filter((c) => c.displayName.toLowerCase().includes(mentionQuery.toLowerCase()))
          .slice(0, 6);

  // "/shortcut" typed at the start of an empty-ish draft suggests matching quick replies.
  const shortcutQuery = !editing && /^\/[\w-]*$/.test(draft) ? draft.toLowerCase() : null;
  const quickReplyMatches =
    showQuickReplies ? quickReplies : shortcutQuery ? quickReplies.filter((reply) => reply.shortcut.startsWith(shortcutQuery)).slice(0, 6) : [];

  function insertQuickReply(reply: QuickReply) {
    setDraft((current) => (current === "" || /^\/[\w-]*$/.test(current) ? reply.body : `${current}${current.endsWith(" ") ? "" : " "}${reply.body}`));
    setShowQuickReplies(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function updateDraft(value: string, caret: number) {
    setDraft(value);
    setMentionQuery(mentionCandidates.length > 0 ? activeMentionQuery(value, caret) : null);
  }

  function pickMention(candidate: MentionCandidate) {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@([^\s@]*)$/, `@${candidate.displayName} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentions((prev) => (prev.some((m) => m.userId === candidate.userId) ? prev : [...prev, candidate]));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(before.length, before.length);
    });
  }

  function startUpload(file: File) {
    if (!accessToken) return;
    const kind = guessKind(file.name);
    const previewUrl = kind === "image" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;

    const rejection = precheckFile(file);
    if (rejection) {
      setPending({ status: "error", file, kind, previewUrl, error: rejection });
      return;
    }

    const handle = mediaService.upload(accessToken, conversationId, file, (progress) => {
      setPending((prev) => (prev?.status === "uploading" && prev.handle === handle ? { ...prev, progress } : prev));
    });
    setPending({ status: "uploading", file, kind, progress: 0, previewUrl, handle });

    handle.promise.then(
      (attachment) =>
        setPending((prev) =>
          prev?.status === "uploading" && prev.handle === handle
            ? { status: "uploaded", file, kind, previewUrl, attachment }
            : prev
        ),
      (err: unknown) =>
        setPending((prev) =>
          prev?.status === "uploading" && prev.handle === handle
            ? { status: "error", file, kind, previewUrl, error: err instanceof Error ? err.message : "Upload failed" }
            : prev
        )
    );
  }

  function removeAttachment() {
    if (pending?.status === "uploading") pending.handle.abort();
    if (pending?.status === "uploaded" && accessToken) {
      // Clean up the unsent upload on the server; failure here is harmless (it stays private to us).
      void mediaService.remove(accessToken, pending.attachment.id).catch(() => undefined);
    }
    setPending(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const body = draft.trim();
  const attachmentReady = pending?.status === "uploaded";
  const canSend =
    !isSending &&
    pending?.status !== "uploading" &&
    pending?.status !== "error" &&
    (editing ? body.length > 0 || editing.contentType !== "text" : body.length > 0 || attachmentReady);

  async function submit() {
    if (!accessToken || !canSend) return;
    const mentionedUserIds = mentions.filter((m) => draft.includes(`@${m.displayName}`)).map((m) => m.userId);

    setIsSending(true);
    setError(null);
    setNotice(null);
    const queueInput = {
      body,
      replyToMessageId: replyingTo?.id,
      mentionedUserIds: mentionedUserIds.length > 0 ? mentionedUserIds : undefined,
    };
    const canQueue = !!offlineQueue && !attachmentReady && body.length > 0;
    const finishQueued = () => {
      onCancelReply();
      setDraft("");
      setMentions([]);
      setNotice("You're offline — the message will be sent when you reconnect.");
    };
    try {
      if (editing) {
        const updated = await messageService.edit(accessToken, conversationId, editing.id, body, mentionedUserIds);
        onEdited(updated);
        onCancelEdit();
      } else if (offlineQueue && canQueue && !offlineQueue.isOnline) {
        await offlineQueue.queue(queueInput);
        finishQueued();
        return;
      } else {
        const hasExtras = Boolean(replyingTo || mentionedUserIds.length > 0 || attachmentReady);
        const sent = hasExtras
          ? await messageService.send(accessToken, conversationId, body, {
              replyToMessageId: replyingTo?.id,
              mentionedUserIds: mentionedUserIds.length > 0 ? mentionedUserIds : undefined,
              attachmentId: pending?.status === "uploaded" ? pending.attachment.id : undefined,
            })
          : await messageService.send(accessToken, conversationId, body);
        onSent(sent);
        onCancelReply();
        setPending(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
      setDraft("");
      setMentions([]);
    } catch (err) {
      // The connection dropped mid-send: queue it with the *same* idempotency key, so if the
      // first attempt did reach the server, the retry returns that message instead of a duplicate.
      if (offlineQueue && canQueue && !editing && isNetworkError(err)) {
        await offlineQueue.queue({ ...queueInput, clientMessageId: err.clientMessageId });
        finishQueued();
        return;
      }
      setError(err instanceof Error ? err.message : editing ? "Failed to save edit" : "Failed to send message");
    } finally {
      setIsSending(false);
    }
  }

  async function schedule() {
    if (!onSchedule || !scheduleAt || !body) return;
    setIsSending(true);
    setError(null);
    try {
      await onSchedule(body, scheduleAt);
      setDraft("");
      setMentions([]);
      setScheduleAt(null);
      setNotice("Message scheduled. Manage it in Chat tools → Scheduled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't schedule the message");
    } finally {
      setIsSending(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  function cancelMode() {
    if (editing) {
      onCancelEdit();
      setDraft("");
      setMentions([]);
    } else if (replyingTo) {
      onCancelReply();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-slate-200 dark:border-slate-800">
      {(replyingTo || editing) && (
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs dark:border-slate-800 dark:bg-surface-dark-subtle">
          <div className="min-w-0 flex-1 border-l-4 border-brand-400 pl-2">
            <p className="font-semibold text-brand-600 dark:text-brand-300">
              {editing ? "Editing message" : `Replying to ${replyingTo?.sender?.displayName ?? "message"}`}
            </p>
            {replyingTo && !editing && (
              <p className="truncate text-slate-500">
                {describeMessageContent(replyingTo.contentType, replyingTo.body) || "Message"}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={cancelMode}
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"
            aria-label={editing ? "Cancel editing" : "Cancel reply"}
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      )}

      {pending && (
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2 dark:border-slate-800" data-testid="pending-attachment">
          {pending.previewUrl ? (
            <img src={pending.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800">
              <FileIcon />
            </div>
          )}
          <div className="min-w-0 flex-1 text-xs">
            <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{pending.file.name}</p>
            <p className="text-slate-400">
              {KIND_LABEL[pending.kind]} · {formatFileSize(pending.file.size)}
            </p>
            {pending.status === "uploading" && (
              <div className="mt-1 flex items-center gap-2">
                <div
                  className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pending.progress * 100)}
                >
                  <div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.round(pending.progress * 100)}%` }} />
                </div>
                <span className="text-slate-500">Uploading…</span>
              </div>
            )}
            {pending.status === "uploaded" && <p className="text-accent-600">Ready to send</p>}
            {pending.status === "error" && (
              <p role="alert" className="text-red-600 dark:text-red-400">
                {pending.error}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={removeAttachment}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Remove attachment"
          >
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      )}

      {suggestions.length > 0 && (
        <ul className="border-b border-slate-100 p-1 dark:border-slate-800" role="listbox" aria-label="Mention suggestions">
          {suggestions.map((candidate) => (
            <li key={candidate.userId}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(candidate)}
                className="w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                @{candidate.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}

      {quickReplyMatches.length > 0 && (
        <ul className="max-h-48 overflow-y-auto border-b border-slate-100 p-1 dark:border-slate-800" aria-label="Quick replies">
          {quickReplyMatches.map((reply) => (
            <li key={reply.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertQuickReply(reply)}
                className="w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <span className="font-mono text-xs text-brand-600">{reply.shortcut}</span> <span className="font-medium">{reply.title}</span>
                <span className="block truncate text-xs text-slate-500">{reply.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {scheduleAt !== null && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-xs dark:border-slate-800" aria-label="Schedule message">
          <span className="font-medium text-slate-600 dark:text-slate-300">Send later at</span>
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            className="rounded-md border border-slate-200 px-2 py-1 dark:border-slate-700 dark:bg-surface-dark-subtle"
            aria-label="Send at"
          />
          <Button type="button" className="px-3 py-1 text-xs" disabled={!scheduleAt || !body || isSending} onClick={() => void schedule()}>
            Schedule
          </Button>
          <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setScheduleAt(null)}>
            Cancel
          </Button>
        </div>
      )}

      {notice && !error && (
        <p role="status" className="px-4 pt-2 text-xs text-slate-500">
          {notice}
        </p>
      )}

      {error && (
        <p role="alert" className="px-4 pt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex items-end gap-2 p-3">
        {!editing && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={ACCEPTED_FILE_EXTENSIONS.join(",")}
              data-testid="attachment-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) startUpload(file);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={pending !== null}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800"
              aria-label="Attach a file"
              title="Attach an image, video, audio clip or document"
            >
              <PaperclipIcon />
            </button>
            {quickReplies.length > 0 && (
              <button
                type="button"
                onClick={() => setShowQuickReplies((open) => !open)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                aria-label="Quick replies"
                aria-expanded={showQuickReplies}
                title="Insert a quick reply (or type /shortcut)"
              >
                <BoltIcon />
              </button>
            )}
            {onSchedule && (
              <button
                type="button"
                onClick={() => setScheduleAt((current) => (current === null ? "" : null))}
                disabled={pending !== null}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800"
                aria-label="Schedule message"
                aria-expanded={scheduleAt !== null}
                title="Send this message later"
              >
                <ClockIcon />
              </button>
            )}
          </>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => updateDraft(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (mentionQuery !== null) setMentionQuery(null);
              else cancelMode();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (suggestions[0]) pickMention(suggestions[0]);
              else if (quickReplyMatches[0] && (shortcutQuery || showQuickReplies)) insertQuickReply(quickReplyMatches[0]);
              else void submit();
            }
          }}
          rows={1}
          placeholder={pending ? "Add a caption (optional)" : "Type a message"}
          aria-label="Message"
          className="max-h-32 flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark-subtle"
        />
        <Button type="submit" disabled={!canSend} isLoading={isSending} aria-label={editing ? "Save edit" : "Send message"}>
          <SendIcon width={18} height={18} />
        </Button>
      </div>
    </form>
  );
}
