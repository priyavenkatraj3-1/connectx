# Security

This is the security statement for ConnectX as of Phase 7 (the final
planned phase). It describes what the code actually does, what has been
verified and how, and — just as important — what is **not** implemented.
Overstating security posture is worse than having none; if you change the
code, keep this file honest.

Verification legend used below:

- **Automated** — covered by the backend/frontend test suites (`npm test`).
  The backend suite runs against pg-mem by default and has also been run
  against real PostgreSQL 16 (`TEST_DATABASE_URL`, see README).
- **Manual** — needs a human with browsers/devices; see
  [manual-testing-final.md](./manual-testing-final.md).
- **Infrastructure** — depends on how you deploy (TLS, proxy, TURN, backups);
  see [deployment.md](./deployment.md).

---

## 1. Authentication model

- **Passwords** — bcrypt (`bcryptjs`), cost `BCRYPT_SALT_ROUNDS` (default
  12; production startup refuses < 10). Policy: 8–128 characters with
  upper-case, lower-case and a digit. Plain-text passwords and hashes are
  never stored in logs or returned by any endpoint. *Automated.*
- **Login responses don't reveal whether an account exists** — an unknown
  email and a wrong password get the identical `401` body, and an unknown
  email still costs one bcrypt comparison against a dummy hash so response
  time doesn't give it away either (Phase 7). *Automated (identical body);
  timing equalization is by construction, not measured.*
- **Signup does reveal existence** (`409 An account with this email
  already exists`) — a deliberate usability trade-off; it is rate-limited
  per IP. Concurrent duplicate signups resolve to exactly one `201` and one
  `409`; user + profile + privacy rows are created in one transaction.
  *Automated.*
- **Tokens** — short-lived access JWTs (`JWT_ACCESS_EXPIRY`, default 15m)
  and refresh JWTs (`JWT_REFRESH_EXPIRY`, default 7d), signed with
  **separate** secrets. Verification is pinned to HS256 (Phase 7), so
  `alg: none`, other HMAC variants and algorithm-confusion tokens are
  rejected. Forged, unsigned, expired and malformed tokens get `401`.
  *Automated.*
- **Production secret checks** — with `NODE_ENV=production` the server
  refuses to start if either JWT secret is shorter than 32 characters,
  still looks like the `.env.example` placeholder, or both secrets are the
  same; also if `CLIENT_ORIGIN` is empty or `*` (Phase 7,
  `productionConfigProblems` in `config/env.ts`). *Automated.*
- **Where secrets live** — only in backend environment variables. The
  frontend bundle contains no secrets (it only knows the API/WS URLs); AI,
  TURN and database credentials are read exclusively by the backend. TURN
  clients get short-lived HMAC credentials when `WEBRTC_TURN_SECRET` is
  used. *Checked by inspection of `frontend/src` and the built bundle.*

## 2. Session model (multi-device)

- Every signup/login creates a `devices` row and a `sessions` row. The
  access token carries the session ID (`sid`).
- A guard in front of every `/api/v1` router (except `/auth`) and the
  WebSocket handshake check that the session exists, belongs to the token's
  user, is not revoked and not expired. Tokens without a `sid` are refused.
- Refresh tokens rotate on every use and only their SHA-256 hash is stored.
  Presenting an already-rotated refresh token is treated as theft and
  revokes the whole session. Sessions keep their original absolute expiry
  across refreshes.
- Logout, "sign out this device" and "sign out all other devices" take
  effect on the very next request, and close that session's sockets
  (close code `4401`).
