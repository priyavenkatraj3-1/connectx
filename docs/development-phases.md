# Development Phases

ConnectX is built in explicit, separated phases. Each phase should be
reviewed and merged before the next begins — this document tracks what's
done and what's next so the project doesn't drift into "build everything
at once."

## Phase 1 — Foundation ✅

- Project structure: `frontend/`, `backend/`, `database/`, `docs/`
- Frontend: React + TypeScript + Vite + Tailwind; landing, login, signup,
  and an authenticated app shell (sidebar, chat list empty state,
  conversation empty state, settings, profile)
- Backend: Express + TypeScript with modular route/service/interface
  structure for every planned domain
- **Fully working:** signup, login, JWT issuance/verification, password
  hashing, protected routes, input validation, rate limiting
- **Scaffolded only:** conversations, messages, groups, media,
  notifications, privacy, all AI features (honest `501` responses, not
  fake data)
- Database schema designed and documented, not yet connected
- Unit + API tests for auth; component tests for frontend routing/UI

## Phase 2 — Authentication & Real-time Direct Messaging ✅

- Connected a real PostgreSQL database (`pg`); replaced `InMemoryUserRepository`
  with `PostgresUserRepository` — authentication is now persistent
- Implemented `users` for real: own profile (view/edit), public profiles,
  case-insensitive search (never leaks email addresses)
- Implemented `conversations` for real: get-or-create direct (1:1)
  conversation, list with last-message preview + unread count, membership
  authorization
- Implemented `messages` for real: send, paginated history, sent/delivered/read
  receipts (`message_receipts` table)
- Real-time transport: a WebSocket gateway (`ws`) authenticated during the
  HTTP Upgrade handshake, pushing `message:new` / `message:delivered` /
  `message:read` events; the frontend reconnects automatically
- Frontend: real conversation list with unread badges, a "start new
  conversation" user-search modal, a live chat thread with sent/delivered/
  read ticks, profile editing
- Versioned SQL migrations (`database/migrations/`) applied by
  `backend/src/db/migrate.ts`, tracked in `schema_migrations`
- Backend integration tests run against `pg-mem` (in-memory Postgres) —
  no live database required to run `npm test`; realtime tests exercise a
  real WebSocket server + real `ws` clients over loopback
- **Still scaffolded:** `groups`, `media`, `notifications`, `privacy`
  persistence, all AI features (honest `501`, not fake data)
- **Not yet implemented:** group conversations, message edit/delete/reactions,
  refresh-token rotation/revocation, file attachments

## Phase 3 — Groups & Media Foundation ✅

Scope was narrowed from the original "Groups, Voice/Video & Notifications"
plan: calls, status and notifications moved to Phase 4 so this phase could
ship group chat and the media foundation properly.

- **Groups:** create (name, description, avatar URL foundation, initial
  members), view details/members, edit details, add/remove members, leave,
  owner/admin/member roles with promote/demote, safe owner hand-over on
  leave. All authorization server-side (`GroupsService`), backed by DB
  constraints (no duplicate membership, at most one owner)
- **Group messaging on the existing stack** — a group is a conversation, so
  send/list/receipts/unread/list-ordering reuse the Phase 2 code paths;
  aggregate delivered/read status across all recipients; history visible
  only from when you joined
- **Messages (all conversations):** replies, @mentions (validated as
  members), author-only edit and delete (soft delete; attachment bytes
  removed)
- **Media foundation:** `StorageProvider` abstraction with local-disk
  storage, raw-body upload with size + extension allow-list + magic-byte
  validation (client MIME type not trusted), sanitized filenames,
  membership-gated download, uploader-only delete of unsent uploads, media
  messages (image/video/audio/document/file) with captions
- **Realtime:** `message:updated`, `message:deleted`, `message:status`,
  `conversation:added/removed/unread`, `group:updated`,
  `group:member_added/removed/left`, `group:role_changed`; the WebSocket
  `message:read` event is now membership-checked
- **Frontend:** new-group modal with member search, group chat view with
  sender names and member count, group info panel with role-aware
  controls, reply/edit/delete actions, @mention suggestions, attachment
  picker with preview, upload progress and error states, inline
  image/video/audio and document file cards
- Migration `002_groups_media.sql` (additive only)
- Fixed a Phase 2 bug found by running the suite on real PostgreSQL: the
  last-read message kept counting as unread (microsecond vs millisecond
  timestamp precision)
- **Known limitations** (see README): no malware scanning, no thumbnails
  or transcoding, no voice *recording* (audio files can be attached), no
  cleanup job for abandoned uploads, no ownership transfer except by
  leaving, no admin moderation of others' messages, avatar is a URL only,
  delivery receipts are only recorded for recipients online at send time

## Phase 4 — Calls & Status ✅ (this phase)

Scope was narrowed from "Calls, Status & Notifications": push/mention
notifications, screen sharing, communities and the media follow-ups moved
to a later phase.

- **Calls:** WebRTC 1:1 voice and video calls, signaled over the existing
  authenticated WebSocket (per-device binding, validated events); full
  lifecycle (ringing/accepted/connecting/connected/declined/missed/ended/
  failed/cancelled) with DB-enforced invariants, ring timeout, busy
  detection, reconnect grace, restart recovery
- **Group call foundation:** peer-to-peer mesh capped at 8, invite/join/
  leave/decline, join-in-progress banner, mute indicators — documented as
  not production-scale; designed so an SFU can replace the mesh
- **STUN/TURN** from env, including time-limited TURN credentials; nothing
  hard-coded; empty by default (same machine/LAN)
