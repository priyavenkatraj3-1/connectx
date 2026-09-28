# API Reference

Base URL: `http://localhost:4000/api/v1` (configurable via `CLIENT_ORIGIN`/`PORT`).
WebSocket gateway: `ws://localhost:4000/ws?token=<accessToken>`.

Request/response bodies are JSON unless noted (media upload/download are
raw bytes). Authenticated routes require:

```
Authorization: Bearer <accessToken>
```

Errors always take the shape:

```json
{ "error": { "message": "human-readable description" } }
```

Status codes used consistently across modules: `400` validation failure
(including malformed IDs in the URL), `401` missing/invalid token, `403`
authenticated but not allowed (not a member, wrong role, not the author),
`404` resource doesn't exist, `409` conflict (duplicate membership,
attachment already sent, call already in progress / user busy), `413` file
too large, `415` unsupported/spoofed file type.

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

## Conversations — `modules/conversations` (direct + group)

### `GET /api/v1/conversations` — requires auth

Returns `{ conversations: ConversationSummary[] }` for every conversation
you're an active member of, sorted by most recent message
(`conversations.updated_at`).

```ts
interface ConversationSummary {
  id: string;
  type: "direct" | "group";
  otherParticipant: PublicProfile | null; // direct only
  group: {                                // group only (Phase 3)
    id: string; name: string; description: string | null; avatarUrl: string | null;
    memberCount: number; myRole: "owner" | "admin" | "member";
  } | null;
  lastMessage: { id; body; contentType; senderId; senderDisplayName; createdAt } | null;
  unreadCount: number;
  updatedAt: string;
}
```

`lastMessage` and `unreadCount` only consider messages you're allowed to
see (sent at or after you joined; not deleted). Media messages have
`contentType` `image` / `video` / `audio` / `file` and a possibly-null
`body` (the caption).

### `POST /api/v1/conversations/direct` — requires auth

```json
{ "userId": "<other user's id>" }
```

Returns the existing direct conversation between the two users if one
exists, or creates it. Idempotent regardless of which user calls it first.
`400` if `userId` is your own ID.

### `GET /api/v1/conversations/:conversationId` — requires auth + membership

Returns `{ conversation }`. `403` if you are not a member.

Group conversations are created through `POST /groups` (below), then read
and messaged through these same conversation/message endpoints.

## Groups — `modules/groups` (Phase 3)

Every route requires auth. Membership and role checks happen in
`GroupsService`; the permission table:

| Action | owner | admin | member |
|---|---|---|---|
| View group / members | ✓ | ✓ | ✓ |
| Edit name / description / avatar | ✓ | ✓ | ✗ |
| Add members | ✓ | ✓ | ✗ |
| Remove a plain member | ✓ | ✓ | ✗ |
| Remove an admin | ✓ | ✗ | ✗ |
| Remove the owner | ✗ | ✗ | ✗ |
| Promote / demote (admin ⇄ member) | ✓ | ✗ | ✗ |
| Leave | ✓ (ownership passes on) | ✓ | ✓ |

Non-members get `403` on every group route; an unknown `groupId` is `404`;
a malformed `groupId`/`userId` is `400`.

`GroupDetails` = `{ group: GroupDTO, members: GroupMemberDTO[] }`, where
`GroupDTO` = `{ id, conversationId, name, description, avatarUrl,
createdBy, createdAt, updatedAt, memberCount, myRole }` and
`GroupMemberDTO` = `{ userId, displayName, avatarUrl, statusMessage, role,
joinedAt, addedBy }`. Members are ordered owner → admins → members.

### `POST /api/v1/groups`

```json
{ "name": "Weekend Trip", "description": "optional", "avatarUrl": "https://… (optional)", "memberIds": ["<userId>", "…"] }
```

Creates the group conversation with you as **owner** and `memberIds` as
members. Names are trimmed (1-120 chars); description ≤ 500 chars;
`avatarUrl` must be an `http(s)` URL. Duplicate IDs are collapsed and your
own ID is ignored; at least one *other* active user is required (`400`),
unknown/inactive users are rejected (`400`), max 256 members. Returns
`201 GroupDetails`. Every member receives `conversation:added`.

### `GET /api/v1/groups/:groupId`

Returns `GroupDetails`. Members only.