- The device list never returns tokens or hashes. Users can only list,
  rename or revoke their own sessions (another user's session ID → `404`).
- *All automated* (`sessions.test.ts`, `security.test.ts`,
  `ws-security.test.ts`).

## 3. Authorization model

Rule: **every** permission is enforced on the server; the UI only hides
controls. Tests call the API directly to prove refusal.

| Resource | Rule | Denied as |
|---|---|---|
| Conversations, messages, receipts, unread | Active member of the conversation; members only see messages sent after they joined | `403` |
| Edit / delete message | Author only (plus membership) | `403` |
| Groups | Members see; owner/admins edit and add; admins remove plain members only; only the owner changes roles; nobody removes the owner | `403` / `404` |
| Media | Message media: active member *and* the message is visible to you; unsent uploads: uploader only; status media: exactly the status' audience | `403` / `404` |
| Status | Server-side privacy (`everyone`, `contacts`, `selected`, `except`) + expiry; hidden, expired and nonexistent are indistinguishable; viewer list is owner-only | `404` / `403` |
| Calls | Only conversation members start/see/join; signaling accepted only from a joined participant's bound connection and delivered only to the target's bound connection | `403` / `call:error` |
| AI | Opt-in consent; requested conversations must all be accessible (else `403`, nothing partially answered); per-chat exclusions; retrieval SQL re-applies membership and join-time visibility; memory is owner-only | `403` / `404` |
| Tasks, reminders, events, saved, scheduled messages, notifications, preferences, business profile, quick replies | Owner only (task assignee may change status) | `404` |
| Shared notes, to-do lists, pins | Active conversation member, re-checked on every call; admin-only notes/pins limited to group owner/admins | `403` / `404` |
| Devices/sessions | Own account only | `404` |

Covered by the per-module API tests plus the Phase 7 cross-module
**authorization matrix** in `backend/tests/api/security.test.ts` (an
outsider against every resource type). *Automated.*

## 4. Input validation

- Every body, query and path parameter is validated with Zod before it
  reaches a service: UUIDs, enums, string lengths, numeric bounds,
  ISO-8601 instants with offsets, local wall-clock times + IANA timezones
  (unknown timezones are rejected, DST gaps are rejected, years limited to
  2000–2100). Unknown properties are either rejected (`.strict()` schemas)
  or stripped — they never reach SQL.
- All SQL is parameterized; `LIKE` searches escape `%`/`_`/`\`.
- Malformed JSON → `400`; JSON bodies over 1MB → `413`; any PostgreSQL
  data exception caused by input that slipped past a schema (SQLSTATE
  class 22, e.g. a malformed UUID) is answered `400` with a generic
  message instead of a logged `500` (Phase 7).
- Profile `avatarUrl` and business `website` must be `http(s)` URLs, so a
  `javascript:`/`data:` URL can't reach another user's screen (Phase 7 fix
  for `avatarUrl`).
- *Automated* (`security.test.ts` plus per-module tests).

## 5. Media security

What is implemented (*automated*, `media.test.ts`, `file-validation.test.ts`):

- Size limit `MAX_UPLOAD_SIZE_MB` enforced by the body parser and again on
  the bytes (`413`).
- Extension allow-list (images, audio, video, PDF, text/CSV, Office OOXML,
  ZIP). SVG, HTML, executables and scripts are refused.
- **Magic-byte validation**: the contents must match the extension; the
  client-declared MIME type is only a consistency check and is never
  stored — the stored type is the server's canonical one.
- Filenames are sanitized for display; bytes are stored under
  server-generated UUID keys. The local storage provider rejects any key
  not matching its pattern and any path resolving outside its root (path
  traversal is prevented twice).
- Downloads are authorized per request and served with `nosniff`,
  `Cache-Control: private, no-store`, a `default-src 'none'; sandbox` CSP,
  and non-media types as `Content-Disposition: attachment`.
- Per-user upload rate limit (Phase 7).

Remaining limitations — **not implemented**:

- **No malware scanning.** A well-formed PDF/Office/ZIP file can still be
  malicious. Treat downloaded files as untrusted.
- Images are not re-encoded, so EXIF metadata (e.g. location) is kept.
- No per-user storage quota; uploads that are never sent are not cleaned up.
- Media is not encrypted at rest by the application; the local-disk
  provider is single-instance only.

## 6. WebSocket security

- **Handshake authentication** — the access token (query parameter `token`,
  since browsers can't set WebSocket headers) is verified and its session
  checked during the HTTP Upgrade itself; invalid or revoked → `401`, the
  socket never opens. *Automated.*
- **Origin allow-list** (Phase 7) — a handshake carrying an `Origin` header
  not in `CLIENT_ORIGIN` gets `403` (cross-site WebSocket hijacking
  defense on top of the token). Clients that send no `Origin` (non-browser)
  are judged by their token. *Automated.*
- **Per-event validation and authorization** — every inbound frame is
  size-capped (128KB; larger frames close that connection with `1009`),
  parsed defensively and schema-validated; identity always comes from the
  authenticated socket, never the payload. `message:read` re-checks
  conversation membership; call events go through `CallsService`.
  Malformed/unknown frames are ignored or answered with a generic error;
  none can crash the process. *Automated.*
- **Flood protection** (Phase 7) — each connection may send
  `WS_MAX_MESSAGES_PER_10S` frames per 10 seconds (default 300); beyond
  that it is closed with `1008`. *Automated.*
- **Connection cap** (Phase 7) — at most `WS_MAX_CONNECTIONS_PER_USER`
  simultaneous sockets per user (default 20; `429` at the handshake). A
  reconnect reusing its own connection ID is always allowed. *Automated.*
- **Heartbeat** (Phase 7) — the server pings every connection each
  `WS_HEARTBEAT_SECONDS` (default 30) and terminates connections that
  didn't answer the previous ping, so dead sockets don't linger in the
  registry, presence or call bindings. *Automated.*
- **Revocation** — revoking a session closes its sockets (`4401`).
  *Automated.*
- **Known limitations** — an open socket is not re-checked when its access
  token later *expires* (only on revocation); reverse proxies that log
  full request URLs will log the access token in the WebSocket URL —
  disable query-string logging for `/ws` (see
  [deployment.md](./deployment.md)).

## 7. WebRTC / calls

- Signaling authorization, participant validation, session ownership and
  the call state machine are enforced in `CallsService`; invalid
  transitions are rejected with `call:error`. SDP and ICE candidates are
  relayed only, never stored or logged. Stale "live" calls are marked
  failed at startup. *Automated* (server side, over real WebSockets; the
  browser side against fake `RTCPeerConnection`).
- **Not verified automatically: real audio/video.** Node/jsdom have no
  WebRTC. See the manual test plan.
- **No ICE servers by default** → calls work only on the same machine/LAN.
  Across the internet you need STUN, and behind symmetric NAT/firewalls you
  need TURN (`WEBRTC_TURN_*`). ConnectX does **not** claim calls will
  connect everywhere without a TURN deployment you've validated.
- **Group calls are a peer-to-peer mesh** (max 8 joined, realistically
  3–4). There is no SFU; this is not production-scale group calling.
- Peer-to-peer calls reveal participants' IP addresses to each other; there
  is no relay-only mode.
- Media is encrypted in transit by WebRTC (DTLS-SRTP), but signaling passes
  through the server and there is no key verification — **this is not
  end-to-end encryption**.

## 8. AI privacy and security

See [ai.md](./ai.md) for detail. In short (*automated* with a scripted
provider; real model behavior is manual):

- Provider keys are backend-only; `AI_PROVIDER=none` is the default and
  every AI feature then honestly reports "not configured".
- Opt-in consent, per-chat exclusions and memory opt-in are enforced
  server-side before any provider call.
- Authorization happens **before** retrieval; the model has no tools and
  only ever sees messages the requester can already read. Nothing is sent
  to the provider for an unauthorized request (asserted in tests).
- All chat content is treated as untrusted: each message is one JSON line
  with `<` escaped inside delimited blocks, with rules telling the model to
  ignore instructions in the data. Structured output is schema-validated;
  cited message references are mapped back to real, visible messages
  (unknown ones dropped). Context size, output size, timeouts and retries
  are bounded; provider failures map to clean errors.
- Per-user AI limits (`AI_RATE_LIMIT_PER_MINUTE` in memory per process,
  `AI_RATE_LIMIT_PER_DAY` counted in the database).
- **With a provider configured, the chats a user selects are sent to that
  third party** (disclosed in Settings). Prompt-injection defenses reduce
  but cannot eliminate the chance a crafted message skews an answer.

## 9. Rate limiting and abuse protection

All limits are enforced server-side. **Every counter is in memory, per
backend process**: limits reset on restart and are *not* shared between
instances (not database-backed, not distributed) — except the AI daily
limit, which is counted in the database.

| What | Key | Default | Variable |
|---|---|---|---|
| Every request | client IP | 300 / min | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` |
| Login + signup | client IP | 10 / 15 min | `AUTH_RATE_LIMIT_MAX` |
| Token refresh | client IP | 60 / 15 min | `REFRESH_RATE_LIMIT_MAX` |
| Send message | user | 120 / min | `MESSAGE_RATE_LIMIT_PER_MINUTE` |
| Media upload | user | 30 / min | `UPLOAD_RATE_LIMIT_PER_MINUTE` |
| User search | user | 60 / min | `SEARCH_RATE_LIMIT_PER_MINUTE` |
| Start a call | user | 20 / min | `CALL_RATE_LIMIT_PER_MINUTE` |
| Post a status | user | 30 / hour | `STATUS_RATE_LIMIT_PER_HOUR` |
| AI requests | user | 10 / min, 200 / day | `AI_RATE_LIMIT_PER_MINUTE`, `AI_RATE_LIMIT_PER_DAY` |
| WebSocket frames (incl. call signaling) | connection | 300 / 10 s | `WS_MAX_MESSAGES_PER_10S` |
| WebSocket connections | user | 20 open | `WS_MAX_CONNECTIONS_PER_USER` |

Rejections are `429` with `{ "error": { "message", "code": "rate_limited" } }`
and standard `RateLimit-*` headers. **Behind a reverse proxy you must set
`TRUST_PROXY`** (e.g. `1`), otherwise every client shares the proxy's IP and
the IP-keyed limits lock everyone out together. Other caps: 100 pending
scheduled messages per user, 100 quick replies, 50 pins per conversation,
200 shared notes and 100 to-do lists per conversation, 500 items per to-do
list. *Limiter behavior automated (`production-readiness.test.ts`,
`ws-security.test.ts`); the route-level limiters are relaxed during tests.*

## 10. Errors and logging

- One error envelope everywhere: `{ "error": { "message", "code"? } }`.
  `500` responses always say only "Internal server error" — no stack
  traces, SQL or file paths reach clients. *Automated.*
- Logging goes through a leveled logger (`LOG_LEVEL`:
  `error|warn|info|debug|silent`). Passwords, tokens, API keys, SDP/ICE and
  message content are never logged; the database URL is logged with its
  password masked (Phase 7 fix — it was previously printed in full when
  the database was unreachable).
- `unhandledRejection` is logged; `uncaughtException` is logged and the
  process exits so a supervisor can restart it; `SIGTERM`/`SIGINT` trigger
  a graceful shutdown (timers stopped, sockets closed with `1001`, in-flight
  requests drained for up to 10s, database pool closed).

## 11. Frontend

- No `dangerouslySetInnerHTML`, `eval` or HTML injection anywhere; all user
  content is rendered as React text. External URLs (avatars, business
  websites) are restricted to `http(s)` server-side.
- **Tokens are stored in `localStorage`.** Any script running on the
  frontend's origin could read them, so an XSS bug would allow token theft.
  Mitigations: no HTML rendering of user content, short access-token
  lifetime, refresh rotation with reuse detection, per-device revocation.
  Recommended at deployment: a strict Content-Security-Policy on the static
  host (see [deployment.md](./deployment.md)). Moving tokens to httpOnly
  cookies would need CSRF protection and is not implemented.
- Offline cache (recent messages, queued drafts) is in `localStorage`,
  namespaced per user, **unencrypted**; signing in purges other accounts'
  data and signing out clears yours. Tokens are not part of that cache.
- `401 session_revoked/session_expired` signs the client out locally.
- Route protection in the UI is cosmetic; the API enforces everything.

## 12. What is explicitly NOT implemented

- **No end-to-end encryption** of messages, media, statuses or calls.
  Messages are stored as plaintext in PostgreSQL. TLS is only present if
  you deploy behind it. Do not describe ConnectX as E2E-encrypted.
- **No malware/virus scanning** of uploads.
- **No push notifications** (web push, APNs, FCM, email) — notifications are
  in-app only and only reach clients that are open. Not "globally
  reliable" delivery.
- **Not fully offline** — no service worker; only recent chats are cached and
  only text messages can be queued.
- **No production-scale group calling** (mesh only, no SFU) and no
  guarantee calls connect across restrictive networks without TURN.
- No 2FA, no password reset / account recovery, no new-device
  confirmation (a `session_new` notification is sent, not a block).
- No CSRF protection (not needed while auth is bearer-token only).
- No audit log; no admin/moderation tooling; group admins can't delete
  others' messages; scam reports aren't reviewed by anyone.
- No encryption at rest by the application (database, media, offline cache).
- No automatic cleanup of expired/revoked session rows or unsent uploads.
- No distributed rate limiting, WebSocket registry or scheduler lock —
  run **one backend instance** (see [deployment.md](./deployment.md)).
- General privacy settings (`/privacy`) answer `501`.

## 13. Known risks (accepted for this release)

- Single-instance design: WebSocket registry, call bindings, per-minute
  limits and the scheduler are in-process.
- Tokens readable by JavaScript (see §11).
- Access token visible in WebSocket URLs to anything that logs URLs.
- Signup reveals whether an email is registered.
- Users can be added to groups without consent, which also grants
  visibility of their "everyone I chat with" statuses.
- AI output can be wrong or influenced by crafted messages; it is labeled
  AI-generated and linked to sources.

## Reporting

This is a pre-production project; there is no public disclosure process
yet. Treat any secret accidentally committed (API keys, `.env` files) as
compromised and rotate it immediately — see `backend/.env.example` for the
secrets the backend expects.
