import { useState, type ReactNode } from "react";
import type { MessageDTO, MessageMention } from "../../types/message";
import { describeMessageContent } from "../../utils/conversationDisplay";
import { formatMessageTime } from "../../utils/formatTime";
import { AttachmentView } from "../media/AttachmentView";
import { EditIcon, ReplyIcon, SmileIcon, TrashIcon } from "../ui/icons";
import { EmojiPicker } from "./EmojiPicker";
import { MessageStatusTicks } from "./MessageStatusTicks";

interface MessageBubbleProps {
  message: MessageDTO;
  isOwn: boolean;
  /** Group conversations show each sender's name above their messages. */
  showSenderName: boolean;
  currentUserId: string | undefined;
  onReply(message: MessageDTO): void;
  onEdit(message: MessageDTO): void;
  onDelete(message: MessageDTO): Promise<void>;
  /** Optional AI tools/results rendered inside the bubble (Phase 5); absent outside the app shell. */
  aiSlot?: ReactNode;
  /** Phase 6: extra hover actions (the pin/save/task menu); absent outside the app shell. */
  extraActions?: ReactNode;
  /** Phase 6: small markers shown next to the time (e.g. pinned / saved). */
  badges?: ReactNode;
  /** Sets (emoji) or removes (null) your reaction. Absent → no reaction controls. */
  onReact?(message: MessageDTO, emoji: string | null): Promise<void>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highlights "@Display Name" for each mention the server confirmed on this message. */
export function renderBodyWithMentions(body: string, mentions: MessageMention[], currentUserId: string | undefined): ReactNode {
  if (mentions.length === 0) return body;
  const byName = new Map(mentions.map((m) => [`@${m.displayName}`, m]));
  // Longest names first so "@Ann Lee" wins over "@Ann".
  const pattern = new RegExp(
    `(${[...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`,
    "g"
  );
  return body.split(pattern).map((part, index) => {
    const mention = byName.get(part);
    if (!mention) return part;
    const isMe = mention.userId === currentUserId;
    return (
      <span
        key={index}
        data-testid="mention"
        className={`rounded px-0.5 font-semibold ${isMe ? "bg-amber-200/70 text-slate-900" : "underline decoration-dotted"}`}
      >
        {part}
      </span>
    );
  });
}

export function MessageBubble({
  message,
  isOwn,
  showSenderName,
  currentUserId,
  onReply,
  onEdit,
  onDelete,
  aiSlot,
  extraActions,
  badges,
  onReact,
}: MessageBubbleProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isPickingReaction, setIsPickingReaction] = useState(false);
  const [reactionError, setReactionError] = useState<string | null>(null);
  const reactions = message.reactions ?? [];
  const myReaction = currentUserId ? (reactions.find((r) => r.userIds.includes(currentUserId))?.emoji ?? null) : null;

  async function react(emoji: string | null) {
    if (!onReact) return;
    setIsPickingReaction(false);
    setReactionError(null);
    try {
      await onReact(message, emoji);
    } catch (err) {
      setReactionError(err instanceof Error ? err.message : "Couldn't update your reaction");
    }
  }
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const senderName = message.sender?.displayName;
  const canEdit = isOwn && message.body !== null;

  async function confirmDelete() {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(message);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete message");
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  }

  const actionButton =
    "flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200";

