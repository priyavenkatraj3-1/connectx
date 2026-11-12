import { formatDuration, MAX_RECORDING_SECONDS } from "../../lib/media/voiceRecording";
import type { VoiceRecorderStatus } from "../../hooks/useVoiceRecorder";
import { StopIcon, TrashIcon } from "../ui/icons";

interface VoiceRecorderBarProps {
  status: Exclude<VoiceRecorderStatus, "idle">;
  elapsedSeconds: number;
  onStop(): void;
  onCancel(): void;
}

/** Replaces the composer's input row while a voice message is being recorded. */
export function VoiceRecorderBar({ status, elapsedSeconds, onStop, onCancel }: VoiceRecorderBarProps) {
  const recording = status === "recording";
  return (
    <div className="flex flex-1 items-center gap-3" data-testid="voice-recorder">
      <button
        type="button"
        onClick={onCancel}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:text-slate-400 dark:hover:bg-slate-800"
        aria-label="Discard recording"
        title="Discard recording"
      >
        <TrashIcon />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm dark:border-slate-700 dark:bg-surface-dark-subtle">
        {recording ? (
          <>
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
            <span className="font-medium text-slate-900 dark:text-slate-100">Recording</span>
            <span role="timer" aria-label="Recording duration" className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
              {formatDuration(elapsedSeconds)}
            </span>
            <span className="ml-auto hidden text-xs text-slate-400 sm:inline">max {formatDuration(MAX_RECORDING_SECONDS)}</span>
          </>
        ) : (
          <span role="status" className="text-slate-500 dark:text-slate-400">
            Waiting for microphone permission…
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onStop}
        disabled={!recording}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40"
        aria-label="Stop recording"
        title="Stop and preview"
      >
        <StopIcon width={18} height={18} />
      </button>
    </div>
  );
}
