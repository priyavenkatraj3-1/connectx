-- ============================================================================
-- ConnectX — 002_groups_media (Phase 3)
--
-- Extends the Phase 1/2 schema for group conversations, @mentions and the
-- media/file foundation. Purely additive: no existing column, constraint or
-- row is dropped or rewritten.
--
-- Membership model (see docs/database.md):
--   * conversation_members stays the single source of truth for "who can
--     read/send in this conversation" (active = left_at IS NULL) — for
--     direct and group conversations alike.
--   * group_members carries the *role* (owner/admin/member) of each active
--     member of a group. The application keeps both in step inside one
--     transaction (GroupsRepository); a row exists in group_members only
--     while the user is an active conversation member.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Groups
-- ----------------------------------------------------------------------------

ALTER TABLE groups ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE group_members ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Exactly zero or one owner per group, enforced by the database.
CREATE UNIQUE INDEX uq_group_members_one_owner ON group_members(group_id) WHERE role = 'owner';

-- Fast "active members of conversation X" lookups (fan-out of every message).
CREATE INDEX idx_conversation_members_active ON conversation_members(conversation_id) WHERE left_at IS NULL;

-- ----------------------------------------------------------------------------
-- Messages: mentions and replies
-- ----------------------------------------------------------------------------

CREATE TABLE message_mentions (
    message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX idx_message_mentions_user_id ON message_mentions(user_id);
CREATE INDEX idx_messages_reply_to_message_id ON messages(reply_to_message_id);

-- ----------------------------------------------------------------------------
-- Attachments (media foundation)
--
-- No Phase 1/2 code path ever wrote to `attachments`, so the new NOT NULL
-- columns can be added without a default.
-- ----------------------------------------------------------------------------

ALTER TABLE attachments ADD COLUMN conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE attachments ADD COLUMN original_filename VARCHAR(255) NOT NULL;
ALTER TABLE attachments ADD COLUMN kind VARCHAR(16) NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document', 'file'));
ALTER TABLE attachments ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX uq_attachments_storage_key ON attachments(storage_key);
CREATE INDEX idx_attachments_conversation_id ON attachments(conversation_id);
