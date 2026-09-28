# Database

Full DDL lives in [`database/migrations/`](../database/migrations/)
(PostgreSQL), applied in order by `backend/src/db/migrate.ts`
(`npm run db:migrate --workspace=backend`). This document explains the
*why* behind the shape of it.

Two conventions worth knowing before reading the DDL:

- **IDs are generated application-side** (`crypto.randomUUID()`, see
  `backend/src/utils/id.ts`), not via a database default. This avoids
  depending on the `pgcrypto` extension being enabled, so setup is just
  "create a database" — no extensions to remember.
- **Email uniqueness is a plain `UNIQUE` constraint on a lowercased
  value** — the application normalizes email to lowercase before every
  insert/query (see `modules/auth/auth.validation.ts`), so no `citext`
  extension is needed either.

## Entity groups

### Identity

| Table | Purpose |
|---|---|
| `users` | Core account: email, password hash, display name |
| `user_profiles` | Optional profile data (avatar, bio, status, locale) — 1:1 with `users`, split out so hot auth queries don't touch rarely-changed profile fields |
| `devices` | One row per device a user has logged in from — enables multi-device support and per-device sign-out |
| `sessions` | One row per refresh-token-bearing login — enables server-side session revocation and "active sessions" UI |

### Messaging

| Table | Purpose |
|---|---|
| `conversations` | A direct (1:1) or group thread. Groups also get a row in `groups` |
| `conversation_members` | Membership + per-member read state (`last_read_message_id`) and mute state |
| `messages` | Message content, soft-deletable via `deleted_at`, supports replies via `reply_to_message_id` |
| `message_reactions` | Composite-keyed (message, user, emoji) so a user can react with multiple distinct emoji but not duplicate the same one |
| `message_receipts` | One row per (message, recipient) tracking `delivered`/`read` status — see below |
| `attachments` | File metadata; `message_id` is nullable so an attachment can be uploaded before the message that references it is created |

`message_receipts` is what powers sent/delivered/read ticks: a message
with no receipt row for a recipient is "sent" only; a `delivered` row is
written the instant that recipient's WebSocket connection receives it; a
`read` row is written when they mark the conversation read
(`MessagesRepository.markReadUpTo`, upserted so a status never regresses
from `read` back to `delivered`).

Since Phase 3 a message can have many recipients, so the status shown to
the sender is an **aggregate** computed in `MessagesRepository`
(`aggregateStatus`): the recipients are the conversation's active members,
other than the sender, who had joined by the time the message was sent;
the message is `delivered`/`read` only when every one of them has a
receipt in that state. For a direct conversation (one recipient) this is
exactly the Phase 2 behavior.

`message_mentions` (Phase 3) records which users a message @mentions —
one row per (message, user), validated server-side to be conversation
members. Replies use the Phase 1 `messages.reply_to_message_id` column
(now indexed). Deleting a message is a soft delete: `deleted_at` is set
and `body` is cleared, so replies keep a valid foreign key but can no
longer show the original content.

### Groups

| Table | Purpose |
|---|---|
| `groups` | 1:1 with a `conversations` row of type `group` — keeps group-specific metadata (name, description, avatar) out of the generic `conversations` table |
| `group_members` | The role (`owner` / `admin` / `member`) of each *active* group member |

**Membership model (Phase 3).** `conversation_members` remains the single
source of truth for *access* — "can this user read/send in this
conversation?" (`left_at IS NULL`) — for direct and group conversations
alike, so every Phase 2 authorization check (`requireConversationMember`)
covers groups unchanged. `group_members` holds only the *role*, and a row
exists there only while the user is an active member. `GroupsRepository`
writes both tables in the same transaction for every create / add /
remove / leave, so they can't drift.

Integrity rules enforced by the database, not just the app:

- `PRIMARY KEY (group_id, user_id)` — no duplicate memberships.
- `uq_group_members_one_owner` — a partial unique index on
  `group_members(group_id) WHERE role = 'owner'`: at most one owner per
  group. When an owner leaves, their row is deleted *before* the successor
  is promoted, inside one transaction, so the index is never violated.
- `CHECK (role IN ('owner','admin','member'))` and
  `groups.conversation_id UNIQUE` (one group per conversation).

