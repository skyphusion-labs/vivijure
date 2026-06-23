// Pure audio-master logic: clamp the config, build the CPU container request body, parse the container
// response, and shape an honest soft-degrade passthrough. No I/O here -- so the contract is unit-tested
// without runtime or spend (mirrors finish-upscale/src/finish.ts and subtitle/src/subtitle.ts).

import type { MasterInput, MasterOutput } from "./contract";

/** Passthrough MasterOutput that records WHY the bed went through unmastered, so a real failure
 *  (misconfig / container down) is never indistinguishable from a legitimate no-op -- the silent-degrade
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
 *  clamp so a hand-built request can never push the container out of range). */
export function coerceConfig(cfg: Record<string, unknown>): MasterConfig {
  const base = defaultConfig();
  const lufsRaw = Number(cfg.target_lufs);
  const target_lufs = Number.isFinite(lufsRaw) ? Math.min(LUFS_MAX, Math.max(LUFS_MIN, lufsRaw)) : base.target_lufs;
  const format = (FORMATS as readonly string[]).includes(String(cfg.format)) ? (String(cfg.format) as "wav" | "mp3") : base.format;
  const upscale = cfg.upscale === undefined ? base.upscale : !!cfg.upscale;
  return { target_lufs, upscale, format };
}

/** The POST /master body for the audio-master CPU container (Workers VPC). The core presigns the bed GET
 *  (audio_url) and the mastered PUT (output_url) and owns the output_key; this module just forwards them
 *  with the clamped knobs. The container downloads audioUrl, masters, and PUTs to outputUrl. */
export interface MasterBody {
  audioUrl: string;
  outputUrl: string;
  outputKey: string;
  targetLufs: number;
  upscale: boolean;
  format: "wav" | "mp3";
}

export function buildMasterBody(input: MasterInput, cfg: MasterConfig): MasterBody {
  return {
    audioUrl: input.audio_url,
    outputUrl: input.output_url,
    outputKey: input.output_key,
    targetLufs: cfg.target_lufs,
    upscale: cfg.upscale,
    format: cfg.format,
  };
}

/** What the audio-master container returns on success (the POST /master JSON). The container reports
 *  STRUCTURED facts (it did/did not upscale, the loudness target it hit); the module composes the honest
 *  `applied` tags from them rather than trusting the request flags (mirrors subtitle's burned/sidecar). */
export interface MasterContainerResult {
  ok: boolean;
  key?: string;
  bytes?: number;
  format?: string;
  durationSeconds?: number;
  lufs?: number;
  loudnessTargetLufs?: number;
  upscaled?: boolean;
}

export function parseContainerResult(body: unknown): MasterContainerResult | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  return {
    ok: o.ok === true,
    key: typeof o.key === "string" ? o.key : undefined,
    bytes: typeof o.bytes === "number" ? o.bytes : undefined,
    format: typeof o.format === "string" ? o.format : undefined,
    durationSeconds: typeof o.durationSeconds === "number" ? o.durationSeconds : undefined,
    lufs: typeof o.lufs === "number" ? o.lufs : undefined,
    loudnessTargetLufs: typeof o.loudnessTargetLufs === "number" ? o.loudnessTargetLufs : undefined,
    upscaled: typeof o.upscaled === "boolean" ? o.upscaled : undefined,
  };
}

/** Compose the MasterOutput from a SUCCESSFUL container result. `applied` is built from what the
 *  container ACTUALLY did: a "music-upscale:soxr48k" tag only when it upscaled, then the loudnorm tag at
 *  the target it hit -- the same honest #77 record the old RunPod handler emitted. The mastered key
 *  (res.key, echoed from output_key) becomes the carried audio_key. */
export function masterOutputFromResult(input: MasterInput, res: MasterContainerResult): MasterOutput {
  const applied: string[] = [];
  if (res.upscaled) applied.push("music-upscale:soxr48k");
  const target = typeof res.loudnessTargetLufs === "number" ? res.loudnessTargetLufs : undefined;
  applied.push(target !== undefined ? `loudnorm:${target}LUFS` : "loudnorm");
  return {
    audio_key: res.key && res.key.length > 0 ? res.key : input.output_key,
    applied,
  };
}
