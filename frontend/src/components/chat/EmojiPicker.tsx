import { useEffect, useRef } from "react";

/** Shown first when reacting. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** A curated, dependency-free set: enough for everyday chat without a large emoji database. */
export const EMOJI_CHOICES = [
  "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😉", "😊", "😇",
  "🥰", "😍", "😘", "😋", "😜", "🤪", "🤔", "🤨", "😐", "😏", "😒", "🙄",
  "😬", "😌", "😴", "😷", "🤒", "🤯", "🥳", "😎", "🤓", "😕", "😟", "😮",
  "😲", "😳", "🥺", "😢", "😭", "😱", "😤", "😡", "🤬", "💀", "👋", "👌",
  "✌️", "🤞", "👍", "👎", "👏", "🙌", "🙏", "💪", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "🖤", "💔", "💯", "🔥", "✨", "🎉", "🎂", "🎁", "☕", "🍕",
  "⚽", "🚀", "✅", "❌", "⭐", "💡", "📌", "⏰",
];

interface EmojiPickerProps {
  /** Accessible name, e.g. "Add reaction" or "Insert emoji". */
  label: string;
  onPick(emoji: string): void;
  onClose(): void;
  /** Highlights the emoji the user already chose (reactions). */
  selected?: string | null;
  /** Show QUICK_REACTIONS above the grid. */
  showQuick?: boolean;
  className?: string;
}

/** A small popover grid of emoji. Escape or a click outside closes it. */
export function EmojiPicker({ label, onPick, onClose, selected, showQuick = false, className = "" }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  const cell = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      onClick={() => onPick(emoji)}
      aria-label={emoji}
      aria-pressed={selected === undefined ? undefined : selected === emoji}
      className={`flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-800 dark:focus:bg-slate-800 ${
        selected === emoji ? "bg-brand-100 dark:bg-brand-900" : ""
      }`}
    >
      {emoji}
    </button>
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`z-40 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-surface-dark-subtle ${className}`}
    >
      {showQuick && (
        <div className="mb-1 flex justify-between border-b border-slate-100 pb-1 dark:border-slate-800" aria-label="Quick reactions" role="group">
          {QUICK_REACTIONS.map(cell)}
        </div>
      )}
      <div className="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto" role="group" aria-label="All emoji">
        {EMOJI_CHOICES.filter((e) => !showQuick || !QUICK_REACTIONS.includes(e)).map(cell)}
      </div>
    </div>
  );
}
