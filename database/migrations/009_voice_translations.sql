-- ============================================================================
-- 009 — Voice message translation
--
-- Translations of a Voice Intelligence transcript, one row per requesting
-- user, audio attachment and target language. Purely additive: no existing
-- table or row is changed.
--
-- Transcripts are per user (ai_voice_results is keyed by user + attachment),
-- so their translations are too: a user only ever sees translations of the
-- transcript they themselves requested. The original audio (attachments)
-- and the original transcript (ai_voice_results) are never modified.
--
-- `source_hash` is the SHA-256 of the exact transcript that was translated.
-- Re-transcribing produces a different transcript, so a cached translation
-- of the old one no longer matches and is regenerated on the next request.
--
-- Deleting the user, the attachment (or its message's account) or the voice
-- result removes these rows (ON DELETE CASCADE).
-- ============================================================================

CREATE TABLE ai_voice_translations (
    voice_result_id         UUID NOT NULL REFERENCES ai_voice_results(id) ON DELETE CASCADE,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attachment_id           UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    target_language         VARCHAR(16) NOT NULL,
    source_hash             CHAR(64) NOT NULL,
    translated_text         TEXT NOT NULL,
    detected_source_language VARCHAR(16),
    provider                VARCHAR(32),
    model                   VARCHAR(80),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, attachment_id, target_language)
);

CREATE INDEX idx_ai_voice_translations_voice_result ON ai_voice_translations (voice_result_id);
