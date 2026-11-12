-- ============================================================================
-- ConnectX — 006_message_reactions
--
-- Emoji reactions use the Phase 1 `message_reactions` table, which no code
-- path wrote before, so there is no existing data to reconcile. ConnectX
-- allows one reaction per person per message (choosing another emoji
-- replaces it); this index enforces that even for concurrent requests and
-- lets the API upsert atomically. Additive.
-- ============================================================================

CREATE UNIQUE INDEX uq_message_reactions_message_user ON message_reactions(message_id, user_id);
