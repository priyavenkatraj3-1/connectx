# Final manual test plan (Phase 7)

The release checklist for ConnectX as a whole. It consolidates the
per-phase scripts ([2](./manual-testing-phase2.md), [3](./manual-testing-phase3.md),
[4](./manual-testing-phase4.md), [5](./manual-testing-phase5.md),
[6](./manual-testing-phase6.md)) — use those for step-by-step detail.

Every line is tagged:

- **[A]** — covered by the automated suites (`npm test`); the file is named.
  A manual pass is still useful as a smoke test but isn't the only evidence.
- **[M]** — needs a human in real browsers; not provable by the test suites.
- **[I]** — infrastructure-dependent; can only be verified in the target
  deployment (TLS, proxy, TURN, backups, multiple networks).

Nothing on this list has been marked done on your behalf. Record the date,
build (git commit) and tester next to each section as you go.

## Setup

- PostgreSQL migrated (`npm run db:migrate --workspace=backend`), backend and
  frontend running, `SCHEDULER_INTERVAL_SECONDS=5` for faster timed checks.
- Users **Alice**, **Bob**, **Carol** in separate browser profiles; Alice also
  on a second browser (**Alice-2**). One Alice↔Bob direct chat and one group
  (Alice owner, Bob admin, Carol member).
- Keep the browser dev tools console open: any uncaught error is a failure.

## 1. Signup, login, logout

- [ ] **[A]** Signup validation (weak password, bad email, duplicate email) — `auth.test.ts`, `security.test.ts`
- [ ] **[A]** Unknown email and wrong password give the same error — `security.test.ts`
- [ ] **[A]** Logout invalidates the session immediately; refresh rotation and reuse detection — `security.test.ts`, `sessions.test.ts`
- [ ] **[M]** UI: the forms show server errors inline; after logout the back button doesn't reveal the app; reloading while signed in keeps you signed in; after 15+ minutes idle the app refreshes silently.
- [ ] **[M]** Expired access token: sleep the computer (or leave the tab in the background) for 20+ minutes, wake it, then start a call and have the other user call you — no "Invalid or expired token" error, the incoming call rings, and the chat list shows messages sent meanwhile. Automated: `tokenRefresh.test.tsx`, `apiClient.test.ts`.
- [ ] **[M]** Too many wrong logins (11 within 15 minutes from one IP) shows "Too many authentication attempts" rather than a broken page.

## 2. Direct chat

- [ ] **[A]** Send/receive in real time, delivered/read receipts, unread counts, edit/delete own only, replies — `messages.test.ts`, `ws.test.ts`
- [ ] **[A]** Outsider can't read/send/mark read — `security.test.ts`, `messages.test.ts`
- [ ] **[M]** Two browsers: ticks turning blue, unread badge clearing on Alice-2 when Alice reads on Alice-1, long messages wrap, emoji render.

## 2a. Chat features (added after Phase 7)

Apply migrations 006–008 first (`npm run db:migrate --workspace=backend`).

