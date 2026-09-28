# Architecture

## Overview

ConnectX is split into three independently deployable pieces:

```
connectx/
├── frontend/    React + TypeScript + Vite web client
├── backend/     Node.js + TypeScript + Express API + WebSocket gateway
└── database/    PostgreSQL schema, applied via versioned migrations
```

The frontend talks to the backend over a versioned HTTP API (`/api/v1/...`)
for request/response operations, and a WebSocket connection (`/ws`) for
realtime push (new messages, delivery/read receipts). Nothing in the
frontend imports backend code directly, and nothing in the backend assumes
a particular client — the same API is meant to eventually serve mobile and
desktop clients.

## Backend module boundaries

Each domain lives in its own folder under `backend/src/modules/`:

```
modules/
├── auth/            signup, login, tokens, password hashing
├── users/            user profiles, search
├── conversations/    conversation list (direct + group), direct conversation creation
├── messages/         send, list, edit, delete, replies, @mentions, read receipts
├── groups/           group creation, metadata, membership, roles (Phase 3)
├── media/            upload validation, metadata, storage abstraction, authorized download (Phase 3)
├── notifications/    in-app/push notification delivery — scaffolded, later phase
├── ai/                 provider-agnostic AI feature interfaces — scaffolded, later phase
└── privacy/           user-controlled privacy & AI-consent settings — scaffolded, later phase
```

Every module follows the same internal shape where it applies:

- `*.interface.ts` — the service contract (what the module promises, not how)
- `*.repository.ts` — SQL against PostgreSQL via `DatabaseClient`
- `*.service.ts` — business logic
- `*.controller.ts` — translates HTTP requests/responses to service calls
- `*.routes.ts` — an Express `Router` **factory** (`createXRouter(service)`)
  wiring URLs to controllers/middleware

Routers are factories rather than module-level singletons specifically so
they can be built from either the real PostgreSQL-backed services
(production) or test-only services backed by an in-memory database (see
Testing below) — see `backend/src/container.ts`.

## Why some modules are still interface-only

`auth`, `users`, `conversations`, and `messages` are fully implemented as
of Phase 2; `groups` and `media` as of Phase 3. `notifications`, `privacy`,
and `ai` remain a service contract plus a router that honestly responds
`501 Not Implemented` — see `backend/src/utils/notImplemented.ts`. This
keeps the shape of the system visible and reviewable without faking
functionality that doesn't exist yet (no fabricated group data, no AI
responses that are secretly hard-coded strings).

## Dependency injection: `container.ts`

`backend/src/container.ts` builds every repository and service from a
single `DatabaseClient` and a `RealtimeGateway`:

```
DatabaseClient ─┬─> PostgresUserRepository ─> AuthService
                ├─> UsersRepository ─────────> UsersService
                ├─> ConversationsRepository ─> ConversationsService
                ├─> MediaRepository ─┬───────> MediaService ──────┐
                │                    └─┐                          ├── StorageProvider (local disk / in-memory in tests)
                ├─> MessagesRepository ┴─────> MessagesService ───┤
                └─> GroupsRepository ────────> GroupsService      │
                                                  │               │
          MessagesService, GroupsService ─(push events via)─> RealtimeGateway
```

Tests can also override `storage` (an in-memory `StorageProvider`) and
`maxUploadBytes`.

## Groups: one conversation model, two tables