Leaving/removal sets `conversation_members.left_at` rather than deleting
the row. Re-adding someone clears `left_at` and resets `joined_at` and
their read marker — and because history visibility is "messages sent at or
after `joined_at`", a re-added member does not regain access to what was
said before or while they were away.

### Attachments (media foundation, Phase 3)

`attachments` existed since Phase 1 but was never written to; migration
002 completes it with `conversation_id` (NOT NULL, `ON DELETE CASCADE`),
`original_filename` (sanitized, display-only), `kind`
(`image`/`video`/`audio`/`document`/`file`), and `updated_at`, plus a
unique index on `storage_key`. An upload creates a row with
`message_id = NULL`; sending a message sets `message_id` with a
conditional `UPDATE … WHERE message_id IS NULL` so the same upload can't be
attached twice concurrently. The bytes live outside the database behind
the `StorageProvider` interface (local disk in development); the row
stores only the opaque `storage_key` (`<conversationId>/<attachmentId>`,
or `statuses/<ownerId>/<attachmentId>` for status media — Phase 4 adds
`purpose` = `message` | `status`).

### Calls (Phase 4)

| Table | Purpose |
|---|---|
| `call_sessions` | One call: conversation, initiator, `scope` (direct/group), `media` (voice/video), `state`, `end_reason`, `created_at`/`answered_at`/`connected_at`/`ended_at`, `duration_seconds`. Partial unique index `uq_call_sessions_one_live_per_conversation` (`WHERE ended_at IS NULL`); `CHECK ((ended_at IS NULL) = state IN live states)` |
| `call_participants` | `PRIMARY KEY (call_id, user_id)` — one row per user per call: `role` (initiator/invitee), `state` (invited/ringing/joined/declined/missed/left), join/leave times |
| `call_events` | Metadata-only audit trail (created, ringing, accepted, joined, declined, cancelled, connected, left, ended, missed, failed). Never SDP/ICE/media |

All cascade from `conversations` / `call_sessions`; `call_events.actor_id`
is `SET NULL`. See [calls.md](./calls.md).

### Status / stories, notifications, privacy

| Table | Purpose |
|---|---|
| `statuses` | **Re-created in Phase 4** (the Phase 1 placeholder was never written to): `content_type`, `body`, `background_color`, unique `attachment_id`, `visibility` (everyone/contacts/selected/except), server-set `expires_at` (`CHECK expires_at > created_at`) |
| `status_audience` | Per-status allow-list (`selected`) / deny-list (`except`) |
| `status_views` | `PRIMARY KEY (status_id, viewer_id)` — one view record per user per status |
| `status_privacy_settings` / `status_privacy_users` | A user's default status visibility and list |
| `notifications` | Generic notification envelope with a `payload` JSONB column so new notification types don't require schema changes |
| `privacy_settings` | 1:1 with `users`; **also the AI consent record** (`ai_features_enabled`, `ai_memory_enabled`, and from Phase 5 `ai_chat_retrieval_enabled`, `ai_spam_shield_enabled`, `ai_voice_enabled`, `ai_preferred_language`, `ai_consented_at`) |

### AI (deliberately isolated, Phase 5)

