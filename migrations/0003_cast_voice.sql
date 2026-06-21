-- Vivijure Studio -- cast voice_id (migration 0003).
--
-- The "talking characters" pipeline voices each shot's dialogue with the speaking cast member's
-- assigned voice, so a character sounds the same across every shot of every film. voice_id is a
-- Deepgram Aura-1 speaker name (see src/voices.ts), a sibling of the cast member's LoRA (its face).
-- NULL = no voice assigned yet; the dialogue stage falls back to a default at TTS time.

ALTER TABLE cast_members ADD COLUMN voice_id TEXT;   -- aura-1 speaker; NULL => unassigned
