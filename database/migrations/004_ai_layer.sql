-- ============================================================================
-- ConnectX — 004_ai_layer (Phase 5)
--
-- AI consent settings, user-controlled AI memory, AI action suggestions
-- (handoff only — no reminders/tasks run yet), translation cache,
-- scam-warning feedback, voice-intelligence results, and metadata-only AI
-- usage logging.
--
-- Additive for all existing data, with one deliberate exception (same
-- precedent as 003's `statuses`): the Phase 1 placeholder tables
-- `ai_conversations`, `ai_memories` and `ai_actions` are dropped and
-- re-created / replaced. No Phase 1–4 code path ever read or wrote them
-- (they were schema-only), so there is no data to preserve.
-- `ai_conversations` is replaced by `ai_usage`, which deliberately stores
-- NO prompt or response text — see docs/ai.md.
--
-- Every AI table references the owning user with ON DELETE CASCADE so a
-- deleted account takes its AI data with it.
-- ============================================================================

DROP TABLE IF EXISTS ai_conversations;
DROP TABLE IF EXISTS ai_memories;
DROP TABLE IF EXISTS ai_actions;

-- The two re-created tables below use explicit constraint names that differ
-- from the dropped tables' auto-generated ones, so no engine can trip over a
-- stale name (same approach as 003's `statuses`).

-- ----------------------------------------------------------------------------
-- Consent / settings. The Phase 1 columns ai_features_enabled (master
-- switch) and ai_memory_enabled already exist on privacy_settings and stay
-- the source of truth; the per-feature switches are added next to them.
-- Everything that sends content to an external provider defaults OFF.
-- ----------------------------------------------------------------------------

ALTER TABLE privacy_settings ADD COLUMN ai_chat_retrieval_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE privacy_settings ADD COLUMN ai_spam_shield_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE privacy_settings ADD COLUMN ai_voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE privacy_settings ADD COLUMN ai_preferred_language VARCHAR(16) NOT NULL DEFAULT 'en';
-- When the user last turned the master AI switch on (null = never consented).
ALTER TABLE privacy_settings ADD COLUMN ai_consented_at TIMESTAMPTZ;

-- Conversations a user has excluded from their own AI features (Ask Your
-- Chats, summaries, action extraction, translation of its messages).
CREATE TABLE ai_conversation_exclusions (
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, conversation_id)
);

-- ----------------------------------------------------------------------------
-- AI memory: explicit, user-created, inspectable, deletable. Never written
-- automatically from conversation content.
-- ----------------------------------------------------------------------------

CREATE TABLE ai_memories (
    id                      UUID NOT NULL,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    memory_type             VARCHAR(16) NOT NULL CHECK (memory_type IN ('preference', 'fact', 'context', 'working')),
    content                 VARCHAR(500) NOT NULL,
    -- Optional provenance when the user saved a memory from a message.
    source_conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
    source_message_id       UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_ai_memories_v2 PRIMARY KEY (id)
);

CREATE INDEX idx_ai_memories_user_created ON ai_memories(user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Smart Action Extraction handoff. Rows start as 'suggested'; only an
-- explicit user action moves them to 'confirmed' or 'dismissed'. Nothing
-- here schedules anything — Phase 6 consumes confirmed rows.
-- ----------------------------------------------------------------------------

CREATE TABLE ai_actions (
    id                  UUID NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id     UUID REFERENCES conversations(id) ON DELETE CASCADE,
    source_message_id   UUID REFERENCES messages(id) ON DELETE SET NULL,
    type                VARCHAR(16) NOT NULL CHECK (
                            type IN ('task', 'reminder', 'deadline', 'event', 'follow_up', 'action_item')
                        ),
    title               VARCHAR(200) NOT NULL,
    notes               VARCHAR(1000),
    due_at              TIMESTAMPTZ,
    -- The date/time text as written in the message ("Friday at 3 PM") when it couldn't be resolved exactly.
    due_text            VARCHAR(120),
    timezone            VARCHAR(64),
    participants        JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence          VARCHAR(8) CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
    explanation         VARCHAR(500),
    status              VARCHAR(16) NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'dismissed')),
    confirmed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_ai_actions_v2 PRIMARY KEY (id)
);

CREATE INDEX idx_ai_actions_user_status ON ai_actions(user_id, status, created_at DESC);

-- ----------------------------------------------------------------------------
-- Translation cache. One row per (message, target language); `source_hash`
-- ties it to the exact text translated, so an edited message is never
-- served a stale translation. Rows are deleted when the message is edited
-- or deleted (MessagesRepository) and are only ever returned after the
-- caller passes the same visibility check as reading the message.
-- ----------------------------------------------------------------------------

CREATE TABLE ai_translations (
    message_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    target_language         VARCHAR(16) NOT NULL,
    source_hash             CHAR(64) NOT NULL,
    translated_text         TEXT NOT NULL,
    detected_source_language VARCHAR(16),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, target_language)
);

-- ----------------------------------------------------------------------------
-- Scam/Spam Shield feedback: a user dismissed or reported a warning on a
-- message. Warnings are advisory only; messages are never blocked.
-- ----------------------------------------------------------------------------

CREATE TABLE ai_message_flags (
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id          UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    action              VARCHAR(16) NOT NULL CHECK (action IN ('dismissed', 'reported')),
    risk_level          VARCHAR(16) CHECK (risk_level IS NULL OR risk_level IN ('likely_safe', 'suspicious', 'high_risk')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_ai_message_flags_reported ON ai_message_flags(message_id) WHERE action = 'reported';

-- ----------------------------------------------------------------------------
-- Voice Intelligence results, per requesting user and audio attachment.
-- ----------------------------------------------------------------------------

CREATE TABLE ai_voice_results (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attachment_id       UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    status              VARCHAR(16) NOT NULL CHECK (status IN ('transcribing', 'processing', 'complete', 'failed')),
    transcript          TEXT,
    detected_language   VARCHAR(16),
    summary             TEXT,
    action_items        JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message       VARCHAR(300),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, attachment_id)
);

-- ----------------------------------------------------------------------------
-- Usage/cost log — metadata only. Never stores prompts, message content,
-- or model output. Also backs the per-user daily AI limit.
-- ----------------------------------------------------------------------------

CREATE TABLE ai_usage (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature             VARCHAR(32) NOT NULL,
    provider            VARCHAR(32) NOT NULL,
    model               VARCHAR(80),
    status              VARCHAR(16) NOT NULL CHECK (status IN ('success', 'error', 'timeout', 'rate_limited', 'unavailable')),
    error_code          VARCHAR(48),
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    latency_ms          INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_usage_user_created ON ai_usage(user_id, created_at DESC);
