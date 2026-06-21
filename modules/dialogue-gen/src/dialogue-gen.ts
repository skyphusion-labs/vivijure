// Pure helpers for the dialogue-gen module: TTS param construction, R2 key layout, poll tokens, run
// state, and line validation. No I/O -- unit-tested without bindings or spend.
//
// Backed by Deepgram Aura-1 on Workers AI (@cf/deepgram/aura-1). We request 16-bit PCM WAV (not the
// default MP3) so the lip-sync backend (MuseTalk) gets clean, lossless audio to drive the mouth from.

import type { DialogueInput, DialogueLine, DialogueOutput, DialogueShotAudio } from "./contract";

export const MODEL = "@cf/deepgram/aura-1" as const;

// --- vendored voice catalog (kept in sync with the core's src/voices.ts; modules vendor, not import) ---
export const VOICE_IDS = [
  "angus", "asteria", "arcas", "orion", "orpheus", "athena",
  "luna", "zeus", "perseus", "helios", "hera", "stella",
] as const;
export type VoiceId = (typeof VOICE_IDS)[number];
export const DEFAULT_VOICE_ID: VoiceId = "angus";
const VOICE_SET: ReadonlySet<string> = new Set(VOICE_IDS);

// Resolve a requested voice to a valid speaker, falling back to the default for absent/unknown ones.
// (The core normally resolves this; the fallback keeps a stray line from failing the whole batch.)
export function resolveVoice(voiceId: string | undefined): VoiceId {
  return voiceId && VOICE_SET.has(voiceId) ? (voiceId as VoiceId) : DEFAULT_VOICE_ID;
}

// Per-line cap, mirrors the core's DIALOGUE_MAX_CHARS. A second guard here keeps the billed TTS call
// bounded even if a caller skipped core validation.
export const DIALOGUE_MAX_CHARS = 300;

/** Build the Workers AI params for one Aura-1 line. WAV/PCM out for a clean lip-sync drive track. */
export function buildTtsParams(text: string, voice: VoiceId): Record<string, unknown> {
  return { text, speaker: voice, encoding: "linear16", container: "wav" };
}

export const AUDIO_MIME = "audio/wav";

export interface PollToken { job_id: string; }

export function encodePoll(t: PollToken): string {
  return btoa(JSON.stringify(t));
}
export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.job_id === "string" && o.job_id.length > 0) return { job_id: o.job_id };
  } catch { /* fall through */ }
  return null;
}

export function stateKey(jobId: string): string {
  return `dialogue-gen/${jobId}.state.json`;
}

// Per-shot audio lands beside the shot's other render artifacts. shot_id is already a safe
// `shot_NN` token (the core validates it), so it is a safe key segment.
export function audioKey(project: string, shotId: string): string {
  return `renders/${project}/dialogue/${shotId}.wav`;
}

// `running` carries the workflow instance id so /poll can surface an errored/terminated workflow as a
// failure instead of pending-forever; R2 presence of the done state remains the authoritative signal.
export type RunState =
  | { status: "running"; started_at: number; project: string; workflow_id?: string }
  | { status: "done"; project: string; audio: DialogueShotAudio[]; applied: string[] }
  | { status: "failed"; error: string };

export function appliedTags(audio: DialogueShotAudio[]): string[] {
  return [`dialogue:${MODEL}`, `lines:${audio.length}`];
}

export function readOutput(state: Extract<RunState, { status: "done" }>): DialogueOutput {
  return { project: state.project, audio: state.audio, applied: state.applied };
}

/** Validate + normalize the batch input. Returns the cleaned lines or an error string. Empty text or
 *  a missing shot_id drops that line (a no-op shot), but an over-cap line is a hard error so a caller
 *  can't silently truncate a character's words. */
export function normalizeInput(input: DialogueInput | undefined): { ok: true; project: string; lines: NormalizedLine[] } | { ok: false; error: string } {
  const project = typeof input?.project === "string" ? input.project.trim() : "";
  if (!project) return { ok: false, error: "input.project required" };
  if (!Array.isArray(input?.lines)) return { ok: false, error: "input.lines must be an array" };
  const lines: NormalizedLine[] = [];
  for (const raw of input.lines as DialogueLine[]) {
    const shotId = typeof raw?.shot_id === "string" ? raw.shot_id.trim() : "";
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    if (!shotId || !text) continue;  // nothing to say for this shot -> skip it
    if (text.length > DIALOGUE_MAX_CHARS) {
      return { ok: false, error: `line for ${shotId} is ${text.length} chars; cap is ${DIALOGUE_MAX_CHARS}` };
    }
    lines.push({ shot_id: shotId, text, voice: resolveVoice(raw.voice_id) });
  }
  return { ok: true, project, lines };
}

export interface NormalizedLine {
  shot_id: string;
  text: string;
  voice: VoiceId;
}
