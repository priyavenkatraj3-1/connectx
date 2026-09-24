# Security

## What is actually implemented in Phase 1

- **Password hashing** — bcrypt via `bcryptjs`, salt rounds configurable
  (`BCRYPT_SALT_ROUNDS`, default 12). Plain-text passwords are never stored
  or logged (`modules/auth/password.service.ts`).
- **JWT-based authentication** — short-lived access tokens (default 15m)
  and longer-lived refresh tokens (default 7d), signed with separate
  secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`). See
  `modules/auth/token.service.ts`.
- **Protected routes** — `middleware/requireAuth.ts` verifies the
  `Authorization: Bearer <token>` header and rejects with `401` on a
  missing/invalid/expired token before any handler runs.
- **Input validation** — every mutating auth route validates its body
  against a Zod schema (`modules/auth/auth.validation.ts`) before touching
  business logic; invalid input never reaches a service.
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

- **No end-to-end encryption.** Messages are not encrypted client-side in
  Phase 1. Do not describe ConnectX as E2E-encrypted until it demonstrably
  is.
- **No live database**, so no real persistence, no row-level access
  control enforcement beyond what's coded in the (currently 501) route
  handlers, and no server-side refresh-token revocation.
- **No CSRF protection** — irrelevant while there is no cookie-based
  session, but must be revisited if cookies are introduced later.
- **No audit logging.**
- **No file storage backend**, so `uploadValidation` is exercised by unit
  tests but not by a real upload path yet.
- **No account recovery / password reset flow.**
- **No 2FA.**

## Threat-model notes for later phases

- Access tokens are stateless JWTs — a compromised access token is valid
  until expiry with no way to revoke it early in Phase 1. Once `sessions`
  is backed by a database, add a revocation check (e.g. a `sessions.revoked_at`
  lookup) to `requireAuth`.
- The in-memory auth store (`InMemoryUserRepository`) is explicitly
  documented as dev/test-only in its own file header — it must never ship
  to a real deployment holding real user data.
- `privacy_settings.ai_memory_enabled` is the single gate every memory
  extraction call must check. When implementing `MemoryExtractionService`,
  treat a missing/false consent value as "do not extract," not as "assume
  yes."

## Reporting

This is a development-phase project; there is no public disclosure process
yet. Treat any secret accidentally committed (API keys, `.env` files) as
compromised and rotate it immediately — see `.env.example` for the list of
secrets the backend expects.
