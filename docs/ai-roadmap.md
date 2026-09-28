# AI Roadmap

ConnectX's AI features are designed around three non-negotiable rules,
enforced structurally rather than left to prompt engineering alone:

1. **Provider-agnostic.** Every feature is written against
   `modules/ai/interfaces/ai-provider.interface.ts`, never against a vendor
   SDK directly. Swapping or combining providers should never require
   touching feature logic.
2. **Consent-gated.** `privacy_settings.ai_features_enabled` and
   `ai_memory_enabled` (see [database.md](./database.md)) are the source of
   truth for whether a feature may run for a given user. A feature service
   that skips this check is a bug.
3. **Scoped to what the user can already see.** Every interface takes a
   `requestingUserId` / `userId` and is documented to only operate over
   conversations that user is a member of. No AI feature is a backdoor
   around normal access control.

## Feature-by-feature status

| Feature | Interface | Phase 1 status |
|---|---|---|
| Ask Your Chats | `chat-assistant.interface.ts` | Interface only — route returns 501 |
| AI Chat Memory | `memory.interface.ts` | Interface only — route returns 501 |
| Voice Intelligence | `voice-intelligence.interface.ts` | Interface only — route returns 501 |
| Group Decision AI | `summarization.interface.ts` | Interface only — route returns 501 |
| Scam/Spam Shield | `spam-shield.interface.ts` | Interface only — route returns 501 |
| Smart Action Extraction | `action-extraction.interface.ts` | Interface only — route returns 501 |
| Live/Automatic Translation | `translation.interface.ts` | Interface only — route returns 501 |
| Chat search (supporting) | `chat-search.interface.ts` | Interface only — route returns 501 |

No provider is configured in Phase 1 (`AI_PROVIDER=none`); calling
`getAIProvider()` returns `NoneAIProvider`, which throws a clear
"not configured" error rather than returning fabricated output.

## Design commitments per feature

**Ask Your Chats** — answers must only draw on conversations the
authenticated user is a member of; `ChatAssistantAnswer.citedMessageIds`
exists so an answer is always traceable back to source messages, not a
black box.

**AI Chat Memory** — extraction only runs with explicit consent
(`aiMemoryEnabled`). `MemoryExtractionService` requires `listMemories` and
`deleteMemory` to exist alongside extraction — a memory feature without a
way to see and delete what was stored is not acceptable.

**Voice Intelligence** — transcription, summary, key points, and action
items are separate fields (`VoiceIntelligenceResult`) so a client can show
"here's the transcript" distinctly from "here's what the AI inferred," and
a user can judge the inference against the source.

**Group Decision AI** — `ConversationSummaryResult.decisionsMade` is
documented to stay empty unless the transcript clearly shows a decision was
made. Options discussed and unresolved questions are separate fields from
decisions specifically so the summary can't quietly conflate "discussed" with
"decided."

**Scam/Spam Shield** — `SpamShieldResult.reasons` must be non-empty
whenever the verdict isn't `"safe"` — a verdict without a stated reason is
not shippable. `confidence` is exposed so a UI can distinguish "flagged
with high confidence" from "worth a second look."

**Smart Action Extraction** — `SuggestedAction.confirmed` defaults to
`false` and can only become `true` via `confirmAction`, which requires the
user's own ID. Nothing extracted here becomes a real reminder/task/event
without that explicit confirmation step.

**Live/Automatic Translation** — `detectLanguage` and `translate` are
separate methods so a client can show the detected language before
committing to a translation, and so translation is opt-in per
conversation/message rather than silently rewriting content.

## What later phases need to add

- A real `AIProvider` implementation (AI phase — see development-phases.md), registered in
  `providers/provider.factory.ts` alongside `NoneAIProvider`.
- Persistence for `ai_conversations`, `ai_memories`, `ai_actions` once a
  database is connected.
- A UI surface for reviewing/deleting AI memories (Settings → AI Features
  already has the placeholder row in Phase 1's frontend).
- Retrieval/ranking logic for Ask Your Chats and chat search — these are
  the two interfaces most likely to need a vector index, which is
  intentionally not part of the Phase 1 schema (see database.md).
