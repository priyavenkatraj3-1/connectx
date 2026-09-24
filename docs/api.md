# API Reference (Phase 1)

Base URL: `http://localhost:4000/api/v1` (configurable via `CLIENT_ORIGIN`/`PORT`).

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

Returns `200 { "status": "ok", "service": "connectx-backend" }`. Used for
uptime checks; not part of the versioned API surface.

## Auth — `modules/auth` (fully implemented in Phase 1)

### `POST /api/v1/auth/signup`

```json
{ "email": "a@example.com", "password": "Passw0rd!", "displayName": "Ada" }
```

Password must be 8-128 characters with at least one uppercase letter, one
lowercase letter, and one number. Returns `201` with `{ user, tokens }` or
`409` if the email is already registered.

### `POST /api/v1/auth/login`

```json
{ "email": "a@example.com", "password": "Passw0rd!" }
```

Returns `200` with `{ user, tokens }` or `401` on bad credentials.

### `POST /api/v1/auth/logout`

Stateless in Phase 1 (no server-side session store yet) — returns `204`
regardless of input. The client is responsible for discarding its tokens.

Both `signup` and `login` are rate-limited to 10 requests per 15 minutes
per IP (`middleware/rateLimiter.ts`).

## Users — `modules/users` (partially implemented)

### `GET /api/v1/users/me` — requires auth

Returns `{ "userId": "<uuid>" }` from the verified access token. Full
profile retrieval (bio, avatar, status) is planned once `user_profiles` is
backed by a real database.

## Everything else — scaffolded, not implemented

The following routers exist with the correct URL shape and
`requireAuth` protection, but every handler currently responds
`501 Not Implemented` with an explanatory message
(`{ "error": { "message": "<Feature> is not implemented yet (planned for a later phase)." } }`).
This is intentional — see [development-phases.md](./development-phases.md).

| Module | Routes |
|---|---|
| `conversations` | `GET /conversations`, `POST /conversations`, `GET /conversations/:conversationId` |
| `messages` | `GET /messages/:conversationId`, `POST /messages/:conversationId`, `DELETE /messages/:messageId`, `POST /messages/:messageId/reactions` |
| `groups` | `POST /groups`, `POST /groups/:groupId/members`, `DELETE /groups/:groupId/members/:userId`, `GET /groups/:groupId/members` |
| `media` | `POST /media`, `GET /media/:attachmentId`, `DELETE /media/:attachmentId` |
| `notifications` | `GET /notifications`, `POST /notifications/:notificationId/read` |
| `privacy` | `GET /privacy`, `PATCH /privacy` |
| `ai` | `POST /ai/ask`, `GET /ai/memories`, `DELETE /ai/memories/:memoryId`, `POST /ai/voice/:attachmentId/analyze`, `POST /ai/conversations/:conversationId/summarize`, `POST /ai/spam-shield/analyze`, `POST /ai/conversations/:conversationId/actions`, `POST /ai/translate` |

Each of these maps to a documented service interface under the
corresponding module (e.g. `modules/ai/interfaces/*.interface.ts`) — the
contract is fixed even though the implementation isn't, so the frontend and
backend can evolve against a stable shape.
