import { AppError } from "../middleware/errorHandler";

/**
 * Timezone helpers for user-entered dates (Phase 6). The API accepts either
 * an absolute ISO-8601 instant with an offset ("2026-10-01T09:00:00Z") or a
 * wall-clock time ("2026-10-01T09:00") plus an IANA timezone; the latter is
 * converted to UTC here, on the server, so "9:00 in Europe/Berlin" means
 * the same instant whatever the client's clock or locale says.
 */

export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockIn(instant: Date, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset of `timezone` from UTC at `instant`, in milliseconds (positive east of UTC). */
function offsetAt(instant: Date, timezone: string): number {
  const wall = wallClockIn(instant, timezone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

/**
 * Converts a wall-clock time in `timezone` to the UTC instant. Throws a 400
 * for malformed input, impossible dates (Feb 30), and times skipped by a
 * DST change (02:30 on a spring-forward night). An ambiguous fall-back time
 * resolves to its first (earlier) occurrence.
 */
export function zonedLocalToUtc(local: string, timezone: string): Date {
  const match = LOCAL_PATTERN.exec(local);
  if (!match) throw new AppError("Local date-time must look like YYYY-MM-DDTHH:mm", 400);
  if (!isValidTimezone(timezone)) throw new AppError("Unknown timezone", 400);
  const [year, month, day, hour, minute, second] = match.slice(1).map((value) => Number(value ?? "0")) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes converge on the right offset, including across DST changes.
  const earlierOffset = offsetAt(new Date(naiveUtc - 24 * 3600_000), timezone);
  const laterOffset = offsetAt(new Date(naiveUtc + 24 * 3600_000), timezone);
  const candidates = [naiveUtc - Math.max(earlierOffset, laterOffset), naiveUtc - Math.min(earlierOffset, laterOffset)];

  for (const candidate of candidates) {
    const wall = wallClockIn(new Date(candidate), timezone);
    if (
      wall.year === year &&
      wall.month === month &&
      wall.day === day &&
      wall.hour === hour &&
      wall.minute === minute &&
      wall.second === second
    ) {
      return new Date(candidate);
    }
  }
  throw new AppError(`${local} does not exist in ${timezone} (invalid date or skipped by a daylight-saving change)`, 400);
}

/** Rejects dates outside the supported range (catches typos like year 20260). */
export function assertSaneDate(date: Date, field: string): Date {
  if (Number.isNaN(date.getTime())) throw new AppError(`${field} is not a valid date`, 400);
  const year = date.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) throw new AppError(`${field} must be between ${MIN_YEAR} and ${MAX_YEAR}`, 400);
  return date;
}

/**
 * Resolves a date field from an API body: `iso` (absolute, with offset)
 * wins; otherwise `local` is read in `timezone` (falling back to the user's
 * preferred timezone). Returns undefined when neither is present, null when
 * the client explicitly cleared it.
 */
export function resolveDateInput(
  field: string,
  iso: string | null | undefined,
  local: string | null | undefined,
  timezone: string | null | undefined
): Date | null | undefined {
  if (iso === null || local === null) return null;
  if (iso !== undefined) return assertSaneDate(new Date(iso), field);
  if (local !== undefined) {
    if (!timezone) throw new AppError(`A timezone is required to interpret ${field}`, 400);
    return assertSaneDate(zonedLocalToUtc(local, timezone), field);
  }
  return undefined;
}
