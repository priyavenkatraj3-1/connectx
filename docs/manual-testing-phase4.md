# Manual Acceptance Test (Phase 4 — Calls & Status)

Automated tests cover authorization, the call state machine, signaling
relay over real WebSockets, status privacy/expiry, and the UI against
**fake** WebRTC objects. They **cannot** prove that real audio/video
flows between browsers — that needs this script. Record the date,
browsers and result of each section when you run it.

## Prerequisites

1. PostgreSQL running and migrated: `npm run db:migrate --workspace=backend`
   (should report `003_calls_status.sql` applied or already applied).
2. `npm run dev:backend` and `npm run dev:frontend`.
3. **Two separate browser sessions** with two accounts — e.g. Chrome
   normal window as Alice and a Chrome **Incognito** (or Firefox) window as
   Bob. Two tabs in the same session share one login, which isn't what you
   want. For group tests, a third session (Carol).
4. Use `http://localhost:5173` — browsers only allow camera/mic on
   `https://` or `localhost`. If testing from another device on your LAN
   via its IP, you'll need HTTPS.
5. Same machine/LAN works with no ICE configuration. For two different
   networks, set `WEBRTC_STUN_URLS` (and ideally TURN) — see
   [calls.md](./calls.md#stun--turn).
6. Alice and Bob need a direct chat (Alice starts it and sends a message,
   which also makes Bob Alice's *contact* for status privacy — and Bob
   replies so it's mutual). For group tests: a group with Alice, Bob, Carol.

## 1. Permissions

| Step | Expected |
|---|---|
| As Alice, click the phone icon in the chat header | Browser asks for the microphone |
| Deny it | Dialog: "ConnectX needs permission to use your microphone…" — **Bob's browser never rings** |
| Re-allow the mic in site settings, retry | Proceeds to calling |
| (Optional) Unplug/disable the camera, start a **video** call | Call proceeds with a notice "Your camera isn't available — you're on audio only." |

## 2. Voice call — happy path

| Step | Expected |
|---|---|
| Alice clicks **Start voice call** | Alice sees full-screen "Calling…", then "Ringing…" once Bob's browser shows the invite |
| Bob sees an incoming banner "Alice · Incoming voice call" | Accept (green) / Decline (red) |
| Bob accepts (allow mic) | Both show "Connecting…", then a running timer `0:01, 0:02…` |
| Speak on each side | **Audio is heard both ways** ← the key manual check |
| Mute on Alice | Bob no longer hears Alice; Alice's mute button shows pressed. Unmute restores audio |
| Alice ends the call | Both show "Call ended" with the duration, which then closes |
| Look at the chat thread (both sides) | "Outgoing voice call · m:ss" (Alice) / "Incoming voice call · m:ss" (Bob) inline in the timeline |

## 3. Video call

| Step | Expected |
|---|---|
| Alice starts a video call; Bob accepts (allow camera + mic) | Each sees the other full-screen and themselves in a small mirrored preview |
| Turn Alice's camera off | Alice's preview disappears; Bob's view of Alice goes black/frozen; turning it back on resumes |
| Resize the window to phone width (DevTools device mode) | Controls stay reachable; preview stays in a corner |
| End the call from Bob | Both see "Call ended" |

## 4. Decline, cancel, missed

| Step | Expected |
|---|---|
| Alice calls, Bob **declines** | Alice: "Bob declined the call". History: Bob "Declined voice call", Alice "Voice call declined" |
| Alice calls, then **cancels** while ringing | Bob's banner disappears. History: Alice "Cancelled voice call", Bob "Missed voice call" (red) |
| Alice calls, Bob does nothing for 45s | Alice: "No answer" + **Call again**. Bob's banner disappears. History: Bob "Missed voice call", Alice "Voice call · no answer" |
| Bob is logged out/offline, Alice calls | Rings out after 45s as above; Bob sees the missed call in the chat after logging in |

## 5. Multi-device and failure handling

| Step | Expected |
|---|---|
| Open Bob in two tabs of the same session; Alice calls | Both Bob tabs ring; answering in one makes the other stop ringing |
| During a call, close Bob's tab | Within ~10s Alice sees "Call ended — connection lost" |
| During a call, toggle Bob's network off briefly (<10s) and back | The call survives (may show "Reconnecting…") |
| (Optional) Restart the backend mid-call | On restart the call is recorded as failed; clients show it ended |

## 6. Group call (small)

| Step | Expected |
|---|---|
| In the group, Alice starts a video call | Bob and Carol both get an incoming group call banner naming the group |
| Bob joins | Alice and Bob see each other; screen says "2 in call · peer-to-peer, best for small groups" |
| Carol declines, then clicks **Join** on the "call in progress" banner in the group chat | Carol joins; all three see each other (three tiles total across views) |
| Carol mutes | Others see a muted icon on Carol's tile |
| Bob leaves | Alice and Carol continue |
| Alice and Carol leave | Call ends; the group chat shows the call in history |

## 7. Status — create and view

| Step | Expected |
|---|---|
| Alice → **Status** (sidebar) → **+** → Text, type, pick a color | Preview shows the color; "Visible to: My contacts" is shown |
| Publish | "My status · 1 update · Just now · 0 views" |
| Bob's Status page (without reloading) | Alice appears under **Recent updates** (realtime `status:created`) |
| Bob opens it | Full-screen text on the chosen color, progress bar, auto-advances after 5s |
| Alice's status page | Views go to 1; open own status → **Seen by 1** → Bob listed with time |
| Alice posts a **photo** with a caption, then a **video** | Upload progress bar, then published; Bob can view both (video plays) |
| Try uploading a PDF in the Photo tab | Rejected before upload: "A status can only be a photo or a video" |
| Alice deletes a status from the viewer (trash icon) | It disappears for Bob too, without reloading |

## 8. Status privacy

| Step | Expected |
|---|---|
| Carol shares only a group with Alice. Alice posts with default privacy (contacts) | Carol does **not** see it; Bob does |
| Alice posts with "Everyone I chat with" | Carol now sees that one |
| Alice posts with "Only share with…" → Carol | Only Carol sees it; Bob does not |
| Alice posts with "My contacts except…" → Bob | Bob does not see it |
| A fourth user Dave opens a chat with Alice and messages her, Alice never replies | Dave does **not** see Alice's contacts-only statuses |
| Status → **Privacy** → change default → post without changing | New status uses the new default (shown in the "Visible to" line) |
| (API) As Bob, `GET /api/v1/statuses/<id of a status hidden from Bob>` | `404` |
| (API) As Bob, `GET /api/v1/statuses/<Alice's visible status>/viewers` | `403` |

## 9. Status expiry

Waiting 24 hours isn't practical; expire a status directly in the database
and confirm the backend (not the UI) enforces it:

```sql
UPDATE statuses SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 minute'
WHERE id = '<status id>';
```

| Step | Expected |
|---|---|
| Reload Bob's Status page | The status is gone (the API no longer returns it) |
| `GET /api/v1/statuses/<id>` or its media URL | `404` |
| Within ~60s | The sweep deletes the row and media file; open clients receive `status:expired` |

## Direct API checks (optional)

```bash
TOKEN=<Bob's access token>
# Outsider trying to start a call in someone else's conversation → 403
curl -X POST localhost:4000/api/v1/calls -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"<a conversation Bob is not in>","media":"voice","connectionId":"00000000-0000-4000-8000-000000000000"}'
# ICE servers (empty list unless configured)
curl localhost:4000/api/v1/calls/ice-servers -H "Authorization: Bearer $TOKEN"
```
