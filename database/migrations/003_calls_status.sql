-- ============================================================================
-- ConnectX — 003_calls_status (Phase 4)
--
-- Adds voice/video call sessions (metadata only — no audio/video is ever
-- stored), call history, and status/stories with backend-enforced privacy.
--
-- Additive for all existing data, with one deliberate exception: the
-- Phase 1 placeholder `statuses` table is dropped and re-created. No
-- Phase 1–3 code path ever read or wrote it (it was schema-only), so there
-- is no data to preserve, and re-creating it is far cleaner than patching
-- its old visibility CHECK constraint.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Calls
--
-- A call session belongs to exactly one conversation (direct or group).
-- Session lifecycle:
--   ringing → accepted → connecting → connected → ended
--   ringing → declined | missed | cancelled
--   any live state → failed
-- Live states are ringing/accepted/connecting/connected; a live session
-- always has ended_at IS NULL, and a terminal one always has it set.
-- ----------------------------------------------------------------------------

CREATE TABLE call_sessions (
    id                  UUID PRIMARY KEY,
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    initiator_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope               VARCHAR(16) NOT NULL CHECK (scope IN ('direct', 'group')),
    media               VARCHAR(16) NOT NULL CHECK (media IN ('voice', 'video')),
    state               VARCHAR(16) NOT NULL DEFAULT 'ringing' CHECK (
                            state IN ('ringing', 'accepted', 'connecting', 'connected',
                                      'declined', 'missed', 'ended', 'failed', 'cancelled')
                        ),
    end_reason          VARCHAR(32) CHECK (
                            end_reason IS NULL OR end_reason IN (
                                'hangup', 'declined', 'no_answer', 'cancelled', 'connection_failed',
                                'media_error', 'disconnected', 'all_left', 'server_restart'
                            )
                        ),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- First invitee accepted/joined.
    answered_at         TIMESTAMPTZ,
    -- A client reported the WebRTC media path as connected. Duration is measured from here.
    connected_at        TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    duration_seconds    INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((ended_at IS NULL) = (state IN ('ringing', 'accepted', 'connecting', 'connected')))
);

-- At most one live call per conversation, enforced by the database.
CREATE UNIQUE INDEX uq_call_sessions_one_live_per_conversation ON call_sessions(conversation_id) WHERE ended_at IS NULL;
CREATE INDEX idx_call_sessions_conversation_created ON call_sessions(conversation_id, created_at DESC);
CREATE INDEX idx_call_sessions_initiator_id ON call_sessions(initiator_id);

CREATE TABLE call_participants (
    call_id             UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role                VARCHAR(16) NOT NULL CHECK (role IN ('initiator', 'invitee')),
    state               VARCHAR(16) NOT NULL CHECK (
                            state IN ('invited', 'ringing', 'joined', 'declined', 'missed', 'left')
                        ),
    invited_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    joined_at           TIMESTAMPTZ,
    left_at             TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One row per user per call.
    PRIMARY KEY (call_id, user_id)
);

CREATE INDEX idx_call_participants_user_id ON call_participants(user_id);

-- Metadata-only audit trail of lifecycle transitions. Never holds SDP,
-- ICE candidates, or any media — only who did what, and when.
CREATE TABLE call_events (
    id                  UUID PRIMARY KEY,
    call_id             UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
    actor_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type          VARCHAR(32) NOT NULL CHECK (
                            event_type IN ('created', 'ringing', 'accepted', 'joined', 'declined', 'cancelled',
                                           'connected', 'left', 'ended', 'missed', 'failed')
                        ),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_events_call_id ON call_events(call_id);

-- ----------------------------------------------------------------------------
-- Status media: attachments no longer always belong to a conversation.
--
-- purpose = 'message': a chat attachment (conversation_id required) — the
--                      Phase 3 behavior, unchanged for every existing row.
-- purpose = 'status':  status media (conversation_id NULL); readable only by
--                      viewers the status' privacy setting allows.
-- ----------------------------------------------------------------------------

ALTER TABLE attachments ADD COLUMN purpose VARCHAR(16) NOT NULL DEFAULT 'message' CHECK (purpose IN ('message', 'status'));
ALTER TABLE attachments ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE attachments ADD CONSTRAINT ck_attachments_purpose_conversation
    CHECK ((purpose = 'message' AND conversation_id IS NOT NULL) OR (purpose = 'status' AND conversation_id IS NULL AND message_id IS NULL));

-- ----------------------------------------------------------------------------
-- Status / stories
--
-- Visibility (enforced server-side in StatusesRepository.isVisibleTo):
--   everyone  — anyone who shares an active direct OR group chat with the owner
--   contacts  — anyone who shares an active direct chat with the owner
--   selected  — only the users listed in status_audience
--   except    — contacts, minus the users listed in status_audience
-- ----------------------------------------------------------------------------

DROP TABLE statuses;

-- Constraint/index names are explicit (and differ from the dropped table's
-- auto-generated ones) so no engine can trip over a stale name.
CREATE TABLE statuses (
    id                  UUID NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_type        VARCHAR(16) NOT NULL CHECK (content_type IN ('text', 'image', 'video')),
    -- Text of a text status, or the caption of an image/video status.
    body                VARCHAR(700),
    background_color    VARCHAR(16) CHECK (
                            background_color IS NULL OR background_color IN ('indigo', 'rose', 'emerald', 'amber', 'slate', 'violet')
                        ),
    attachment_id       UUID UNIQUE REFERENCES attachments(id) ON DELETE SET NULL,
    visibility          VARCHAR(16) NOT NULL CHECK (visibility IN ('everyone', 'contacts', 'selected', 'except')),
    -- Set by the server (created_at + 24h); never taken from the client.
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_statuses PRIMARY KEY (id),
    CHECK (expires_at > created_at),
    CHECK (content_type <> 'text' OR (body IS NOT NULL AND attachment_id IS NULL))
);

CREATE INDEX idx_statuses_v2_user_id_created ON statuses(user_id, created_at DESC);
CREATE INDEX idx_statuses_v2_expires_at ON statuses(expires_at);

-- Per-status audience list, snapshotted at publish time: the allow-list for
-- 'selected', or the deny-list for 'except'.
CREATE TABLE status_audience (
    status_id           UUID NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (status_id, user_id)
);

CREATE INDEX idx_status_audience_user_id ON status_audience(user_id);

-- One view record per user per status.
CREATE TABLE status_views (
    status_id           UUID NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
    viewer_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (status_id, viewer_id)
);

CREATE INDEX idx_status_views_viewer_id ON status_views(viewer_id);

-- A user's default privacy for new statuses. No row = 'contacts'.
CREATE TABLE status_privacy_settings (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    visibility          VARCHAR(16) NOT NULL DEFAULT 'contacts' CHECK (visibility IN ('everyone', 'contacts', 'selected', 'except')),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The default allow-list ('selected') or deny-list ('except') for new statuses.
CREATE TABLE status_privacy_users (
    owner_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (owner_id, user_id),
    CHECK (owner_id <> user_id)
);