### `PATCH /api/v1/groups/:groupId`

Body: any of `{ name?, description? (nullable), avatarUrl? (nullable) }`.
Owner/admin only. Returns `GroupDetails`; members receive `group:updated`.

### `GET /api/v1/groups/:groupId/members`

Returns `{ members: GroupMemberDTO[] }`. Members only.

### `POST /api/v1/groups/:groupId/members`

```json
{ "userIds": ["<userId>"] }
```

Owner/admin only. `409` if anyone listed is already a member (duplicate
memberships are also impossible at the database level — primary key on
`group_members`). A previously removed/left user can be re-added; they see
only messages sent after they rejoined. Returns `GroupDetails`; members
receive `group:member_added`, the added users receive `conversation:added`.

### `DELETE /api/v1/groups/:groupId/members/:userId`

Removes a member, subject to the role hierarchy above. Removing yourself
is a `400` (use `/leave`). The removed user immediately loses read/send
access to the conversation and its media. Returns `GroupDetails`; members
and the removed user receive `group:member_removed`, the removed user also
receives `conversation:removed` (`reason: "removed"`).

### `PATCH /api/v1/groups/:groupId/members/:userId/role`

```json
{ "role": "admin" }
```

Owner only; `role` is `"admin"` or `"member"` (`"owner"` is rejected —
ownership only changes hands when the owner leaves). Changing the owner's
own role is `400`. Returns `GroupDetails`; members receive
`group:role_changed` (no event if the role didn't actually change).

### `POST /api/v1/groups/:groupId/leave`

Leaves the group. If the owner leaves, ownership passes atomically to the
longest-standing admin, else the longest-standing member; the last member
leaving leaves an empty group (its history is retained). Returns
`{ newOwnerId: string | null }`. Remaining members receive
`group:member_left`; the leaver receives `conversation:removed`
(`reason: "left"`).

## Messages — `modules/messages` (direct + group)

All routes require auth **and** active membership of `:conversationId`
(enforced by `requireConversationMember` and again in `MessagesService`) —
otherwise `403`.

```ts
interface MessageDTO {
  id: string; conversationId: string; senderId: string;
  sender: { id: string; displayName: string; avatarUrl: string | null };
  contentType: "text" | "image" | "video" | "audio" | "file";
  body: string | null;                      // null for a caption-less media message
  status: "sent" | "delivered" | "read";    // aggregate, see below
  createdAt: string; editedAt: string | null;
  replyTo: { id; senderId; senderDisplayName; body; contentType; deleted } | null;
  mentions: { userId: string; displayName: string }[];
  attachment: AttachmentDTO | null;
}
```

**Status in groups** is an aggregate from the sender's point of view:
`delivered` / `read` only once *every* member who was in the group when the
message was sent has reached that state. For direct chats (one recipient)
this is identical to Phase 2.

### `GET /api/v1/messages/:conversationId?before=<messageId>&limit=<n>`

Returns `{ items: MessageDTO[], hasMore: boolean }`, oldest first.
`before` pages backward; `limit` defaults to 50, max 100. Deleted messages
are omitted. You only see messages sent at or after you (most recently)
joined the conversation.

### `POST /api/v1/messages/:conversationId`

```json
{
  "body": "Hello @Bob",
  "replyToMessageId": "<optional message id>",
  "mentionedUserIds": ["<optional user ids>"],
  "attachmentId": "<optional, from POST /media>"
}
```

`body` (≤ 4000 chars, trimmed) and/or `attachmentId` is required; the
Phase 2 shape `{ "body": "…" }` is unchanged.

- `replyToMessageId` must be a non-deleted message in the same
  conversation that you can see — else `400`.
- `mentionedUserIds` must all be active members — else `400`; a
  self-mention is silently dropped; duplicates are collapsed; max 50.
- `attachmentId` must be your own, unsent upload *for this conversation*
  (`404` if not yours/unknown, `400` if for another conversation, `409` if
  already sent). The message's `contentType` comes from the attachment kind.

Updates the conversation's `updated_at` (list ordering) and pushes
`message:new` to every member. Returns `201 { message }`.

### `PATCH /api/v1/messages/:conversationId/:messageId`

```json
{ "body": "fixed text", "mentionedUserIds": ["…"] }
```

Author only (`403` otherwise); `404` for unknown/deleted messages. A text
message can't be edited to empty (`400`); a media message's caption can.
Mentions are replaced. Sets `editedAt`; members receive `message:updated`.
Returns `{ message }`.

### `DELETE /api/v1/messages/:conversationId/:messageId`

Author only — including in groups (owners/admins cannot delete others'
messages in this phase). Soft-deletes: the row stays so replies keep their
link, but `body` is cleared, mentions are removed, and any attachment's
metadata **and stored bytes** are deleted. Members receive
`message:deleted`. Returns `204`.

### `POST /api/v1/messages/:conversationId/read`

```json
{ "upToMessageId": "<message id>" }
```

`upToMessageId` must belong to this conversation (`400` otherwise). Marks
everything up to it (not sent by you) as read and zeroes your unread
count. Direct: the other participant receives `message:read`. Group: each
sender whose messages just became read-by-everyone receives
`message:status`. Your own other sessions receive `conversation:unread`.
Returns `204`.

## Media — `modules/media` (Phase 3 foundation)

Flow: **upload** (creates a private, unattached attachment) → **send a
message** with `attachmentId` (makes it visible to the conversation).

```ts
interface AttachmentDTO {
  id: string;
  conversationId: string | null;          // null for status media (Phase 4)
  purpose: "message" | "status";          // Phase 4
  messageId: string | null; uploaderId: string;
  kind: "image" | "video" | "audio" | "document" | "file";
  mimeType: string; sizeBytes: number; originalFilename: string; createdAt: string;
}
```

The server-side storage key is never exposed.

### `POST /api/v1/media?conversationId=<id>&filename=<name>[&mimeType=<type>]`
### `POST /api/v1/media?purpose=status&filename=<name>[&mimeType=<type>]` (Phase 4)

`purpose=status` uploads **status media**: no `conversationId` (sending
one is a `400`), same validation below, and only images/videos are
accepted (`415`). The result can only be used by publishing it with
`POST /statuses`; until then only the uploader can read it, afterwards
exactly the viewers the status' privacy allows (everyone else gets `404`).

Body: the raw file bytes, `Content-Type: application/octet-stream` (no
multipart). Requires membership of `conversationId` (`403`). Validation:

- size: non-empty (`400`) and ≤ `MAX_UPLOAD_SIZE_MB` (default 25 MB, `413`);
- extension allow-list: `jpg jpeg png gif webp` (image), `mp4 mov webm`
  (video), `mp3 m4a ogg oga opus wav weba` (audio), `pdf txt csv docx xlsx
  pptx` (document), `zip` (file) — anything else `415` (notably SVG, HTML,
  executables, scripts);
- the file's leading bytes must match the extension (`415` — e.g. an `.exe`
  renamed `.png`);
