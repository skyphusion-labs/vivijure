// Pure helpers for the narration-gen module: RunPod request-body construction, status parsing, poll
// tokens, and R2 key layout. Unit-tested without bindings.
//
// Synthesis runs on RunPod's hosted minimax-speech-02-hd endpoint via the SAME async submit+poll
// transport as seedance/kling (POST /run -> job id; GET /status/<id> -> COMPLETED + audio url), so a
// multi-minute synth never blocks a Worker request and the durable poll (runpodJobGone + grace) survives
// a recycle (#155, #141). NOT Workers AI / waitUntil.

import type { ScoreInput, PlanEnhanceStoryboard } from "./contract";

// RunPod hosted endpoint id (https://api.runpod.ai/v2/<MODEL>). Verified live: input.prompt = the
// narration text, output.result = the audio URL on COMPLETED.
export const MODEL = "minimax-speech-02-hd";
export const DEFAULT_VOICE = "Wise_Woman";
export const MAX_TEXT = 10_000;

// The RunPod minimax-speech-02-hd emotion enum (verified live: the endpoint 400s on anything else).
// NOTE this differs from Workers AI speech-2.8 (which had calm/fluent) -- this module is on RunPod, so
// "neutral" replaces "calm" and there is no "fluent". Sending an out-of-set value fails the job.
export const EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "neutral",
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

// Everything /poll needs to finalize a RunPod job, opaque (base64 JSON) and round-tripped from /invoke.
// Stateless like seedance: no R2 run-state doc -- the audio is written to R2 only on COMPLETED, and the
// token carries the rest. submittedAt (epoch ms) measures the not-found grace window (#141).
export interface PollState {
  jobId: string;
  job_id: string;       // the score job id (R2 audio key namespace)
  film_key: string;
  format: SpeechFormat;
  applied: string[];
  submittedAt?: number;
}

// How long after submit a RunPod "job not found" is a propagation race vs a real GC. Mirrors the control
// plane's PHANTOM_GRACE_SECONDS (150s), same as seedance/kling.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

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

/** Build the RunPod request body for minimax-speech-02-hd. Their input field is `prompt` (the narration
 *  text), NOT `text`. Verified live: { input: { prompt, voice_id, speed, volume, ... } }. */
export function buildSpeechBody(text: string, config: NarrationConfig): { input: Record<string, unknown> } {
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

  const input: Record<string, unknown> = {
    prompt: trimmed.slice(0, MAX_TEXT),
    voice_id: voiceId,
    speed,
    volume,
    pitch,
    format,
    sample_rate: sampleRate,
  };

  const emotion = pickEmotion(config.emotion);
  if (emotion) input.emotion = emotion;

  return { input };
}

/** Extract the audio URL from a COMPLETED RunPod status body. Verified live: output.result is the URL.
 *  Also tolerates output.audio / a bare-string output for resilience. */
export function extractAudioUrl(output: unknown): string | null {
  if (typeof output === "string" && output.length > 0) return output;
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.result === "string" && o.result.length > 0) return o.result;
  if (typeof o.audio === "string" && o.audio.length > 0) return o.audio;
  return null;
}

/** Pure: did RunPod report this job as gone (HTTP 404 / numeric status 404 / "not found" title)? (#141)
 *  Same semantics as seedance: narration writes R2 only on COMPLETED, so a gone job has no artifact. */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: "gone-failed" past the grace window (or a legacy token); "gone-grace" inside it. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

export function mimeForFormat(format: SpeechFormat): string {
  if (format === "wav") return "audio/wav";
  if (format === "flac") return "audio/flac";
  return "audio/mpeg";
}

export function extForFormat(format: SpeechFormat): string {
  return format;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.job_id === "string" && typeof o.film_key === "string") {
      return {
        jobId: o.jobId,
        job_id: o.job_id,
        film_key: o.film_key,
        format: pickFormat(o.format),
        applied: Array.isArray(o.applied) ? o.applied : [],
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
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

// Cold-start cap: on a VIRGIN host the image pull (10-20GB) can outlive the normal #141 grace window
// while /status 404s, so the first-ever job on a fresh endpoint false-failed ("GC'd or never ran")
// and only the warm retry succeeded. When the endpoint's /health shows no worker has EVER come up,
// the 404 means "still initializing", not "dropped" -- keep polling up to this cap instead.
export const RUNPOD_COLD_GRACE_MS = 900_000; // 15 min; the film pipeline's 90-min deadline still bounds it

/** Pure: has NO worker ever come up on this endpoint (ready/idle/running all 0) while one is still
 *  coming (initializing/throttled > 0)? That is the virgin-host image pull. A dead endpoint (nothing
 *  up, nothing coming) returns false so a gone job still fails instead of pending forever. */
export function workersStillCold(health: unknown): boolean {
  if (!health || typeof health !== "object") return false;
  const w = (health as Record<string, unknown>).workers;
  if (!w || typeof w !== "object") return false;
  const n = (k: string): number => {
    const v = (w as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const up = n("ready") + n("idle") + n("running");
  const coming = n("initializing") + n("throttled");
  return up === 0 && coming > 0;
}

/** Pure: did the backend report a TERMINAL error inside `output` while the RunPod envelope status
 *  never advanced? (F17: a handler error path that returns instead of raising leaves the job
 *  IN_PROGRESS forever -- billing the worker -- while output already carries
 *  {status:"error", error:{stage, message}}.) Returns the human error string, or null when the
 *  output is a normal progress snapshot. */
export function terminalErrorInOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" && e.message.length > 0
      ? e.message
      : JSON.stringify(e).slice(0, 200);
    const stage = typeof e.stage === "string" && e.stage.length > 0 ? " (stage: " + e.stage + ")" : "";
    return msg + stage;
  }
  if (typeof err === "string" && err.length > 0) return err;
  if (o.status === "error") return "backend reported status=error with no error detail";
  return null;
}
