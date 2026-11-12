# ConnectX

ConnectX is a modern communication platform — real-time messaging, groups,
status/stories, voice/video, and privacy-conscious, opt-in AI features —
built with its own visual identity and architecture (not a clone of any
existing product).

**This repository is at Phase 5: AI Features & Privacy Layer.** See [docs/development-phases.md](docs/development-phases.md)
for the full roadmap and what's planned next.

## Project vision

- Real-time messaging
- Voice/video communication
- Groups and communities
- Status/stories
- File and media sharing
- Strong privacy and security
- AI-powered communication features (Ask Your Chats, AI Chat Memory, Voice
  Intelligence, Group Decision AI, Scam/Spam Shield, Smart Action
  Extraction, Live Translation)
- Future productivity and collaboration features

Designed for web today, with an architecture that anticipates mobile and
desktop clients and multi-device sync.

## Architecture

```
connectx/
├── frontend/    React + TypeScript + Vite + Tailwind CSS
├── backend/     Node.js + TypeScript + Express + WebSocket (ws)
├── database/    PostgreSQL schema, applied via versioned migrations
└── docs/        Architecture, database, API, AI roadmap, security, phases
```

Full details: [docs/architecture.md](docs/architecture.md).

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, React Router |
| Backend | Node.js, TypeScript, Express, `ws` (WebSocket), Zod, JWT, bcrypt |
| Database | PostgreSQL, accessed via `pg` |
| Testing | Vitest, Testing Library, Supertest, `pg-mem` (in-memory Postgres for backend integration tests) |

## Folder structure

```
backend/src/
├── config/        environment config
├── middleware/    auth guard, conversation-membership guard, error handling,
│                  rate limiting, validation
├── db/            PostgreSQL connection pool + migration runner
├── realtime/      WebSocket gateway, connection registry, event types (+ validated
│                  client events), broadcast, gateway → service wiring
├── container.ts   dependency-injection wiring (repositories -> services -> routers)
├── modules/       one folder per domain (auth, users, conversations, messages,
│                  groups, media (+ storage/), calls, statuses, notifications, ai, privacy)
└── server.ts, app.ts

frontend/src/
├── components/    ui/, layout/, chat/, groups/, media/, calls/, status/, common/
├── pages/         Landing, Login, Signup, and authenticated app/ views
├── context/       AuthContext, RealtimeContext, ConversationsContext, CallContext
├── lib/webrtc/    PeerMesh (RTCPeerConnection per peer), friendly media errors
├── routes/        ProtectedRoute
├── services/      API client + per-domain service wrappers (auth, users, conversations,
│                  messages, groups, media, calls, statuses)
├── hooks/, utils/
└── types/
```

## Setup instructions

Requires Node.js 18+ and a PostgreSQL database (see below).

```bash
# from the repository root
npm install

# copy and fill in backend environment variables
cp backend/.env.example backend/.env
```

### Database setup (required)

ConnectX uses a real, persistent PostgreSQL database — there is no
in-memory fallback for production use. You need:

1. **A running PostgreSQL server.** Either:
   - Install PostgreSQL locally (postgresql.org), or
   - Run it via Docker: `docker run --name connectx-db -e POSTGRES_USER=connectx -e POSTGRES_PASSWORD=connectx -e POSTGRES_DB=connectx_dev -p 5432:5432 -d postgres:16`
2. **`DATABASE_URL` set** in `backend/.env` to point at it — the default in
   `.env.example` (`postgresql://connectx:connectx@localhost:5432/connectx_dev`)
   matches the Docker command above.
3. **Migrations applied**:
   ```bash
   npm run db:migrate --workspace=backend
   ```
   This is idempotent — safe to re-run. It applies every file in
   [database/migrations](database/migrations) that hasn't run yet, in
   order, and records it in a `schema_migrations` table.

   **Upgrading an existing Phase 2 database to Phase 3:** just run the same
   command. It skips `001_initial_schema.sql` and applies
   `002_groups_media.sql`, which is purely additive (new columns, indexes
   and the `message_mentions` table) — no existing rows are changed.

   **Upgrading a Phase 3 database to Phase 4:** same command; it applies
   `003_calls_status.sql` — new call and status tables, plus an
   `attachments.purpose` column (existing rows default to `message`). The
   only non-additive step re-creates the Phase 1 placeholder `statuses`
   table, which no earlier code ever wrote to.