- `mimeType` (optional, client-declared) must not contradict the detected
  type (`415`); the **stored** MIME type is always the server's, never the
  client's;
- `filename` is sanitized (directory parts, control and unsafe characters
  stripped); it is display-only — bytes are stored under a server-generated
  key.

Returns `201 { attachment }` (`messageId: null`).

### `GET /api/v1/media/:attachmentId`

Returns `{ attachment }` metadata.

### `GET /api/v1/media/:attachmentId/content`

Returns the bytes with the stored `Content-Type`, `X-Content-Type-Options:
nosniff`, `Cache-Control: private, no-store`, a sandboxing CSP, and
`Content-Disposition: inline` for image/video/audio or `attachment` for
documents/files.

**Access rules (both GET routes):** you must be an active member of the
attachment's conversation; an unsent upload is visible only to its
uploader; a sent one follows its message — not deleted, and sent at or
after you joined. Otherwise `403` (or `404` if it doesn't exist / its
message was deleted).

### `DELETE /api/v1/media/:attachmentId`

Uploader only (`403`), and only while unsent (`409` — delete the message
instead). Removes metadata and stored bytes. Returns `204`.

## Calls — `modules/calls` (Phase 4)

Architecture, lifecycle and STUN/TURN: [calls.md](./calls.md). REST
starts calls and serves lookups/history; everything after the start is
WebSocket (see Realtime below).

