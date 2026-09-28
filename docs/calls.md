# Voice & Video Calls (Phase 4)

ConnectX calls use **WebRTC** for audio/video and the existing
**authenticated WebSocket gateway** for signaling. Audio and video never
pass through the ConnectX server or the normal message channel; the
server only decides who may call whom, tracks each call's lifecycle, and
relays the small signaling messages browsers need to find each other.

> **Status of this feature — read before relying on it**
>
> | | |
> |---|---|
> | **Implemented** | 1:1 voice & video calls, group-call foundation (small mesh), signaling, lifecycle, call history, ICE/TURN configuration |
> | **Automated-tested** | Server-side authorization, state machine, signaling relay (over real WebSockets), history, ICE config; frontend call UI and signaling flows against a *fake* `RTCPeerConnection`/`getUserMedia` |
> | **Not automated-tested** | Real media — jsdom and Node have no WebRTC. Actual audio/video must be verified with the [manual test plan](./manual-testing-phase4.md) |
> | **Requires production infrastructure** | A TURN server for calls across restrictive NATs/firewalls; HTTPS (browsers only allow camera/mic on https:// or localhost) |

## Components

```
Browser A                       ConnectX backend                     Browser B
─────────                       ────────────────                     ─────────
CallContext  ── REST ──▶  POST /api/v1/calls (start) ──┐
   │                      CallsService (state machine) │── call:invite ──▶ CallContext
   │                             │  CallsRepository    │                      │
   │◀── WS: call:ring/accept ────┤  (call_sessions,    │◀── WS: call:ring ────┤
   │                             │   call_participants,│◀── WS: call:accept ──┤
PeerMesh ── WS: call:answer ───▶ │   call_events)      │◀── WS: call:offer ── PeerMesh
   │     ◀── call:offer relayed ─┘                                             │
   └══════════════ WebRTC media (direct, or via TURN relay) ═══════════════════┘
```

| Piece | Where | Role |
|---|---|---|
| `CallsService` | `backend/src/modules/calls/calls.service.ts` | Authorization, state machine, signaling relay, ring timeout, disconnect grace |
| `CallsRepository` | `…/calls.repository.ts` | Call **metadata** only (conditional-UPDATE transitions) |
| `buildIceServers` | `…/ice-servers.ts` | STUN/TURN list per user (incl. time-limited TURN credentials) |
| `parseClientEvent` | `backend/src/realtime/client-events.ts` | Zod validation of every inbound WebSocket event |
| `ws.server.ts` | `backend/src/realtime/` | Per-connection IDs, targeted delivery, payload cap |
| `CallContext` | `frontend/src/context/CallContext.tsx` | Client call state, local media, signaling |
| `PeerMesh` | `frontend/src/lib/webrtc/peerMesh.ts` | One `RTCPeerConnection` per remote participant |
| `mediaErrors.ts` | `frontend/src/lib/webrtc/` | Friendly permission/device/browser errors, camera → audio-only fallback |
| `CallOverlay`, `CallScreen`, `IncomingCallDialog`, `CallButtons`, `CallHistoryItem` | `frontend/src/components/calls/` | UI |

## Connection identity (why calls are per-tab)

A user may have several tabs/devices connected. Each tab generates a
random connection ID and connects with `ws://…/ws?token=…&cid=<uuid>`
(the server falls back to generating one). When a call is started
(`POST /calls { connectionId }`) or accepted (`call:accept` over the
socket), the server **binds that participant to that connection**:

- SDP offers/answers and ICE candidates are delivered **only to the bound
  connection** (`RealtimeGateway.sendToConnection`), never to the user's
  other tabs.
- Signaling from any other connection of the same user is refused
  ("This call is active on another of your devices").
- Invites still ring **every** device; when one answers, the others get
  `call:accept` with their own user ID and stop ringing.
- Connection IDs are scoped to the authenticated user — reusing one can
  only take over your *own* earlier connection (e.g. a reconnect).

## Call lifecycle

Session states (`call_sessions.state`):

```
ringing ──accept──▶ accepted ──first offer──▶ connecting ──media connected──▶ connected
   │                   └───────────── hang up / last participant leaves ──────────┴──▶ ended
   ├── callee declines (direct) / every invitee declines (group) ──▶ declined
   ├── caller cancels before any answer ──▶ cancelled
   └── ring timeout (45s, CALL_RING_TIMEOUT_SECONDS) with no answer ──▶ missed
direct call: a client reports media failure ──▶ failed
```

- **Live** states are `ringing | accepted | connecting | connected`; a
  database `CHECK` ties `ended_at IS NULL` to exactly those states, and a
  partial unique index allows **one live call per conversation**.
- Every transition is a conditional `UPDATE … WHERE state IN (…)`, and
  per-call events are serialized in-process, so racing actions (accept vs
  cancel) can't both succeed.
- `connected` is set only when a client reports its `RTCPeerConnection`
  reached `connected` — the server never invents a success state.
  **Duration** is measured from that moment, so a call whose media never
  connected has no duration.
- Participant states: `invited → ringing → joined → left`, or `declined` /
  `missed`.
- **Disconnects:** if the bound connection drops, the participant gets a
  10-second grace period to reconnect with the same `cid`; after that a
  direct call ends (`end_reason = disconnected`) and a group participant
  leaves.
- **Server restart:** the device bindings and timers live in memory, so on
  startup any call still marked live is set to `failed`
  (`end_reason = server_restart`).

## Signaling protocol

Starting a call is REST (clean HTTP errors: 403 not a member, 409 busy /
already in progress / not connected). Everything after is WebSocket.

### Client → server

| Event | Payload | Who may send it |
|---|---|---|
| `call:ring` | `{ callId }` | An invitee — "this device is ringing" |
| `call:accept` | `{ callId }` | Direct: the invitee while ringing. Group: any active member (join / re-join) |
| `call:decline` | `{ callId }` | An invitee who hasn't joined |
| `call:cancel` | `{ callId }` | The caller, before anyone answered |
| `call:end` | `{ callId }` | Any participant — hangs up in whatever way fits (cancel / decline / end / leave) |
| `call:offer` / `call:answer` | `{ callId, toUserId, sdp }` | A **joined** participant, from its **bound** connection, to another joined participant |
| `call:ice_candidate` | `{ callId, toUserId, candidate }` | Same as above |
| `call:connected` | `{ callId }` | A joined participant whose peer connection connected |
| `call:failed` | `{ callId, reason: "connection_failed" \| "media_error" }` | A joined participant |
| `call:media_state` | `{ callId, audioEnabled, videoEnabled }` | A joined participant (mute/camera indicators) |

Every event is validated (`client-events.ts`): IDs must be UUIDs, SDP is
capped at 64KB, ICE candidates must have exactly the standard fields, and
any identity fields a client adds (`userId`, `fromUserId`, …) are
discarded — the sender is always the authenticated socket's user. Frames
over 128KB close the connection. A malformed, unauthorized or
state-invalid event gets a `call:error { callId, message }` back and has
no other effect.

### Server → client

| Event | Sent to |
|---|---|
| `call:invite { call }` | Every invitee (all devices) |
| `call:ring { callId, userId }` | Joined participants |
| `call:accept { call, userId }` | All participants (all devices) |
| `call:decline { call, userId }` / `call:cancel { call }` | All participants |
| `call:end { call, userId \| null }` | All participants (state `ended` or `missed`) |
| `call:failed { call, userId }` | All participants |
| `call:participant_left { call, userId }` | All participants (group) |
| `call:updated { call }` | Participants — media connected, mic/camera changes, ring timeout for some invitees |
| `call:offer` / `call:answer` / `call:ice_candidate` `{ callId, fromUserId, … }` | **Only** the target's bound connection |
| `call:error { callId, message }` | Only the connection whose event was rejected |

Lifecycle events carry the full `CallDTO`, so a client never reconstructs
state from deltas. Offline users simply miss events; an unanswered call
times out to `missed` and appears in their call history.

### Offer/answer roles (no "glare")

Whoever **joins** a call sends offers to everyone already in it; existing
participants only answer. In a 1:1 call the callee (the joiner) offers to
the caller. In a group call each newcomer offers to each joined member.

## Group calls — a foundation, not a conference system

Group calls use a **peer-to-peer mesh**: every joined device holds a
direct connection to every other. Upload bandwidth and CPU grow with each
participant, so the server caps joined participants at **8**
(`MAX_MESH_PARTICIPANTS`); realistically, quality degrades beyond 3–4 on
typical home connections. **This is not production-scalable for large
groups.**

What exists and is reusable for a future SFU (media server): the
session/participant model, invite/join/leave/decline lifecycle, per-device
binding, mute/camera state fan-out, and targeted signaling. Swapping mesh
for an SFU would replace `PeerMesh` on the client and route offers to the
media server instead of to peers — the call records, authorization and UI
states stay.

Other group behavior: every active group member is invited; members added
after the call started can still join; removed members can't; a member who
declined can change their mind and join; the call ends when the last
joined participant leaves; there's a "call in progress — Join" banner in
the group chat. Active-speaker detection is **not** implemented (mute
indicators are).

## STUN / TURN

Browsers need ICE servers to connect across networks:

- **STUN** lets a browser learn its public address — enough for many home
  networks.
- **TURN** relays media when a direct path is impossible (symmetric NAT,
  corporate firewalls, some mobile carriers). **Without TURN, a
  meaningful share of real-world calls will fail to connect** — ConnectX
  does not claim universal connectivity without a validated TURN setup.

Configured in `backend/.env` and served per user from
`GET /api/v1/calls/ice-servers`:

| Variable | Meaning |
|---|---|
| `WEBRTC_STUN_URLS` | Comma-separated STUN URLs. **Default: none.** |
| `WEBRTC_TURN_URLS` | Comma-separated `turn:`/`turns:` URLs |
| `WEBRTC_TURN_SECRET` | **Recommended.** coturn `use-auth-secret` shared secret; each user gets `username = "<expiry>:<userId>"`, `credential = base64(HMAC-SHA1(secret, username))`, valid for `WEBRTC_TURN_TTL_SECONDS` (default 3600). The secret never leaves the server. |
| `WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL` | Static credentials (simpler; every client gets the same long-lived secret) |
| `CALL_RING_TIMEOUT_SECONDS` | Ring timeout (default 45) |

**Local development:** with nothing configured, the ICE list is empty and
calls work between two browsers **on the same machine or LAN** (host
candidates). That's the safe default — no traffic to third-party STUN
servers unless you opt in. To test across networks, set e.g.
`WEBRTC_STUN_URLS=stun:stun.l.google.com:19302` (which reveals client IPs
to that provider) and, for restrictive networks, run a TURN server such as
coturn:

```
# coturn (turnserver.conf) — minimal sketch
listening-port=3478
use-auth-secret
static-auth-secret=<same value as WEBRTC_TURN_SECRET>
realm=connectx.example.com
```

No credentials are hard-coded anywhere; TURN URLs without credentials are
dropped (TURN always authenticates).

## Call history

`GET /api/v1/calls?conversationId=…` returns calls the requester was
**invited to or started** (a group member who joined later never sees
earlier calls), each annotated for the viewer: `direction`
(`incoming`/`outgoing`) and `outcome` (`completed`, `missed`, `declined`,
`cancelled`, `no_answer`, `failed`, `ongoing`), plus `durationSeconds`.
The chat view interleaves these with messages ("Missed voice call",
"Outgoing video call · 3:05").

## Privacy

- **Stored:** who called whom, in which conversation, media type
  (voice/video), timestamps, duration, how it ended, and a metadata-only
  event trail (`call_events`: created/ringing/accepted/…).
- **Never stored or logged:** audio, video, SDP, ICE candidates (they're
  relayed in memory only). Note that ICE candidates contain participants'
  IP addresses, and peer-to-peer media means **participants can learn each
  other's IP addresses**; a TURN-only policy would hide them (not
  implemented).
- **Encryption:** WebRTC media is always encrypted in transit with
  DTLS-SRTP between the endpoints (or endpoint ↔ TURN relay, which relays
  but can't decrypt). This is a WebRTC property, **not** an audited
  ConnectX end-to-end-encryption guarantee: signaling passes through the
  server, which could in principle substitute keys. ConnectX makes **no
  E2EE claim** for calls.

## Known limitations

- Real audio/video has **not** been verified by automated tests (no WebRTC
  in jsdom/Node) — see the manual test plan.
- Mesh group calls: max 8 joined, practical limit lower; no SFU; no active
  speaker detection; no screen sharing; no device picker (uses the
  browser's default camera/mic).
- Single backend instance: device bindings and timers are in memory (same
  constraint as the existing WebSocket gateway). Horizontal scaling needs
  shared state/pub-sub.
- No push notifications — you only get a ringing call while ConnectX is
  open in a tab. Missed calls show in the chat history.
- A user already in a call isn't shown incoming calls (they ring out as
  missed); no call waiting.
- No ICE restart — a connection that goes `failed` ends a direct call (with
  "Call again") rather than renegotiating.
- Closing the tab ends your participation (best effort via `beforeunload`,
  otherwise after the 10s disconnect grace).
