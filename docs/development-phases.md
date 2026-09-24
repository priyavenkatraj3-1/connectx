# Development Phases

ConnectX is built in explicit, separated phases. Each phase should be
reviewed and merged before the next begins — this document tracks what's
done and what's next so the project doesn't drift into "build everything
at once."

## Phase 1 — Foundation ✅ (this phase)

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

## Phase 2 — Real-time Messaging (planned)

- Connect a real PostgreSQL database; replace `InMemoryUserRepository`
- Implement `conversations`, `messages`, `groups` modules for real
- WebSocket (or equivalent) transport for real-time message delivery and
  presence
- Message persistence, pagination, edit/delete, reactions
- File upload backend (object storage) wired to `media` module

## Phase 3 — Voice/Video & Notifications (planned)

- Calling infrastructure (signaling + media transport)
- Push notification delivery (web push, mobile push)
- Status/stories with expiry cleanup job

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
