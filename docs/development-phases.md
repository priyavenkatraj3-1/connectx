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

## Phase 2 — Authentication & Real-time Direct Messaging ✅ (this phase)

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

## Phase 3 — Groups, Voice/Video & Notifications (planned)

- Group conversations (multi-member), building on the existing `groups` /
  `group_members` schema
- Calling infrastructure (signaling + media transport)
- Push notification delivery (web push, mobile push)
- Status/stories with expiry cleanup job
- File attachments (media module wired to real object storage)

## Phase 4 — AI Features (planned)

- Wire up a real `AIProvider` implementation
- Implement Ask Your Chats, chat search, and AI Chat Memory (with consent
  UI backed by real `privacy_settings` persistence)
- Voice Intelligence, Group Decision AI, Scam/Spam Shield, Smart Action
  Extraction, Live Translation

## Phase 5 — Multi-device, Scale & Productivity (planned)

- Refresh-token rotation and server-side session revocation
- Mobile/desktop client shells against the same API
- Horizontal scaling of the backend (stateless by design since Phase 1)
- Productivity/collaboration features beyond messaging

## Ground rules for every phase

- No phase implements features from a later phase "while we're at it."
- No fake/mocked functionality presented as real — an unimplemented route
  says so (`501`), it doesn't return plausible-looking fabricated data.
- No security claims (e.g. "end-to-end encrypted") until they're true and
  verified.
- Each phase gets its own reviewed commit(s); this file is updated when a
  phase completes.