```ts
interface CallDTO {
  id: string; conversationId: string;
  scope: "direct" | "group"; media: "voice" | "video";
  state: "ringing" | "accepted" | "connecting" | "connected" | "declined" | "missed" | "ended" | "failed" | "cancelled";
  endReason: "hangup" | "declined" | "no_answer" | "cancelled" | "connection_failed" | "media_error"
           | "disconnected" | "all_left" | "server_restart" | null;
  initiatorId: string; createdAt: string; answeredAt: string | null; connectedAt: string | null;
  endedAt: string | null; durationSeconds: number | null;  // from media connected → end
  participants: Array<{
    userId: string; displayName: string; avatarUrl: string | null;
    role: "initiator" | "invitee";
    state: "invited" | "ringing" | "joined" | "declined" | "missed" | "left";
    joinedAt: string | null; leftAt: string | null;
    audioEnabled: boolean | null; videoEnabled: boolean | null;  // live calls only
  }>;
}
interface CallHistoryEntryDTO extends CallDTO {
  direction: "incoming" | "outgoing";
  outcome: "ongoing" | "completed" | "missed" | "declined" | "cancelled" | "no_answer" | "failed";
}
```

### `POST /api/v1/calls`

Body `{ conversationId, media: "voice" | "video", connectionId }` —
`connectionId` is the `cid` this tab connected to the WebSocket with; it
must be one of the caller's **own open** connections (`409` otherwise).
Checks: caller is an active member (`403`); someone else is in the
conversation (`400`); caller not already in a call (`409`); direct callee
not in another call (`409 "<name> is on another call"`); no live call in
this conversation (`409` — for a group, join the existing one instead).
Every other member gets `call:invite`. Returns `201 { call }` (state
`ringing`).

### `GET /api/v1/calls?conversationId=<id>&limit=<1-100>&before=<callId>`

Call history, newest first: only calls the requester was invited to or
started. With `conversationId`, the requester must be an active member
(`403`). Returns `{ calls: CallHistoryEntryDTO[] }`.

### `GET /api/v1/calls/active?conversationId=<id>`

The live call in a conversation, or `{ call: null }`. Members only (`403`).

### `GET /api/v1/calls/:callId`

`{ call }` for participants — and, for a *live group* call, any active
group member (so they can join). Otherwise `403`; unknown `404`.

### `POST /api/v1/calls/:callId/end`

Hang up over REST (fallback when the socket is down): cancels (caller,
still ringing), declines (invitee, still ringing), ends (direct, in
progress) or leaves (group). Participants only (`403`). Idempotent on an
already-finished call. Returns `{ call }`.

### `GET /api/v1/calls/ice-servers`

`{ iceServers: Array<{ urls: string[]; username?: string; credential?: string }> }`
from `WEBRTC_*` settings — empty unless configured. With
`WEBRTC_TURN_SECRET`, TURN credentials are per-user and time-limited.
Sent with `Cache-Control: private, no-store`.

## Status — `modules/statuses` (Phase 4)

Rules and privacy model: [status.md](./status.md). Invisible, expired and
nonexistent statuses all return `404`.

```ts
interface StatusDTO {
  id: string; userId: string; type: "text" | "image" | "video";
  text: string | null;                       // text, or caption
  backgroundColor: "indigo" | "rose" | "emerald" | "amber" | "slate" | "violet" | null;
  media: { attachmentId: string; kind: "image" | "video"; mimeType: string; sizeBytes: number } | null;
  createdAt: string; expiresAt: string;      // expiresAt = createdAt + 24h, set by the server
  viewedByMe: boolean;
}
interface OwnStatusDTO extends StatusDTO {   // only ever returned to the owner
  visibility: "everyone" | "contacts" | "selected" | "except";
  audienceUserIds: string[]; viewCount: number;
}
```

### `GET /api/v1/statuses`

`{ mine: OwnStatusDTO[], feed: Array<{ user: PublicProfile, statuses: StatusDTO[], hasUnseen: boolean, latestAt: string }> }`
— your active statuses, plus every active status you may see, grouped by
person (unseen first, then most recent).

### `POST /api/v1/statuses`

Body `{ type, text?, backgroundColor?, attachmentId?, privacy? }`:

- `text`: required for `text` statuses (≤700 chars), optional caption
  otherwise; `backgroundColor` only for text;
- `attachmentId`: required for `image`/`video` — an upload of yours made
  with `purpose=status` (`404` if not yours, `400` if a chat attachment or
  the wrong kind, `409` if already used);
