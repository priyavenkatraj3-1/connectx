// Guard probe: proves tests/setup/no-real-db.ts refuses every real PostgreSQL connection. It never connects anywhere.
import pg from "pg";
import { describe, expect, it, vi, type MockInstance } from "vitest";

const GUARD = "Real PostgreSQL connections are disabled in tests; use createTestDb() (pg-mem).";
const CONFIG_PLACEHOLDER = "postgresql://blocked.invalid:1/blocked";
// `?host=/<path>` overrides the URL host (pg-connection-string), so if the guard
// ever failed pg would try a non-existent local socket path: no DNS, no TCP.
const LOCAL_DEAD_URL = "postgresql://unused/none?host=/nonexistent-connectx-guard-probe";
const LOCAL_DEAD_SOCKET = "/nonexistent-connectx-guard-probe/.s.PGSQL.1";

/** A cleanup step: a label for reporting, and the action that releases the resource. */
type Cleanup = { label: string; run: () => unknown };

const CLEANUP_TIMEOUT_MS = 3000;

/** Rejects with a labelled error if `promise` does not settle within `ms`. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`cleanup "${label}" timed out after ${ms} ms; the resource may still be open`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs `fn` with a call-through spy on the guarded Client#connect.
 *
 * Cleanup stack: `fn` pushes a labelled cleanup immediately after creating each
 * resource. Any error from `fn` (failed import, failed construction, failed
 * assertion) is caught and held, so cleanup always runs afterwards:
 *   1. runs every registered cleanup one at a time, newest first, each bounded
 *      by CLEANUP_TIMEOUT_MS and isolated so a failure can't skip the rest;
 *   2. restores the spy, then restores env vars stubbed with vi.stubEnv; each
 *      is attempted independently and a failure is recorded like a cleanup's;
 *   3. reports every failed or timed-out cleanup on stderr.
 * Then the body's own error, if any, is rethrown unchanged; cleanup failures
 * only fail the test when the body passed, so they never mask the real error.
 */
async function withProbe(fn: (spy: MockInstance, cleanups: Cleanup[]) => Promise<void>): Promise<void> {
  const spy = vi.spyOn(pg.Client.prototype, "connect");
  const cleanups: Cleanup[] = [];
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    await fn(spy, cleanups);
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  const failures: string[] = [];
  const recordFailure = (label: string, error: unknown) =>
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  for (const { label, run } of [...cleanups].reverse()) {
    try {
      await within(Promise.resolve().then(run), CLEANUP_TIMEOUT_MS, label);
    } catch (error) {
      recordFailure(label, error);
    }
  }
  try {
    spy.mockRestore();
  } catch (error) {
    recordFailure("spy.mockRestore()", error);
  }
  try {
    vi.unstubAllEnvs();
  } catch (error) {
    recordFailure("vi.unstubAllEnvs()", error);
  }
  if (failures.length > 0) {
    console.error(`PROBE CLEANUP FAILURES (${failures.length}):\n  ${failures.join("\n  ")}`);
  }

  // The body's error takes precedence; a cleanup failure only fails a body that passed.
  if (bodyFailed) throw bodyError;
  if (failures.length > 0) {
    throw new Error(`PROBE: ${failures.length} cleanup step(s) failed: ${failures.join("; ")}`);
  }
}

/** Asserts `error` is the guard's own Error, not a DNS / OS / socket error. */
function expectGuardError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(GUARD);
  // DNS / OS / socket errors carry errno fields (ENOTFOUND, ECONNREFUSED, ENOENT, etc.); the guard's Error has none.
  expect((error as NodeJS.ErrnoException).code).toBeUndefined();
  expect((error as NodeJS.ErrnoException).syscall).toBeUndefined();
}

/** Invokes and awaits `attempt`; it must be rejected by the guard, via this pg instance's (spied) Client#connect. */
async function expectGuardRejection(spy: MockInstance, attempt: () => Promise<unknown>): Promise<void> {
  const callsBefore = spy.mock.calls.length;
  // Started only after callsBefore is captured; a synchronous throw counts as a rejection.
  const outcome = await Promise.resolve()
    .then(attempt)
    .then(
      () => ({ rejected: false, error: undefined as unknown }),
      (error: unknown) => ({ rejected: true, error }),
    );
  expect(outcome.rejected, "attempt was not rejected").toBe(true);
  expectGuardError(outcome.error);
  expect(spy.mock.calls.length).toBeGreaterThan(callsBefore);
}

