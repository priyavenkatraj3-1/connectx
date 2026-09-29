-- ============================================================================
-- ConnectX — 005_productivity (Phase 6)
--
-- Productivity (tasks, reminders, events, shared notes, shared to-do lists),
-- message organization (pins, saved messages, focused conversations),
-- offline-send idempotency, multi-device sessions, scheduled messages,
-- in-app notifications, user preferences, and the business-profile /
-- quick-reply foundation.
--
-- Additive for all existing data, with one deliberate exception (same
-- precedent as 003's `statuses` and 004's AI tables): the Phase 1
-- placeholder `notifications` table is dropped and re-created. No Phase 1–5
-- code path ever read or wrote it (its routes returned 501), so there is no
-- data to preserve, and its old type CHECK can't hold the new types.
--
-- Authorization model (enforced in the services, see docs/security.md):
--   * tasks / reminders / events / saved messages / notifications /
--     scheduled messages / business profile / quick replies are private to
--     their owning user (a task may also be visible to its assignee).
--   * shared notes, shared to-do lists and pinned messages belong to a
--     conversation and are visible only to its *active* members.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Preferences (timezone, productivity mode, notification switches).
-- No row = defaults.
-- ----------------------------------------------------------------------------

CREATE TABLE user_preferences (
    user_id                     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- IANA zone used to interpret wall-clock times ("tomorrow 9:00") the user enters.
    timezone                    VARCHAR(64),
    productivity_mode           BOOLEAN NOT NULL DEFAULT FALSE,
    notify_mentions             BOOLEAN NOT NULL DEFAULT TRUE,
    notify_task_due             BOOLEAN NOT NULL DEFAULT TRUE,
    notify_reminders            BOOLEAN NOT NULL DEFAULT TRUE,
    notify_scheduled_messages   BOOLEAN NOT NULL DEFAULT TRUE,
    notify_assignments          BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversations a user marked as "focused" (shown first in Productivity Mode).
CREATE TABLE focused_conversations (
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, conversation_id)
);

-- ----------------------------------------------------------------------------
-- AI suggestion → real item handoff. A suggestion can be turned into at most
-- one task/reminder/event, and only by an explicit user request.
-- ----------------------------------------------------------------------------

ALTER TABLE ai_actions ADD COLUMN converted_to VARCHAR(16);
ALTER TABLE ai_actions ADD COLUMN converted_id UUID;
ALTER TABLE ai_actions ADD CONSTRAINT ck_ai_actions_converted_to
    CHECK (converted_to IS NULL OR converted_to IN ('task', 'reminder', 'event'));

-- ----------------------------------------------------------------------------
-- Tasks
-- ----------------------------------------------------------------------------

CREATE TABLE tasks (
    id                      UUID PRIMARY KEY,
    owner_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Optional assignee: must be an active member of the source conversation when assigned.
    assignee_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    title                   VARCHAR(200) NOT NULL,
    description             VARCHAR(2000),
    status                  VARCHAR(16) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'completed', 'cancelled')),
    priority                VARCHAR(8) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    due_at                  TIMESTAMPTZ,
    reminder_at             TIMESTAMPTZ,
    timezone                VARCHAR(64),
    source_conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
    source_message_id       UUID REFERENCES messages(id) ON DELETE SET NULL,
    source_action_id        UUID REFERENCES ai_actions(id) ON DELETE SET NULL,
    -- Set when the "task due" notification has been sent, so it is sent once.
    due_notified_at         TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ,
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX idx_tasks_owner_status ON tasks(owner_id, status);
CREATE INDEX idx_tasks_assignee_id ON tasks(assignee_id);
CREATE INDEX idx_tasks_due_pending ON tasks(due_at) WHERE due_notified_at IS NULL;

-- ----------------------------------------------------------------------------
-- Reminders (standalone, or the reminder of a task via task_id)
-- ----------------------------------------------------------------------------

CREATE TABLE reminders (
    id                      UUID PRIMARY KEY,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id                 UUID REFERENCES tasks(id) ON DELETE CASCADE,
    title                   VARCHAR(200) NOT NULL,
    notes                   VARCHAR(1000),
    remind_at               TIMESTAMPTZ NOT NULL,
    timezone                VARCHAR(64),
    -- pending → fired (notification sent) → completed | dismissed. Rescheduling returns it to pending.
    status                  VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'completed', 'dismissed')),
    source_conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
    source_message_id       UUID REFERENCES messages(id) ON DELETE SET NULL,
    source_action_id        UUID REFERENCES ai_actions(id) ON DELETE SET NULL,
    fired_at                TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reminders_user_status ON reminders(user_id, status);
CREATE INDEX idx_reminders_due ON reminders(remind_at) WHERE status = 'pending';
-- A task has at most one reminder.
CREATE UNIQUE INDEX uq_reminders_task_id ON reminders(task_id) WHERE task_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Calendar events (private to the user who created them)
-- ----------------------------------------------------------------------------

