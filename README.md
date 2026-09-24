# ConnectX

ConnectX is a modern communication platform — real-time messaging, groups,
status/stories, voice/video, and privacy-conscious, opt-in AI features —
built with its own visual identity and architecture (not a clone of any
existing product).

**This repository is at Phase 2: Authentication & Real-time Direct
Messaging.** See [docs/development-phases.md](docs/development-phases.md)
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
│                  rate limiting, validation, upload checks
├── db/            PostgreSQL connection pool + migration runner
├── realtime/      WebSocket gateway, connection registry, event types
├── container.ts   dependency-injection wiring (repositories -> services -> routers)
├── modules/       one folder per domain (auth, users, conversations, messages,
│                  groups, media, notifications, ai, privacy)
└── server.ts, app.ts

frontend/src/
├── components/    ui/, layout/, chat/, common/
├── pages/         Landing, Login, Signup, and authenticated app/ views
├── context/       AuthContext, RealtimeContext, ConversationsContext
├── routes/        ProtectedRoute
├── services/      API client + per-domain service wrappers (auth, users, conversations, messages)
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

### Database setup (required for Phase 2)

Phase 2 uses a real, persistent PostgreSQL database — there is no
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
   This is idempotent — safe to re-run. It creates every table defined in
   [database/migrations](database/migrations) and records what's been
   applied in a `schema_migrations` table.

If `DATABASE_URL` is missing or unreachable, `npm run dev:backend` /
`npm start` fails immediately with a message telling you exactly what to
configure, rather than starting in a broken state.

Automated tests do **not** need a real database — they run against
`pg-mem`, an in-memory Postgres-compatible engine, so `npm test` works
without any of the above.

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
| `AI_PROVIDER` | AI provider selector; `none` in Phase 2 |

The frontend reads `VITE_API_BASE_URL` (defaults to
`http://localhost:4000/api/v1`) and `VITE_WS_URL` (defaults to the same
host with `ws://` and `/ws`).

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

## Currently implemented features (Phase 2)

Everything from Phase 1, now backed by a real, persistent PostgreSQL
database, plus:

- **Persistent authentication** — signup/login backed by a real `users`
  table (no more in-memory store)
- **User profiles** — view and edit your display name, bio, and status
  message (`GET/PATCH /api/v1/users/me`)
- **User search** — find other users by name or email (`GET /api/v1/users/search`)
- **1:1 conversations** — start (or resume) a direct conversation with
  another user; duplicate-conversation creation is prevented server-side
- **Persistent messages** — sent messages are stored in PostgreSQL and
  survive restarts
- **Real-time messaging over WebSocket** — new messages arrive instantly
  for connected recipients (`ws://.../ws?token=<accessToken>`)
- **Sent / delivered / read receipts** — a message's status reflects
  whether the recipient was online when it was sent, and updates to "read"
  when they open the conversation
- **Conversation list with unread counts** — sorted by recent activity,
  with a per-conversation unread badge and a sidebar total
- **Authorization** — every conversation/message route checks that the
  requesting user is an actual member of that conversation (403 otherwise)

See [docs/api.md](docs/api.md) for the full endpoint list and
[docs/security.md](docs/security.md) for what's covered.

## What's only scaffolded

Groups, media storage, notifications, privacy settings persistence, and
all AI features remain typed interfaces and route shapes only — routes
honestly respond `501`, not fake data. See [docs/api.md](docs/api.md) and
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

## Manual two-user testing

For a hands-on check that real-time delivery, receipts, and unread counts
actually work between two independent accounts, see
[docs/manual-testing-phase2.md](docs/manual-testing-phase2.md).

## Planned phases

1. **Foundation** — structure, auth, UI shell, schema design
2. **Authentication & Real-time Direct Messaging** (this phase) — persistent
   auth, profiles, search, 1:1 conversations, real-time messages, receipts
3. **Groups, Voice/Video & Notifications** — group chat, calling, push
   notifications, status/stories
4. **AI Features** — a real AI provider wired into every interface above
5. **Multi-device, Scale & Productivity** — session management, mobile/desktop clients, scaling

Full detail: [docs/development-phases.md](docs/development-phases.md).
