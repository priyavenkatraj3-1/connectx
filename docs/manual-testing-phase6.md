# Manual testing — Phase 6 (productivity & collaboration)

The automated suite covers the API (including the scheduler with a
controlled clock), authorization and the main UI components. Use this plan
to check the real, timed, multi-device behavior in browsers.

## Setup

1. `npm run db:migrate --workspace=backend` (applies `005_productivity.sql`).
2. Optional: set `SCHEDULER_INTERVAL_SECONDS=5` in `backend/.env` so timed items fire quickly.
3. Start both dev servers. Anyone signed in before the upgrade is signed out on the next request (expected: old tokens have no session).
4. Three users — **Alice**, **Bob**, **Carol** — with an Alice↔Bob direct chat and a group (Alice owner, Bob member, Carol member).
5. Sign Alice in on two browsers/profiles (**Alice-1**, **Alice-2**) to check multi-device sync.

## 1. Tasks, reminders, events

- [ ] Bob sends "Please send the report by Friday". Alice → message ⋯ (**More message actions**) → **Create task…** → the form is prefilled from the message; save. The task appears under **Work → Tasks** with a link back to the message; the message itself is unchanged.
- [ ] Assign a task to Bob from the group → Bob gets a 🔔 **task assigned** notification, sees the task and can only change its status.
- [ ] Try to assign a direct-chat task to Carol → refused.
- [ ] Filters (status, priority, whose tasks), search and sort work; complete → reopen → delete.
- [ ] Create a reminder 1 minute ahead → it fires (🔔 + on Alice-2 too); complete / dismiss / reschedule it.
- [ ] Settings → Productivity → set timezone to `Asia/Tokyo`; create a reminder for 09:00 → it shows 09:00 Tokyo time (UTC stored).
- [ ] Create an event with an end before its start → validation error. Create a valid one → listed under **Events**.
- [ ] Delete the source message → the task stays, the excerpt disappears.
- [ ] (AI provider configured) Actions tab → suggestion → create a task from it → the suggestion can't be converted a second time.

## 2. Shared notes & to-dos (chat tools panel)

- [ ] In the group, open **Chat tools** → **Shared notes** → Bob creates a note; Alice and Carol see it live.
- [ ] Alice and Bob open the same note, both edit, Alice saves, then Bob saves → Bob sees a conflict message and must reload.
- [ ] Alice (owner) sets the note to admins-only → Bob can read but not edit.
- [ ] **To-do lists**: create a list, add items, assign one to Carol (Carol gets a notification), tick items off — progress updates for everyone live.
- [ ] Remove Carol from the group → she can no longer open the notes/lists (403/404).

## 3. Pins, saved messages, Productivity Mode

- [ ] Group: Bob (member) has no **Pin to chat** in the ⋯ menu; Alice (owner) pins a message → **Pinned** shows it for everyone; clicking it jumps to the message. Deleting the message removes the pin.
- [ ] Save a message with a label and a star → **Work → Saved**; filter by label/starred; search; unsave.
- [ ] Turn on Productivity Mode (Work header switch or Settings). Mark a chat focused (☆ in the chat header) → the chat list shows **Focused**, **Unread**, **Everything else**; Alice-2 updates too. The All/Unread/Groups/Direct filters work.
- [ ] Settings → Notifications → turn off mentions → Bob @mentions Alice → no notification. Turn it back on → a mention creates one.

## 4. Scheduled messages

- [ ] Composer 🕒 (**Schedule message**) → schedule a message 1 minute ahead → listed in **Work → Scheduled**; edit its text; it's delivered once at the time, and Alice is notified.
- [ ] Schedule another, then cancel it → never sent.
- [ ] Carol schedules a group message, then leaves the group → at send time it becomes **failed** with a reason, and Carol is notified.
- [ ] Stop the backend with a message due, start it after the due time → it's sent once on startup.

## 5. Notifications

- [ ] 🔔 badge counts unread; open the center → items link to their chat/task; mark one read, mark all read, delete one; the badge updates on Alice-2 as well.

## 6. Devices & sessions

- [ ] Settings → **Devices** on Alice-1 lists both sessions (current one marked); rename Alice-2.
- [ ] Signing in on Alice-2 created a **new sign-in** notification on Alice-1.
- [ ] Sign out Alice-2 from Alice-1 → Alice-2 is signed out immediately (its next request or its socket), and can't refresh.
- [ ] **Sign out all other devices** works the same; logging out on a device removes it from the list.
- [ ] On Alice-2, edit and delete a message and read a chat → Alice-1 reflects all three without reloading.

## 7. Offline

- [ ] With the app loaded, open DevTools → Network → Offline. The offline banner appears; recent chats and messages remain readable.
- [ ] Send two messages → shown as pending, the banner counts them. Go back online → each is delivered **exactly once**, in order.
- [ ] Throttle to make a send hang, go offline mid-send, then back online → still no duplicate.
- [ ] Sign out → the offline data for that account is gone from `localStorage` (`connectx.offline.<userId>.*`); signing in as Bob never shows Alice's cached chats.

## 8. Business profile & quick replies

- [ ] Settings → **Business**: quick replies can't be added before a profile exists.
- [ ] Create a profile with hours → status shows **unverified** (no way to change it).
- [ ] Add quick replies; a duplicate shortcut is refused. In a chat, ⚡ inserts one; typing `/shortcut` offers it.
- [ ] Make the profile private → others can no longer view it. Delete the profile → its quick replies are removed.
