-- ============================================================================
-- ConnectX — 001_initial_schema
--
-- Full Phase 1 + Phase 2 schema. Applied by `backend/src/db/migrate.ts`
-- (npm run db:migrate). See docs/database.md for the reasoning behind each
-- table.
--
-- Conventions:
--   * Primary keys are UUIDs, generated application-side (crypto.randomUUID())
--     and supplied on INSERT — no DB extension (pgcrypto/uuid-ossp) required.
--   * `email` is stored lowercased by the application; uniqueness is a plain
--     UNIQUE constraint on that normalized value (no citext extension needed).
--   * Timestamps are `timestamptz`, always UTC.
--   * Soft-deletes use a nullable `deleted_at` where messages/content may be
--     hidden without destroying audit trails.
--   * AI tables are namespaced and kept separate from core messaging tables.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Core identity
-- ----------------------------------------------------------------------------

CREATE TABLE users (
    id              UUID PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    display_name    VARCHAR(80) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_profiles (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    avatar_url          TEXT,
    bio                 VARCHAR(280),
    status_message      VARCHAR(140),
    phone_number        VARCHAR(32),
    locale              VARCHAR(16) NOT NULL DEFAULT 'en',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name     VARCHAR(120),
    platform        VARCHAR(32) NOT NULL, -- 'web' | 'ios' | 'android' | 'desktop'
    push_token      TEXT,
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_user_id ON devices(user_id);

CREATE TABLE sessions (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id           UUID REFERENCES devices(id) ON DELETE SET NULL,
    refresh_token_hash  TEXT NOT NULL,
    ip_address          INET,
    user_agent          TEXT,
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ----------------------------------------------------------------------------
-- Conversations & messaging
-- ----------------------------------------------------------------------------

CREATE TABLE conversations (
    id              UUID PRIMARY KEY,
    type            VARCHAR(16) NOT NULL CHECK (type IN ('direct', 'group')),
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_message_id UUID,
    muted_until     TIMESTAMPTZ,
    left_at         TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_conversation_members_user_id ON conversation_members(user_id);

-- Enforces "at most one direct conversation between any two users" at the
-- application layer (see ConversationsRepository.findDirectConversationId) —
-- Postgres has no clean way to express a 2-row-set uniqueness constraint
-- directly, so this is application-enforced, not DB-enforced.

CREATE TABLE messages (
    id              UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id),
    content_type    VARCHAR(16) NOT NULL CHECK (content_type IN ('text', 'image', 'video', 'audio', 'file')),
    body            TEXT,
    reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at       TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_messages_conversation_id_created_at ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_sender_id ON messages(sender_id);

CREATE TABLE message_reactions (
    message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji           VARCHAR(16) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

-- Per-recipient delivery/read tracking. One row per (message, recipient).
-- 'delivered' is written when the message reaches a recipient's active
-- WebSocket connection; 'read' is written when that recipient marks the
-- conversation read. A message with no row for a recipient is "sent" only.
CREATE TABLE message_receipts (
    message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          VARCHAR(16) NOT NULL CHECK (status IN ('delivered', 'read')),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX idx_message_receipts_user_id ON message_receipts(user_id);

CREATE TABLE attachments (
    id              UUID PRIMARY KEY,
    message_id      UUID REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id     UUID NOT NULL REFERENCES users(id),
    storage_key     TEXT NOT NULL,
    mime_type       VARCHAR(120) NOT NULL,
    size_bytes      BIGINT NOT NULL CHECK (size_bytes > 0),
    width           INTEGER,
    height          INTEGER,
    duration_seconds INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_message_id ON attachments(message_id);
CREATE INDEX idx_attachments_uploader_id ON attachments(uploader_id);

-- ----------------------------------------------------------------------------
-- Groups
-- ----------------------------------------------------------------------------

CREATE TABLE groups (
    id              UUID PRIMARY KEY,
    conversation_id UUID NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    name            VARCHAR(120) NOT NULL,
    description     VARCHAR(500),
    avatar_url      TEXT,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
    group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    added_by        UUID REFERENCES users(id),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_members_user_id ON group_members(user_id);

-- ----------------------------------------------------------------------------
-- Status / stories
-- ----------------------------------------------------------------------------

CREATE TABLE statuses (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_type    VARCHAR(16) NOT NULL CHECK (content_type IN ('text', 'image', 'video')),
    body            TEXT,
    attachment_id   UUID REFERENCES attachments(id) ON DELETE SET NULL,
    visibility      VARCHAR(16) NOT NULL DEFAULT 'contacts' CHECK (visibility IN ('everyone', 'contacts', 'custom')),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_statuses_user_id ON statuses(user_id);
CREATE INDEX idx_statuses_expires_at ON statuses(expires_at);

-- ----------------------------------------------------------------------------
-- Notifications
-- ----------------------------------------------------------------------------

CREATE TABLE notifications (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(32) NOT NULL CHECK (type IN ('message', 'mention', 'group_invite', 'system')),
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_id_created_at ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_user_id_unread ON notifications(user_id) WHERE read_at IS NULL;

-- ----------------------------------------------------------------------------
-- Privacy & security
-- ----------------------------------------------------------------------------

CREATE TABLE privacy_settings (
    user_id                     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_seen_visibility        VARCHAR(16) NOT NULL DEFAULT 'everyone' CHECK (last_seen_visibility IN ('everyone', 'contacts', 'nobody')),
    profile_photo_visibility    VARCHAR(16) NOT NULL DEFAULT 'everyone' CHECK (profile_photo_visibility IN ('everyone', 'contacts', 'nobody')),
    read_receipts_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    ai_features_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    ai_memory_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- AI data — deliberately isolated from core messaging tables above.
-- Every row here must be traceable to explicit user consent recorded in
-- privacy_settings (ai_features_enabled / ai_memory_enabled). See
-- docs/ai-roadmap.md and docs/security.md.
-- ----------------------------------------------------------------------------

CREATE TABLE ai_conversations (
    id                      UUID PRIMARY KEY,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature                 VARCHAR(32) NOT NULL CHECK (
                                feature IN (
                                    'ask_your_chats',
                                    'summarization',
                                    'chat_search',
                                    'voice_intelligence',
                                    'spam_shield',
                                    'action_extraction',
                                    'translation'
                                )
                            ),
    source_conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
    prompt                  TEXT,
    response                TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_conversations_user_id ON ai_conversations(user_id);
CREATE INDEX idx_ai_conversations_feature ON ai_conversations(feature);

CREATE TABLE ai_memories (
    id                      UUID PRIMARY KEY,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
    content                 TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_memories_user_id ON ai_memories(user_id);

CREATE TABLE ai_actions (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_message_id   UUID REFERENCES messages(id) ON DELETE SET NULL,
    type                VARCHAR(16) NOT NULL CHECK (type IN ('task', 'reminder', 'event')),
    title               VARCHAR(200) NOT NULL,
    due_at              TIMESTAMPTZ,
    confirmed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_actions_user_id ON ai_actions(user_id);
CREATE INDEX idx_ai_actions_unconfirmed ON ai_actions(user_id) WHERE confirmed_at IS NULL;