CREATE TABLE calendar_events (
    id                      UUID PRIMARY KEY,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title                   VARCHAR(200) NOT NULL,
    description             VARCHAR(2000),
    location                VARCHAR(300),
    starts_at               TIMESTAMPTZ NOT NULL,
    ends_at                 TIMESTAMPTZ,
    all_day                 BOOLEAN NOT NULL DEFAULT FALSE,
    timezone                VARCHAR(64),
    source_conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
    source_message_id       UUID REFERENCES messages(id) ON DELETE SET NULL,
    source_action_id        UUID REFERENCES ai_actions(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX idx_calendar_events_user_starts ON calendar_events(user_id, starts_at);

-- ----------------------------------------------------------------------------
-- Shared notes (conversation-scoped)
--
-- edit_policy (groups only; direct chats: both members may edit):
--   members — any active member may edit
--   admins  — only the group owner/admins (and the note's creator) may edit
-- `version` increments on every edit, for optimistic concurrency.
-- ----------------------------------------------------------------------------

CREATE TABLE shared_notes (
    id                  UUID PRIMARY KEY,
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    title               VARCHAR(200) NOT NULL,
    content             VARCHAR(20000) NOT NULL DEFAULT '',
    edit_policy         VARCHAR(16) NOT NULL DEFAULT 'members' CHECK (edit_policy IN ('members', 'admins')),
    version             INTEGER NOT NULL DEFAULT 1,
    created_by          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shared_notes_conversation ON shared_notes(conversation_id, updated_at DESC);

-- ----------------------------------------------------------------------------
-- Shared to-do lists (conversation-scoped)
-- ----------------------------------------------------------------------------

CREATE TABLE shared_todo_lists (
    id                  UUID PRIMARY KEY,
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    title               VARCHAR(120) NOT NULL,
    created_by          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shared_todo_lists_conversation ON shared_todo_lists(conversation_id);

CREATE TABLE shared_todo_items (
    id                  UUID PRIMARY KEY,
    list_id             UUID NOT NULL REFERENCES shared_todo_lists(id) ON DELETE CASCADE,
    title               VARCHAR(200) NOT NULL,
    notes               VARCHAR(1000),
    assignee_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    priority            VARCHAR(8) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    due_at              TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    completed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shared_todo_items_list ON shared_todo_items(list_id, created_at);

-- ----------------------------------------------------------------------------
-- Pinned messages (conversation-wide) and saved messages (per user)
-- ----------------------------------------------------------------------------

CREATE TABLE pinned_messages (
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id          UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE saved_messages (
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id          UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    label               VARCHAR(40),
    starred             BOOLEAN NOT NULL DEFAULT FALSE,
    note                VARCHAR(500),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_saved_messages_user_created ON saved_messages(user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Offline send idempotency: a client-generated ID per outgoing message. A
-- retried send with the same (sender, client_message_id) returns the
-- original message instead of creating a duplicate.
-- ----------------------------------------------------------------------------

ALTER TABLE messages ADD COLUMN client_message_id UUID;
CREATE UNIQUE INDEX uq_messages_sender_client_id ON messages(sender_id, client_message_id) WHERE client_message_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Scheduled messages (text only). Delivered by the in-process scheduler
-- (backend/src/modules/scheduler), which re-checks membership at send time.
-- scheduled → sending → sent | failed;  scheduled → cancelled.
-- ----------------------------------------------------------------------------

CREATE TABLE scheduled_messages (
    id                  UUID PRIMARY KEY,
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body                VARCHAR(4000) NOT NULL,
    scheduled_for       TIMESTAMPTZ NOT NULL,
    timezone            VARCHAR(64),
    status              VARCHAR(16) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    failure_reason      VARCHAR(300),
    sent_message_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
    sent_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scheduled_messages_sender ON scheduled_messages(sender_id, scheduled_for);
CREATE INDEX idx_scheduled_messages_due ON scheduled_messages(scheduled_for) WHERE status = 'scheduled';

-- ----------------------------------------------------------------------------
-- In-app notifications (re-created; see header). `dedupe_key` makes
-- scheduler-generated notifications idempotent per user.
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS notifications;

CREATE TABLE notifications (
    id                  UUID NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                VARCHAR(32) NOT NULL CHECK (
                            type IN ('mention', 'task_due', 'task_assigned', 'reminder', 'todo_assigned',
                                     'scheduled_message_sent', 'scheduled_message_failed', 'session_new', 'system')
                        ),
    title               VARCHAR(200) NOT NULL,
    body                VARCHAR(500),
    -- Only IDs needed to navigate (conversationId, messageId, taskId…) — never message content.
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key          VARCHAR(120),
    read_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_notifications_v2 PRIMARY KEY (id),
    CONSTRAINT uq_notifications_v2_dedupe UNIQUE (user_id, dedupe_key)
);

CREATE INDEX idx_notifications_v2_user_created ON notifications(user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Multi-device sessions. The Phase 1 `devices`/`sessions` tables are now
-- used: every login/signup creates one device row and one session row.
-- Access tokens carry the session ID; revoking a session invalidates its
-- tokens on the next request and closes its WebSocket connections.
-- Only a SHA-256 hash of the refresh token is stored.
-- ----------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN last_seen_at TIMESTAMPTZ;
CREATE INDEX idx_sessions_device_id ON sessions(device_id);

-- ----------------------------------------------------------------------------
-- Business profile foundation. verification_status is NOT user-writable;
-- nothing in ConnectX verifies businesses yet, so every profile is
-- 'unverified' until a real verification process exists.
-- ----------------------------------------------------------------------------

CREATE TABLE business_profiles (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    business_name       VARCHAR(120) NOT NULL,
    description         VARCHAR(1000),
    category            VARCHAR(60),
    website             VARCHAR(300),
    contact_email       VARCHAR(254),
    contact_phone       VARCHAR(32),
    address             VARCHAR(300),
    -- { "mon": [{"open":"09:00","close":"17:00"}], ... } validated by the API.
    business_hours      JSONB NOT NULL DEFAULT '{}'::jsonb,
    verification_status VARCHAR(16) NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'pending', 'verified')),
    is_public           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quick_replies (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shortcut            VARCHAR(32) NOT NULL,
    title               VARCHAR(80) NOT NULL,
    body                VARCHAR(2000) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, shortcut)
);
