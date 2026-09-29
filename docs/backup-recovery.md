# Backup and recovery

ConnectX keeps state in three places. None of them is backed up by the
application itself — you must set this up. Nothing in this document was
exercised against a production system during Phase 7; commands are
standard PostgreSQL/filesystem tooling, not ConnectX-specific scripts.

| State | Where | Back up? |
|---|---|---|
| Accounts, messages, groups, statuses, calls history, AI data, tasks, sessions… | PostgreSQL | **Yes — primary** |
| Uploaded media (attachments, status media) | `UPLOAD_DIR` on disk | **Yes — together with the database** |
| Online presence, call bindings, rate-limit counters, scheduler loop | Backend process memory | No — rebuilt on restart |
| Offline cache, queued drafts, tokens | Each user's browser (`localStorage`) | No — per device |

## PostgreSQL

Expectations for a real deployment:

- **Nightly logical dumps at minimum**, retained for e.g. 14–30 days, stored
  off the database host and encrypted (they contain every message in
  plaintext — ConnectX has no end-to-end encryption).
  ```bash
  pg_dump --format=custom --no-owner --file=connectx-$(date +%F).dump "$DATABASE_URL"
  ```
- For lower data loss, use your provider's point-in-time recovery (WAL
  archiving) instead of, or in addition to, dumps.
- **Rehearse a restore** into a scratch database before you need it:
  ```bash
  createdb connectx_restore_test
  pg_restore --no-owner --dbname=connectx_restore_test connectx-2026-10-01.dump
  ```
- The `schema_migrations` table is part of the dump, so a restored database
  knows which migrations it already has.

## Migrations and rollback

- Migrations (`database/migrations/NNN_*.sql`) are forward-only. Each runs
  in its own transaction, so a failing migration leaves the database at the
  previous version, and the runner is safe to re-run.
- **There are no down-migrations.** Rolling back a release means restoring
  the backup taken *before* running its migrations — which also discards
  everything written since. So: back up → migrate → deploy, and keep the
  previous release's build around until the new one is confirmed healthy.
- Past migrations include deliberate table re-creations of never-used
  placeholder tables (`003` statuses, `004` AI tables, `005`
  notifications). They are safe on a database created by this project's
  own earlier migrations; they would drop data if someone had put data into
  those placeholder tables by other means. Check before applying to an
  unusual database.
- Never edit a migration that has already been applied anywhere; add a new
  one.

## Media (`UPLOAD_DIR`)

- Files are stored as `<conversationId>/<attachmentId>` and
  `statuses/<ownerId>/<attachmentId>`; the `attachments` table points at
  them. Back up the directory **at the same time** as the database
  (snapshot both, or dump the DB first and copy files right after). A
  database restored without its files shows broken attachments
  ("content unavailable"); files without rows are unreachable orphans.
- Files are unencrypted on disk; protect the backup accordingly.
- Expired statuses delete their media automatically; deleted messages
  delete their attachment bytes best-effort. Uploads that were never sent
  are **not** cleaned up.

## Sessions and tokens after a restore or incident

- Restoring an older database brings back the sessions table as of the
  backup: sessions created later disappear (those users must sign in
  again), and sessions revoked later are *active again* until their
  original expiry. After restoring, consider revoking all sessions
  (`UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;`) so
  everyone signs in fresh — this is a deliberate, destructive operator
  action; run it only if you intend it.
- **Rotating `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`** invalidates every
  token immediately (everyone is signed out). Do this if a secret may have
  leaked.
- Refresh tokens are stored only as SHA-256 hashes, so a leaked database
  dump doesn't contain usable refresh tokens — but it does contain every
  message, bcrypt password hashes and AI data. Treat a leaked dump as a
  serious breach.

## Recovery considerations

- **Backend crash/restart**: calls that were live are marked failed on
  startup; scheduled messages left "sending" are re-queued (sends are
  idempotent, so nothing is posted twice); overdue reminders/scheduled
  messages fire on the first scheduler tick; clients reconnect
  automatically and resynchronize.
- **Database outage**: `/health/ready` returns `503`; API calls fail with
  `500` ("Internal server error"); the process keeps running and recovers
  when the database returns. Messages queued offline in browsers are
  retried by the clients.
- **Lost `UPLOAD_DIR`** without a backup: messages survive but their
  attachments are gone permanently.
- **Clients**: each browser's offline cache is disposable; it is purged on
  sign-in to another account and on sign-out.
- ConnectX has no built-in data export, account deletion workflow or
  retention policy; implement those according to your legal requirements.
