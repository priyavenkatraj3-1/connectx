import { randomUUID } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { env } from "../config/env";

/**
 * Minimal, dependency-free migration runner: applies every .sql file in
 * database/migrations, in filename order, that hasn't already been
 * recorded in `schema_migrations`. Safe to run repeatedly.
 *
 * Usage: npm run db:migrate --workspace=backend
 * Requires DATABASE_URL to point at an existing, empty (or previously
 * migrated) PostgreSQL database — see README.md for setup instructions.
 */

// backend compiles to CommonJS, so __dirname is available natively (no
// import.meta workaround needed). This file lives at backend/src/db/.
const migrationsDir = join(__dirname, "..", "..", "..", "database", "migrations");

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: env.databaseUrl });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id UUID PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    const appliedNames = new Set(applied.rows.map((row) => row.filename));

    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log(`No migration files found in ${migrationsDir}`);
      return;
    }

    for (const file of files) {
      if (appliedNames.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), "utf8");
      console.log(`apply ${file}`);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id, filename) VALUES ($1, $2)", [randomUUID(), file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        client.release();
      }
    }

    console.log("Migrations up to date.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