If `DATABASE_URL` is missing or unreachable, `npm run dev:backend` /
`npm start` fails immediately with a message telling you exactly what to
configure, rather than starting in a broken state.

Automated tests do **not** need a real database — they run against
`pg-mem`, an in-memory Postgres-compatible engine, so `npm test` works
without any of the above.

### Running backend tests against real PostgreSQL (optional)

pg-mem doesn't behave exactly like PostgreSQL, so the backend suite can
also run against a real server. Each test worker uses a throwaway schema
(`connectx_test_w<n>`) that is dropped and re-created per test — nothing
outside it is touched:

```bash
cd backend
TEST_DATABASE_URL=postgresql://connectx:connectx@localhost:5432/connectx_dev npx vitest run --no-file-parallelism
# afterwards: DROP SCHEMA connectx_test_w1 CASCADE;
```

### Media storage (development)

Uploaded files are stored on local disk under `UPLOAD_DIR` (default
`backend/uploads/`, gitignored), as `<conversationId>/<attachmentId>`
files (status media: `statuses/<ownerId>/<attachmentId>`); metadata lives
in the `attachments` table. The storage layer sits
behind a `StorageProvider` interface; production hosts without a
persistent disk use Cloudinary instead (`MEDIA_STORAGE=cloudinary`, see
[docs/deployment.md](docs/deployment.md#7-file-storage)). With local
storage, back this directory up together with the database — deleting it
breaks existing attachments.

### Environment variables

See [backend/.env.example](backend/.env.example) for the full list. Key
ones:

| Variable | Purpose |
|---|---|
| `PORT` | Backend port (default `4000`) |
| `NODE_ENV` | `production` enables startup safety checks (secret strength, CORS) |
| `CLIENT_ORIGIN` | Allowed frontend origin(s) for CORS and the WebSocket Origin check, comma-separated (default `http://localhost:5173`) |
| `TRUST_PROXY` | Set to `1` behind one reverse proxy so rate limits see real client IPs (default `false`) |
| `LOG_LEVEL` | `error` · `warn` · `info` (default) · `debug` · `silent` |
| `DATABASE_URL` | PostgreSQL connection string — **required**, see above |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Required — long random secrets for signing tokens |
| `BCRYPT_SALT_ROUNDS` | Password hashing cost factor (default `12`) |
| `MAX_UPLOAD_SIZE_MB` | Upload size limit (default `25`) |
| `MEDIA_STORAGE` | `local` (default) or `cloudinary` |
| `UPLOAD_DIR` | Local media storage directory (default `uploads`, relative to `backend/`) |
| `CLOUDINARY_URL` / `CLOUDINARY_FOLDER` | Cloudinary credentials (`cloudinary://key:secret@cloud`) and public-ID prefix (default `connectx`); required with `MEDIA_STORAGE=cloudinary` |
| `WEBRTC_STUN_URLS` / `WEBRTC_TURN_URLS` | ICE servers for calls — **empty by default** (same machine/LAN only). See [docs/calls.md](docs/calls.md#stun--turn) |
| `WEBRTC_TURN_SECRET` (+ `WEBRTC_TURN_TTL_SECONDS`) | Recommended TURN auth: short-lived per-user credentials (coturn `use-auth-secret`) |
| `WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL` | Alternative static TURN credentials |
| `CALL_RING_TIMEOUT_SECONDS` | How long a call rings before it's missed (default `45`) |
| `AI_PROVIDER` / `AI_PROVIDER_API_KEY` / `AI_MODEL` | AI provider: `none` (default — AI features report "not configured"), `anthropic`, or `gemini`. See [docs/ai.md](docs/ai.md#configuration) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Required when `AI_PROVIDER=gemini` (no default model) |
| `AI_RATE_LIMIT_PER_MINUTE` / `AI_RATE_LIMIT_PER_DAY` | Per-user AI request limits (default `10` / `200`) |
| `TRANSCRIPTION_PROVIDER` / `TRANSCRIPTION_BASE_URL` | Speech-to-text for Voice Intelligence: `none` (default) or `whisper-http` |
| `RATE_LIMIT_*`, `AUTH_RATE_LIMIT_MAX`, `*_RATE_LIMIT_PER_*`, `WS_*` | Server-side abuse limits (in memory, per process) — see [docs/security.md](docs/security.md#9-rate-limiting-and-abuse-protection) |
| `SCHEDULER_INTERVAL_SECONDS` | How often the in-process scheduler checks for due reminders, tasks and scheduled messages (default `15`, minimum `5`) |
| `BACKGROUND_JOBS_ENABLED` | `true` (default) or `false`; any other value stops startup. `false` is intended only for isolated local manual testing: it skips stale-call and scheduled-message recovery, expired-status cleanup and all scheduler processing (reminders, task-due notifications, scheduled messages). Skipped work isn't cancelled, so overdue items run on the next start with jobs on. Never set it to `false` in production |

The frontend reads `VITE_API_BASE_URL` (defaults to
`http://localhost:4000/api/v1`) and `VITE_WS_URL` (defaults to the same
host with `ws://` and `/ws`). `VITE_MAX_UPLOAD_MB` (default `25`) only
drives the client-side size pre-check — keep it equal to the backend's
`MAX_UPLOAD_SIZE_MB`; the server always enforces its own limit.

## Development commands

```bash
# apply database migrations (see Database setup above)
npm run db:migrate --workspace=backend

# run backend and frontend dev servers (in separate terminals)
npm run dev:backend
npm run dev:frontend

# type-check everything
npm run typecheck

# run all tests (no database required — uses pg-mem)
npm test

# build everything
npm run build
```

## Currently implemented features

### Phase 7 — Security, performance & production readiness (final phase)

No new product features. An audit and hardening pass over everything
below: stricter token verification and login behavior, per-user and
WebSocket abuse limits, input-validation gaps closed (no more `500`s on
malformed IDs), crash handlers and graceful shutdown, a readiness probe,
safe logging, bounded list queries, accessible modals, and honest
production documentation:

- [docs/security.md](docs/security.md) — the final security statement:
  what is implemented, how it's verified, and what is **not** implemented
- [docs/deployment.md](docs/deployment.md) — backend, frontend,
  PostgreSQL, reverse proxy/WebSockets, TURN, storage, scheduler, health checks
- [docs/backup-recovery.md](docs/backup-recovery.md)
- [docs/manual-testing-final.md](docs/manual-testing-final.md) — the release
  checklist, each item tagged automated / manual / infrastructure-dependent

### Phase 6 — Advanced productivity & collaboration

API reference: [docs/api.md](docs/api.md#productivity--collaboration-phase-6).

- **Work page** (sidebar ✓): Tasks · Reminders · Events · Saved ·
  Scheduled, with filters, sorting and search; everything is private to you
- **Tasks / reminders / events from chat:** a message's ⋯ menu creates one
  linked back to the message (the message is untouched); an AI suggestion
  becomes one only when you ask. Times you type are read in your timezone
- **Chat tools panel:** shared notes (with conflict detection), shared
  to-do lists with assignees, and pinned messages — live for every member
- **Pinned & saved messages:** pins are shared (admins-only in groups);
  saves are private, with labels, stars and search
- **Productivity Mode:** focused chats first, then unread; All/Unread/
  Groups/Direct filters; per-type notification switches
- **Scheduled messages:** the composer's 🕒 button; edit or cancel until
  sent; you're notified if a send fails (e.g. you left the group)
- **In-app notifications** (🔔): mentions, assignments, due tasks,
  reminders, scheduled-send results, new sign-ins
- **Devices:** Settings → Devices lists your signed-in sessions; rename
  them, sign one out, or sign out all others — immediately, including
  their live connections. Refresh tokens rotate on every use
- **Offline:** recent chats stay readable offline; messages you write are
  queued, shown as pending, and sent exactly once when you reconnect
- **Business profile & quick replies:** Settings → Business; insert a
  quick reply with ⚡ or by typing its `/shortcut`

### Phase 5 — AI features & privacy layer

All opt-in (off by default), server-enforced, and labeled as AI-generated.
Details: [docs/ai.md](docs/ai.md).

- **Settings → AI Features:** master switch plus per-feature consent,
  translation language, per-chat exclusion, provider status and a
  plain-language "what is shared" disclosure
- **Ask Your Chats** (sidebar ✨ or the chat's ✨ panel): questions over
  chats you pick, answered only from messages you can see, with the source
  messages shown; "not enough information" instead of guessing
- **AI Memory:** explicit notes (typed, or "Remember" on a message) that you
  can view, delete or clear at any time — never extracted automatically
- **Smart Actions:** suggested tasks/reminders/deadlines from a chat; you
  confirm, edit or dismiss each one; from Phase 6 you can turn one into
  a task, reminder or event on request
- **Group Decision AI:** summary / decisions / open issues for a group, each
  item linked to supporting messages; no invented consensus
- **Translation:** per message, on request; the original is never changed
- **Scam/Spam Shield:** automatic local warnings with reasons (no AI
  provider needed), optional AI check, dismiss/report
- **Voice Intelligence foundation:** transcribe and summarize audio
  attachments (needs a transcription provider)
- Provider abstraction with an Anthropic (Claude) implementation; with no
  provider configured, features say so instead of faking output

### Phase 4 — Calls & status

- **1:1 voice and video calls** over WebRTC, signaled through the existing
  authenticated WebSocket: start from a direct chat, incoming-call banner
  (accept/decline), "Calling…/Ringing…", cancel, end, mute, camera on/off,
  local preview + remote video, live timer, reconnecting/failure states
  with **Call again**, friendly permission/device/browser errors (camera
  missing → audio-only fallback). Media never touches the server.
- **Group call foundation** — start from a group, every member is invited,
  join/leave/decline, join a call already in progress, participant tiles
  and mute indicators. Peer-to-peer **mesh, capped at 8** — a foundation
  for a future media server, not a large-meeting system.
- **Call lifecycle on the server**: `ringing → accepted → connecting →
  connected → ended`, plus `declined`, `cancelled`, `missed` (45s ring
  timeout), `failed`; one live call per conversation; busy detection;
  signaling bound to the specific device that joined; 10s reconnect grace;
  stale calls failed on restart. Only metadata is stored.
- **Call history** inline in each chat ("Missed voice call", "Outgoing
  video call · 3:05"), visible only to the call's participants.
- **STUN/TURN configuration** from environment variables, including
  short-lived per-user TURN credentials. No credentials hard-coded.
- **Status / stories** — text (with background colors), photo and video
  statuses with captions; 24h expiry decided and enforced by the backend;
  grouped feed (recent vs viewed), full-screen viewer with progress,
  next/previous, auto-advance; delete your own; **seen-by list (owner
  only)**; realtime new/deleted/expired/viewed updates.
- **Status privacy** — My contacts / My contacts except… / Only share
  with… / Everyone I chat with, per status or as a saved default, always
  shown in the UI and **enforced by the server** (feed, direct lookup,
  media downloads and realtime events).

Details: [docs/calls.md](docs/calls.md), [docs/status.md](docs/status.md).

### Phase 3 — Groups & media foundation

- **Group conversations** — create a group (name, description, avatar URL,
  members), view details and members, edit details, add and remove
  members, leave, with **owner / admin / member roles** (promote/demote).
  When the owner leaves, ownership passes to the longest-standing admin
  (or member). Every rule is enforced server-side and backed by database
  constraints (no duplicate memberships, at most one owner per group).
- **Group messaging** on the same stack as direct chats: persistent
  messages, real-time delivery to every member, sender names, aggregate
  delivered/read ticks (only once *everyone* has received/read), per-member
  unread counts, `Alice: …` previews, ordering by latest message. Members
  only see history from when they joined.
- **Replies, @mentions, edit and delete** (author only) — in groups and
  direct chats.
- **Media foundation** — attach images, videos, audio files, documents and
  generic files: validated on the server (size, extension allow-list, file
  contents must match the extension — the browser's MIME type isn't
  trusted), stored behind a replaceable storage abstraction (local disk in
  development), downloadable only by conversation members. The UI shows a
  preview, upload progress and clear error states, and never shows a
  rejected upload as sent.
- **Realtime events** for edits, deletions, group membership and role
  changes, group metadata, conversation added/removed, and cross-device
  unread sync.

### Phase 2 — Authentication & real-time direct messaging

- **Persistent authentication** (PostgreSQL `users` table), **profiles**
  (`GET/PATCH /api/v1/users/me`), **user search**
- **1:1 conversations**, **persistent messages**, **real-time delivery over
  WebSocket** (`ws://.../ws?token=<accessToken>`)
- **Sent / delivered / read receipts**, **conversation list with unread
  counts**
- **Authorization** — every conversation/message route checks active
  membership (403 otherwise)

See [docs/api.md](docs/api.md) for every endpoint and event, and
[docs/security.md](docs/security.md) for what's covered.

## Known limitations

The complete, current list lives in [docs/security.md](docs/security.md#12-what-is-explicitly-not-implemented)
and [docs/deployment.md](docs/deployment.md#supported-topology-read-this-first).
Most important: **run a single backend instance**, there is **no
end-to-end encryption**, **no push notifications**, **no malware scanning**,
and calls across the internet need **STUN/TURN** you deploy yourself.
Details by area follow.

Productivity & multi-device:

- **Everyone must sign in again after upgrading to Phase 6** — tokens
  issued earlier carry no session ID and are rejected.
- **Offline is a foundation, not an offline-first app.** No service worker:
  the app must already be loaded to keep working offline. Only the 20 most
  recent chats (50 messages each) are cached, in unencrypted
  `localStorage`. Only text messages can be queued — not attachments,
  edits or deletes — and Phase 6 items (tasks, notes…) need a connection.
- **Scheduler is in-process and single-instance**, checking every
  `SCHEDULER_INTERVAL_SECONDS` (so reminders/sends can be up to that late);
  nothing fires while the server is down (due items are sent on the next
  start). Scheduled messages are text only.
- **Notifications are in-app only** — no push, email or OS notifications.
- **Events:** no recurrence, invitations or external calendar sync.
  Reminders don't repeat or snooze.
- **Shared notes are plain text** with whole-note saves; concurrent editors
  get a conflict to resolve, not live co-editing.
- **Business profiles are a foundation:** nothing verifies businesses
  (all are `unverified`), and there are no catalogs, away messages or
  automated replies.
- Every authenticated request now does one indexed session lookup.

AI (see [docs/ai.md](docs/ai.md#known-limitations)):

- **Real model output is not covered by automated tests** — the suite uses
  a scripted test provider to verify authorization, validation and
  privacy logic. Check real behavior with
  [docs/manual-testing-phase5.md](docs/manual-testing-phase5.md).
- Retrieval is keyword + recency, not semantic search. Requests are
  synchronous (no job queue). The per-minute AI limit is per process.
- Scam heuristics are pattern-based (English-centric) and can be wrong both
  ways; reports aren't reviewed yet. No in-app voice recording.
- With a provider configured, selected chat content is sent to that
  provider (disclosed in Settings).

Calls and status (Phase 4):

- **Real audio/video is not covered by automated tests** — Node/jsdom have
  no WebRTC; the call UI and signaling are tested against fake
  `RTCPeerConnection`/`getUserMedia`, and the server side over real
  WebSockets. Verify media with
  [docs/manual-testing-phase4.md](docs/manual-testing-phase4.md).
- **Calls across the internet need STUN, and restrictive networks need
  TURN.** With the default (no ICE servers) calls only work on the same
  machine/LAN. ConnectX does not claim calls will connect everywhere
  without a validated TURN deployment. Camera/mic also require HTTPS
  outside `localhost`.
- **Group calls are a peer-to-peer mesh** (max 8 joined; realistically
  3–4): no SFU/media server, no active-speaker detection, no screen
  sharing, no device picker.
- **Single backend instance** — call device bindings and timers are in
  memory (like the WebSocket registry); horizontal scaling needs shared
  state.
- **No push notifications**: incoming calls ring only while ConnectX is
  open; no call waiting (a busy user's incoming calls ring out as missed).
- **No end-to-end encryption claim** for calls. WebRTC encrypts media in
  transit (DTLS-SRTP), but signaling goes through the server and there's no
  key verification. Peer-to-peer calls can reveal participants' IP
  addresses to each other.
- Status: replies are supported (sent as a direct message with a snapshot
  of the status); no reactions to statuses or muting someone's updates;
  privacy can't be edited after posting; being added to a group grants `everyone`-level visibility
  without consent; media isn't re-encoded (EXIF preserved).

Chat features added after Phase 7 (typing, reactions, search, pin/archive/mute, contact info, status replies, PDF preview, call-invite replay):

- **Mute is in-app only** — it silences @mention notifications and keeps
  the chat out of the unread total; there are no push/sound notifications
  to mute. At most 5 pinned chats; archived chats stay archived on new
  messages.
- **Search** is a plain substring match within one chat (no index, no
  stemming), newest 30 results; results older than the loaded history
  can be read in the results list but not jumped to.
- **Reactions**: one per person per message; the picker offers a curated
  set of emoji (any single emoji is accepted by the API).
- **Typing indicator** state lives in server memory (single instance, like
  the WebSocket registry).
- **Document preview**: PDFs open in the browser's own viewer from the
  authenticated download (some mobile browsers can't show PDFs inline —
  download instead). DOCX/PPTX/XLSX are download-only: previewing them
  needs a server-side conversion service, and public third-party viewers
  would expose private files.

Carried over from Phase 3:

- **No malware scanning** of uploads — only format validation (extension +
  magic bytes). No thumbnails, image re-encoding/EXIF stripping, or video
  transcoding.
- **No in-app voice recording** — audio *files* can be attached and played;
  recording a voice note in the browser is not built.
- **Local-disk media storage** only (single instance); no object-storage
  provider yet. No cleanup job for uploads that are never sent. One
  attachment per message.
- **Group avatar is a URL field only** — no avatar image upload.
- **No explicit ownership transfer** — ownership only moves when the owner
  leaves. Group admins **cannot delete other people's messages**.
- **Delivery receipts** are only recorded for recipients online at the
  moment of sending (same as Phase 2) — reconnecting later doesn't mark
  older messages delivered; reading them still marks them read.
- **Deleted messages** simply disappear from the thread (replies to them do
  show "Original message was deleted").
- **Mentions** create in-app notifications only (Phase 6) — no push.
- **No end-to-end encryption** for any content, including media.
- The UI is verified by component tests plus API/WebSocket tests — **not**
  by an automated browser run. Use the manual test scripts
  ([Phase 3](docs/manual-testing-phase3.md), [Phase 4](docs/manual-testing-phase4.md)).

## What's only scaffolded

General privacy settings persistence (`/privacy`) remains a typed
interface and route shape only — its routes honestly respond `501`, not
fake data. (In-app notifications are implemented as of Phase 6.) (Status privacy *is* implemented,
under `/statuses/privacy`.) Communities aren't started. See
[docs/development-phases.md](docs/development-phases.md) for when each
lands.

## AI feature roadmap

See [docs/ai-roadmap.md](docs/ai-roadmap.md) for the design commitments
behind each AI feature (Ask Your Chats, AI Chat Memory, Voice Intelligence,
Group Decision AI, Scam/Spam Shield, Smart Action Extraction, Live
Translation). Phase 5 implements them — see [docs/ai.md](docs/ai.md).

## Security notes

No end-to-end encryption exists yet, and this repository must not be
described as E2E-encrypted until that's implemented and verified. See
[docs/security.md](docs/security.md) for exactly what is and isn't in
place today.

## Manual testing

- Phase 2 (two users, direct chat): [docs/manual-testing-phase2.md](docs/manual-testing-phase2.md)
- Phase 3 (three users, groups, roles, media): [docs/manual-testing-phase3.md](docs/manual-testing-phase3.md)
- Phase 4 (two browser sessions, voice/video calls, status, privacy, expiry): [docs/manual-testing-phase4.md](docs/manual-testing-phase4.md)
- Phase 5 (AI consent, each AI feature, unconfigured provider, limits): [docs/manual-testing-phase5.md](docs/manual-testing-phase5.md)
- Phase 6 (tasks, shared notes/to-dos, pins, scheduling, notifications, devices, offline, business): [docs/manual-testing-phase6.md](docs/manual-testing-phase6.md)
- **Final release checklist (all features, tagged automated / manual / infrastructure):** [docs/manual-testing-final.md](docs/manual-testing-final.md)

## Planned phases

1. **Foundation** ✅ — structure, auth, UI shell, schema design
2. **Authentication & Real-time Direct Messaging** ✅ — persistent auth,
   profiles, search, 1:1 conversations, real-time messages, receipts
3. **Groups & Media Foundation** ✅ — group chat, roles,
   replies/mentions/edit/delete, validated media uploads
4. **Calls & Status** ✅ — WebRTC voice/video calls, group
   call foundation, call history, status/stories with server-enforced
   privacy and expiry
5. **AI Features & Privacy Layer** ✅ — provider abstraction,
   consent, Ask Your Chats, memory, actions, group decisions, translation,
   scam shield, voice intelligence foundation
6. **Advanced Productivity & Collaboration** ✅ — tasks,
   reminders, events, shared notes/to-dos, pins/saved, Productivity Mode,
   scheduled messages, in-app notifications, multi-device sessions,
   offline foundation, business profile & quick replies
7. **Security, Performance & Production Readiness** ✅ (final phase) —
   security/authorization audit and hardening, abuse limits, reliability,
   deployment/backup/security documentation, final test plan
8. **Not planned** — horizontal scaling, native mobile/desktop clients

Full detail: [docs/development-phases.md](docs/development-phases.md).
