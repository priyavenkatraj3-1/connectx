import { useEffect, useRef, useState } from "react";
import type { ConversationSummary, MuteOption } from "../../types/conversation";
import { isMuted } from "../../utils/chatPreferences";
import { MoreIcon } from "../ui/icons";

interface ChatRowMenuProps {
  conversation: ConversationSummary;
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onChange(changes: { pinned?: boolean; archived?: boolean; mute?: MuteOption }): Promise<void>;
}

/**
 * The "⋯" menu on a chat-list row (also opened by right-click on the row):
 * pin, archive, mute. Muting silences the chat's @mention notifications and
 * keeps its unread count out of the total — ConnectX has no push or sound
 * notifications.
 */
export function ChatRowMenu({ conversation, title, open, onOpenChange, onChange }: ChatRowMenuProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const muted = isMuted(conversation);

  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  async function run(changes: { pinned?: boolean; archived?: boolean; mute?: MuteOption }) {
    setBusy(true);
    setError(null);
    try {
      await onChange(changes);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update this chat");
    } finally {
      setBusy(false);
    }
  }

  const item = "block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-700 dark:hover:text-slate-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        aria-label={`Chat options for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreIcon width={16} height={16} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Chat options for ${title}`}
          className="absolute right-0 top-8 z-30 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-surface-dark-subtle"
        >
          <button type="button" role="menuitem" disabled={busy} className={item} onClick={() => void run({ pinned: !conversation.pinned })}>
            {conversation.pinned ? "Unpin chat" : "Pin chat"}
          </button>
          <button type="button" role="menuitem" disabled={busy} className={item} onClick={() => void run({ archived: !conversation.archived })}>
            {conversation.archived ? "Unarchive chat" : "Archive chat"}
          </button>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          {muted ? (
            <button type="button" role="menuitem" disabled={busy} className={item} onClick={() => void run({ mute: "off" })}>
              Unmute
            </button>
          ) : (
            <>
              <button type="button" role="menuitem" disabled={busy} className={item} onClick={() => void run({ mute: "8h" })}>
                Mute for 8 hours
              </button>
              <button type="button" role="menuitem" disabled={busy} className={item} onClick={() => void run({ mute: "1w" })}>
                Mute for 1 week
              </button>
              <button type="button" role="menuitem" disabled={busy} className={item} onClick={() => void run({ mute: "always" })}>
                Mute until I unmute
              </button>
            </>
          )}
          <p className="px-3 pb-1 pt-0.5 text-[11px] text-slate-400">Muting hides @mention alerts and leaves this chat out of the unread total.</p>
          {error && (
            <p role="alert" className="px-3 pb-1 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
