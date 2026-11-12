# Status / Stories (Phase 4)

Text, photo and video updates that disappear after 24 hours, with
server-enforced privacy.

## Model

| Table | Purpose |
|---|---|
| `statuses` | One status: owner, `content_type` (`text`/`image`/`video`), `body` (text or caption, ≤700 chars), `background_color` (text only), `attachment_id` (media, **unique** — one upload, one status), `visibility`, `expires_at`, `created_at` |
| `status_audience` | Per-status user list, snapshotted at publish time: the allow-list for `selected`, the deny-list for `except` |
| `status_views` | One row per (status, viewer) — `PRIMARY KEY (status_id, viewer_id)` — with `viewed_at` |
| `status_privacy_settings` | A user's **default** visibility for new statuses (no row ⇒ `contacts`) |
| `status_privacy_users` | The default allow/deny list |

Status media reuses the Phase 3 media pipeline: `attachments` gained a
`purpose` column (`message` | `status`); status media has
`conversation_id = NULL` (a `CHECK` constraint enforces the pairing).

## Expiry — decided by the server

- `expires_at = created_at + 24h` is set by `StatusesService`; a client
  can't choose it (extra fields are stripped by validation).
- Every read path filters with `expires_at > now()` **in SQL, on the
  database clock** — list, get, view, viewers, and status-media downloads.
  An expired status disappears from every query the moment it expires,
  regardless of any client clock.
- A sweep (`StatusesService.sweepExpired`, every 60s from `server.ts`)
  then deletes expired rows (views and audience cascade) and their media
  bytes, and sends `status:expired` to the owner and audience so open
  clients drop them. The sweep is cleanup + notification, not the source of
  truth for expiry.
- The frontend also hides statuses whose `expiresAt` has passed (re-checked
  every 30s) — purely cosmetic; the backend already refuses them.

## Privacy

| Visibility | UI label | Who can see it |
|---|---|---|
| `contacts` (default) | My contacts | **Contacts**: users in a direct chat with you that *you* engaged in — you started it or have sent a message in it |
| `except` | My contacts except… | Contacts minus the chosen users |
| `selected` | Only share with… | Exactly the chosen users (can include non-contacts) |
| `everyone` | Everyone I chat with | Contacts plus everyone who shares an active group with you |

Why "contacts" is defined that way: ConnectX has no address book, and
anyone can open a direct chat with anyone. If merely *being messaged*
made someone your contact, a stranger could see your statuses by opening a
chat with you. Requiring the owner's engagement prevents that.

`everyone` deliberately does **not** mean "every ConnectX user": the feed
only ever shows statuses from people you share a chat with (or who
explicitly selected you). Note that group membership doesn't require
consent in this phase — someone who adds you to a group will see your
`everyone` statuses. The UI states this ("contacts and group members").

**Enforcement is entirely on the backend** (`StatusesRepository.canView`
is the single decision point) and applies to:

- the feed (`GET /statuses`) — candidates are filtered per status;
- `GET /statuses/:id`, `POST /statuses/:id/view`;
- status media downloads (`GET /media/:id[/content]`) via the
  `StatusMediaAccess` hook in `MediaService`;
- realtime events — `status:created/deleted/expired` go only to the owner
  and currently-allowed viewers.

A status you're not allowed to see, an expired one and a nonexistent one
all return the same **404**, so the API never confirms existence. Privacy
details (`visibility`, `audienceUserIds`, `viewCount`) are only included in
the owner's own DTOs.

Contacts/"everyone" are evaluated **at view time** (if you start chatting
with someone, they can see your contacts-only status from then on); the
selected/except lists are **snapshotted at publish time**.

## Viewers

- Viewing records at most one `status_views` row per user per status;
  viewing your own status records nothing.
- `GET /statuses/:id/viewers` is **owner-only** (403 for a viewer who can
  see the status, 404 for anyone else). There is no endpoint to list
  another person's viewers or what a user has viewed.
- The owner gets a `status:viewed` realtime event with the new count.

## Media validation

`POST /media?purpose=status&filename=…` runs the same checks as chat
uploads (size limit, extension allow-list, magic bytes must match,
sanitized filename, server-generated storage key
`statuses/<ownerId>/<attachmentId>` — no user input reaches the path) plus:
only images or videos (415 otherwise). Publishing checks that the upload
is yours (404 otherwise, so other users' upload IDs aren't confirmed), is
status media (a chat attachment can't become a status, and status media
can't be attached to a chat message), matches the declared type, and
isn't already used.

## Realtime events

| Event | To | Meaning |
|---|---|---|
| `status:created { statusId, userId }` | Owner + allowed viewers | Refetch the list |
| `status:deleted { statusId, userId }` | Owner + allowed viewers | Remove it |
| `status:expired { statusIds, userId }` | Owner + allowed viewers | Remove them (from the sweep) |
| `status:viewed { statusId, viewer, viewedAt, viewCount }` | Owner only | Someone viewed your status |

## Known limitations

- Replies are supported: `POST /statuses/:id/reply` sends a direct message
  to the owner with a snapshot of the status (type + text/caption preview,
  never the media), so it survives the status expiring. Only people who
  can see the status may reply. No reactions to statuses, no muting
  someone's updates, no per-status privacy editing after publishing
  (delete and re-post).
- No thumbnails/transcoding; images keep their metadata (EXIF) as
  uploaded — same as chat media.
- Deleted/expired status media is removed from storage, but the sweep runs
  every 60s, so bytes may outlive expiry by up to a minute (they're
  unreachable through the API during that window).
- Group membership grants `everyone` visibility without the member's
  consent (see above).
