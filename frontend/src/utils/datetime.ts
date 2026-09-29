/** The browser's IANA timezone, e.g. "Europe/Berlin" (UTC if it can't be determined). */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * An instant as the "YYYY-MM-DDTHH:mm" wall-clock value of `timezone` —
 * the format <input type="datetime-local"> uses. Used to pre-fill inputs.
 */
export function toLocalInputValue(iso: string | Date, timezone: string): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  } catch {
    return date.toISOString().slice(0, 16);
  }
}

/** "Tue, 1 Oct, 09:00" in the viewer's locale and the given (or browser) timezone. */
export function formatDateTime(iso: string | null | undefined, timezone?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function isPast(iso: string | null | undefined): boolean {
  return !!iso && new Date(iso).getTime() < Date.now();
}
