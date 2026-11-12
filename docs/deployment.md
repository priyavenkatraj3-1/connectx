# Deployment guide

How to run ConnectX in production. **Nothing in this repository deploys
automatically, and no production deployment has been performed or
verified as part of Phase 7.** What *has* been verified locally is listed
at the end. Read [security.md](./security.md) first — especially what is
not implemented.

## Supported topology (read this first)

ConnectX is designed and tested as **one backend process** + a static
frontend + PostgreSQL:

```
browser ──HTTPS──▶ reverse proxy (TLS) ──▶ static frontend files (frontend/dist)
        ──HTTPS/WSS──▶ reverse proxy ──▶ ONE backend process (HTTP + /ws)
                                               │
                                               ├──▶ PostgreSQL 14+
                                               └──▶ local disk (UPLOAD_DIR) or Cloudinary
```

Run exactly **one** backend instance. The following live in that
process's memory and are not shared: the WebSocket connection registry
(who is online, event delivery), call device bindings and ring timers,
per-minute rate-limit counters, and the scheduler loop. Several instances
would deliver events only to sockets on the same instance and could
double-schedule work that hasn't been validated for concurrency. Scaling
out needs a shared pub/sub (e.g. Redis), a shared rate-limit store, object
storage and a scheduler lock — none of which exist yet.

## Requirements

- Node.js 18+ (tested with Node 24).
- PostgreSQL 14+ (tested with PostgreSQL 16).
- A TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer…).
  Browsers only allow camera/microphone on HTTPS (or `localhost`).
- Media storage: either a persistent disk for `UPLOAD_DIR`, or a
  Cloudinary account (`MEDIA_STORAGE=cloudinary`) on hosts whose disk is
  wiped on restart/redeploy (e.g. Render's free tier). See §7.
- For calls beyond one LAN: STUN, and for restrictive networks a TURN
  server (e.g. coturn). See [calls.md](./calls.md#stun--turn).

## 1. PostgreSQL

1. Create a database and a dedicated role that owns it (it needs to create
   tables on first migration). Example:
   ```sql
   CREATE ROLE connectx LOGIN PASSWORD '<strong password>';
   CREATE DATABASE connectx OWNER connectx;
   ```
2. Use TLS to the database if it isn't on the same host
   (`?sslmode=require` in `DATABASE_URL`, or your provider's equivalent).
3. Set up backups **before** real users arrive — see
   [backup-recovery.md](./backup-recovery.md).

## 2. Backend

```bash
# from the repository root
npm ci
npm run build --workspace=backend          # → backend/dist

# configure (see "Environment" below), then migrate:
cd backend
npm run db:migrate:prod                    # compiled runner; safe to re-run
NODE_ENV=production node dist/server.js    # or: npm start
```

- `db:migrate:prod` runs `dist/db/migrate.js`, which applies every
  not-yet-applied file in `database/migrations/` in order, each in its own
  transaction, and records it in `schema_migrations`. It needs the
  repository's `database/` folder next to `backend/`. (`npm run db:migrate`
  does the same from TypeScript but needs the dev dependency `tsx`.)
- Run migrations **before** starting a new version, and take a backup
  first — there are no down-migrations (see backup-recovery.md).
- The backend reads `backend/.env` (via `dotenv`) *or* real environment
  variables; in production prefer real environment variables / your
  platform's secret store.
- Run it under a supervisor that restarts on exit (systemd, Docker
  `restart: unless-stopped`, PM2…). On an uncaught exception the process
  logs and exits on purpose.
- Stop it with `SIGTERM`: it stops the scheduler, closes WebSockets with
  `1001` (clients reconnect), drains HTTP requests for up to 10 seconds and
  closes the database pool.

### Health checks

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /health` | Process is up (no dependencies checked; not rate-limited) | liveness |
| `GET /health/ready` | `200 {"status":"ready"}` when the database answers, else `503` | readiness / load balancer |

## 3. Frontend

The frontend is a static single-page app. The API location is baked in at
**build time**:

```bash
VITE_API_BASE_URL=https://api.chat.example.com/api/v1 \
VITE_WS_URL=wss://api.chat.example.com/ws \
VITE_MAX_UPLOAD_MB=25 \
npm run build --workspace=frontend         # → frontend/dist
```

The build **fails** if `VITE_API_BASE_URL` is missing, empty or not an
absolute `http(s)://` URL, or if `VITE_WS_URL` is set but isn't a `ws(s)://`
URL — the app's `http://localhost:4000/api/v1` fallback is for `vite` dev
mode only. Pointing either at `localhost`/`127.0.0.1` explicitly is allowed
but prints a warning, since that bundle only works next to the backend.

Serve `frontend/dist` from any static host with an SPA fallback (unknown
paths → `index.html`). Recommended response headers on the static host:

```
Content-Security-Policy: default-src 'self'; connect-src 'self' https://api.chat.example.com wss://api.chat.example.com; img-src 'self' https: blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(self), microphone=(self)
```

(Adjust `connect-src` to your API host. `img-src https:` is needed because
avatar URLs may point at other hosts.) The CSP matters more than usual
because tokens are kept in `localStorage` — see security.md §11. These
headers were **not** tested against a real deployment; verify the app
still works after adding them.

## 4. Reverse proxy and WebSockets

The backend serves HTTP and the WebSocket gateway on the same port; the
gateway path is `/ws`. The proxy must forward the Upgrade:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;      # > WS_HEARTBEAT_SECONDS
    access_log off;               # the URL carries the access token
}
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 26m;     # ≥ MAX_UPLOAD_SIZE_MB
}
```

- Set **`TRUST_PROXY=1`** (one proxy hop) so rate limits key on real client
  IPs. Without it, everyone shares the proxy's IP and the per-IP limits
  lock all users out together. With `NODE_ENV=production` the server
  refuses to start when `TRUST_PROXY` is unset, `false`/`0`, or `true`
  (which trusts any client-supplied `X-Forwarded-For`, so clients could
  dodge per-IP limits). A list of proxy IPs/subnets or `loopback` is also
  accepted.
- Set **`CLIENT_ORIGIN`** to the exact frontend origin(s), e.g.
  `https://chat.example.com`. It controls CORS *and* the WebSocket
  Origin check — a mismatch shows up as failed WebSocket handshakes (403).
