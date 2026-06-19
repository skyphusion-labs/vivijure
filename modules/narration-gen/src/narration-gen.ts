// Pure helpers for the narration-gen module: param construction, Workers AI result parsing,
// poll tokens, and R2 key layout. Unit-tested without bindings.

import type { ScoreInput, ScoreOutput, PlanEnhanceStoryboard } from "./contract";

export const MODEL = "minimax/speech-2.8-hd";
export const DEFAULT_VOICE = "English_expressive_narrator";
export const MAX_TEXT = 10_000;

export const EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "calm",
  "fluent",
] as const;

export const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100] as const;
export const FORMATS = ["mp3", "flac", "wav"] as const;

export type SpeechFormat = (typeof FORMATS)[number];
export type SpeechEmotion = (typeof EMOTIONS)[number];

export interface NarrationConfig {
  text?: string;
  voice_id?: string;
  emotion?: SpeechEmotion;
  format?: SpeechFormat;
  pitch?: number;
  speed?: number;
  volume?: number;
  sample_rate?: number;
}

export interface PollToken {
  job_id: string;
}

// `pending` carries the input + config so /poll can run synthesis itself (the env.AI.run is too long
// for submit's post-response budget -- see issue #155). `generating` is a claim flag so an overlapping
// poll does not double-run the model. Mirrors cast-image's "poll does the work" model.
export type RunState =
  | { status: "pending"; started_at: number; film_key: string; applied: string[]; input: ScoreInput; config: NarrationConfig }
  | { status: "generating"; started_at: number; film_key: string; applied: string[] }
  | { status: "done"; film_key: string; audio_key: string; mime: string; applied: string[] }
  | { status: "failed"; error: string; applied: string[] };

function pickEnumNumber(raw: unknown, allowed: readonly number[], fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return allowed.includes(n as never) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function pickFormat(raw: unknown): SpeechFormat {
  if (raw === "flac") return "flac";
  if (raw === "wav") return "wav";
  return "mp3";
}

function pickEmotion(raw: unknown): SpeechEmotion | undefined {
  if (typeof raw !== "string") return undefined;
  return (EMOTIONS as readonly string[]).includes(raw) ? (raw as SpeechEmotion) : undefined;
}

/** Derive narration script from config + storyboard context. */
export function textFromScoreInput(input: ScoreInput, config: NarrationConfig): string {
  const configured = typeof config.text === "string" ? config.text.trim() : "";
  if (configured) return configured.slice(0, MAX_TEXT);

  const sb = input.storyboard;
  if (sb && Array.isArray(sb.scenes) && sb.scenes.length > 0) {
    const lines: string[] = [];
    for (const scene of sb.scenes) {
      const narration = typeof scene.narration === "string" ? scene.narration.trim() : "";
      const prompt = typeof scene.prompt === "string" ? scene.prompt.trim() : "";
      const line = narration || prompt;
      if (line) lines.push(line);
    }
    if (lines.length) return lines.join("\n\n").slice(0, MAX_TEXT);
  }

  if (sb && typeof (sb as PlanEnhanceStoryboard).title === "string") {
    const title = String((sb as PlanEnhanceStoryboard).title).trim();
    if (title) {
      return `A cinematic narration for "${title}".`.slice(0, MAX_TEXT);
    }
  }

  throw new Error("text required (set config.text or provide storyboard scenes)");
}

/** Build the Workers AI / AI Gateway params for minimax/speech-2.8-hd. */
export function buildSpeechParams(text: string, config: NarrationConfig): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("text required");

  const voiceId = typeof config.voice_id === "string" && config.voice_id.trim()
    ? config.voice_id.trim()
    : DEFAULT_VOICE;
  const format = pickFormat(config.format);
  const pitch = clamp(Math.round(typeof config.pitch === "number" ? config.pitch : 0), -12, 12);
  const speed = clamp(typeof config.speed === "number" ? config.speed : 1, 0.5, 2);
  const volume = clamp(typeof config.volume === "number" ? config.volume : 1, 0, 10);
  const sampleRate = pickEnumNumber(config.sample_rate, SAMPLE_RATES, 44100);

  const params: Record<string, unknown> = {
    text: trimmed.slice(0, MAX_TEXT),
    voice_id: voiceId,
    speed,
    volume,
    pitch,
    format,
    sample_rate: sampleRate,
  };

  const emotion = pickEmotion(config.emotion);
  if (emotion) params.emotion = emotion;

  return params;
}

/** Parse the audio URL from a Workers AI speech response. */
export function parseAudioUrl(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.state === "string" && r.state.length > 0 && r.state !== "Completed") {
    return null;
  }
  if (typeof r.audio === "string" && r.audio.length > 0) return r.audio;
  const inner = r.result;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const audio = (inner as Record<string, unknown>).audio;
    if (typeof audio === "string" && audio.length > 0) return audio;
  }
  return null;
}

export function mimeForFormat(format: SpeechFormat): string {
  if (format === "wav") return "audio/wav";
  if (format === "flac") return "audio/flac";
  return "audio/mpeg";
}

export function extForFormat(format: SpeechFormat): string {
  return format;
}

export function encodePoll(t: PollToken): string {
  return btoa(JSON.stringify(t));
}

export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.job_id === "string" && o.job_id.length > 0) return { job_id: o.job_id };
  } catch {
    /* fall through */
  }
  return null;
}

export function stateKey(jobId: string): string {
  return `narration-gen/${jobId}.state.json`;
}

export function audioKey(jobId: string, format: SpeechFormat): string {
  return `out/narr-${jobId}.${extForFormat(format)}`;
}

export function appliedTags(format: SpeechFormat, config: NarrationConfig): string[] {
  const tags = [`narration:${MODEL}`, `format:${format}`];
  const voice = typeof config.voice_id === "string" && config.voice_id.trim()
    ? config.voice_id.trim()
    : DEFAULT_VOICE;
  tags.push(`voice:${voice}`);
  if (config.emotion) tags.push(`emotion:${config.emotion}`);
  return tags;
}

export function readOutput(state: Extract<RunState, { status: "done" }>): ScoreOutput {
  return { film_key: state.film_key, applied: state.applied };
}

export function normalizeConfig(raw: Record<string, unknown>): NarrationConfig {
  return {
    text: typeof raw.text === "string" ? raw.text : "",
    voice_id: typeof raw.voice_id === "string" ? raw.voice_id : DEFAULT_VOICE,
    emotion: pickEmotion(raw.emotion),
    format: pickFormat(raw.format),
    pitch: clamp(Math.round(typeof raw.pitch === "number" ? raw.pitch : 0), -12, 12),
    speed: clamp(typeof raw.speed === "number" ? raw.speed : 1, 0.5, 2),
    volume: clamp(typeof raw.volume === "number" ? raw.volume : 1, 0, 10),
    sample_rate: pickEnumNumber(raw.sample_rate, SAMPLE_RATES, 44100),
  };
}
