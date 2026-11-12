import { Client, Connection } from "pg";

/**
 * Fail closed: automated tests never open a real PostgreSQL connection.
 * Every pg connection (pg.Pool via pg-pool's `new this.Client`, a direct
 * pg.Client, src/db/pool.ts, src/db/migrate.ts, tests/helpers/testDb.ts)
 * goes through Client.prototype.connect, so refusing it here blocks them
 * all before any SQL (including testDb.ts's DROP SCHEMA) is sent.
 * pg-mem never loads `pg`, so createTestDb()'s default path is unaffected.
 */
const refused = () =>
  new Error("Real PostgreSQL connections are disabled in tests; use createTestDb() (pg-mem).");

Client.prototype.connect = function connect(callback?: (err: Error) => void) {
  const err = refused();
  if (typeof callback === "function") {
    process.nextTick(callback, err);
    return undefined;
  }
  return Promise.reject(err);
} as unknown as typeof Client.prototype.connect;

// Backstop: the only place pg's JS driver opens a socket (lib/connection.js),
// also reached by Client#cancel without going through connect(). @types/pg
// doesn't declare Connection#connect, hence the cast.
(Connection.prototype as unknown as { connect: () => never }).connect = function connect() {
  throw refused();
};
