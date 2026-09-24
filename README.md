# ConnectX

ConnectX is a modern communication platform — real-time messaging, groups,
status/stories, voice/video, and privacy-conscious, opt-in AI features —
built with its own visual identity and architecture (not a clone of any
existing product).

**This repository is at Phase 1: Foundation.** See
[docs/development-phases.md](docs/development-phases.md) for the full
roadmap and what's planned next.

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
├── backend/     Node.js + TypeScript + Express
├── database/    PostgreSQL schema (design artifact for Phase 1)
└── docs/        Architecture, database, API, AI roadmap, security, phases
```

Full details: [docs/architecture.md](docs/architecture.md).

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, React Router |
| Backend | Node.js, TypeScript, Express, Zod, JWT, bcrypt |
| Database (designed, not yet connected) | PostgreSQL |
| Testing | Vitest, Testing Library, Supertest |

## Folder structure

```
backend/src/
├── config/        environment config
├── middleware/    auth guard, error handling, rate limiting, validation, upload checks
├── db/            database client abstraction (not yet connected)
├── modules/       one folder per domain (auth, users, conversations, messages,
│                  groups, media, notifications, ai, privacy)
└── server.ts, app.ts

frontend/src/
├── components/    ui/, layout/, chat/, common/
├── pages/         Landing, Login, Signup, and authenticated app/ views
├── context/       AuthContext
├── routes/        ProtectedRoute
├── services/      API client + auth service
└── types/
```

## Setup instructions

Requires Node.js 18+.

```bash
# from the repository root
npm install

# copy and fill in backend environment variables
cp backend/.env.example backend/.env
```

### Environment variables

See [backend/.env.example](backend/.env.example) for the full list. Key
ones:

| Variable | Purpose |
|---|---|
| `PORT` | Backend port (default `4000`) |
| `CLIENT_ORIGIN` | Allowed CORS origin (default `http://localhost:5173`) |
| `DATABASE_URL` | PostgreSQL connection string (not yet used by any live code) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Required — long random secrets for signing tokens |
| `BCRYPT_SALT_ROUNDS` | Password hashing cost factor (default `12`) |
| `AI_PROVIDER` | AI provider selector; `none` in Phase 1 |

The frontend reads `VITE_API_BASE_URL` (defaults to
`http://localhost:4000/api/v1` if unset).

## Development commands

```bash
# run backend and frontend dev servers (in separate terminals)
npm run dev:backend
npm run dev:frontend

# type-check everything
npm run typecheck

# run all tests
npm test

# build everything
npm run build
```

## Currently implemented features (Phase 1)

- Signup, login, JWT-based authentication, password hashing, protected
  routes, input validation, rate limiting — see
  [docs/security.md](docs/security.md)
- Landing, login, signup pages and an authenticated app shell (sidebar,
  chat list, conversation area, settings, profile) with responsive layout,
  loading/empty/error states
- Full module structure and service interfaces for conversations, messages,
  groups, media, notifications, privacy, and every planned AI feature —
  intentionally scaffolded, not implemented (routes honestly respond `501`)
- Reviewed database schema for the full Phase 1+ data model
- Unit tests, API tests, and frontend component tests

## What's only scaffolded

Conversations, messages, groups, media storage, notifications, privacy
settings persistence, and all AI features exist as typed interfaces and
route shapes only. No live database connection exists yet. See
[docs/api.md](docs/api.md) for the exact list of `501` routes and
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

## Planned phases

1. **Foundation** (this phase) — structure, auth, UI shell, schema design
2. **Real-time Messaging** — live database, real conversations/messages/groups, WebSockets
3. **Voice/Video & Notifications** — calling, push notifications, status/stories
4. **AI Features** — a real AI provider wired into every interface above
5. **Multi-device, Scale & Productivity** — session management, mobile/desktop clients, scaling

Full detail: [docs/development-phases.md](docs/development-phases.md).
