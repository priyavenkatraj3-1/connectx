import { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../utils/logger";

/**
 * Thin abstraction over a SQL connection so repositories depend on this
 * interface instead of the `pg` package directly. Production wiring
 * (server.ts / app.ts) uses `createPostgresClient()`; tests inject a
 * pg-mem-backed implementation built with `createClientFromPgPool` — see
 * backend/tests/helpers/testDb.ts.
 */
export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface DatabaseClient {
  query<Row = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  /** Runs `fn` with a client dedicated to one transaction, committing on success and rolling back on error. */
  withTransaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The subset of `pg.Pool`'s API this module depends on — also implemented by pg-mem's `pg` adapter, which is what makes it swappable in tests. */
export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    release(): void;
  }>;
  end(): Promise<void>;
}

/** Wraps any pg-compatible pool (real `pg.Pool` or pg-mem's adapter) in the DatabaseClient shape. */
export function createClientFromPgPool(pool: PgPoolLike): DatabaseClient {
  return {
    async query<Row = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    },

    async withTransaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: DatabaseClient = {
          query: async <Row = unknown>(sql: string, params: unknown[] = []) => {
            const result = await client.query(sql, params);
            return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
          },
          withTransaction: () => {
            throw new Error("Nested transactions are not supported");
          },
          close: async () => undefined,
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Real PostgreSQL-backed implementation of DatabaseClient using `pg`'s
 * connection pool. Requires `DATABASE_URL` to point at a real, migrated
 * database — see docs/database.md and the root README for setup steps.
 */
export function createPostgresClient(connectionString: string = env.databaseUrl): DatabaseClient {
  const pool = new Pool({ connectionString });
  // An idle client dropped by the server (e.g. Neon restarting or suspending)
  // is emitted on the pool; without a listener it would crash the process.
  // The pool discards that client and opens a new one on the next query.
  pool.on("error", (err) => logger.error("[database] idle client error", err));
  return createClientFromPgPool(pool);
}

let sharedClient: DatabaseClient | null = null;

/** Lazily creates the process-wide database client used by production wiring. */
export function getDb(): DatabaseClient {
  if (!sharedClient) {
    sharedClient = createPostgresClient();
  }
  return sharedClient;
}
