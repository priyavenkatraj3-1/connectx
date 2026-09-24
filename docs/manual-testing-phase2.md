# Manual Two-User Acceptance Test (Phase 2)

Automated tests (`npm test`) cover the backend logic against `pg-mem`, but
they can't confirm what it actually feels like for two real people to
message each other in a browser. Use this script for that — it's the
Phase 2 acceptance test referenced in the project instructions.

## Prerequisites

1. A running, migrated PostgreSQL database — see the **Database setup**
   section of the root [README.md](../README.md). Confirm with:
   ```bash
   npm run db:migrate --workspace=backend
   ```
   (safe to re-run; prints `Migrations up to date.` if nothing changed)
2. Backend running: `npm run dev:backend` (default `http://localhost:4000`)
3. Frontend running: `npm run dev:frontend` (default `http://localhost:5173`)
4. Two browser sessions that don't share cookies/localStorage — e.g. one
   normal window and one Incognito/Private window, or two different
   browsers. This matters because `AuthContext` stores the session in
   `localStorage`, which is shared across tabs of the same browser profile.

## Steps

### 1. Create two accounts

- **Window A:** go to `http://localhost:5173`, click **Create your
  account**, sign up as e.g. `alice@example.com` / `Passw0rd!` / display
  name `Alice`.
- **Window B:** sign up as `bob@example.com` / `Passw0rd!` / display name
  `Bob`.
- **Expected:** both land on the empty chat list (`/app`) after signup,
  with "No conversations yet."

### 2. Start a conversation

- In **Window A**, click the **+** button next to "Chats," type `bob`.
- **Expected:** Bob appears in the results within ~1 second (debounced
  search).
- Click Bob.
- **Expected:** you're taken to a new conversation with Bob, showing "No
  messages yet."

### 3. Send a message and watch it arrive in real time

- In **Window B**, open the chat list.
- **Expected:** a conversation with Alice already appears (created by
  Alice starting it), even though Bob hasn't refreshed anything.
- In **Window A**, type a message ("Hey Bob!") and send it (Enter or the
  send button).
- **Expected in Window A:** the message appears immediately in the
  thread, right-aligned, with a single checkmark (sent) that becomes a
  double checkmark (delivered) within about a second — Bob is online, so
  delivery is near-instant.
- **Expected in Window B (without refreshing):** the message appears in
  the open conversation instantly, and the chat list's Bob-sees-Alice row
  updates its preview text and unread badge (**1**) — also without a
  refresh.

### 4. Read receipts

- In **Window B**, click into the conversation with Alice (if not already
  open).
- **Expected:** the unread badge for that conversation clears (both in the
  chat list and the sidebar total).
- **Expected in Window A (without refreshing):** the checkmark on the
  message you sent turns blue/colored, indicating Bob has read it.

### 5. Reply and confirm bidirectionality

- In **Window B**, reply ("Hey Alice!").
- **Expected in Window A:** the reply appears instantly, left-aligned.

### 6. Unread counts with the recipient away

- In **Window B**, navigate away from the conversation (click "Chats" or
  go to Settings).
- In **Window A**, send two more messages in quick succession.
- **Expected in Window B:** without doing anything, the chat list's
  unread badge for Alice increases (to 2), and the sidebar total updates
  too.
- Click back into the conversation in Window B.
- **Expected:** the badge clears again, and in Window A the ticks for
  those two messages turn to read.

### 7. Authorization boundary (optional, confirms it's not just UI-level)

- With Window A's access token (DevTools → Application → Local Storage →
  `connectx.auth` → copy `tokens.accessToken`), try:
  ```bash
  curl -H "Authorization: Bearer <alice-token>" \
       http://localhost:4000/api/v1/conversations/<a-conversation-id-alice-is-not-in>
  ```
  (You'd need a third account's conversation ID to test this meaningfully
  — e.g. sign up a third user and have them start a conversation with Bob,
  then try to access it as Alice.)
- **Expected:** `403 { "error": { "message": "You do not have access to this conversation" } }`

### 8. Disconnect / reconnect

- In Window A, stop the backend (`Ctrl+C`) briefly, then restart it.
- **Expected:** the frontend's WebSocket reconnects automatically within a
  couple seconds (no page reload needed) — send a message from Window B
  after the backend is back up and confirm it still arrives live in
  Window A.

## What this test confirms

- Persistent auth (accounts survive independently per browser session)
- User search
- 1:1 conversation creation (and that it's visible to both members
  without either having created it themselves)
- Real-time message delivery over WebSocket
- Sent → delivered → read status transitions
- Unread counts updating live, in both the per-conversation badge and the
  sidebar total
- Conversation-level authorization
- WebSocket reconnection after a server restart

If any step doesn't match its "Expected" outcome, it's a regression —
please file it against the relevant module (see
[architecture.md](./architecture.md) for where each piece lives).
