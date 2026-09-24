# Architecture

## Overview

ConnectX is split into three independently deployable pieces:

```
connectx/
├── frontend/    React + TypeScript + Vite web client
├── backend/     Node.js + TypeScript + Express API
└── database/    PostgreSQL schema (design artifact — not yet wired up)
```

The frontend talks to the backend exclusively over a versioned HTTP API
(`/api/v1/...`). Nothing in the frontend imports backend code directly, and
nothing in the backend assumes a particular client — the same API is meant
to eventually serve mobile and desktop clients.

## Backend module boundaries

Each domain lives in its own folder under `backend/src/modules/`:

```
modules/
├── auth/            signup, login, tokens, password hashing
├── users/            user identity/profile access
├── conversations/    direct & group conversation management
├── messages/         sending, listing, reacting to messages
├── groups/            group/community membership
├── media/             file/attachment upload & retrieval
├── notifications/    in-app/push notification delivery
├── ai/                 provider-agnostic AI feature interfaces
└── privacy/           user-controlled privacy & AI-consent settings
```

Every module follows the same internal shape where it applies:

- `*.interface.ts` — the service contract (what the module promises, not how)
- `*.service.ts` — business logic (implemented where the feature is real in Phase 1)
- `*.controller.ts` — translates HTTP requests/responses to service calls
- `*.routes.ts` — Express `Router` wiring URLs to controllers/middleware

This separation exists so a route's HTTP concerns (status codes, request
parsing) never leak into business logic, and so business logic can be
tested without spinning up Express at all.

## Why most modules are interface-only in Phase 1

The task for Phase 1 was explicitly to build a **foundation**, not a working
messaging app. Modules other than `auth` (and the thin `users` read path)
expose their intended service contract as a TypeScript interface and a
router that honestly responds `501 Not Implemented` — see
`backend/src/utils/notImplemented.ts`. This keeps the shape of the system
visible and reviewable without faking functionality that doesn't exist yet
(no in-memory chat history pretending to be persistent, no AI responses
that are secretly hard-coded strings).

## AI architecture

AI features are built against a provider-agnostic abstraction
(`modules/ai/interfaces/ai-provider.interface.ts`). Feature-level services
(chat assistant, summarization, translation, etc.) depend on `AIProvider`,
never on a specific vendor SDK. `modules/ai/providers/provider.factory.ts`
selects an implementation based on the `AI_PROVIDER` environment variable;
Phase 1 ships only `NoneAIProvider`, which reports itself as unconfigured
rather than returning fake output. See [ai-roadmap.md](./ai-roadmap.md).

## Database access

`backend/src/db/pool.ts` defines the `DatabaseClient` interface
(`query<Row>(sql, params)`) that all future repositories will depend on.
Phase 1 does not connect to a real database — `auth` uses an explicitly
documented in-memory repository (`InMemoryUserRepository`) so the
authentication flow can be exercised end-to-end in tests and local
development before a real Postgres-backed repository replaces it.

## Frontend structure

```
frontend/src/
├── components/
│   ├── ui/        generic building blocks (Button, Input, Avatar, icons)
│   ├── layout/    shell-level layout (Sidebar, AppShellLayout, AuthLayout)
│   ├── chat/      chat-specific pieces (ChatListPanel, ConversationArea)
│   └── common/    cross-cutting states (LoadingState, ErrorState, EmptyState)
├── pages/         route-level views (Landing, Login, Signup, app/*)
├── context/        React context providers (AuthContext)
├── routes/         routing helpers (ProtectedRoute)
├── services/        API client + per-domain service wrappers
├── types/           shared TypeScript types
└── styles/          Tailwind entry point
```

Routing is handled by `react-router-dom`. Authenticated routes are nested
under `/app` and wrapped in `<ProtectedRoute>`, which redirects to `/login`
when no session is present in `AuthContext`.

## Multi-device & scalability notes (forward-looking)

These are documented now so later phases don't have to retrofit them:

- **Sessions & devices** are modeled as separate tables (`sessions`,
  `devices`) from the start, so multi-device login and per-device sign-out
  are schema-supported even though only single-session JWT auth exists in
  Phase 1.
- **Stateless access tokens** (short-lived JWT) plus **refresh tokens**
  scoped to a session record are the intended long-term auth model — Phase 1
  implements token issuance/verification but not refresh-token rotation or
  server-side revocation (no DB yet).
- The backend has no in-process state beyond the Phase 1 in-memory auth
  store, so it can already run as multiple stateless instances behind a load
  balancer once a real database and a real-time transport (WebSockets, or a
  message broker) are introduced.
