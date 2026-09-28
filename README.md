# ConnectX

ConnectX is a modern communication platform — real-time messaging, groups,
status/stories, voice/video, and privacy-conscious, opt-in AI features —
built with its own visual identity and architecture (not a clone of any
existing product).

**This repository is at Phase 3: Groups & Media Foundation.** See [docs/development-phases.md](docs/development-phases.md)
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
├── realtime/      WebSocket gateway, connection registry, event types, broadcast
├── container.ts   dependency-injection wiring (repositories -> services -> routers)
├── modules/       one folder per domain (auth, users, conversations, messages,
│                  groups, media (+ storage/), notifications, ai, privacy)
└── server.ts, app.ts

frontend/src/
├── components/    ui/, layout/, chat/, groups/, media/, common/
├── pages/         Landing, Login, Signup, and authenticated app/ views
├── context/       AuthContext, RealtimeContext, ConversationsContext
├── routes/        ProtectedRoute
├── services/      API client + per-domain service wrappers (auth, users, conversations,
│                  messages, groups, media)
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
files; metadata lives in the `attachments` table. The storage layer sits
behind a `StorageProvider` interface so it can be replaced with S3/object
storage later. Back this directory up together with the database —
deleting it breaks existing attachments.

### Environment variables

See [backend/.env.example](backend/.env.example) for the full list. Key
ones:

| Variable | Purpose |
|---|---|
| `PORT` | Backend port (default `4000`) |
| `CLIENT_ORIGIN` | Allowed CORS origin (default `http://localhost:5173`) |
| `DATABASE_URL` | PostgreSQL connection string — **required**, see above |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Required — long random secrets for signing tokens |
| `BCRYPT_SALT_ROUNDS` | Password hashing cost factor (default `12`) |
| `MAX_UPLOAD_SIZE_MB` | Upload size limit (default `25`) |
| `UPLOAD_DIR` | Local media storage directory (default `uploads`, relative to `backend/`) |
| `AI_PROVIDER` | AI provider selector; `none` until the AI phase |

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

## Known limitations (Phase 3)

What this phase does **not** do:

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
- **Mentions** create no notifications (notifications are Phase 4).
- **No end-to-end encryption** for any content, including media.
- The group/media UI is verified by component tests plus an API/WebSocket
  smoke test against the real server — **not** by an automated browser
  run. Use the manual test script below.

## What's only scaffolded

Notifications, privacy settings persistence, and all AI features remain
typed interfaces and route shapes only — routes honestly respond `501`,
not fake data. Calls, status/stories and communities aren't started. See
[docs/development-phases.md](docs/development-phases.md) for when each
lands.

## AI feature roadmap

See [docs/ai-roadmap.md](docs/ai-roadmap.md) for the design commitments
behind each AI feature (Ask Your Chats, AI Chat Memory, Voice Intelligence,
Group Decision AI, Scam/Spam Shield, Smart Action Extraction, Live
Translation) and their current (interface-only) status.

## Security notes

No end-to-end encryption exists yet, and this repository must not be
described as E2E-encrypted until that's implemented and verified. See
[docs/security.md](docs/security.md) for exactly what is and isn't in
place today.

## Manual testing

- Phase 2 (two users, direct chat): [docs/manual-testing-phase2.md](docs/manual-testing-phase2.md)
- Phase 3 (three users, groups, roles, media): [docs/manual-testing-phase3.md](docs/manual-testing-phase3.md)

## Planned phases

1. **Foundation** ✅ — structure, auth, UI shell, schema design
2. **Authentication & Real-time Direct Messaging** ✅ — persistent auth,
   profiles, search, 1:1 conversations, real-time messages, receipts
3. **Groups & Media Foundation** ✅ (this phase) — group chat, roles,
   replies/mentions/edit/delete, validated media uploads
4. **Calls, Status & Notifications** — voice/video calls, screen sharing,
   status/stories, push notifications, communities, media follow-ups
5. **AI Features** — a real AI provider wired into every interface
6. **Multi-device, Scale & Productivity** — session management,
   mobile/desktop clients, scaling, productivity tools

Full detail: [docs/development-phases.md](docs/development-phases.md).