- Make sure the proxy's idle timeout exceeds `WS_HEARTBEAT_SECONDS`
  (default 30s) so healthy idle sockets aren't cut.
- Never log the query string of `/ws` requests — it contains the access
  token.

## 5. Environment

Full list with comments: [`backend/.env.example`](../backend/.env.example).
Production essentials:

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (enables startup safety checks) |
| `DATABASE_URL` | Your PostgreSQL URL (with TLS if remote) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Two different random values ≥ 32 chars (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) |
| `CLIENT_ORIGIN` | Exact frontend origin(s), comma-separated, never `*` |
| `TRUST_PROXY` | `1` behind one reverse proxy (required: unset, `false`, `0` and `true` are refused) |
| `MEDIA_STORAGE`, `CLOUDINARY_URL` | `cloudinary` with its URL; `local` is refused unless `ALLOW_LOCAL_MEDIA_STORAGE=true` (see §7) |
| `UPLOAD_DIR` | Only with `MEDIA_STORAGE=local`: absolute path on persistent, backed-up storage |
| `MAX_UPLOAD_SIZE_MB` | Match the proxy body limit and `VITE_MAX_UPLOAD_MB` |
| `LOG_LEVEL` | `info` (or `warn`) |
| `WEBRTC_STUN_URLS`, `WEBRTC_TURN_URLS`, `WEBRTC_TURN_SECRET` | Your STUN/TURN (coturn `use-auth-secret`) |
| `AI_PROVIDER`, `AI_PROVIDER_API_KEY` | Leave `none` unless you intend to send selected chat content to that provider |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Only with `AI_PROVIDER=gemini`; both required (no default model). Set them as secrets in your host's environment, never in the repo. Check Google's free-tier data terms first ([ai.md](./ai.md#configuration)) |
| Rate limits (`*_RATE_LIMIT_*`, `WS_*`) | Defaults are sized for normal use; see security.md §9 |

The server refuses to start in production with placeholder/short/shared
JWT secrets, a missing/wildcard `CLIENT_ORIGIN`, a missing or unsafe
`TRUST_PROXY`, or `MEDIA_STORAGE=local` without
`ALLOW_LOCAL_MEDIA_STORAGE=true`; it lists every problem at once. Numeric variables with
typos (e.g. `15m` where seconds are expected) fail fast at startup.

Changing `JWT_*_SECRET` signs **everyone** out (all tokens become invalid).

## 6. WebRTC / TURN

- No ICE servers configured → calls only connect on the same machine/LAN.
- Add STUN for most home networks; add **TURN** for corporate networks,
  mobile carriers and symmetric NATs. Prefer `WEBRTC_TURN_SECRET`
  (short-lived per-user credentials) over static credentials.
- Open the TURN ports (typically 3478 UDP/TCP, 5349 TLS, plus the relay
  port range) and test with a real call between two different networks.
- Group calls are a peer-to-peer mesh (≤ 8, realistically 3–4 people);
  each participant uploads one stream per peer. There is no SFU.

## 7. File storage

`MEDIA_STORAGE` selects where attachment bytes live. Metadata always stays
in PostgreSQL, and clients always download through the authenticated
`GET /api/v1/media/:id/content` route, whichever provider is used.

- `local` (default): disk under `UPLOAD_DIR`. Single instance, not
  encrypted at rest, no quota, no cleanup of never-sent uploads. Needs a
  persistent disk; back it up with the database (backup-recovery.md). In
  production it must be confirmed with `ALLOW_LOCAL_MEDIA_STORAGE=true`,
  otherwise the server refuses to start — so a host whose disk is wiped on
  redeploy can't silently lose every upload.
- `cloudinary`: set `CLOUDINARY_URL` (from the Cloudinary console). Files
  are uploaded as `raw` assets (exact bytes, no processing) with delivery
  type `authenticated`, so they have no public URL; the backend fetches
  them through URLs signed with the API secret, which never leave the
  server. Public IDs are `<CLOUDINARY_FOLDER>/<storage key>` — don't
  change `CLOUDINARY_FOLDER` once files exist. Deletes remove the asset
  and invalidate CDN copies.
  - Free plan: raw files are limited to 10 MB, so set
    `MAX_UPLOAD_SIZE_MB=10` and `VITE_MAX_UPLOAD_MB=10`.
  - Free accounts block delivery of PDF and ZIP files until it's allowed
    in Settings → Security ("Allow delivery of PDF and ZIP files"). Test a
    PDF download after deploying.
  - Switching providers doesn't move existing files: attachments stored
    by the old provider become unavailable (404) unless copied across.
- Other object stores: implement `StorageProvider`
  (`backend/src/modules/media/storage/storage-provider.interface.ts`) and
  select it in `create-storage-provider.ts`; nothing else needs to change.

## 8. Scheduler (reminders, task-due notifications, scheduled messages)

- Runs inside the backend process every `SCHEDULER_INTERVAL_SECONDS`
  (default 15s). Items can fire up to one interval late.
- Nothing fires while the backend is down; overdue items are processed on
  the next start (in batches of 100 per tick).
- Each item is claimed with a conditional `UPDATE` before it's acted on,
  scheduled sends are idempotent, and notifications are de-duplicated. A
  failing notification is logged and doesn't block the rest of the batch;
  delivery is at-most-once for reminders and task-due notices.
  Scheduled messages retry transient failures up to 3 times.
- Multi-instance execution is **not validated** — run one instance.

## 9. Operations checklist

- [ ] TLS everywhere (frontend, API, WSS, and DB if remote)
- [ ] `NODE_ENV=production`, strong distinct JWT secrets, exact `CLIENT_ORIGIN`
- [ ] `TRUST_PROXY` set to your proxy hop count (e.g. `1`), never `true`
- [ ] `MEDIA_STORAGE=cloudinary` + `CLOUDINARY_URL` (or `local` + `ALLOW_LOCAL_MEDIA_STORAGE=true` on a persistent, backed-up disk)
- [ ] Frontend built with `VITE_API_BASE_URL` (and `VITE_WS_URL`) for the production API
- [ ] `/ws` Upgrade forwarded, its URLs not logged, idle timeout > 30s
- [ ] Migrations applied with `db:migrate:prod` after a backup
- [ ] Liveness `/health`, readiness `/health/ready` wired to the platform
- [ ] Process supervisor restarts on exit; `SIGTERM` used for stops
- [ ] Database + `UPLOAD_DIR` backups scheduled and a restore rehearsed
- [ ] STUN/TURN configured and a cross-network call tested (if calls matter)
- [ ] Static host serves the SPA with CSP/security headers
- [ ] Exactly one backend instance
- [ ] Walk through [manual-testing-final.md](./manual-testing-final.md)

## What was verified in Phase 7 (locally, not in production)

- Backend and frontend production builds succeed.
- Migrations apply to a fresh database (pg-mem and real PostgreSQL 16) and
  re-running the migration runner on an up-to-date database applies nothing.
- The compiled backend (`node dist/server.js`) started against a real
  local PostgreSQL 16 (isolated schema), answered `/health` and
  `/health/ready`, and passed a 20-step API + WebSocket smoke script:
  signup/login/logout, identical unknown-email/wrong-password responses,
  `400` for malformed IDs, messaging delivered live over WebSocket,
  outsider `403`s, unread counts, WebSocket `401` without a token and `403`
  from a foreign Origin, and a revoked session's socket closed with `4401`.
  The login rate limit returned `429` after 10 attempts.
- With `NODE_ENV=production` and placeholder secrets / `CLIENT_ORIGIN=*`
  the server refused to start; with an unreachable database the logged
  URL had its password masked.
- Graceful shutdown on `SIGTERM`/`SIGINT` was **not** exercised: the
  checks ran on Windows, where an external signal terminates a Node
  process without running handlers. It is implemented; check it on your
  target platform.
- No TLS, reverse proxy, TURN, backup/restore, or multi-network call was
  tested — those are infrastructure-dependent.
