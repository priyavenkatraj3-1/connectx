import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import type { Priority } from "../../types/productivity";
import { CloseIcon } from "../ui/icons";

export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

export const PRIORITY_CLASS: Record<Priority, string> = {
  low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  medium: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  urgent: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

export const fieldClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark-subtle dark:text-slate-100";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
      {children}
      {hint && <span className="text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${PRIORITY_CLASS[priority]}`}>{PRIORITY_LABEL[priority]}</span>;
}

/** Modal shell matching the app's existing dialogs (NewGroupModal etc.). */
export function Modal({ title, onClose, children, labelId }: { title: string; onClose(): void; children: ReactNode; labelId: string }) {
  useEscapeKey(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-y-auto rounded-xl2 bg-white shadow-xl dark:bg-surface-dark-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <h2 id={labelId} className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <CloseIcon width={18} height={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

export function SourceLink({ excerpt, conversationId }: { excerpt: string | null; conversationId: string | null }) {
  if (!conversationId) return null;
  return (
    <Link to={`/app/chat/${conversationId}`} className="mt-1 block truncate text-xs text-brand-600 hover:underline dark:text-brand-300">
      {excerpt ? `From chat: “${excerpt}”` : "Open source conversation"}
    </Link>
  );
}
