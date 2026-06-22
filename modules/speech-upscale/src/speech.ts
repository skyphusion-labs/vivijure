// Pure speech-upscale logic: config, the enhanced-audio key, the RunPod request body, the result
// parse, and the async poll token. No I/O here -- unit-tests without runtime or spend.

import type { SpeechInput, SpeechOutput } from "./contract";

/** Passthrough SpeechOutput: the INPUT audio passes through unchanged. This is a polish step -- a
 *  disabled toggle, a missing endpoint, or an endpoint failure must NEVER fail the chain and must
 *  NEVER fake the `applied` success tag (#249/#77). `applied` stays empty (nothing applied) and
 *  `degraded` carries the honest reason. Pure: no I/O. */
export function passthroughOutput(
  input: { shot_id: string; audio_key: string },
  reason: string,
  detail?: string,
): SpeechOutput {
  return {
    shot_id: input.shot_id,
    audio_key: input.audio_key,   // original audio passed through -- lip-sync uses it unchanged
    applied: [],                  // nothing applied -- no fake speech-upscale tag
    degraded: detail ? `${reason}: ${detail}` : reason,
  };
}

export interface SpeechUpscaleConfig {
  enable: boolean;   // opt-in toggle (default false): the speech chain runs this step but no-ops unless on
  denoise: boolean;  // optional extra denoise pass before the enhance
}

export function defaultConfig(): SpeechUpscaleConfig {
  return { enable: false, denoise: false };
}

export function coerceConfig(cfg: Record<string, unknown>): SpeechUpscaleConfig {
  return {
    enable: cfg.enable === true,
    denoise: cfg.denoise === true,
  };
}

/** The enhanced audio lands beside the source with an `_enh.wav` suffix (the endpoint always writes
 *  wav), so the original survives. `renders/p/dialogue/shot.wav` -> `..._enh.wav`. Mirrors the
 *  vivijure-audio-upscale handler's own default output-key derivation. */
export function enhancedAudioKey(audioKey: string): string {
  const slash = audioKey.lastIndexOf("/");
  const dot = audioKey.lastIndexOf(".");
  return dot > slash ? `${audioKey.slice(0, dot)}_enh.wav` : `${audioKey}_enh.wav`;
}

/** The RunPod /run body for the dedicated vivijure-audio-upscale endpoint (R2 mode: it reads
 *  `audio_key` and writes `output_key` in the shared bucket itself). `audio_key` is guaranteed present
 *  by the caller (submit rejects malformed input). */
export function buildRunPodBody(input: SpeechInput, cfg: SpeechUpscaleConfig): { input: Record<string, unknown> } {
  return {
    input: {
      audio_key: input.audio_key,
      output_key: enhancedAudioKey(input.audio_key),
      denoise: cfg.denoise,
    },
  };
}

// --- poll token (carries the INPUT audio_key so the stateless /poll can pass it through on a
// soft-degrade, plus submittedAt for the GC grace window #141) -----------------------------------

export interface PollState {
  jobId: string;
  shotId: string;
  audioKey: string;   // the INPUT audio, passed through unchanged on a poll-time soft-degrade
  submittedAt?: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.shotId === "string" && typeof o.audioKey === "string") {
      return {
        jobId: o.jobId, shotId: o.shotId, audioKey: o.audioKey,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch { /* fall through */ }
  return null;
}

// How long after submit a RunPod "job not found" is treated as a propagation race vs a real GC.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did RunPod report this job as gone? A GC'd job returns HTTP 404 with a body like
 *  {"status":404,...} where `status` is the NUMBER 404, not a run state. (#141) */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: classify a gone job -- "gone-failed" past the grace window (or a legacy token without
 *  submittedAt, where a 404 is a real GC not a fresh race); "gone-grace" while still inside it. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

/** What the vivijure-audio-upscale endpoint returns on completion (R2 mode): the enhanced audio key
 *  (echoed as `output_key`), the sample rate, and the `applied` tag. */
export interface BackendOutput {
  output_key?: string;
  sr?: number;
  applied?: string[];
}

export function parseBackendOutput(output: unknown): BackendOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  return {
    output_key: typeof o.output_key === "string" ? o.output_key : undefined,
    sr: typeof o.sr === "number" ? o.sr : undefined,
    applied: Array.isArray(o.applied) ? (o.applied as string[]) : undefined,
  };
}

/** Build the SUCCESS SpeechOutput: the ENHANCED audio key + the real `applied` tag. Never `degraded`. */
export function successOutput(st: PollState, out: BackendOutput): SpeechOutput {
  return {
    shot_id: st.shotId,
    audio_key: out.output_key as string,
    applied: out.applied && out.applied.length ? out.applied : ["speech-upscale:resemble-enhance"],
  };
}