- [ ] **[A]** Contact info: bio only for people sharing a chat — `users.test.ts`, `ChatConversationPage.contact.test.tsx`
- [ ] **[M]** Click Bob's name/avatar in the chat header (and the ⓘ button) → Contact info panel with name, status message and bio; on a phone the panel replaces the chat and closes back to it.
- [ ] **[A]** Typing: relayed to other members only, outsiders ignored, throttled, stop on send/idle/switch — `typing-ws.test.ts`, `useTyping.test.tsx`, `ChatConversationPage.typing.test.tsx`
- [ ] **[M]** Two browsers: Alice types → Bob sees "Alice is typing…" within a second; it disappears when Alice sends, clears the box, switches chat, or stops for ~4s; closing Alice's tab clears it within ~6s. Group: two typists → "A and B are typing…".
- [ ] **[A]** Reactions: one per person, authorization, emoji validation, concurrency, live updates — `reactions.test.ts`, `MessageBubble.test.tsx`, `ChatConversationPage.reactions.test.tsx`
- [ ] **[M]** React with 👍 from the hover smiley, switch to ❤️, remove it by clicking your chip; Bob sees each change live. The composer smiley inserts an emoji at the caret. Keyboard: Tab to the smiley, Enter, Tab through emoji, Escape closes.
- [ ] **[A]** Search: membership, deleted/pre-join messages excluded, literal `%`/`_` — `message-search.test.ts`, `MessageSearchPanel.test.tsx`
- [ ] **[M]** 🔍 in the chat header → type a word → matches highlighted, newest first; clicking a loaded result scrolls to it; an older result is marked "not loaded in this view".
- [ ] **[A]** Pin/archive/mute: privacy, 5-pin cap, archive↔pin rules, mute silences @mentions, live sync — `chat-preferences.test.ts`, `ChatListPanel.preferences.test.tsx`
- [ ] **[M]** Chat list ⋯ (or right-click a row): pin → moves to the top with a pin icon; 6th pin shows "You can pin up to 5 chats"; archive → moves to "Archived (n)"; mute 8h → bell icon, grey badge, Sidebar total excludes it, Bob @mentioning Alice creates no 🔔 notification. Alice-2 reflects every change live.
- [ ] **[A]** Status reply: visibility rule, own status refused, snapshot survives expiry, can't be forged — `status-replies.test.ts`, `StatusViewer.test.tsx`
- [ ] **[M]** Open Bob's status → type a reply (the story stops advancing; ←/→ move the caret) → Send → "Reply sent"; Bob sees it in his chat with Alice, quoting the status; still readable after 24h.
- [ ] **[A]** PDF preview: authenticated fetch, blob: URL, Office files download-only — `AttachmentView.test.tsx`
- [ ] **[M]** Desktop Chrome/Edge/Firefox: 👁 on a PDF opens it in-app; Download from the preview saves it with its name. Android Chrome / iOS Safari: if nothing renders, the "download it instead" link works. DOCX/XLSX/PPTX show no preview button.
- [ ] **[A]** Call-invite replay: rings on connect while still ringing; never after answer/decline/cancel/timeout; not to outsiders or busy users; stale incoming screen cleared after reconnect — `calls-replay-ws.test.ts`, `CallContext.test.tsx`
- [ ] **[M]** Bob closes the app; Alice calls; Bob opens ConnectX within the ring time → it rings. Bob turns Wi-Fi off while ringing, Alice cancels, Wi-Fi back on → Bob's ringing screen goes away.

## 2b. Voice-note transcription (needs a real speech-to-text endpoint)

- [ ] **[A]** Opt-in, authorization (incl. after leaving a group), per-user results, concurrent requests share one call, retry after failure, no speech, unsupported format, size limit, timeout, rate limit, provider not configured — `voice-transcription.test.ts`, `ai-features.test.ts`, `VoiceTranscription.test.tsx` (scripted provider; no real speech-to-text is called)
- [ ] **[I]** Configure `TRANSCRIPTION_PROVIDER=whisper-http`, `TRANSCRIPTION_BASE_URL` (and key/model) on a non-production backend. Without it, confirm voice messages show no Transcribe action.
- [ ] **[M]** Settings → AI: turn on Voice Intelligence. Bob sends a voice note (mp3/m4a/ogg/wav/webm). Alice: Transcribe (auto-detect) → "Transcribing…" → transcript beneath the audio with the detected language; Copy works. Pick a language and Transcribe again. A silent recording → "No speech was recognized…" with Try again.
- [ ] **[M]** Bob sees no transcript until he transcribes it himself. Eve (not in the chat) can't reach it. Double-clicking Transcribe or clicking in two tabs bills one transcription (check the provider's usage).
- [ ] **[M]** In-chat recording, in a direct chat and a group, in Chrome/Edge, Firefox and Safari: click the mic → the browser asks for permission only now → the timer counts up → Stop → an audio preview plays in the composer → Send → the message plays in the chat and offers Transcribe/Translate. Discard while recording sends nothing; the browser's mic indicator turns off after Stop, Discard, switching chats, and closing the chat. Denying permission shows "ConnectX needs permission to use your microphone…".
- [ ] **[M]** A recording over `TRANSCRIPTION_MAX_AUDIO_MB` is refused with "too large to transcribe"; stopping the transcription server shows a clear error and Try again works once it's back.

