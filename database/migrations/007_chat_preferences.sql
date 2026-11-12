-- ============================================================================
-- ConnectX — 007_chat_preferences
--
-- Per-user chat list preferences, stored on the user's own membership row
-- (so they're private to that user and disappear with the membership):
--   * pinned_at   — pinned to the top of the chat list (newest pin first)
--   * archived_at — moved out of the main list into "Archived"
-- Mute reuses the Phase 1 column conversation_members.muted_until (unused
-- until now). What mute does is limited to what ConnectX actually has —
-- see docs/api.md (no push notifications exist to silence). Additive.
-- ============================================================================

ALTER TABLE conversation_members ADD COLUMN pinned_at TIMESTAMPTZ;
ALTER TABLE conversation_members ADD COLUMN archived_at TIMESTAMPTZ;
