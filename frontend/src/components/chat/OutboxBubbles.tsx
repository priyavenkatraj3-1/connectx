import type { OutboxItem } from "../../lib/offline/outbox";
import { formatMessageTime } from "../../utils/formatTime";
import { ClockIcon } from "../ui/icons";

const STATE_LABEL: Record<OutboxItem["state"], string> = {
  pending: "Waiting to send",
  sending: "Sending…",
  failed: "Not sent",
};

/**
 * Outgoing messages that the server hasn't confirmed yet (Phase 6 offline
 * outbox), shown at the end of the thread with their state. Failed ones
 * can be retried (same idempotency key — never a duplicate) or discarded.
 */
export function OutboxBubbles({ items, onRetry, onDiscard }: { items: OutboxItem[]; onRetry(id: string): void; onDiscard(id: string): void }) {
  if (items.length === 0) return null;
  return (
    <div aria-label="Unsent messages">
      {items.map((item) => (
        <div key={item.clientMessageId} className="mb-2 flex flex-row-reverse items-center gap-1" data-outbox-state={item.state}>
          <div className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm text-white ${item.state === "failed" ? "bg-red-500/80" : "bg-brand-600/60"}`}>
            <p className="whitespace-pre-wrap break-words">{item.body}</p>
            <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-white/80">
              <ClockIcon width={12} height={12} aria-hidden="true" />
              <span>{STATE_LABEL[item.state]}</span>
              <span>· {formatMessageTime(item.createdAt)}</span>
            </div>
            {item.state === "failed" && item.error && <p className="mt-0.5 text-[11px] text-white/90">{item.error}</p>}
          </div>
          {item.state === "failed" && (
            <div className="flex flex-col gap-1 text-xs">
              <button type="button" onClick={() => onRetry(item.clientMessageId)} className="rounded-md px-2 py-0.5 font-medium text-brand-600 hover:bg-slate-100 dark:hover:bg-slate-800">
                Retry
              </button>
              <button type="button" onClick={() => onDiscard(item.clientMessageId)} className="rounded-md px-2 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                Discard
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
