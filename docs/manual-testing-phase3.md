# Manual Acceptance Test (Phase 3 — Groups & Media)

The automated suites cover the backend against pg-mem and real
PostgreSQL, and the frontend components with mocked services. What they
can't show is the real browser experience across several accounts at once.
This script covers that. Allow about 20 minutes.

## Prerequisites

1. Database migrated to Phase 3:
   ```bash
   npm run db:migrate --workspace=backend
   ```
   Expect `skip 001_initial_schema.sql` and either `apply 002_groups_media.sql`
   (first time) or `skip 002_groups_media.sql`, then `Migrations up to date.`
2. `npm run dev:backend` and `npm run dev:frontend`.
3. **Three** isolated browser sessions (e.g. a normal window, a private
   window, and a second browser), because the session lives in
   `localStorage`. Sign up as **Alice**, **Bob** and **Carol** (or reuse the
   Phase 2 accounts plus one new one).
4. A few small test files: a `.jpg`/`.png`, a short `.mp4`, an `.mp3` or
   `.ogg`, a `.pdf`, and one unsupported file (e.g. an `.exe` or `.svg`).

## 1. Create a group

- **Alice:** click the **people icon** ("New group") next to "Chats".
  Name it `Trip`, add a description, search and tick **Bob** and **Carol**
  (chips appear), click **Create group**.
- **Expected:** Alice lands in the new group chat; the header reads `Trip`
  and `3 members`. Within a second, `Trip` appears in **Bob's** and
  **Carol's** chat lists with a group icon, with no refresh needed.
- Try creating a group with a name but no members: **Create group** stays
  disabled.

## 2. Group messaging, receipts, unread

- **Alice** (Bob and Carol both have the app open, but not the group):
  send `Hi both`.
- **Expected:** Bob and Carol each see `Trip` jump to the top with
  `Alice: Hi both` and an unread badge of 1. Alice's message shows **two
  ticks** (delivered to *everyone*).
- **Bob** opens the group. **Expected:** Alice's ticks do **not** turn blue yet, because
  Carol hasn't read it yet.
- **Carol** opens the group. **Expected:** Alice's ticks turn **blue**.
- In Bob's window, the message shows **Alice's name** above it; Alice's own
  messages don't.

## 3. Mentions, replies, edit, delete

- **Bob:** type `@ca`, pick **@Carol** from the suggestions, add `bring
  snacks?`, send. **Expected:** in every window `@Carol` is emphasised;
  in **Carol's** window it's highlighted.
- **Carol:** hover Bob's message → **Reply** → `Sure!` → send.
  **Expected:** the reply shows a quote block with `Bob` and the original
  text.
- **Carol:** hover her reply → **Edit**, change the text, press Enter.
  **Expected:** updates in all windows with an `edited` label.
- **Bob:** hover his own message → **Delete** → confirm. **Expected:** it
  disappears for everyone; Carol's reply now reads *"Original message was
  deleted"*.
- **Alice:** hover Bob's message. **Expected:** only **Reply** is offered
  (no edit/delete for others' messages, even for the group owner).

## 4. Attachments

- **Alice:** click the paperclip and pick the image. **Expected:** a
  thumbnail, file size, a progress bar, then *"Ready to send"*. Add a
  caption, send. The image renders inline for all three.
- Repeat with the video and audio files. **Expected:** inline players.
- Send the PDF. **Expected:** a file card (name + size). Clicking the
  download icon fetches it, then a save icon downloads the original file.
- Pick the **unsupported** file. **Expected:** an immediate red error
  (*"… files aren't supported"*), Send disabled, nothing uploaded.
- Rename a text file to `fake.png` and attach it. **Expected:** the upload
  is **rejected by the server** (*"File contents do not match…"*), never
  shown as ready; remove it with ✕.
- Attach a file, then remove it with ✕ before sending. **Expected:** it's
  gone and was never visible to Bob or Carol.

## 5. Group admin

- **Alice:** click the **ⓘ** (Group info). Edit the name to `Trip 2025`
  and save. **Expected:** the header and all chat lists update live.
- **Alice:** **Make admin** on Bob. **Expected:** Bob shows an `ADMIN` badge
  in everyone's panel.
- **Bob** (admin) opens Group info. **Expected:** he sees **Edit group**,
  **Add members**, and **Remove** next to Carol, but *no* Remove next to
  Alice and *no* Make admin buttons.
- **Carol** (member) opens Group info. **Expected:** no management controls
  at all, only **Leave group**.
- **Bob:** remove Carol. **Expected:** if Carol has the group open, her window shows *"You were
  removed from this group…"* and the composer disappears; `Trip 2025`
  leaves her chat list. Messages sent afterwards never reach her.
- **Alice:** **Add members** → Carol. **Expected:** Carol gets the group
  back, but sees **only messages sent after being re-added**.

## 6. Leaving and ownership

- **Alice** (owner): Group info → **Leave group**. **Expected:** a
  confirmation warning that ownership will pass on; confirm. Alice returns
  to the chat list and the group is gone for her.
- **Bob** opens Group info. **Expected:** Bob is now **Owner** (he was the
  longest-standing admin).

## 7. Direct chats still work

- Repeat a short Phase 2 check ([manual-testing-phase2.md](./manual-testing-phase2.md)
  steps 2–4) between two users: start a 1:1 chat, exchange messages, and
  confirm ticks and unread badges behave exactly as before.

## Direct API checks (optional)

With an access token from login, confirm the server enforces the rules
even if the UI is bypassed:

```bash
# A non-member reading a group's messages → 403
curl -i -H "Authorization: Bearer $EVE_TOKEN" http://localhost:4000/api/v1/messages/$GROUP_CONVERSATION_ID

# A plain member adding someone → 403
curl -i -X POST -H "Authorization: Bearer $CAROL_TOKEN" -H "Content-Type: application/json" \
  -d '{"userIds":["<someone>"]}' http://localhost:4000/api/v1/groups/$GROUP_ID/members
```