- `privacy`: `{ visibility, userIds? }` (`userIds` = allow-list for
  `selected`, deny-list for `except`; ≤256 existing users, else `400`;
  `selected` needs at least one). Omitted: your saved default.

Any `expiresAt` in the body is ignored. Returns `201 { status: OwnStatusDTO }`
and sends `status:created` to you and the allowed audience.

### `GET /api/v1/statuses/:statusId`

`{ status }` (an `OwnStatusDTO` if it's yours). `404` unless visible to you.

### `POST /api/v1/statuses/:statusId/view`

Records your view once (no-op for your own). `404` unless visible.
Returns `{ viewedAt }`; the owner gets `status:viewed` on the first view.

### `GET /api/v1/statuses/:statusId/viewers`

Owner only: `{ viewers: Array<{ userId, displayName, avatarUrl, viewedAt }> }`.
`403` for a viewer who can see the status, `404` for anyone else.

### `DELETE /api/v1/statuses/:statusId`

Owner only (`403` if you can see but don't own it, `404` otherwise).
Deletes the status, its views and its media. `204`; sends `status:deleted`.

### `GET /api/v1/statuses/privacy` · `PUT /api/v1/statuses/privacy`

Your default privacy for new statuses: `{ privacy: { visibility, userIds } }`
(default `contacts`). `PUT` body `{ visibility, userIds? }` — de-duplicated,
yourself removed, unknown users `400`.

## Realtime — WebSocket gateway (`backend/src/realtime`)

Connect to `ws://<host>/ws?token=<accessToken>[&cid=<uuid>]` (the access
token is passed as a query parameter because browsers' native WebSocket
API cannot set custom headers). An invalid/missing token is rejected
during the HTTP Upgrade handshake with a `401` — the socket never opens.
`cid` (Phase 4) is a per-tab connection ID the client generates and keeps
across reconnects; calls are bound to it (see [calls.md](./calls.md)).
Inbound frames over 128KB close the connection; every client event is
schema-validated before use.

Events are only ever sent to users entitled to them: active members of the
conversation, plus the affected user for removals/leaves.

**Server → client events** (`ServerEvent`, see `realtime/events.ts`):

| `type` | Payload | Sent when |
|---|---|---|
| `message:new` | `{ conversationId, message }` | A message is sent in a conversation you're in (including your own, for multi-tab sync) |
| `message:delivered` | `{ conversationId, messageId, userId }` | Direct chats: the recipient was online and received your message |
| `message:read` | `{ conversationId, userId, upToMessageId }` | Direct chats: the other participant read up to that message |
| `message:status` | `{ conversationId, messageIds, status }` | **Phase 3**, groups: the aggregate status of your messages changed (all recipients delivered/read) |
| `message:updated` | `{ conversationId, message }` | **Phase 3**: a message was edited |
| `message:deleted` | `{ conversationId, messageId }` | **Phase 3**: a message was deleted |
| `conversation:added` | `{ conversationId }` | **Phase 3**: you were added to a conversation (new group / added to one) |
| `conversation:removed` | `{ conversationId, reason: "removed" \| "left" }` | **Phase 3**: you're no longer a member |
| `conversation:unread` | `{ conversationId, unreadCount }` | **Phase 3**: your unread count changed from another session (you read it elsewhere) |
| `group:updated` | `{ conversationId, group }` | **Phase 3**: name/description/avatar changed |
| `group:member_added` | `{ conversationId, groupId, userIds, addedBy }` | **Phase 3** |
| `group:member_removed` | `{ conversationId, groupId, userId, removedBy }` | **Phase 3** |
| `group:member_left` | `{ conversationId, groupId, userId, newOwnerId }` | **Phase 3** |
| `group:role_changed` | `{ conversationId, groupId, userId, role, changedBy }` | **Phase 3** |
| `call:invite` · `call:ring` · `call:accept` · `call:decline` · `call:cancel` · `call:end` · `call:failed` · `call:participant_left` · `call:updated` | `{ call: CallDTO, … }` (see [calls.md](./calls.md#server--client)) | **Phase 4**: call lifecycle, to the call's participants |
| `call:offer` · `call:answer` · `call:ice_candidate` | `{ callId, fromUserId, sdp \| candidate }` | **Phase 4**: signaling relay — only to the target's joined connection |
| `call:error` | `{ callId, message }` | **Phase 4**: your call event was malformed, unauthorized or invalid for the call's state |
| `status:created` · `status:deleted` | `{ statusId, userId }` | **Phase 4**: to the owner and allowed viewers |
| `status:expired` | `{ statusIds, userId }` | **Phase 4**: from the expiry sweep, to the owner and allowed viewers |
| `status:viewed` | `{ statusId, viewer, viewedAt, viewCount }` | **Phase 4**: owner only |
| `error` | `{ message }` | The server couldn't process (or refused) your last client event |

**Client → server events** (`ClientEvent`):

| `type` | Payload | Effect |
|---|---|---|
| `message:read` | `{ conversationId, upToMessageId }` | Same as `POST /messages/:conversationId/read`, including the membership check (a non-member gets an `error` event and nothing is written) |
| `ping` | — | No-op; the open connection itself is the liveness signal |
| `call:ring` · `call:accept` · `call:decline` · `call:cancel` · `call:end` · `call:connected` | `{ callId }` | **Phase 4** call lifecycle — see [calls.md](./calls.md#client--server) for who may send each |
| `call:offer` · `call:answer` | `{ callId, toUserId, sdp }` | **Phase 4**: relayed to `toUserId`'s joined device (sender must be joined, from its bound connection) |
| `call:ice_candidate` | `{ callId, toUserId, candidate: { candidate, sdpMid?, sdpMLineIndex?, usernameFragment? } }` | **Phase 4**: as above |
| `call:failed` | `{ callId, reason: "connection_failed" \| "media_error" }` | **Phase 4**: ends a direct call as `failed`; a group participant leaves |
| `call:media_state` | `{ callId, audioEnabled, videoEnabled }` | **Phase 4**: mic/camera indicator for other participants |

## AI (Phase 5)

All under `/api/v1/ai`, all authenticated. Full request/response shapes,
consent rules and error codes (`ai_disabled`, `ai_not_configured`,
`ai_rate_limited`, …) are in [ai.md](./ai.md#features).

| Method & path | Purpose |
|---|---|
| `GET` / `PATCH /ai/settings` | Consent switches + preferred language; `GET` also returns provider status, supported languages, data-sharing disclosure |
| `GET /ai/exclusions` · `PUT` / `DELETE /ai/exclusions/:conversationId` | Chats excluded from the user's AI features |
| `POST /ai/ask` | Ask Your Chats (`{ question, conversationIds[1..10], useMemory? }`) → answer + real source messages |
| `GET` / `POST` / `DELETE /ai/memories` · `DELETE /ai/memories/:memoryId` | Explicit AI memory |
| `POST /ai/conversations/:conversationId/actions/extract` · `GET /ai/actions` · `PATCH /ai/actions/:actionId` · `POST /ai/actions/:actionId/confirm` · `POST /ai/actions/:actionId/dismiss` | Smart Action suggestions (nothing is scheduled) |
| `POST /ai/conversations/:conversationId/decision-summary` | Group Decision AI (`mode`: `summary` \| `decisions` \| `open_issues`) |
| `POST /ai/messages/:messageId/translate` | On-request translation (`{ targetLanguage }`) |
| `POST /ai/conversations/:conversationId/safety-scan` | Local scam heuristics over given message ids (no provider) |
| `POST /ai/messages/:messageId/scam-check` · `POST /ai/messages/:messageId/safety-feedback` | AI scam check; dismiss/report a warning |
| `GET /ai/voice/:attachmentId` · `POST …/transcribe` · `POST …/analyze` | Voice Intelligence |

Server → client events `ai:processing` / `ai:completed` / `ai:failed`
(`{ requestId, feature, code? }`) are sent only to the requesting user and
never contain content.

## Everything else — scaffolded, not implemented

These routers exist with the correct URL shape and `requireAuth`
protection, but every handler responds `501 Not Implemented`. This is
intentional — see [development-phases.md](./development-phases.md).

| Module | Routes |
|---|---|
| `notifications` | `GET /notifications`, `POST /notifications/:notificationId/read` |
| `privacy` | `GET /privacy`, `PATCH /privacy` |

Each maps to a documented service interface under the corresponding
module.