  return (
    <div className={`group mb-2 flex items-center gap-1 ${isOwn ? "flex-row-reverse" : "flex-row"}`} data-message-id={message.id}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
          isOwn
            ? "bg-brand-600 text-white"
            : "border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-surface-dark-subtle dark:text-slate-100"
        }`}
      >
        {showSenderName && !isOwn && senderName && (
          <p className="mb-0.5 text-xs font-semibold text-brand-600 dark:text-brand-300">{senderName}</p>
        )}

        {message.replyTo && (
          <div
            className={`mb-1.5 rounded-lg border-l-4 px-2 py-1 text-xs ${
              isOwn ? "border-white/60 bg-white/10" : "border-brand-400 bg-slate-100 dark:bg-slate-800"
            }`}
            aria-label="Replying to"
          >
            <p className="font-semibold">{message.replyTo.senderDisplayName}</p>
            <p className="truncate opacity-80">
              {message.replyTo.deleted
                ? "Original message was deleted"
                : describeMessageContent(message.replyTo.contentType, message.replyTo.body) || "Message"}
            </p>
          </div>
        )}

        {message.statusReply && (
          <div
            className={`mb-1.5 rounded-lg border-l-4 px-2 py-1 text-xs ${
              isOwn ? "border-white/60 bg-white/10" : "border-accent-400 bg-slate-100 dark:bg-slate-800"
            }`}
            aria-label="Status reply"
          >
            <p className="font-semibold">{isOwn ? "You replied to their status" : "Replied to your status"}</p>
            <p className="truncate opacity-80">
              {message.statusReply.preview ?? (message.statusReply.type === "image" ? "Photo" : message.statusReply.type === "video" ? "Video" : "Status")}
            </p>
          </div>
        )}

        {message.attachment && (
          <div className="mb-1">
            <AttachmentView attachment={message.attachment} isOwn={isOwn} />
          </div>
        )}

        {message.body && (
          <p className="whitespace-pre-wrap break-words">
            {renderBodyWithMentions(message.body, message.mentions ?? [], currentUserId)}
          </p>
        )}

        {aiSlot}

        <div
          className={`mt-1 flex items-center justify-end gap-1 text-[11px] ${isOwn ? "text-white/70" : "text-slate-400"}`}
        >
          {badges}
          {message.editedAt && <span>edited ·</span>}
          <span>{formatMessageTime(message.createdAt)}</span>
          {isOwn && <MessageStatusTicks status={message.status} />}
        </div>

        {deleteError && <p className="mt-1 text-xs text-red-200">{deleteError}</p>}

        {reactions.length > 0 && (
          <div className="-mb-1 mt-1.5 flex flex-wrap gap-1" aria-label="Reactions">
            {reactions.map((r) => {
              const mine = r.emoji === myReaction;
              return (
                <button
                  key={r.emoji}
                  type="button"
                  disabled={!onReact}
                  onClick={() => void react(mine ? null : r.emoji)}
                  aria-pressed={mine}
                  aria-label={`${r.emoji} ${r.count} ${r.count === 1 ? "reaction" : "reactions"}${mine ? ", including yours" : ""}`}
                  className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs ${
                    mine
                      ? "border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500 dark:bg-brand-900/60 dark:text-brand-100"
                      : "border-slate-200 bg-white text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                  }`}
                >
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              );
            })}
          </div>
        )}
        {reactionError && (
          <p role="alert" className={`mt-1 text-xs ${isOwn ? "text-red-200" : "text-red-600"}`}>
            {reactionError}
          </p>
        )}
      </div>

      {confirmingDelete ? (
        <div className="flex items-center gap-1 text-xs" role="group" aria-label="Confirm delete">
          <button
            type="button"
            onClick={() => void confirmDelete()}
            disabled={isDeleting}
            className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            disabled={isDeleting}
            className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {onReact && (
            <div className="relative">
              <button
                type="button"
                className={actionButton}
                onClick={() => setIsPickingReaction((open) => !open)}
                aria-label="Add reaction"
                aria-haspopup="dialog"
                aria-expanded={isPickingReaction}
              >
                <SmileIcon width={16} height={16} />
              </button>
              {isPickingReaction && (
                <EmojiPicker
                  label="Add reaction"
                  showQuick
                  selected={myReaction}
                  onPick={(emoji) => void react(emoji === myReaction ? null : emoji)}
                  onClose={() => setIsPickingReaction(false)}
                  className={`absolute bottom-8 ${isOwn ? "right-0" : "left-0"}`}
                />
              )}
            </div>
          )}
          <button type="button" className={actionButton} onClick={() => onReply(message)} aria-label="Reply">
            <ReplyIcon width={16} height={16} />
          </button>
          {canEdit && (
            <button type="button" className={actionButton} onClick={() => onEdit(message)} aria-label="Edit message">
              <EditIcon width={16} height={16} />
            </button>
          )}
          {isOwn && (
            <button
              type="button"
              className={actionButton}
              onClick={() => setConfirmingDelete(true)}
              aria-label="Delete message"
            >
              <TrashIcon width={16} height={16} />
            </button>
          )}
          {extraActions}
        </div>
      )}
    </div>
  );
}
