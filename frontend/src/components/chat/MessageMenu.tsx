import { useEffect, useRef, useState } from "react";
import { MoreIcon } from "../ui/icons";

export interface MessageMenuProps {
  isPinned: boolean;
  canPin: boolean;
  isSaved: boolean;
  isStarred: boolean;
  onTogglePin(): Promise<void>;
  onToggleSave(): Promise<void>;
  onToggleStar(): Promise<void>;
  onCreate(kind: "task" | "reminder" | "event"): void;
}

/**
 * The "⋯" menu on a message (Phase 6): pin, save, star, and turn the
 * message into a task / reminder / event. Rendered next to the existing
 * reply/edit/delete buttons via MessageBubble's `extraActions` slot.
 */
export function MessageMenu({ isPinned, canPin, isSaved, isStarred, onTogglePin, onToggleSave, onToggleStar, onCreate }: MessageMenuProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function act(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't do that");
    }
  }

  const item = "block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        aria-label="More message actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreIcon width={16} height={16} />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-8 right-0 z-30 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-surface-dark-subtle">
          {canPin && (
            <button type="button" role="menuitem" className={item} onClick={() => void act(onTogglePin)}>
              {isPinned ? "Unpin" : "Pin to chat"}
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={() => void act(onToggleSave)}>
            {isSaved ? "Remove from saved" : "Save message"}
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => void act(onToggleStar)}>
            {isStarred ? "Unstar" : "Star"}
          </button>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onCreate("task"); }}>
            Create task…
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onCreate("reminder"); }}>
            Remind me…
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onCreate("event"); }}>
            Create event…
          </button>
          {error && <p className="px-3 py-1 text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
