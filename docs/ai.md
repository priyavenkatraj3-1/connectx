# AI Features & Privacy Layer (Phase 5)

ConnectX's AI features are opt-in, scoped to what the requesting user can
already read, and honest about what they are: suggestions, labeled
"AI-generated · may be inaccurate", always traceable to real messages.

With `AI_PROVIDER=none` (the default) nothing is faked: every feature that
needs a model returns `503 ai_not_configured`, and the UI says so. The
Scam/Spam Shield's automatic warnings are the exception — they're local
heuristics and work without any provider.

## Architecture

```
routes (requireAuth + zod validation)
  └─ AIController            identity only from the verified token
      └─ feature services     consent → authorization → retrieval → prompt → validate → map
          ├─ AISettingsService.require()   consent (403 ai_disabled) then provider (503 ai_not_configured)
          ├─ AIContextService              membership / join-time visibility / exclusions / size bounds
          ├─ prompt-safety.ts              untrusted-data delimiting + security rules
          └─ AIGateway                     the only path to a provider
               ├─ AIRateLimiter            per-user minute window + daily cap
               ├─ timeout + bounded retries (retryable errors only)
               ├─ zod validation of structured output (bad output → 502, never a crash)
               ├─ ai_usage log (metadata only)
               └─ ai:* realtime status events (requester's devices only)
                    └─ AIProvider / TranscriptionProvider (providers/*)
```

