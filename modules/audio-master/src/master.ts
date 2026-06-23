// Pure audio-master logic: build the RunPod request body, derive the output key, parse the result,
// encode/decode the async poll token, and shape an honest soft-degrade passthrough. No I/O here -- so
// the contract is unit-tested without runtime or spend (mirrors finish-upscale/src/finish.ts).

import type { MasterInput, MasterOutput } from "./contract";

/** Passthrough MasterOutput that records WHY the bed went through unmastered, so a real failure
 *  (misconfig / backend down) is never indistinguishable from a legitimate no-op -- the silent-degrade
 *  bug of #77 / #249. A genuine degrade tags `applied` with `passthrough:<reason>` and sets `degraded`;
 *  the bed (audio_key) is carried through UNCHANGED -- a polish step never drops the film's audio. Pure. */
export function passthroughOutput(
  input: MasterInput,
  reason: string,
  opts: { detail?: string } = {},
): MasterOutput {
  return {
    audio_key: input.audio_key, // the input bed, unchanged -- never a dropped or fabricated key
    applied: [`passthrough:${reason}`],
    degraded: opts.detail ? `${reason}: ${opts.detail}` : reason,
  };
}

export interface MasterConfig {
  target_lufs: number; // integrated loudness target (LUFS); web streaming default -14
  upscale: boolean;    // music upscale: VHQ soxr resample to 48k + gentle high-shelf "air" lift
  format: "wav" | "mp3";
}

const FORMATS = ["wav", "mp3"] as const;
const LUFS_MIN = -24;
const LUFS_MAX = -9;

export function defaultConfig(): MasterConfig {
  return { target_lufs: -14, upscale: true, format: "wav" };
}

/** Clamp the user's config against the schema (the core already validates, but a module owns its own
 *  clamp so a hand-built request can never push the backend out of range). */
export function coerceConfig(cfg: Record<string, unknown>): MasterConfig {
  const base = defaultConfig();
  const lufsRaw = Number(cfg.target_lufs);
  const target_lufs = Number.isFinite(lufsRaw) ? Math.min(LUFS_MAX, Math.max(LUFS_MIN, lufsRaw)) : base.target_lufs;
  const format = (FORMATS as readonly string[]).includes(String(cfg.format)) ? (String(cfg.format) as "wav" | "mp3") : base.format;
  const upscale = cfg.upscale === undefined ? base.upscale : !!cfg.upscale;
  return { target_lufs, upscale, format };
}

/** The mastered bed lands beside the source with a `_mastered` suffix, so the original survives and the
 *  chain hands the new key downstream. `renders/p/audio/bed.wav` -> `renders/p/audio/bed_mastered.<fmt>`.
 *  The output extension follows the requested format (mastering may re-encode wav -> mp3). */
export function masteredKey(audioKey: string, format: "wav" | "mp3"): string {
  const slash = audioKey.lastIndexOf("/");
  const dot = audioKey.lastIndexOf(".");
  const base = dot > slash ? audioKey.slice(0, dot) : audioKey;
  return `${base}_mastered.${format}`;
}

/** The RunPod /run body for the dedicated vivijure-audio-master endpoint (R2 mode: it reads `audio_key`
 *  and writes `output_key` in the shared bucket itself, exactly as the finish endpoints do for clips). */
export function buildRunPodBody(input: MasterInput, cfg: MasterConfig): { input: Record<string, unknown> } {
  return {
    input: {
      audio_key: input.audio_key,
      output_key: masteredKey(input.audio_key, cfg.format),
      target_lufs: cfg.target_lufs,
      upscale: cfg.upscale,
      format: cfg.format,
      seconds: input.seconds,
    },
  };
}

// --- poll token (same shape + grace discipline as the finish modules) --------------------------

// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141). audioKey is
// carried so a GC'd / failed job can soft-degrade to the ORIGINAL bed (passthrough), never a drop.
export interface PollState {
  jobId: string;
  filmId: string;
  audioKey: string;
  submittedAt?: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.audioKey === "string") {
      return {
        jobId: o.jobId,
        filmId: typeof o.filmId === "string" ? o.filmId : "",
        audioKey: o.audioKey,
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

/** Pure: classify a gone job -- "gone-failed" past the grace window (or for a legacy token without
 *  submittedAt, where a 404 is a real GC not a fresh race); "gone-grace" while still inside it. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

/** What the vivijure-audio-master endpoint returns on completion (R2 mode). */
export interface BackendOutput {
  audio_key?: string;  // the mastered key (the handler echoes output_key here)
  applied?: string[];
}

export function parseBackendOutput(output: unknown): BackendOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  return {
    audio_key: typeof o.audio_key === "string" ? o.audio_key : undefined,
    applied: Array.isArray(o.applied) ? (o.applied as string[]) : [],
  };
}