Every AI table references its owning user `ON DELETE CASCADE`. See [ai.md](./ai.md#data-stored--retention).

| Table | Purpose |
|---|---|
| `ai_conversation_exclusions` | Chats a user excluded from their own AI features |
| `ai_memories` | **Re-created in Phase 5.** User-written memory items (`preference`/`fact`/`context`/`working`), optional source message. Never extracted automatically |
| `ai_actions` | **Re-created in Phase 5.** Suggested tasks/reminders/deadlines/events with `status` `suggested` → `confirmed`/`dismissed` only by explicit user action. Nothing here schedules anything |
| `ai_translations` | Translation cache per (message, language), tied to a SHA-256 of the source text; purged on edit/delete |
| `ai_message_flags` | Scam-warning dismiss/report per (user, message) |
| `ai_voice_results` | Transcript / summary / action items per (user, audio attachment) |
| `ai_usage` | Replaces `ai_conversations`. Metadata only (feature, provider, model, status, tokens, latency) — **never prompt or output text**. Also backs the daily AI limit |

## Why AI data is isolated

Three reasons, all deliberate:

1. **Deletion safety.** A user can delete all their AI memories/history
   without any risk of that cascade touching real conversation data (the
   foreign keys from AI tables to `conversations`/`messages` are
   `ON DELETE SET NULL`, not the other way around).
2. **Auditability.** It's always possible to answer "what did the AI
   generate about this user, and from what" without joining through core
   messaging tables.
3. **Consent enforcement.** Every AI table is reachable only through
   `privacy_settings`-gated services (see `docs/ai-roadmap.md`), so consent
   checking has one obvious place to live.

## Indexing notes

- `messages(conversation_id, created_at DESC)` — the dominant query pattern
  is "most recent messages in a conversation."
- Partial indexes (`WHERE read_at IS NULL`, `WHERE confirmed_at IS NULL`,
  `WHERE deleted_at IS NULL`-style predicates) are used where a query
  pattern only ever cares about one state (e.g. unread notifications,
  unconfirmed AI actions), keeping the index small.
- `sessions(expires_at)` supports a cleanup job that purges expired
  sessions without a full table scan.

## Migrations

| File | Phase | Contents |
|---|---|---|
| `001_initial_schema.sql` | 1–2 | Every Phase 1/2 table |
| `002_groups_media.sql` | 3 | `groups.updated_at`, `group_members.updated_at`, one-owner partial unique index, active-members index, `message_mentions`, reply index, attachment columns + indexes. Purely additive — no existing data is modified |
| `003_calls_status.sql` | 4 | `call_sessions`, `call_participants`, `call_events`; `attachments.purpose` (default `message`) with `conversation_id` now nullable for status media (a `CHECK` keeps message attachments tied to a conversation); `statuses` dropped and re-created (never used before), `status_audience`, `status_views`, `status_privacy_settings`, `status_privacy_users`. Existing rows untouched |
| `004_ai_layer.sql` | 5 | New `privacy_settings` AI columns; `ai_conversation_exclusions`, `ai_translations`, `ai_message_flags`, `ai_voice_results`, `ai_usage`. The never-used Phase 1 placeholders `ai_conversations`, `ai_memories`, `ai_actions` are dropped (`ai_memories`/`ai_actions` re-created). All other data untouched |

Apply with `npm run db:migrate --workspace=backend` (idempotent; each file
runs once, in its own transaction, recorded in `schema_migrations`).

## Timestamp comparisons stay in SQL

PostgreSQL `timestamptz` has microsecond precision; a JavaScript `Date`
has millisecond precision. A timestamp read into JS and passed back as a
query parameter is therefore truncated, and `created_at > $cutoff` can
wrongly include the very row the cutoff came from. Repositories compare
timestamps inside SQL instead (e.g. `created_at > (SELECT created_at FROM
messages WHERE id = $3)`, `created_at >= (SELECT joined_at FROM
conversation_members …)`). This fixed a Phase 2 bug where the last-read
message kept counting as unread on real PostgreSQL — invisible under
pg-mem, which stores milliseconds.

## Testing against this schema

Backend integration tests apply every migration to a fresh `pg-mem`
instance (an in-memory PostgreSQL-compatible engine) — see
`backend/tests/helpers/testDb.ts`. This exercises the real SQL in the
repositories (joins, `ON CONFLICT`, transactions) without requiring a
network database in CI or on a fresh clone. Production always talks to a
real PostgreSQL server via `pg`; `pg-mem` is test-only.

pg-mem is not perfect (for example it mis-evaluates `id = $1 AND
message_id IS NULL` via an index once the table has several rows — see the
comment in `MediaRepository.attachToMessage`), so the same suite can also
run against **real PostgreSQL**: set `TEST_DATABASE_URL` and run
`npx vitest run --no-file-parallelism` in `backend/`. Each call re-creates
a throwaway schema (`connectx_test_w<n>`) inside that database and never
touches other schemas; drop it afterwards with
`DROP SCHEMA connectx_test_w1 CASCADE`.

## Not yet in the schema (intentionally)

Communities/channels, message search indexes (would likely need a
full-text or vector index once "Ask Your Chats" is implemented), and
payment/billing tables are out of scope for the current phase and are not
modeled yet — adding them speculatively would just be guessing at
requirements ahead of the phase that needs them.
