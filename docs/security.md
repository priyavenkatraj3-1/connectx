# Security

## What is actually implemented

- **Password hashing** — bcrypt via `bcryptjs`, salt rounds configurable
  (`BCRYPT_SALT_ROUNDS`, default 12). Plain-text passwords are never stored
  or logged (`modules/auth/password.service.ts`).
- **Persistent authentication** — `PostgresUserRepository` backs signup/login
  with a real `users` table; no in-memory fallback ships in this phase.
- **JWT-based authentication** — short-lived access tokens (default 15m)
  and longer-lived refresh tokens (default 7d), signed with separate
  secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`). See
  `modules/auth/token.service.ts`.
- **Protected routes** — `middleware/requireAuth.ts` verifies the
  `Authorization: Bearer <token>` header and rejects with `401` on a
  missing/invalid/expired token before any handler runs.
- **Conversation-level authorization** — `middleware/requireConversationMember.ts`
  checks that the authenticated user is an active member of `:conversationId`
  before any conversation/message route runs, rejecting with `403`
  otherwise. This is what stops one user from reading, sending to, or
  marking read another pair's private conversation — covered by tests in
  `backend/tests/api/messages.test.ts` and `conversations.test.ts`.
- **WebSocket authentication** — the realtime gateway validates the access
  token during the HTTP Upgrade handshake itself (`verifyClient` in
  `realtime/ws.server.ts`), so an invalid token never completes a
  WebSocket connection (a real `401`, not "connect then disconnect").
  Every event a client sends is scoped to the userId resolved from that
  token — a client cannot claim to be a different user.
- **Search never leaks email addresses** — `GET /users/search` matches
  against email server-side but only ever returns public profile fields
  (id, display name, avatar, status).
- **Input validation** — every mutating route validates its body/query
  against a Zod schema before touching business logic; invalid input never
  reaches a service.
- **Rate limiting** — a general API limiter (default 100 req/min/IP) plus a
  stricter auth-specific limiter (10 req/15min/IP) on signup/login, to slow
  credential stuffing and brute force (`middleware/rateLimiter.ts`).
- **Security headers** — `helmet()` is applied to every response.
- **CORS** — restricted to a single configured origin (`CLIENT_ORIGIN`),
  not a wildcard.
- **Upload validation contract** — `middleware/uploadValidation.ts` defines
  size limits, an allowlist of MIME types, and filename sanitization
  (rejects path separators and `..`) ahead of any real storage backend
  being wired up.
- **Consent-gated AI design** — see [ai-roadmap.md](./ai-roadmap.md); AI
  features are structurally required to check `privacy_settings` before
  acting.

## What is explicitly NOT implemented yet

Be precise about this — overstating security posture is worse than having
none:

- **No end-to-end encryption.** Messages are stored as plaintext in
  PostgreSQL and transmitted over TLS only if you deploy behind TLS
  yourself (not configured in this repo). Do not describe ConnectX as
  E2E-encrypted until it demonstrably is.
- **No server-side refresh-token revocation.** The `sessions` table exists
  in the schema but nothing writes to it yet — a leaked refresh token is
  valid until it expires. There is no "sign out other devices" yet.
- **No CSRF protection** — irrelevant while there is no cookie-based
  session, but must be revisited if cookies are introduced later.
- **No audit logging.**
- **No file storage backend**, so `uploadValidation` is exercised by unit
  tests but not by a real upload path yet.
- **No account recovery / password reset flow.**
- **No 2FA.**
- **No per-user rate limiting on message sending** — only the global/IP
  limiters apply; a single authenticated user could still send messages in
  rapid succession.

## Threat-model notes for later phases

- Access tokens are stateless JWTs — a compromised access token is valid
  until expiry with no way to revoke it early. Once `sessions` is actually
  written to, add a revocation check (e.g. a `sessions.revoked_at` lookup)
  to `requireAuth`.
- `privacy_settings.ai_memory_enabled` is the single gate every memory
  extraction call must check. When implementing `MemoryExtractionService`,
  treat a missing/false consent value as "do not extract," not as "assume
  yes."
- The WebSocket gateway tracks online users in an in-process
  `ConnectionRegistry` (see [architecture.md](./architecture.md)) — running
  multiple backend instances would need a shared registry/pub-sub before
  delivery/online-status guarantees hold across instances.

## Reporting

This is a development-phase project; there is no public disclosure process
yet. Treat any secret accidentally committed (API keys, `.env` files) as
compromised and rotate it immediately — see `.env.example` for the list of
secrets the backend expects.
