import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { newDb } from "pg-mem";
import { createClientFromPgPool, type DatabaseClient, type PgPoolLike } from "../../src/db/pool";

const migrationsDir = join(__dirname, "..", "..", "..", "database", "migrations");

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Builds a fresh, fully-migrated DatabaseClient.
 *
 * Default: backed by pg-mem (an in-memory PostgreSQL-compatible engine),
 * so the suite runs anywhere with no database server. This exercises real
 * SQL — real schema, constraints and joins — without a live PostgreSQL.
 *
 * Opt-in: set TEST_DATABASE_URL to run the same suite against a real
 * PostgreSQL server. Each test worker gets its own throwaway schema
 * (dropped and re-created, then migrated, on every call), so nothing
 * outside that schema is touched. See README "Running tests against real
 * PostgreSQL".
 */
export async function createTestDb(): Promise<DatabaseClient> {
  const realUrl = process.env.TEST_DATABASE_URL;
  return realUrl ? createRealPostgresTestDb(realUrl) : createPgMemTestDb();
}

async function createPgMemTestDb(): Promise<DatabaseClient> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool: MemPool } = mem.adapters.createPg();
  const client = createClientFromPgPool(new MemPool() as unknown as PgPoolLike);

  for (const file of migrationFiles()) {
    await client.query(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return client;
}

let previousRealPool: Pool | null = null;

async function createRealPostgresTestDb(connectionString: string): Promise<DatabaseClient> {
  const schema = `connectx_test_w${process.env.VITEST_POOL_ID ?? "0"}`;

  // Close the previous test's pool so repeated calls don't exhaust connections.
  if (previousRealPool) {
    await previousRealPool.end().catch(() => undefined);
    previousRealPool = null;
  }

  const admin = new Pool({ connectionString, max: 1 });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  previousRealPool = pool;
  const client = createClientFromPgPool(pool);
  for (const file of migrationFiles()) {
    await client.query(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return client;
}