## 3. Group chat

- [ ] **[A]** Roles and permissions (owner/admin/member), add/remove/leave, history visibility after join — `groups.test.ts`, `group-messages.test.ts`, `groups-ws.test.ts`
- [ ] **[M]** UI hides controls a role can't use; removed member's chat disappears live; mentions highlight.

## 4. Media

- [ ] **[A]** Allowed types, magic-byte mismatch, disguised executable, oversize (413), unauthorized download (403/404) — `media.test.ts`, `file-validation.test.ts`, `security.test.ts`
- [ ] **[M]** Image/video/audio preview and playback; PDF/Office/ZIP download with the right filename (PDFs can also be previewed in-app, see 2a; Office files are download-only); upload progress and cancel; a file just over `VITE_MAX_UPLOAD_MB` (10 MB on the Cloudinary free plan, default 25) is refused before upload with "Files can be at most …MB".
- [ ] **[I]** Media survives a backend restart (persistent `UPLOAD_DIR`) and a backup/restore.

## 5. Status

- [ ] **[A]** Privacy (everyone/contacts/selected/except), expiry, viewer tracking, owner-only viewer list, media privacy — `statuses.test.ts`, `security.test.ts`
- [ ] **[M]** Story viewer: tap/arrow navigation, Escape closes, progress bar, video status plays; expiry removes it from open clients.

## 6. Voice and video calls

- [ ] **[A]** Signaling authorization, invalid state transitions, cleanup on disconnect, busy/missed/declined — `calls.test.ts`, `calls-ws.test.ts`, `call-signaling.test.ts`, `calls-mesh.test.ts`
- [ ] **[M]** Same machine / same LAN: voice call and video call connect, audio both ways, mute/camera toggles reflect on the other side, hang up from either side, call history entries.
- [ ] **[M]** Denied camera/mic permission shows a clear message; a second device of the callee stops ringing when one answers.
- [ ] **[M]** Group call with 3 participants on one LAN.
- [ ] **[I]** Call between two different networks (e.g. home Wi-Fi ↔ mobile hotspot) with STUN, and through a restrictive network with TURN. **Not verified in this project.**
- [ ] **[I]** Camera/mic on the deployed HTTPS origin (browsers block them on plain HTTP).

## 7. AI

- [ ] **[A]** Consent gates, provider unavailable, authorization before retrieval, memory ownership, prompt-injection delimiting, malformed provider output, rate limits — `ai-features.test.ts`, `ai-settings.test.ts`, `ai-core.test.ts`, `security.test.ts` (scripted provider)
- [ ] **[M]** With `AI_PROVIDER=none`: every AI entry point says "not configured" (nothing fake).
- [ ] **[M]** With a real provider: Ask Your Chats answers cite real messages; a chat containing "ignore previous instructions…" doesn't change the task; translation; action extraction; excluded chats are refused. Real model quality is **not** covered by tests.
- [ ] **[I]** The provider's data-retention terms are acceptable for your users (disclosed in Settings).

## 8. Tasks, reminders, events

- [ ] **[A]** CRUD, ownership, assignee rules, timezones/DST, scheduler firing once — `productivity.test.ts`, `scheduling.test.ts`, `security.test.ts`
- [ ] **[M]** A reminder set 1 minute ahead fires on both Alice devices; a task created from a message links back to it.

## 9. Shared notes and to-do lists

- [ ] **[A]** Membership, admin-only notes, edit conflicts, assignment — `collaboration.test.ts`, `security.test.ts`
- [ ] **[M]** Live updates for all members; conflict message when two people save the same note.

## 10. Scheduled messages

- [ ] **[A]** Delivered exactly once, cancel, sender-left failure, authorization — `scheduling.test.ts`
- [ ] **[M]** A message scheduled 1 minute ahead appears for Bob in real time; stopping the backend past the due time then starting it sends it on startup.

