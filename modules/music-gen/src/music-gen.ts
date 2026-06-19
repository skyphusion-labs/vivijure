// Pure helpers for the music-gen module: param construction, Workers AI result parsing, poll
// tokens, and R2 key layout. Unit-tested without bindings.

import type { ScoreInput, ScoreOutput, PlanEnhanceStoryboard } from "./contract";

export const MODEL = "minimax/music-2.6";

export const BITRATES = [32000, 64000, 128000, 256000] as const;
export const SAMPLE_RATES = [16000, 24000, 32000, 44100] as const;
export const FORMATS = ["mp3", "wav"] as const;

export type MusicFormat = (typeof FORMATS)[number];

export interface MusicGenerateConfig {
  prompt?: string;
  lyrics?: string;
  is_instrumental?: boolean;
  lyrics_optimizer?: boolean;
  format?: MusicFormat;
  bitrate?: number;
  sample_rate?: number;
}

export interface PollToken {
  job_id: string;
}

// `running` carries the workflow instance id so /poll can surface an errored/terminated workflow as a
// failure instead of pending-forever, even though R2 presence remains the authoritative done-signal (#155).
export type RunState =
  | { status: "running"; started_at: number; film_key: string; applied: string[]; workflow_id?: string }
  | { status: "done"; film_key: string; audio_key: string; mime: string; applied: string[] }
  | { status: "failed"; error: string; applied: string[] };

function pickEnumNumber(raw: unknown, allowed: readonly number[], fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return allowed.includes(n as never) ? n : fallback;
}

function pickFormat(raw: unknown): MusicFormat {
  return raw === "wav" ? "wav" : "mp3";
}

/** Derive a MiniMax prompt from config + storyboard context. */
export function promptFromScoreInput(input: ScoreInput, config: MusicGenerateConfig): string {
  const configured = typeof config.prompt === "string" ? config.prompt.trim() : "";
  if (configured) return configured;
  const sb = input.storyboard;
  if (sb && typeof (sb as PlanEnhanceStoryboard).title === "string") {
    const title = String((sb as PlanEnhanceStoryboard).title).trim();
    if (title) {
      return `Instrumental score for "${title}": cinematic, matches the storyboard mood and pacing.`;
    }
  }
  if (sb && Array.isArray(sb.scenes) && sb.scenes.length > 0) {
    const hints = sb.scenes
      .slice(0, 4)
      .map((s) => (typeof s.prompt === "string" ? s.prompt.trim() : ""))
      .filter(Boolean);
    if (hints.length) return `Instrumental film score inspired by: ${hints.join("; ")}`;
  }
  throw new Error("prompt required (set config.prompt or provide storyboard context)");
}

/** Build the Workers AI / AI Gateway params for minimax/music-2.6. */
export function buildMusicParams(prompt: string, config: MusicGenerateConfig): Record<string, unknown> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("prompt required");

  const isInstrumental = config.is_instrumental === true;
  const lyricsOptimizer = config.lyrics_optimizer === true;
  const format = pickFormat(config.format);
  const bitrate = pickEnumNumber(config.bitrate, BITRATES, 128000);
  const sampleRate = pickEnumNumber(config.sample_rate, SAMPLE_RATES, 44100);

  const params: Record<string, unknown> = {
    prompt: trimmed,
    is_instrumental: isInstrumental,
    lyrics_optimizer: lyricsOptimizer,
    format,
    bitrate,
    sample_rate: sampleRate,
  };

  // MiniMax returns gateway error 7003 when lyrics is missing on vocal tracks. Default to the model's
  // instrumental marker when the caller did not supply lyrics and is not auto-generating them.
  if (!lyricsOptimizer) {
    const lyrics = typeof config.lyrics === "string" ? config.lyrics.trim() : "";
    params.lyrics = lyrics.length > 0 ? lyrics : "[Instrumental]";
  }

  return params;
}

/** Parse the audio URL from a Workers AI music response. */
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

export function mimeForFormat(format: MusicFormat): string {
  return format === "wav" ? "audio/wav" : "audio/mpeg";
}

export function extForFormat(format: MusicFormat): string {
  return format === "wav" ? "wav" : "mp3";
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
  return `music-gen/${jobId}.state.json`;
}

export function audioKey(jobId: string, format: MusicFormat): string {
  return `out/${jobId}.${extForFormat(format)}`;
}

export function appliedTags(format: MusicFormat, config: MusicGenerateConfig): string[] {
  const tags = [`music:${MODEL}`, `format:${format}`];
  if (config.is_instrumental) tags.push("instrumental");
  if (config.lyrics_optimizer) tags.push("lyrics_optimizer");
  return tags;
}

export function readOutput(state: Extract<RunState, { status: "done" }>): ScoreOutput {
  return { film_key: state.film_key, applied: state.applied };
}

export function normalizeConfig(raw: Record<string, unknown>): MusicGenerateConfig {
  return {
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    lyrics: typeof raw.lyrics === "string" ? raw.lyrics : "",
    is_instrumental: raw.is_instrumental === true,
    lyrics_optimizer: raw.lyrics_optimizer === true,
    format: pickFormat(raw.format),
    bitrate: pickEnumNumber(raw.bitrate, BITRATES, 128000),
    sample_rate: pickEnumNumber(raw.sample_rate, SAMPLE_RATES, 44100),
  };
}