- **Call history** inline in chats, per-viewer direction/outcome/duration
- **Status/stories:** text/photo/video, 24h server-decided expiry,
  feed/viewer UI, delete, owner-only viewer list, realtime updates, expiry
  sweep that deletes rows and media
- **Status privacy:** contacts / contacts except / only share with /
  everyone-I-chat-with, per status or default, enforced server-side
  everywhere (including media downloads and realtime fan-out)
- Status media reuses the Phase 3 upload pipeline (`attachments.purpose`)
- Migration `003_calls_status.sql`; backend tests also run green against
  real PostgreSQL
- **Verified by:** backend API + real-WebSocket signaling tests; frontend
  tests against fake WebRTC. **Real audio/video requires the manual test
  plan** ([manual-testing-phase4.md](./manual-testing-phase4.md)).
- **Known limitations:** see [calls.md](./calls.md#known-limitations) and
  [status.md](./status.md#known-limitations) — notably TURN required for
  restrictive networks, mesh-only group calls, single-instance in-memory
  call state, no push notifications

## Later — Notifications, Communities & Media follow-ups (planned)

- Push notification delivery (web push, mobile push) and missed-call notifications (in-app mention notifications shipped in Phase 6)
- Screen sharing; an SFU/media server for larger group calls
- Communities/channels
- Media follow-ups: object storage provider, thumbnails, voice recording,
  malware scanning, abandoned-upload cleanup

## Phase 5 — AI Features & Privacy Layer ✅

- Vendor-neutral `AIProvider`/`TranscriptionProvider`; Anthropic (Claude)
  and Whisper-compatible HTTP implementations; honest `none` default
- `AIGateway`: per-user rate limits, timeouts, bounded retries, schema
  validation of model output, metadata-only usage log, `ai:*` status events
- Consent settings (all off by default), per-chat exclusions, data-sharing
  disclosure — Settings → AI Features
- Ask Your Chats (with real source messages), explicit AI Memory, Smart
  Action suggestions (confirm/edit/dismiss; nothing scheduled), Group
  Decision AI, on-request Translation (cached), Scam/Spam Shield (local
  heuristics + optional AI check), Voice Intelligence foundation
- Authorization + prompt-injection defenses shared by every feature
  (see [ai.md](./ai.md))
- Migration `004_ai_layer.sql`; backend tests also run green against real
  PostgreSQL
- **Verified by:** API tests with a scripted provider, frontend component
  tests. **Real model/transcription output requires the manual test plan**
  ([manual-testing-phase5.md](./manual-testing-phase5.md)).
- **Known limitations:** see [ai.md](./ai.md#known-limitations)

## Phase 6 — Advanced Productivity & Collaboration ✅

- **Tasks, reminders, events** — private CRUD with filters/sorting,
  priorities, due dates, assignees (active members of the source chat,
  status-only access), timezone-aware wall-clock input (IANA zones, DST
  gaps rejected); create from any message or, on explicit request, from a
  Phase 5 AI suggestion (at most once)
- **Shared notes** (edit policy, optimistic concurrency) and **shared
  to-do lists** (assignees, completion) per conversation, live for all
  members
- **Productivity Mode** — focused conversations first, then unread; chat
  list filters; per-type notification switches; preferred timezone
- **Pinned** (conversation-wide, admins-only in groups) and **saved**
  messages (private labels, stars, notes, search)
- **Offline foundation** — cached chats/messages, a per-user outbox that
  resends exactly once via `clientMessageId` idempotency, offline banner
- **Multi-device sessions** — server-side sessions, refresh-token
  rotation with reuse detection, revocation that closes sockets, device
  list/rename/sign-out-others, new-sign-in notification; edits, deletes,
  read state, preferences and every Phase 6 item sync across devices
- **Scheduled messages** (text) and an in-process **scheduler** for
  reminders, task-due notifications and scheduled sends (idempotent,
  retried, crash-recovered)
- **In-app notifications** — mentions, assignments, due tasks, reminders,
  scheduled-send results, new sign-ins; unread badge and notification
  center
- **Business profile foundation** — profile, hours, public/private,
  honest `unverified` status; owner-only **quick replies** (⚡ or
  `/shortcut` in the composer)
- Frontend: Work page (Tasks · Reminders · Events · Saved · Scheduled),
  chat tools panel (notes, to-dos, pins), per-message menu, Settings →
  Productivity / Notifications / Devices / Business
- Migration `005_productivity.sql`; backend tests also run green against
  real PostgreSQL
- **Verified by:** API tests (including the scheduler with a controlled
  clock), frontend component/offline tests, and an end-to-end smoke run of
  the production build against real PostgreSQL. Manual plan:
  [manual-testing-phase6.md](./manual-testing-phase6.md).
- **Deferred from the original Phase 6 plan:** horizontal scaling (shared
  realtime pub/sub, shared media storage, multi-instance scheduler) and
  native mobile/desktop client shells
- **Known limitations:** see the README's *Known limitations (Phase 6)*

## Later — Scale & native clients (planned)

- Horizontal scaling of the backend (shared realtime pub/sub, shared media
  storage, a single-leader or queue-based scheduler)
- Mobile/desktop client shells against the same API

## Ground rules for every phase

- No phase implements features from a later phase "while we're at it."
- No fake/mocked functionality presented as real — an unimplemented route
  says so (`501`), it doesn't return plausible-looking fabricated data.
- No security claims (e.g. "end-to-end encrypted") until they're true and
  verified.
- Each phase gets its own reviewed commit(s); this file is updated when a
  phase completes.
