import { Link } from "react-router-dom";
import { ApiError } from "../../services/apiClient";
import type { AIGeneratedBy, AISourceReference } from "../../types/ai";
import { formatMessageTime } from "../../utils/formatTime";

/** A caught error as something the AI UI can show: the server's (already user-safe) message plus its code. */
export interface AIErrorInfo {
  message: string;
  code: string | undefined;
}

export function toAIError(err: unknown, fallback = "Something went wrong. Please try again."): AIErrorInfo {
  if (err instanceof ApiError) return { message: err.message, code: err.code };
  return { message: err instanceof Error ? err.message : fallback, code: undefined };
}

/** Error / unavailable state for AI features, with a route to Settings when the fix is a setting. */
export function AIErrorNotice({ error }: { error: AIErrorInfo }) {
  const isSetting = error.code === "ai_disabled" || error.code === "ai_conversation_excluded";
  const tone =
    error.code === "ai_not_configured"
      ? "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
      : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
  return (
    <div role="alert" className={`rounded-lg border px-3 py-2 text-sm ${tone}`}>
      <p>{error.message}</p>
      {isSetting && (
        <Link to="/app/settings" className="mt-1 inline-block text-xs font-semibold underline">
          Open AI settings
        </Link>
      )}
    </div>
  );
}

/** Every AI output is labeled as such, with the model that produced it. */
export function AIGeneratedLabel({ generatedBy, cached }: { generatedBy: AIGeneratedBy | null; cached?: boolean }) {
  return (
    <p className="text-[11px] text-slate-400">
      AI-generated{generatedBy ? ` · ${generatedBy.model}` : ""}
      {cached ? " · saved result" : ""} · may be inaccurate
    </p>
  );
}

export function SourceList({ sources }: { sources: AISourceReference[] }) {
  if (sources.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5" aria-label="Sources">
      {sources.map((source) => (
        <li key={source.messageId} className="rounded-md bg-slate-100 px-2 py-1.5 text-xs dark:bg-slate-800">
          <p className="font-medium text-slate-700 dark:text-slate-200">
            {source.senderName} · {source.conversationTitle} · {formatMessageTime(source.createdAt)}
          </p>
          <Link
            to={`/app/chat/${source.conversationId}`}
            className="line-clamp-3 text-slate-500 hover:underline dark:text-slate-400"
            title="Open this chat"
          >
            “{source.excerpt}”
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 border-b border-slate-100 py-4 last:border-0 dark:border-slate-800">
      <span>
        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{label}</span>
        <span className="block text-sm text-slate-500 dark:text-slate-400">{description}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="mt-1 h-5 w-9 shrink-0 cursor-pointer accent-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
    </label>
  );
}
