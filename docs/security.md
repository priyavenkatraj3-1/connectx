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
- **Group authorization (Phase 3)** — every group operation is checked in
  `GroupsService` against the caller's current role (permission table in
  [api.md](./api.md#groups--modulesgroups-phase-3)): only owners/admins
  edit details or add members, admins can remove only plain members, only
  the owner changes roles or removes admins, and nobody can remove the
  owner. Membership and roles are also protected by the database (primary
  key against duplicate membership, a partial unique index allowing at most
  one owner). The UI hides controls you can't use, but that is cosmetic —
  tests call the API directly to prove the server refuses.
- **Group message authorization** — group conversations reuse the Phase 2
  membership gate, so non-members get `403` on read, send, edit, delete
  and mark-read. `MessagesService` re-checks membership itself (not only
  the HTTP middleware), which also closes a Phase 2 gap: the WebSocket
  `message:read` client event previously reached `markRead` without any
  membership check. Only a message's author can edit or delete it.
- **History visibility** — members only see messages (and their media)
  sent at or after they joined, so someone added to — or re-added to — a
  group can't read earlier conversation.
- **Upload validation (Phase 3)** — `modules/media/file-validation.ts`:
  size limit (`MAX_UPLOAD_SIZE_MB`, enforced by the body parser and again
  on the bytes), an extension allow-list (no SVG/HTML/executables/scripts),
  and **magic-byte checks** that the file contents match the extension.
  The client-declared MIME type is never trusted: a contradicting
  declaration is rejected, and the stored type is the server's.
  Filenames are sanitized for display only — bytes are stored under a
  server-generated `<conversationId>/<attachmentId>` key, and the local
  storage provider rejects any key not matching that pattern and any path
  resolving outside its root (path traversal is prevented twice).
- **Media access control** — downloads require active membership of the
  attachment's conversation; unsent uploads are visible only to their
  uploader; sent media follows its message's visibility; only the uploader
  can delete an unsent upload. Responses carry `nosniff`, `private,
  no-store`, a sandboxing CSP, and documents are served as downloads
  (`Content-Disposition: attachment`), not rendered inline.
- **Consent-gated AI design** — see [ai-roadmap.md](./ai-roadmap.md); AI
  features are structurally required to check `privacy_settings` before
  acting.

## What is explicitly NOT implemented yet

Be precise about this — overstating security posture is worse than having
none:

- **No end-to-end encryption** — for direct chats, groups, or media.
  Messages are stored as plaintext in
  PostgreSQL and transmitted over TLS only if you deploy behind TLS
  yourself (not configured in this repo). Do not describe ConnectX as
  E2E-encrypted until it demonstrably is.
- **No server-side refresh-token revocation.** The `sessions` table exists
  in the schema but nothing writes to it yet — a leaked refresh token is
  valid until it expires. There is no "sign out other devices" yet.
- **No CSRF protection** — irrelevant while there is no cookie-based
  session, but must be revisited if cookies are introduced later.
- **No audit logging.**
- **No malware / virus scanning of uploads.** Validation checks format
  (extension + magic bytes) only. A well-formed PDF, Office document or
  ZIP can still contain malicious content; treat downloaded files as
  untrusted.
- **Media is not encrypted at rest** by the application — files sit on
  local disk (development storage) as uploaded. Images are not re-encoded,
  so embedded metadata (e.g. EXIF location) is preserved.
- **No cleanup of abandoned uploads** — an upload that's never sent stays
  (private to its uploader) until they delete it; no background job purges
  them yet.
- **No per-user upload quota or upload-specific rate limit** beyond the
  global API limiter.
- **Group admins cannot moderate (delete) other people's messages** —
  deletion is author-only in this phase.
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