describe("test database guard probe", () => {
  it("1. vitest test.env overrides are present", () => {
    expect(process.env.TEST_DATABASE_URL).toBe("");
    expect(process.env.NODE_PG_FORCE_NATIVE).toBe("");
    expect(process.env.DATABASE_URL === CONFIG_PLACEHOLDER, "DATABASE_URL is not the config placeholder").toBe(true);
  });

  it("2. pg.Pool query is refused by the guard", () =>
    withProbe(async (spy, cleanups) => {
      const pool = new pg.Pool({ connectionString: LOCAL_DEAD_URL });
      cleanups.push({ label: "pool.end()", run: () => pool.end() });
      await expectGuardRejection(spy, () => pool.query("select 1"));
      expect(typeof spy.mock.calls.at(-1)?.[0], "pg-pool connects through Client#connect(callback)").toBe("function");
    }));

  it("3. pg.Client connect is refused by the guard", () =>
    withProbe(async (spy, cleanups) => {
      const client = new pg.Client({ connectionString: LOCAL_DEAD_URL });
      cleanups.push({ label: "client.end()", run: () => client.end() });
      await expectGuardRejection(spy, () => client.connect());
    }));

  it("4. Connection#connect backstop throws the guard error", () =>
    withProbe(async (_spy, cleanups) => {
      const connection = new pg.Connection();
      cleanups.push({ label: "connection.stream.destroy()", run: () => connection.stream.destroy() });
      let thrown: unknown = undefined;
      try {
        (connection as unknown as { connect: (path: string) => void }).connect(LOCAL_DEAD_SOCKET);
      } catch (error) {
        thrown = error;
      }
      expectGuardError(thrown);
    }));

  it("5. the app's createPostgresClient is refused (safe URL set before import)", () =>
    withProbe(async (spy, cleanups) => {
      expect(process.env.DATABASE_URL === CONFIG_PLACEHOLDER, "DATABASE_URL is not the config placeholder").toBe(true);
      // Stubbed BEFORE src/config/env.ts / src/db/pool.ts are imported; restored by withProbe's finally.
      vi.stubEnv("DATABASE_URL", LOCAL_DEAD_URL);
      // Bottom of the stack, so it runs last, after the pool below is closed. Not a resource cleanup.
      cleanups.push({ label: "vi.resetModules()", run: () => vi.resetModules() });

      const { env } = await import("../src/config/env");
      const { createPostgresClient } = await import("../src/db/pool");
      // dotenv loaded backend/.env during that import; it must not have replaced the stubbed value.
      expect(env.databaseUrl === LOCAL_DEAD_URL, "env.databaseUrl did not come from the test environment").toBe(true);

      const db = createPostgresClient(LOCAL_DEAD_URL);
      cleanups.push({ label: "createPostgresClient().close()", run: () => db.close() });
      await expectGuardRejection(spy, () => db.query("select 1"));
      await expectGuardRejection(spy, () => db.withTransaction(async () => undefined));
    }));

  it("6. the app's getDb() is refused (safe URL set before import)", () =>
    withProbe(async (spy, cleanups) => {
      expect(process.env.DATABASE_URL === CONFIG_PLACEHOLDER, "DATABASE_URL is not the config placeholder").toBe(true);
      vi.stubEnv("DATABASE_URL", LOCAL_DEAD_URL);
      cleanups.push({ label: "vi.resetModules()", run: () => vi.resetModules() });

      const { env } = await import("../src/config/env");
      const { getDb } = await import("../src/db/pool");
      // getDb() uses env.databaseUrl; only call it once that is proven to be the safe URL.
      expect(env.databaseUrl === LOCAL_DEAD_URL, "env.databaseUrl did not come from the test environment").toBe(true);

      const shared = getDb();
      cleanups.push({ label: "getDb().close()", run: () => shared.close() });
      await expectGuardRejection(spy, () => shared.query("select 1"));
    }));
});
// END OF FILE (166 lines)
