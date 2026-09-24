# API Reference

Base URL: `http://localhost:4000/api/v1` (configurable via `CLIENT_ORIGIN`/`PORT`).
WebSocket gateway: `ws://localhost:4000/ws?token=<accessToken>`.

All request/response bodies are JSON. Authenticated routes require:

```
Authorization: Bearer <accessToken>
```

Errors always take the shape:

```json
{ "error": { "message": "human-readable description" } }
```

## Health

### `GET /health` (unversioned, outside `/api/v1`)

Returns `200 { "status": "ok", "service": "connectx-backend" }`.

## Auth — `modules/auth` (fully implemented, persistent)

### `POST /api/v1/auth/signup`

```json
{ "email": "a@example.com", "password": "Passw0rd!", "displayName": "Ada" }
```

Password must be 8-128 characters with at least one uppercase letter, one
lowercase letter, and one number. Creates a row in `users` plus empty
`user_profiles` / `privacy_settings` rows. Returns `201` with
`{ user, tokens }` or `409` if the email is already registered.

### `POST /api/v1/auth/login`

```json
{ "email": "a@example.com", "password": "Passw0rd!" }
```

Returns `200` with `{ user, tokens }` or `401` on bad credentials.

### `POST /api/v1/auth/logout`

Stateless in this phase (no server-side session store yet) — returns `204`
regardless of input. The client is responsible for discarding its tokens.

Both `signup` and `login` are rate-limited to 10 requests per 15 minutes
per IP (`middleware/rateLimiter.ts`).

## Users — `modules/users` (fully implemented)

### `GET /api/v1/users/me` — requires auth

Returns the authenticated user's own profile: `{ id, email, displayName, avatarUrl, bio, statusMessage, createdAt }`.

### `PATCH /api/v1/users/me` — requires auth

Body: any of `{ displayName?, bio?, statusMessage?, avatarUrl? }` (at least
one field). Returns the updated profile.

### `GET /api/v1/users/search?q=<query>` — requires auth

Case-insensitive partial match on display name or email. Returns
`{ results: PublicProfile[] }` — `id`, `displayName`, `avatarUrl`,
`statusMessage` only; email is never included in results. Excludes the
requesting user.

### `GET /api/v1/users/:userId` — requires auth

Returns another user's public profile (same shape as one search result).

## Conversations — `modules/conversations` (fully implemented, direct only)

### `GET /api/v1/conversations` — requires auth

Returns `{ conversations: ConversationSummary[] }`, sorted by most recent
activity. Each summary includes the other participant's public profile,
a preview of the last message (or `null`), and the requesting user's
unread count for that conversation.

### `POST /api/v1/conversations/direct` — requires auth

```json
{ "userId": "<other user's id>" }
```

Returns the existing direct conversation between the two users if one
exists, or creates it. Idempotent regardless of which user calls it first.
`400` if `userId` is your own ID.

### `GET /api/v1/conversations/:conversationId` — requires auth + membership

Returns `{ conversation }`. `403` if you are not a member.

Group conversations remain a later phase — see
[development-phases.md](./development-phases.md).

## Messages — `modules/messages` (fully implemented, direct conversations)

All routes below require auth **and** that the requester is a member of
`:conversationId` (enforced by `requireConversationMember`) — otherwise `403`.

### `GET /api/v1/messages/:conversationId?before=<messageId>&limit=<n>`

Returns `{ items: MessageDTO[], hasMore: boolean }` in chronological
(oldest-first) order. `before` pages backward from a given message id;
`limit` defaults to 50, max 100. Each `MessageDTO` includes a `status` of
`"sent" | "delivered" | "read"`.

### `POST /api/v1/messages/:conversationId`

```json
{ "body": "Hello!" }
```

Persists the message, updates the conversation's `updated_at`, and pushes
a `message:new` WebSocket event to every other member. If the recipient is
currently connected, the message is immediately marked `delivered` and the
sender receives a `message:delivered` event. Returns `201 { message }`.

### `POST /api/v1/messages/:conversationId/read`

```json
{ "upToMessageId": "<message id>" }
```

Marks every message in the conversation up to and including that one
(not sent by you) as read, updates your unread count to 0 for this
conversation, and pushes a `message:read` event to the other participant.
Returns `204`.

## Realtime — WebSocket gateway (`backend/src/realtime`)

Connect to `ws://<host>/ws?token=<accessToken>` (the access token is
passed as a query parameter because browsers' native WebSocket API cannot
set custom headers). An invalid/missing token is rejected during the HTTP
Upgrade handshake with a `401` — the socket never opens.

**Server → client events** (`ServerEvent`, see `realtime/events.ts`):

| `type` | Payload | Sent when |
|---|---|---|
| `message:new` | `{ conversationId, message }` | A message is sent in a conversation you're a member of (including your own, for multi-tab sync) |
| `message:delivered` | `{ conversationId, messageId, userId }` | A recipient who was online received your message |
| `message:read` | `{ conversationId, userId, upToMessageId }` | The other participant marked the conversation read |
| `error` | `{ message }` | The server couldn't process your last client event |

**Client → server events** (`ClientEvent`):

| `type` | Payload | Effect |
|---|---|---|
| `message:read` | `{ conversationId, upToMessageId }` | Same effect as `POST /messages/:conversationId/read`, over the socket |
| `ping` | — | No-op; the open connection itself is the liveness signal |

## Everything else — scaffolded, not implemented

The following routers exist with the correct URL shape and
`requireAuth` protection, but every handler currently responds
`501 Not Implemented` with an explanatory message. This is intentional —
see [development-phases.md](./development-phases.md).

| Module | Routes |
|---|---|
| `groups` | `POST /groups`, `POST /groups/:groupId/members`, `DELETE /groups/:groupId/members/:userId`, `GET /groups/:groupId/members` |
| `media` | `POST /media`, `GET /media/:attachmentId`, `DELETE /media/:attachmentId` |
| `notifications` | `GET /notifications`, `POST /notifications/:notificationId/read` |
| `privacy` | `GET /privacy`, `PATCH /privacy` |
| `ai` | `POST /ai/ask`, `GET /ai/memories`, `DELETE /ai/memories/:memoryId`, `POST /ai/voice/:attachmentId/analyze`, `POST /ai/conversations/:conversationId/summarize`, `POST /ai/spam-shield/analyze`, `POST /ai/conversations/:conversationId/actions`, `POST /ai/translate` |

Each of these maps to a documented service interface under the
corresponding module (e.g. `modules/ai/interfaces/*.interface.ts`) — the
contract is fixed even though the implementation isn't.
