/**
 * Minimal leveled logger (Phase 7). Writes to stdout/stderr so any process
 * manager or container runtime can collect it. LOG_LEVEL selects the
 * minimum level: error | warn | info (default) | debug | silent.
 *
 * Never pass passwords, tokens, API keys, SDP/ICE payloads or message
 * content to these functions. Errors are logged with their stack for the
 * operator; stacks never reach API responses (see middleware/errorHandler).
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function parseLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized in RANK) return normalized as LogLevel;
  // Tests stay quiet unless something is actually wrong.
  return process.env.NODE_ENV === "test" ? "error" : "info";
}

let threshold = RANK[parseLevel(process.env.LOG_LEVEL)];

/** Overrides LOG_LEVEL at runtime (used by tests). */
export function setLogLevel(level: LogLevel): void {
  threshold = RANK[level];
}

function enabled(level: Exclude<LogLevel, "silent">): boolean {
  return RANK[level] <= threshold;
}

/**
 * Replaces credentials in connection strings / URLs
 * (`postgresql://user:secret@host` → `postgresql://user:****@host`).
 */
export function redactUrl(value: string): string {
  return value.replace(/(\/\/[^:/@\s]+:)[^@\s]*@/g, "$1****@");
}

export const logger = {
  error(message: string, err?: unknown): void {
    if (enabled("error")) console.error(message, ...(err === undefined ? [] : [err]));
  },
  warn(message: string, err?: unknown): void {
    if (enabled("warn")) console.warn(message, ...(err === undefined ? [] : [err]));
  },
  info(message: string): void {
    if (enabled("info")) console.log(message);
  },
  debug(message: string): void {
    if (enabled("debug")) console.log(message);
  },
};
