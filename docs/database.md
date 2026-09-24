# Database

Full DDL lives in [`database/schema.sql`](../database/schema.sql) (PostgreSQL).
This document explains the *why* behind the shape of it. **No migration
tooling runs this schema yet** — Phase 1's backend does not connect to a
live database (see `backend/src/db/pool.ts`); this is a reviewed design for
the phase where it does.

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
| `attachments` | File metadata; `message_id` is nullable so an attachment can be uploaded before the message that references it is created |

### Groups

| Table | Purpose |
|---|---|
| `groups` | 1:1 with a `conversations` row of type `group` — keeps group-specific metadata (name, description, avatar) out of the generic `conversations` table |
| `group_members` | Role-based membership (`owner` / `admin` / `member`) |

### Status / stories, notifications, privacy

| Table | Purpose |
|---|---|
| `statuses` | Ephemeral posts with an `expires_at`; a background job (later phase) purges expired rows |
| `notifications` | Generic notification envelope with a `payload` JSONB column so new notification types don't require schema changes |
| `privacy_settings` | 1:1 with `users`; **also the consent record AI features must check** (`ai_features_enabled`, `ai_memory_enabled`) |

### AI (deliberately isolated)

| Table | Purpose |
|---|---|
| `ai_conversations` | One row per AI feature invocation (a question asked, a summary run). Never mixed with real `messages` rows |
| `ai_memories` | User-visible, user-deletable facts extracted with consent — see `MemoryExtractionService` |
| `ai_actions` | Suggested tasks/reminders/events; `confirmed_at` is null until the user explicitly confirms — nothing here is a real action until then |

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

## Not yet in the schema (intentionally)

Call/voice metadata, message search indexes (would likely need a
full-text or vector index once "Ask Your Chats" is implemented), and
payment/billing tables are out of scope for Phase 1 and are not modeled yet
— adding them speculatively would just be guessing at requirements ahead of
the phase that needs them.
