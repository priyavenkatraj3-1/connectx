/**
 * Database connection abstraction.
 *
 * Phase 1 intentionally does not wire up a live database driver. This module
 * defines the shape that later phases will implement (e.g. using `pg` for
 * PostgreSQL) so that services can be written against a stable interface
 * from the start.
 */

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface DatabaseClient {
  query<Row = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

/**
 * Placeholder pool. Real implementation (Phase 2+) will create a pooled
 * PostgreSQL connection using `env.databaseUrl` and expose `query`/
 * `transaction` helpers here.
 */
export const db: DatabaseClient = {
  async query() {
    throw new Error(
      "Database is not connected yet. This is a Phase 1 scaffold — wire up a real driver in a later phase."
    );
  },
};
