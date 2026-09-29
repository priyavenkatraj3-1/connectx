import { describe, expect, it } from "vitest";
import { AppError } from "../../src/middleware/errorHandler";
import { assertSaneDate, isValidTimezone, resolveDateInput, zonedLocalToUtc } from "../../src/utils/datetime";

describe("timezone handling (utils/datetime)", () => {
  it("converts a wall-clock time in a zone to UTC", () => {
    expect(zonedLocalToUtc("2026-01-15T09:00", "Europe/Berlin").toISOString()).toBe("2026-01-15T08:00:00.000Z"); // CET, UTC+1
    expect(zonedLocalToUtc("2026-07-15T09:00", "Europe/Berlin").toISOString()).toBe("2026-07-15T07:00:00.000Z"); // CEST, UTC+2
    expect(zonedLocalToUtc("2026-07-15T09:00", "Asia/Kolkata").toISOString()).toBe("2026-07-15T03:30:00.000Z"); // UTC+5:30
    expect(zonedLocalToUtc("2026-07-15T09:00:30", "UTC").toISOString()).toBe("2026-07-15T09:00:30.000Z");
  });

  it("rejects a time skipped by a spring-forward DST change", () => {
    // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 → 03:00).
    expect(() => zonedLocalToUtc("2026-03-08T02:30", "America/New_York")).toThrow(AppError);
  });

  it("resolves an ambiguous fall-back time to its first occurrence", () => {
    // 2026-11-01 01:30 happens twice in New York; the first is EDT (UTC-4).
    expect(zonedLocalToUtc("2026-11-01T01:30", "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("rejects impossible dates, malformed input and unknown zones", () => {
    expect(() => zonedLocalToUtc("2026-02-30T10:00", "UTC")).toThrow(/does not exist/);
    expect(() => zonedLocalToUtc("tomorrow", "UTC")).toThrow(/YYYY-MM-DDTHH:mm/);
    expect(() => zonedLocalToUtc("2026-02-10T10:00", "Mars/Olympus")).toThrow(/Unknown timezone/);
    expect(isValidTimezone("Europe/Paris")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });

  it("resolveDateInput prefers an absolute instant, needs a zone for local times, and supports clearing", () => {
    expect(resolveDateInput("dueAt", "2026-05-01T10:00:00+02:00", "2026-05-01T23:00", "UTC")!.toISOString()).toBe("2026-05-01T08:00:00.000Z");
    expect(resolveDateInput("dueAt", undefined, "2026-05-01T10:00", "America/Los_Angeles")!.toISOString()).toBe("2026-05-01T17:00:00.000Z");
    expect(resolveDateInput("dueAt", undefined, undefined, "UTC")).toBeUndefined();
    expect(resolveDateInput("dueAt", null, undefined, "UTC")).toBeNull();
    expect(() => resolveDateInput("dueAt", undefined, "2026-05-01T10:00", null)).toThrow(/timezone is required/);
  });

  it("rejects dates outside the supported range", () => {
    expect(() => assertSaneDate(new Date("2150-01-01T00:00:00Z"), "dueAt")).toThrow(/between/);
    expect(() => assertSaneDate(new Date("nope"), "dueAt")).toThrow(/not a valid date/);
  });
});
