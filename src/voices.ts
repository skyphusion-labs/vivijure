// Voice catalog for character dialogue TTS. The "talking characters" pipeline voices each shot's
// dialogue line with the speaking cast member's assigned voice, so a character sounds the same in
// every shot of every film -- a voice_id is part of a cast identity, a sibling of its LoRA (face).
//
// Backed by Deepgram Aura-1 on Workers AI (@cf/deepgram/aura-1): a fixed set of 12 named English
// speakers. A cast member's voice_id IS the Aura `speaker` value, 1:1, so the dialogue-gen module
// passes it straight through with no mapping. Keep this list in sync with the model's speaker enum:
//   https://developers.cloudflare.com/workers-ai/models/aura-1/
//
// The dialogue-gen module worker vendors a copy of this catalog (modules vendor, never import the
// core); this file is the source of truth.

export const DIALOGUE_TTS_MODEL = "@cf/deepgram/aura-1" as const;

// The Aura-1 speaker enum, in the model's documented order. `angus` is the model default.
export const VOICE_IDS = [
  "angus", "asteria", "arcas", "orion", "orpheus", "athena",
  "luna", "zeus", "perseus", "helios", "hera", "stella",
] as const;

export type VoiceId = (typeof VOICE_IDS)[number];

export const DEFAULT_VOICE_ID: VoiceId = "angus";

// Human-facing label for the voice picker. Just the capitalized speaker name -- we do not assert a
// gender/accent we cannot verify from the model card; richer descriptors can be added later from
// Deepgram's own voice docs without changing the wire value.
export function voiceLabel(id: VoiceId): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// The catalog the UI/voice-picker renders from. Stable order = the documented enum order.
export const VOICE_CATALOG: ReadonlyArray<{ id: VoiceId; label: string }> =
  VOICE_IDS.map((id) => ({ id, label: voiceLabel(id) }));

const VOICE_ID_SET: ReadonlySet<string> = new Set(VOICE_IDS);

export function isValidVoiceId(value: unknown): value is VoiceId {
  return typeof value === "string" && VOICE_ID_SET.has(value);
}

// Coerce arbitrary input to a valid voice_id or null. A cast member with no voice assigned has a
// null voice_id; a shot whose speaker has no voice falls back to DEFAULT_VOICE_ID at TTS time, not
// here (this is storage-level validation, so "unset" stays distinguishable from "default").
export function coerceVoiceId(value: unknown): VoiceId | null {
  return isValidVoiceId(value) ? value : null;
}
