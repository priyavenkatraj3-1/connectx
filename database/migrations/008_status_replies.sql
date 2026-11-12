-- ============================================================================
-- ConnectX — 008_status_replies
--
-- Replying to a status sends a normal direct message to the status owner.
-- The message keeps a small snapshot of which status it answered — not a
-- foreign key: statuses (and their media) are deleted when they expire, and
-- the reply must still read sensibly afterwards. Only the type and a short
-- text preview are kept (never the media itself). Additive.
-- ============================================================================

ALTER TABLE messages ADD COLUMN status_reply_status_id UUID;
ALTER TABLE messages ADD COLUMN status_reply_type VARCHAR(16) CHECK (status_reply_type IS NULL OR status_reply_type IN ('text', 'image', 'video'));
ALTER TABLE messages ADD COLUMN status_reply_preview VARCHAR(120);
