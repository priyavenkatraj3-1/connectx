import type { CallDTO } from "../../types/call";
import { Avatar } from "../ui/Avatar";
import { PhoneIcon, PhoneOffIcon, VideoIcon } from "../ui/icons";

interface IncomingCallDialogProps {
  call: CallDTO;
  /** Caller's name, plus the group name for group calls. */
  callerName: string;
  groupName?: string;
  onAccept(): void;
  onDecline(): void;
}

export function IncomingCallDialog({ call, callerName, groupName, onAccept, onDecline }: IncomingCallDialogProps) {
  const caller = call.participants.find((p) => p.userId === call.initiatorId);
  const kind = call.media === "video" ? "video call" : "voice call";

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex justify-center p-3 sm:p-4">
      <div
        role="alertdialog"
        aria-label={`Incoming ${kind} from ${callerName}`}
        className="flex w-full max-w-sm items-center gap-3 rounded-2xl bg-slate-900 p-4 text-white shadow-2xl ring-1 ring-white/10"
      >
        <div className="animate-pulse">
          <Avatar name={callerName} imageUrl={caller?.avatarUrl ?? undefined} size="md" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{callerName}</p>
          <p className="truncate text-xs text-white/70">
            Incoming {groupName ? `group ${kind} · ${groupName}` : kind}
          </p>
        </div>
        <button
          type="button"
          onClick={onDecline}
          aria-label="Decline call"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-600 hover:bg-red-700"
        >
          <PhoneOffIcon />
        </button>
        <button
          type="button"
          onClick={onAccept}
          aria-label={`Accept ${kind}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 hover:bg-emerald-700"
        >
          {call.media === "video" ? <VideoIcon /> : <PhoneIcon />}
        </button>
      </div>
    </div>
  );
}