## 11. Notifications

- [ ] **[A]** Mention/assignment/reminder/task-due/scheduled notifications, de-duplication, preferences — `productivity.test.ts`, `scheduling.test.ts`, `organization.test.ts`
- [ ] **[M]** Bell badge updates live on both devices; mark-all-read syncs.
- [ ] **[I]** There are **no push notifications** — confirm stakeholders accept in-app only.

## 12. Offline mode

- [ ] **[A]** Outbox queue, retry, duplicate prevention (clientMessageId), cache limits — `offline.test.ts`, `ChatConversationPage.offline.test.tsx`, `offline-sync.test.ts`
- [ ] **[M]** With the app loaded, switch the browser to offline (dev tools): the offline banner appears, recent chats remain readable, a text message shows as pending; back online → it sends exactly once. Attachments are refused while offline.
- [ ] **[M]** Reloading the page while offline does **not** work (no service worker) — expected limitation.

## 13. Multiple devices and sessions

- [ ] **[A]** Registration, list without secrets, rename, revoke one/others, sockets closed on revoke, cross-device sync — `sessions.test.ts`, `ws-security.test.ts`, `security.test.ts`
- [ ] **[M]** Alice-1 signs out Alice-2 from Settings → Devices; Alice-2 is sent to the login screen within seconds.

## 14. Business profile

- [ ] **[A]** Owner-only editing, public lookup respects visibility, quick replies — `business.test.ts`
- [ ] **[M]** The profile shows "unverified"; quick replies insert via `/shortcut` in the composer.

## 15. Privacy settings and permissions

- [ ] **[A]** Cross-module authorization matrix (outsider vs every resource type) — `security.test.ts`
- [ ] **[M]** General privacy settings page: confirm it honestly shows as unavailable (the `/privacy` API returns 501).

## 16. Security smoke checks

- [ ] **[A]** Forged/unsigned/expired tokens, malformed JSON, malformed IDs, oversized bodies, `javascript:` avatar URLs, search wildcards — `security.test.ts`
- [ ] **[A]** WebSocket: no token / revoked session / foreign Origin refused; floods closed; dead connections reaped; malformed frames harmless — `ws-security.test.ts`
- [ ] **[M]** A profile avatar URL pointing at an image on another host renders; `javascript:` can't be saved.
- [ ] **[I]** Production start refuses placeholder secrets; `TRUST_PROXY` set correctly (rate limits don't lock everyone out together); `/ws` URLs absent from proxy logs.

## 17. Responsive UI and accessibility

- [ ] **[A]** Modals expose `role="dialog"`/`aria-modal` and close on Escape — `NewGroupModal.test.tsx` (pattern shared by the other modals)
- [ ] **[M]** Desktop (≥1280px): chat list + conversation side by side.
- [ ] **[M]** Tablet (~768px) and phone (~375px, dev tools device mode): no horizontal scrolling; the chat list and the conversation are reachable; the composer stays above the on-screen keyboard; call controls fit.
- [ ] **[M]** Keyboard only: Tab reaches every control in a visible order with a visible focus ring; Escape closes dialogs (New chat, New group, Create status, Status privacy, task/reminder/event forms, story viewer); Enter sends a message.
- [ ] **[M]** Screen reader spot check (NVDA/VoiceOver): icon-only buttons announce a label; dialogs announce their title; errors are announced (`role="alert"`).
- [ ] **[M]** Loading, empty and error states: open a chat list with no chats, stop the backend and reload a view — a readable error with retry, not a blank page.

## 18. Deployment-only checks

- [ ] **[I]** HTTPS/WSS end to end; `GET /health` and `GET /health/ready` wired to the platform.
- [ ] **[I]** Restart and `SIGTERM` behavior on the target platform (clients reconnect; nothing sent twice).
- [ ] **[I]** Backup taken and a restore rehearsed ([backup-recovery.md](./backup-recovery.md)).
- [ ] **[I]** Exactly one backend instance is running.