A group *is* a conversation (`conversations.type = 'group'`) plus a
`groups` metadata row. Access control is shared with direct chats:
`conversation_members` (active when `left_at IS NULL`) decides who can
read/send, so the existing `requireConversationMember` guard and the
messages module work for groups without a second messaging stack.
`group_members` adds the role; `GroupsRepository` writes both tables in one
transaction. Role rules live in `GroupsService` (permission table in
[api.md](./api.md#groups--modulesgroups-phase-3)). See
[database.md](./database.md#groups) for the integrity constraints.

## Media: metadata in Postgres, bytes behind `StorageProvider`

`modules/media/storage/storage-provider.interface.ts` defines
`save/read/delete(storageKey)`. Phase 3 ships `LocalDiskStorageProvider`
(writes under `UPLOAD_DIR`, default `backend/uploads/`, gitignored); an
S3/object-storage implementation can replace it in `container.ts` without
touching the service, repository or routes. Storage keys are
`<conversationId>/<attachmentId>` — never derived from user input.

Uploads are sent as a raw request body (`express.raw`, scoped to the one
route) rather than multipart, so no upload library was added. Validation
(`file-validation.ts`) checks size, extension allow-list, and magic bytes
before anything is written. The browser can't attach an `Authorization`
header to `<img src>`, so the frontend fetches media with the token and
renders it through a temporary object URL (`useAttachmentUrl`).

`createApp(overrides?)` (in `app.ts`) calls `createContainer(overrides)`
and mounts routers built from its services, returning both the Express
`app` and the `container` itself. Production (`server.ts`) uses the
default container (a real `pg` pool); tests pass `{ db: <pg-mem client> }`
to run the exact same code against an in-memory database — see
`backend/tests/helpers/testDb.ts`.

The container's `realtimeGatewayRef` is a mutable holder: services are
built with a gateway that delegates through this ref, so `server.ts` can
create the HTTP server first, attach the WebSocket gateway to it, and only
then point the ref at the real gateway — breaking what would otherwise be
a circular dependency (the WebSocket gateway needs `messagesService` to
handle client-sent read receipts; `messagesService` needs the gateway to
push events).

## Realtime: `backend/src/realtime`

`ws.server.ts` attaches a `WebSocketServer` (from the `ws` package) to the
same HTTP server as the Express app, at `/ws`. Authentication happens
during the HTTP Upgrade handshake itself (`verifyClient`), so an invalid
or missing access token gets a real `401` and the socket never opens on
the client side — it does not accept-then-close, which would still fire
the browser's `open` event.

`ConnectionRegistry` tracks which open sockets belong to which
authenticated user (a user may have several: multiple tabs, multiple
devices). `MessagesService` and `GroupsService` push events (messages,
receipts, edits/deletes, membership and role changes — fanned out with
`realtime/broadcast.ts` to the conversation's active members only) through
the `RealtimeGateway` interface — neither
touches the `ws` package directly, so the transport could be swapped
without touching business logic. See [api.md](./api.md#realtime--websocket-gateway)
for the full event catalog.

## Calls: WebRTC media, WebSocket signaling (Phase 4)

Audio/video flows **browser-to-browser over WebRTC** (directly, or via a
TURN relay); the backend never sees media. `CallsService` is the
authority for who may call whom and for each call's state, and relays SDP
and ICE candidates over the existing gateway. Key design points:

- **Per-device binding.** Each WebSocket connection has a connection ID
  (`cid`); a participant is bound to the connection they started/accepted
  from, and signaling goes only there (`RealtimeGateway.sendToConnection`)
  — never to their other tabs.
- **Validated inbound events.** `realtime/client-events.ts` (Zod) checks
  every client event; identity is always the socket's user.
  `ws.server.ts` routes `call:*` events to `CallsService` via
  `realtime/gateway-handlers.ts` (shared by `server.ts` and tests).
- **Race-free state machine.** Conditional `UPDATE … WHERE state IN (…)`
  transitions, a per-call in-process mutex, a partial unique index for one
  live call per conversation, and a `CHECK` tying `ended_at` to terminal
  states.
- **Ephemeral state in memory** (bindings, ring timers, mic/camera flags),
  matching the single-instance gateway; stale live calls are failed at
  startup.
- **Group calls = mesh** on the client (`lib/webrtc/peerMesh.ts`), capped
  at 8 on the server — the session/participant model is designed so an SFU
  can replace the mesh later.

Full details: [calls.md](./calls.md).

## Status: privacy decided in one place (Phase 4)

`StatusesRepository.canView` is the single privacy decision point, used by
the feed, direct lookups, view tracking, realtime fan-out, and — through
the `StatusMediaAccess` interface injected into `MediaService` — status
media downloads. Status media reuses the Phase 3 upload pipeline
(`attachments.purpose = 'status'`, no conversation). Expiry is a SQL
predicate on the database clock; a 60-second sweep in `server.ts` deletes
expired rows/media and notifies clients. Details: [status.md](./status.md).

## AI architecture

AI features are built against a provider-agnostic abstraction
(`modules/ai/interfaces/ai-provider.interface.ts`). Feature-level services
(chat assistant, summarization, translation, etc.) depend on `AIProvider`,
never on a specific vendor SDK. `modules/ai/providers/provider.factory.ts`
selects an implementation based on the `AI_PROVIDER` environment variable;
this phase ships only `NoneAIProvider`, which reports itself as
unconfigured rather than returning fake output. See [ai-roadmap.md](./ai-roadmap.md).

## Database access

`backend/src/db/pool.ts` defines the `DatabaseClient` interface
(`query<Row>(sql, params)`, `withTransaction`, `close`) and
`createPostgresClient()`, a real implementation backed by `pg.Pool`. Every
repository depends on `DatabaseClient`, never on `pg` directly.

Schema changes live as versioned SQL files in `database/migrations/`,
applied by `backend/src/db/migrate.ts` (`npm run db:migrate`), which
tracks what's been applied in a `schema_migrations` table so re-running it
is safe.

## Testing without a live database

Backend integration tests build a fresh `DatabaseClient` per test file
backed by [`pg-mem`](https://github.com/oguimbal/pg-mem) — an in-memory,
PostgreSQL-compatible SQL engine — with every migration applied to it (see
`backend/tests/helpers/testDb.ts`). This means the test suite exercises
real SQL (joins, `ON CONFLICT` upserts, transactions) against the real
schema, without requiring a network PostgreSQL server. Production code
never imports `pg-mem`; it is a devDependency used only by tests.

The same suite can be pointed at a real PostgreSQL server with
`TEST_DATABASE_URL` (see [database.md](./database.md#testing-against-this-schema)) —
this is how Phase 3 caught a timestamp-precision bug pg-mem can't
reproduce.

Realtime tests (`backend/tests/realtime/ws.test.ts`, `groups-ws.test.ts`) go a layer further:
they start a real `http.Server`, attach the real `ws.server.ts` gateway to
it, and connect real `ws` clients over a real (loopback) socket — nothing
about the WebSocket transport itself is mocked.

## Frontend structure

```
frontend/src/
├── components/
│   ├── ui/        generic building blocks (Button, Input, Avatar, icons)
│   ├── layout/    shell-level layout (Sidebar, AppShellLayout, AuthLayout, ChatsLayout)
│   ├── chat/      chat-specific pieces (ChatListPanel, ConversationArea,
│   │              NewConversationModal, MessageStatusTicks, MessageBubble,
│   │              MessageComposer — replies, edits, @mentions, attachments)
│   ├── groups/    NewGroupModal, GroupDetailsPanel, MemberPicker
│   ├── media/     AttachmentView (image/video/audio inline, documents as file cards)
│   └── common/    cross-cutting states (LoadingState, ErrorState, EmptyState)
├── pages/         route-level views (Landing, Login, Signup, app/*)
├── context/        React context providers (AuthContext, RealtimeContext,
│                    ConversationsContext)
├── routes/         routing helpers (ProtectedRoute)
├── services/        API client + per-domain service wrappers (auth, users,
│                    conversations, messages, groups, media)
├── hooks/           useDebouncedValue, useAttachmentUrl
├── utils/           formatting, conversation display + group permission mirror
├── types/           shared TypeScript types (mirrors backend DTOs)
└── styles/          Tailwind entry point
```

Routing is handled by `react-router-dom`. Authenticated routes are nested
under `/app` and wrapped in `<ProtectedRoute>`, which redirects to `/login`
when no session is present in `AuthContext`. `/app` and `/app/chat/:id`
additionally share a `ChatsLayout` (chat list + active conversation).

**`RealtimeContext`** owns the single WebSocket connection for the signed-in
user: it connects when `AuthContext` has an access token, reconnects on
drop, and exposes `subscribe(listener)` for any component to receive
server events. **`ConversationsContext`** is the one place that owns the
conversation list — it fetches it once, then updates it incrementally from
realtime events (new message → move to top of list + bump unread count;
mark-read → zero the badge; `conversation:unread` → sync the badge from
another device; `conversation:removed` → drop it). Events whose effect the
client can't compute locally (a member joined, a message was deleted and
the preview must change) trigger a quiet background refetch.

## Multi-device & scalability notes (forward-looking)

- **Sessions & devices** are modeled as separate tables (`sessions`,
  `devices`) from the start, so multi-device login and per-device sign-out
  are schema-supported even though only single-session JWT auth exists so
  far.
- **Stateless access tokens** (short-lived JWT) plus **refresh tokens**
  scoped to a session record are the intended long-term auth model — token
  issuance/verification is implemented; refresh-token rotation and
  server-side revocation are not yet.
- A user's realtime connections are tracked per-process, in memory
  (`ConnectionRegistry`) — and so are live-call device bindings and ring
  timers (`CallsService`). Running more than one backend instance behind a
  load balancer would require a shared pub/sub layer (e.g. Redis) so an
  event for a user connected to instance B can be delivered even when the
  message was sent via instance A — not needed at this scale, but worth
  flagging before the Scale phase (see development-phases.md).
- Media bytes are stored on the local disk of whichever instance received
  the upload (`LocalDiskStorageProvider`). Multiple instances need a shared
  `StorageProvider` (object storage such as S3) — the interface is already
  in place for that swap.