| Path | Role |
|---|---|
| `backend/src/modules/ai/interfaces/ai-provider.interface.ts` | Vendor-neutral `AIProvider` (`generate`: system + input → text or schema-constrained JSON) and `TranscriptionProvider` |
| `providers/anthropic.provider.ts` | Claude via the official `@anthropic-ai/sdk`: structured outputs (`output_config.format`), `effort`, refusal handling, server-side refusal fallback (opt-out with `AI_REFUSAL_FALLBACK=false`). SDK retries are off — the gateway owns retries |
| `providers/gemini.provider.ts` | Google Gemini via the official `@google/genai` SDK (Gemini Developer API): JSON-schema structured output, safety blocks → refusal, SDK retries off, key held in a `#private` field so it can't be serialized or logged |
| `providers/whisper-http.transcription.ts` | Any Whisper-compatible `POST {base}/audio/transcriptions` endpoint |
| `providers/gemini.transcription.ts` | Speech-to-text with Gemini audio understanding (`TRANSCRIPTION_PROVIDER=gemini`, reuses `GEMINI_API_KEY`): audio sent inline (base64, ≤ 14 MiB so the request stays under Gemini's 20 MB inline limit), JSON-schema output `{ text, language }`, transcript kept in the spoken language's own script, same refusal/error mapping and `#private` key handling as `gemini.provider.ts` |
| `providers/none.provider.ts` | The default. Reports "not configured"; never returns output |
| `providers/provider.factory.ts` | Picks providers from env; unknown names or missing keys fall back to `none` with a warning |
| `ai.gateway.ts` | Rate limit, timeout, retry, output validation, usage log, status events |
| `context/ai-context.service.ts` | Authorization + retrieval shared by every chat-reading feature |
| `context/prompt-safety.ts` | Prompt-injection defenses (below) |
| `features/*.service.ts` | One service per feature |

Adding a vendor = implement `AIProvider`, register it in the factory. No
feature code changes.

## Consent model

Stored on `privacy_settings` (one row per user). Everything that sends
content to a provider defaults **off**.

| Setting | Default | Gates |
|---|---|---|
| `aiFeaturesEnabled` (master) | off | Every provider call. `ai_consented_at` records when it was last turned on |
| `chatRetrievalEnabled` | on* | Ask Your Chats, Group Decision AI, Smart Actions (*only meaningful once the master switch is on) |
| `aiMemoryEnabled` | off | Saving memories, and including them in Ask Your Chats |
| `spamShieldEnabled` | off | Local warnings (no provider); the per-message AI check additionally needs the master switch |
| `voiceEnabled` | off | Sending audio to the transcription provider, and translating your transcripts |
| `preferredLanguage` | `en` | Translation target |
| Per-chat exclusion | — | `ai_conversation_exclusions`: the user's own AI features won't read, translate or transcribe that chat |

Order of checks: consent first (`403 ai_disabled` — tells the user how to
opt in), then provider (`503 ai_not_configured`). Settings → AI Features
shows a plain-language disclosure of exactly what each feature sends
(`DATA_SHARING_DISCLOSURE`, served by `GET /ai/settings`).

## Authorization

- **Conversations:** the user must be an *active* member of every selected
  conversation, or the whole request is `403` — nothing is silently
  dropped or partially answered. Excluded chats → `400 ai_conversation_excluded`.
- **Messages:** retrieval SQL re-applies membership and join-time
  visibility (`m.created_at >= cm.joined_at`) and skips deleted messages,
  so a caller bug can't pull what the user couldn't read in the app.
  Single-message features (translate, scam check, remember) use the same
  `isVisibleTo` check as reading the message and return `404` either way.
- **Attachments:** Voice Intelligence reuses `MediaService.getMetadata/getContent`
  — the same check that gates downloading the audio.
- **Ownership:** memories, actions, voice results, flags and usage rows are
  always filtered by `user_id` in SQL.
- **Outputs** go only to the requester (HTTP response + `ai:*` events to
  their own devices). Translation cache rows are only returned after the
  visibility check, keyed by a SHA-256 of the exact source text, and are
  deleted when the message is edited or deleted.

## Prompt-injection protection

Chat messages are untrusted input written by other people. The real
defenses are structural and don't depend on the model behaving:

1. Authorization happens **before** retrieval — the model only ever sees
   messages the requester can already read, and it has no tools.
2. Structured output is schema-constrained at the provider **and**
   re-validated with zod; malformed output → `502 ai_invalid_output`.
3. Every cited reference (`M1`…`Mn`, prompt-local ids) is mapped back to a
   real server-side message; unknown refs are dropped. An "answer" with no
   valid source is downgraded to "not enough information"; decision/summary
   items with no valid source are removed (counted in `droppedUnsupportedItems`).
4. Extracted action participants must literally appear in the cited message.

On top of that, untrusted content is delimited: each message is one JSON
line (quotes/newlines escaped) and every `<` is escaped to `<`, so a
message can't close `<chat_messages>` or open a fake block. The system
prompt carries fixed security rules (`UNTRUSTED_DATA_RULES`). The user's
question is JSON-encoded too.

## Features

| Feature | Endpoint(s) | Provider? | Notes |
|---|---|---|---|
| Ask Your Chats | `POST /ai/ask` | text | 1–10 chats, question ≤ 500 chars. Keyword-ranked + recent messages, bounded by `AI_MAX_CONTEXT_CHARS`. No messages → answered locally with "not enough information" (no AI call) |
| AI Memory | `GET/POST/DELETE /ai/memories`, `DELETE /ai/memories/:id` | none | Explicit only (typed, or "Remember" on a message). Never extracted automatically. Max 200/user. List/delete/clear always work, even with memory off |
| Smart Action Extraction | `POST /ai/conversations/:id/actions/extract`, `GET /ai/actions`, `PATCH /ai/actions/:id`, `POST …/confirm`, `POST …/dismiss` | text | Stored as `suggested`. Only an explicit confirm makes it `confirmed`. Suggestions never schedule anything themselves. From Phase 6 the owner can explicitly turn one into a task/reminder/event (`sourceActionId`), at most once |
| Group Decision AI | `POST /ai/conversations/:id/decision-summary` (`mode`: summary/decisions/open_issues) | text | Groups only. A "decision" needs explicit agreement in the messages; every item cites sources |
| Translation | `POST /ai/messages/:id/translate` | text | On request only; original is never modified; cached per (message, language, source hash) |
| Scam/Spam Shield | `POST /ai/conversations/:id/safety-scan` (local), `POST /ai/messages/:id/scam-check` (AI), `POST /ai/messages/:id/safety-feedback` | local / text | Warnings are advisory — messages are never blocked. Own messages and dismissed/reported ones are skipped. Reports are stored; no moderation pipeline yet |
| Voice Intelligence | `GET /ai/voice/:attachmentId`, `POST …/transcribe` (`{ languageHint? }`, e.g. `"es"`; omit to auto-detect), `POST …/analyze` | transcription, then text | Opt-in (`voiceEnabled`) and per user: each member transcribes for themselves; results are private. States: `transcribing → complete → processing → complete`, or `failed` (no speech is `failed` with "No speech was recognized…"). Concurrent requests for the same voice message by the same user share one provider call. Only mp3/m4a/ogg/wav/webm audio (`415` otherwise); the provider gets a neutral file name (`voice-message.<ext>`), never the user's. Size capped by `TRANSCRIPTION_MAX_AUDIO_MB` (`413`). Timeouts → `504 ai_timeout`, provider failures → `502`, per-user limit → `429`. A request interrupted by a restart reads as failed so it can be retried |
| Voice translation | `POST /ai/voice/:attachmentId/translate` (`{ targetLanguage }`: `ta`, `en`, `hi`, `te`, `ml`), `GET …/translations` | text | Translates the requester's own transcript; the original audio and transcript are shown unchanged alongside it. Needs AI + Voice Intelligence consent and a text provider; same attachment read check, chat exclusions, `409` until transcribed. The prompt names the target script (Tamil, Devanagari, Telugu, Malayalam, Latin) and forbids transliteration; the output budget is 4 tokens per source character because Indic scripts are token-heavy. Stored in `ai_voice_translations` per (user, attachment, language) with a hash of the transcript: repeats are served from storage, re-transcribing invalidates them. Concurrent identical requests share one provider call |
| Settings | `GET/PATCH /ai/settings`, `GET /ai/exclusions`, `PUT/DELETE /ai/exclusions/:conversationId` | none | `GET` also returns provider/transcription status, supported languages and the disclosure |

All routes require a valid access token. Errors are `{ error: { message, code? } }`:

| Code | Status | Meaning |
|---|---|---|
| `ai_disabled` | 403 | The user hasn't turned on the needed setting |
| `ai_not_configured` | 503 | No AI (or transcription) provider on this server |
| `ai_conversation_excluded` | 400 | The user excluded that chat from AI |
| `ai_rate_limited` | 429 | Per-minute or daily AI limit reached |
| `ai_timeout` | 504 | Provider exceeded `AI_REQUEST_TIMEOUT_MS` (after retries) |
| `ai_provider_error` | 502 | Provider failed (after retries for retryable errors) |
| `ai_invalid_output` | 502 | Provider output failed validation |
| `ai_refused` | 422 | The model declined the request |

Provider error text is never forwarded to clients.

### Realtime

`ai:processing`, `ai:completed`, `ai:failed` (`{ requestId, feature, code? }`)
go only to the requesting user's own connections. They never carry
prompts, message content or model output.

## Cost & abuse controls

- Per-user limits: `AI_RATE_LIMIT_PER_MINUTE` (in-memory, per process) and
  `AI_RATE_LIMIT_PER_DAY` (counted from `ai_usage`, so it survives restarts).
- Bounded input: question/message caps at the API edge, max chats per
  question, `AI_MAX_CONTEXT_CHARS` total and 800 chars per message in a prompt.
- Bounded output: `AI_MAX_OUTPUT_TOKENS` hard ceiling; features request less.
- Every AI call originates from an explicit user click — nothing runs on
  message receipt, so there's no request loop. The automatic scam scan is
  local and sends nothing out.

## Data stored & retention

| Table | Contents | Deleted when |
|---|---|---|
| `ai_memories` | User-written memory items | User deletes/clears, or account deleted |
| `ai_actions` | Suggestions + user decisions | Account or conversation deleted |
| `ai_translations` | Cached translations | Message edited/deleted |
| `ai_message_flags` | Dismiss/report per user & message | Account or message deleted |
| `ai_voice_results` | Transcript/summary per user & attachment | Account or attachment deleted |
| `ai_voice_translations` | Translations of a user's transcript per attachment & language | Account, attachment or voice result deleted (stale after re-transcription) |
| `ai_usage` | Feature, provider, model, status, token counts, latency — **no content** | Account deleted |
| `ai_conversation_exclusions` | Chats excluded from AI | User re-includes, or account deleted |

The AI provider itself receives the content described in the disclosure;
its retention is governed by the provider's own terms, not by ConnectX.

## Configuration

See `backend/.env.example`. Pick one text provider.

Claude (Anthropic):

```
AI_PROVIDER=anthropic
AI_PROVIDER_API_KEY=<your Anthropic API key>
AI_MODEL=claude-opus-5
```

Google Gemini (Gemini Developer API, official `@google/genai` SDK):

```
AI_PROVIDER=gemini
GEMINI_API_KEY=<your Google AI Studio API key>
GEMINI_MODEL=<a current Gemini model id, e.g. a Flash-tier model>
```

`GEMINI_MODEL` has no default — ConnectX won't guess a model name. If
`GEMINI_API_KEY` or `GEMINI_MODEL` is empty, the server logs a warning
(never the key) and AI features stay "not configured". `AI_MODEL`,
`AI_EFFORT` and `AI_REFUSAL_FALLBACK` apply to Anthropic only. Everything
else — consent, exclusions, prompt safety, rate limits, timeouts, retries,
output validation and error codes — is identical for both providers,
because both sit behind `AIGateway`.

Gemini specifics (`providers/gemini.provider.ts`):

- Structured output uses `responseMimeType: "application/json"` +
  `responseJsonSchema`; nullable `type: [X, "null"]` fields are rewritten
  to the equivalent `anyOf`, and the gateway still validates with zod.
- Google safety blocks (blocked prompt, or finish reason `SAFETY`,
  `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`) map to
  `422 ai_refused`; `MAX_TOKENS` marks output truncated.
- The SDK's own retries are off (the gateway owns retries); it is pinned to
  the Gemini Developer API (`vertexai: false`), and the key is passed
  explicitly, so no other environment variable can redirect it.
- **Free tier:** check Google's current Gemini API terms before enabling it
  for real users — unpaid usage may let Google use prompts and responses to
  improve its products. Set `AI_RATE_LIMIT_PER_MINUTE` / `AI_RATE_LIMIT_PER_DAY`
  below your Gemini quota so users get ConnectX's `429` first.

Keys are only read by the backend and never sent to the browser.
Speech-to-text is configured separately, with one of:

- `TRANSCRIPTION_PROVIDER=gemini` — Gemini audio understanding with the
  same `GEMINI_API_KEY`. Model: `GEMINI_TRANSCRIPTION_MODEL`, else
  `GEMINI_MODEL`. Missing key or model → transcription stays unavailable
  (with a startup warning). Accepts mp3, m4a (sent as `audio/m4a`), ogg,
  wav and webm up to 14 MiB (`413` above that, before anything is sent).
  Audio counts toward your Gemini quota (about 32 tokens per second).
- `TRANSCRIPTION_PROVIDER=whisper-http` + `TRANSCRIPTION_BASE_URL`
  (+ optional `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_MODEL`).

With `TRANSCRIPTION_PROVIDER=none` (the default) no Transcribe action is
offered and the API answers `503 ai_not_configured` — transcription is
never simulated. Voice translation uses the **text** provider
(`AI_PROVIDER`), not the transcription one.

## Testing

Provider-independent logic is tested with a **scripted test double**
(`backend/tests/helpers/scriptedAIProvider.ts`, never wired into the app):
authorization, join-time visibility, exclusions, consent gating, prompt
delimiting, invented-reference dropping, malformed output, retries,
timeouts, rate limits, caching, and metadata-only usage logging. **The
automated suite does not call a real model or transcription service** —
see [manual-testing-phase5.md](./manual-testing-phase5.md) for that.

## Known limitations

- Retrieval is keyword + recency (SQL `LIKE`), not semantic/vector search;
  paraphrased questions can miss relevant messages.
- The per-minute AI limit is per process (the daily limit is shared via the DB).
- Requests are synchronous (no job queue); long provider calls hold the HTTP request.
- Scam heuristics are English-centric pattern rules; they will miss scams and
  occasionally flag benign messages. Reports aren't reviewed by anyone yet.
- **Voice transcription needs a speech-to-text service you configure** —
  none is bundled, and with `TRANSCRIPTION_PROVIDER=none` (the default)
  the app shows no Transcribe action. `TRANSCRIPTION_PROVIDER=gemini`
  reuses the Gemini key (inline audio only, ≤ 14 MiB; no Files API
  upload for longer recordings). Any Whisper-compatible
  `/audio/transcriptions` endpoint works (`TRANSCRIPTION_PROVIDER=whisper-http`
  + `TRANSCRIPTION_BASE_URL` [+ `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_MODEL`]):
  a hosted speech-to-text API (paid per audio minute — check the
  provider's current price and data-retention terms before enabling), or a
  self-hosted Whisper server with an OpenAI-compatible API (no per-minute
  fee, but needs its own compute; CPU-only hosting is slow). The real
  service is **not** exercised by the automated tests (a scripted provider
  is). Long recordings are limited only by size (`TRANSCRIPTION_MAX_AUDIO_MB`,
  default 25 — many hosted APIs cap uploads at about that); there is no
  chunking of longer audio.
- Voice Intelligence works on any audio attachment — uploaded files and
  voice messages recorded in the chat composer (mic button, MediaRecorder).
  Recordings are named so the server stores them as audio: Chrome/Edge
  WebM/Opus as `.weba` (`audio/webm`), Firefox Ogg/Opus as `.ogg`, Safari
  MP4 as `.m4a` (`audio/mp4`) — never `.webm`, which is stored as video and
  would get no Transcribe/Translate. Recordings are capped at 10 minutes at
  ~32 kbps (≈ 2.4 MB), inside Gemini's 14 MiB transcription limit.
- Translation is per message on request — no automatic whole-chat translation.
- Voice translation covers Tamil, English, Hindi, Telugu and Malayalam
  targets only, and translates the transcript (so transcription errors carry
  over). Speech-recognition accuracy for Telugu and Malayalam is generally
  lower than for English or Hindi; picking the spoken language before
  transcribing helps. Real-provider transcription/translation quality isn't
  covered by automated tests.
- A suggestion becomes a task/reminder/event only when the user explicitly creates one from it (Phase 6); nothing is created automatically.
- Real-model output quality is not covered by automated tests.
