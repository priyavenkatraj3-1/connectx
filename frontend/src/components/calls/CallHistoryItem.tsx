import { formatCallDuration } from "../../context/CallContext";
import type { CallHistoryEntryDTO } from "../../types/call";
import { formatMessageTime } from "../../utils/formatTime";
import { PhoneIcon, VideoIcon } from "../ui/icons";

export function describeCallHistory(entry: CallHistoryEntryDTO): { label: string; isMissed: boolean } {
  const kind = entry.media === "video" ? "video call" : "voice call";
  const group = entry.scope === "group" ? "group " : "";
  switch (entry.outcome) {
    case "ongoing":
      return { label: `Ongoing ${group}${kind}`, isMissed: false };
    case "missed":
      return { label: `Missed ${group}${kind}`, isMissed: true };
    case "declined":
      return {
        label: entry.direction === "incoming" ? `Declined ${group}${kind}` : `${capitalize(`${group}${kind}`)} declined`,
        isMissed: false,
      };
    case "cancelled":
      return { label: `Cancelled ${group}${kind}`, isMissed: false };
    case "no_answer":
      return { label: `${capitalize(`${group}${kind}`)} · no answer`, isMissed: false };
    case "failed":
      return { label: `${capitalize(`${group}${kind}`)} failed`, isMissed: false };
    case "completed": {
      const direction = entry.direction === "incoming" ? "Incoming" : "Outgoing";
      const duration = entry.durationSeconds !== null ? ` · ${formatCallDuration(entry.durationSeconds)}` : "";
      return { label: `${direction} ${group}${kind}${duration}`, isMissed: false };
    }
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A call shown inline in a conversation's timeline. */
export function CallHistoryItem({ entry }: { entry: CallHistoryEntryDTO }) {
  const { label, isMissed } = describeCallHistory(entry);
  const Icon = entry.media === "video" ? VideoIcon : PhoneIcon;

  return (
    <div className="my-2 flex justify-center" data-testid="call-history-item">
      <div
        className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ${
          isMissed
            ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        }`}
      >
        <Icon width={14} height={14} aria-hidden="true" />
        <span>{label}</span>
        <span className="text-slate-400">{formatMessageTime(entry.createdAt)}</span>
      </div>
    </div>
  );
}
