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
- **Call authorization (Phase 4)** — only active members of a
  conversation can start, see or join its calls; direct calls can only be
  answered by the invitee while ringing; removed group members can't join;
  call history only includes calls you were invited to or started. The
  caller must supply one of their *own* open connection IDs.
- **Signaling integrity (Phase 4)** — every WebSocket event is
  schema-validated (UUIDs, SDP ≤64KB, strict ICE shape, frames ≤128KB);
  identity comes only from the authenticated socket (client-supplied user
  fields are discarded); offers/answers/candidates are accepted only from
  a *joined* participant's *bound* connection and delivered only to the
  target's bound connection; everything else gets `call:error`. An
  unhandled-socket-error crash (oversized frame) was fixed along the way.
- **Call privacy (Phase 4)** — only call metadata is stored; SDP, ICE
  candidates and media are never stored or logged.
- **Status privacy (Phase 4)** — enforced server-side in one place
  (`StatusesRepository.canView`) for the feed, lookups, views, media
  downloads and realtime events; hidden/expired/nonexistent statuses are
  indistinguishable (`404`); viewer lists are owner-only; privacy details
  are only in the owner's DTOs. "Contacts" requires the owner's own
  engagement in the direct chat, so a stranger can't become a contact by
  messaging you. Expiry is decided and checked by the server.
- **AI features (Phase 5)** — see [ai.md](./ai.md). Opt-in consent
  checked server-side before any provider call; conversation membership,
  join-time visibility and per-chat exclusions enforced in the retrieval
  SQL; untrusted message content delimited and escaped in prompts; model
  output schema-validated and every cited message mapped back to a real,
  visible message; per-user AI rate limits; provider keys backend-only;
  usage log stores metadata only; AI results and status events go only to
  the requester.
- **Server-side sessions (Phase 6)** — every login/signup creates a
  `sessions` row; access tokens carry its ID and a guard in front of every
  `/api/v1` router (except `/auth`) and the WebSocket handshake rejects
  tokens of revoked/expired sessions. Refresh tokens rotate on every use
  and only their SHA-256 hash is stored; presenting an already-rotated
  refresh token is treated as a leak and revokes the session. Revoking a
  device (or "sign out all other devices", or logout) takes effect on the
  next request and closes that session's sockets (close code `4401`).
  Sessions keep their original absolute expiry across refreshes.
- **Productivity & collaboration (Phase 6)** — tasks, reminders, events,
  saved messages, scheduled messages, notifications, preferences, business
  profiles and quick replies are owner-scoped in every query (another
  user's IDs return `404`); a task's assignee may only change its status.
  Shared notes, to-do lists and pins require *active* membership of the
  conversation, re-checked on every call; group pins and `admins`-policy
  notes are limited to owners/admins. Creating anything from a message or
  AI suggestion requires being able to read it; the message is never
  modified and its excerpt disappears once it's deleted or unreadable.
  Scheduled messages re-check membership at send time and go through the
  normal send path. Notification payloads contain navigation IDs only,
  never message text. Business `verificationStatus` can't be set by users —
  every profile is honestly `unverified`.
- **Offline storage (Phase 6)** — the browser caches recent conversations,
  messages and unsent drafts in `localStorage`, namespaced per user;
  signing in purges other accounts' offline data and signing out clears
  your own. Tokens, attachments and AI data are never cached there.

## What is explicitly NOT implemented yet

Be precise about this — overstating security posture is worse than having
none:

- **No end-to-end encryption** — for direct chats, groups, media, statuses
  or calls. (WebRTC encrypts call media in transit with DTLS-SRTP, but the
  server relays signaling and there is no key verification, so this is
  *not* an E2EE guarantee.)
  Messages are stored as plaintext in
  PostgreSQL and transmitted over TLS only if you deploy behind TLS
  yourself (not configured in this repo). Do not describe ConnectX as
  E2E-encrypted until it demonstrably is.
- **Offline data is not encrypted at rest.** Cached message text and
  queued drafts sit in the browser's `localStorage` in plaintext; anyone
  with access to the browser profile can read them.
- **No new-device verification** — a new sign-in creates a `session_new`
  notification on your other devices, but isn't blocked or confirmed.
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
- **Calls reveal network addresses** — peer-to-peer WebRTC exposes
  participants' IP addresses to each other (ICE candidates); there's no
  TURN-only/relay-only mode.
- **No rate limit on call attempts or signaling messages** beyond payload
  caps — a member could repeatedly ring the others in their conversations.
- **Group membership doesn't require consent**, and it grants visibility
  of "Everyone I chat with" statuses.
- **No account recovery / password reset flow.**
- **No 2FA.**
- **AI content leaves the server when a provider is configured.** Chats a
  user selects (and voice audio they choose) are sent to the configured
  AI/transcription provider, whose retention is governed by that
  provider's terms. Prompt-injection defenses reduce, but can't eliminate,
  the chance a crafted message skews an answer — which is why answers are
  labeled AI-generated and tied to their sources. Scam reports are stored
  but not reviewed by anyone yet.
- **No per-user rate limiting on message sending** — only the global/IP
  limiters apply; a single authenticated user could still send messages in
  rapid succession.

## Threat-model notes for later phases

- Every authenticated request now does one indexed `sessions` lookup
  (Phase 6). If that becomes a hot spot, cache active session IDs briefly
  (accepting a short revocation delay) rather than dropping the check.
- The Phase 6 scheduler runs in-process on a timer. Its claims are
  single-statement `UPDATE … WHERE status = 'scheduled'`, and sends and
  notifications are idempotent, but running several instances has not
  been tested — use one scheduler instance until it has.
- The WebSocket gateway tracks online users (and `CallsService` tracks
  call device bindings) in-process — `ConnectionRegistry` (see [architecture.md](./architecture.md)) — running
  multiple backend instances would need a shared registry/pub-sub before
  delivery/online-status guarantees hold across instances.

## Reporting

This is a development-phase project; there is no public disclosure process
yet. Treat any secret accidentally committed (API keys, `.env` files) as
compromised and rotate it immediately — see `.env.example` for the list of
secrets the backend expects.
