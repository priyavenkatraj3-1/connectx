import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { newDb } from "pg-mem";
import { createClientFromPgPool, type DatabaseClient, type PgPoolLike } from "../../src/db/pool";

const migrationsDir = join(__dirname, "..", "..", "..", "database", "migrations");

/**
 * Builds a fresh, fully-migrated DatabaseClient backed by pg-mem (an
 * in-memory PostgreSQL-compatible engine) instead of a real network
 * database. This lets integration tests exercise real SQL — real schema,
 * real constraints, real joins — without requiring a live PostgreSQL
 * server in this environment. Production always uses `createPostgresClient`
 * (real `pg` against a real database); this is test-only.
 */
export async function createTestDb(): Promise<DatabaseClient> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const client = createClientFromPgPool(new Pool() as unknown as PgPoolLike);

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await client.query(sql);
  }

  return client;
}
