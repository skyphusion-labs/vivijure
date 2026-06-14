// Pure finish-rife logic: build the RunPod request body, parse the result, encode/decode the
// async poll token. No I/O here -- unit-tests without runtime or spend.

import type { FinishInput } from "./contract";

export interface FinishConfig {
  interpolate: boolean;
  interpolation_factor: number;
  face_restore: string;   // "none" | "gfpgan" | "codeformer"
  face_fidelity: number;
  only_faces: boolean;
}

export function defaultConfig(): FinishConfig {
  return { interpolate: true, interpolation_factor: 2, face_restore: "none", face_fidelity: 0.7, only_faces: true };
}

export function coerceConfig(cfg: Record<string, unknown>): FinishConfig {
  const base = defaultConfig();
  const factor = Number(cfg.interpolation_factor ?? base.interpolation_factor);
  // snap to nearest power of two in {1,2,4,8}
  const snapped = [1, 2, 4, 8].reduce((best, v) => Math.abs(v - factor) < Math.abs(best - factor) ? v : best, 2);
  return {
    interpolate: typeof cfg.interpolate === "boolean" ? cfg.interpolate : base.interpolate,
    interpolation_factor: snapped,
    face_restore: ["none", "gfpgan", "codeformer"].includes(String(cfg.face_restore)) ? String(cfg.face_restore) : base.face_restore,
    face_fidelity: Math.min(1, Math.max(0, Number(cfg.face_fidelity ?? base.face_fidelity))),
    only_faces: typeof cfg.only_faces === "boolean" ? cfg.only_faces : base.only_faces,
  };
}

/** The RunPod /run body for vivijure-backend action="finish_clip". */
export function buildRunPodBody(input: FinishInput, cfg: FinishConfig): { input: Record<string, unknown> } {
  return {
    input: {
      action: "finish_clip",
      project: "finish-rife",   // placeholder project; output key uses shot_id
      shot_id: input.shot_id,
      clip_key: input.clip_key,
      config: {
        interpolate: cfg.interpolate,
        interpolation_factor: cfg.interpolation_factor,
        face_restore: cfg.face_restore === "none" ? false : cfg.face_restore,
        face_fidelity: cfg.face_fidelity,
        only_faces: cfg.only_faces,
      },
    },
  };
}

// --- poll token -------------------------------------------------------------------------------

export interface PollState {
  jobId: string;
  shotId: string;
  srcFps: number;
  frames: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.shotId === "string") {
      return { jobId: o.jobId, shotId: o.shotId, srcFps: Number(o.srcFps) || 16, frames: Number(o.frames) || 0 };
    }
  } catch { /* fall through */ }
  return null;
}

/** What the vivijure-backend finish_clip action returns on completion. */
export interface BackendOutput {
  shot_id?: string;
  clip_key?: string;
  out_fps?: number;
  frames?: number;
  applied?: string[];
}

export function parseBackendOutput(output: unknown): BackendOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  return {
    shot_id: typeof o.shot_id === "string" ? o.shot_id : undefined,
    clip_key: typeof o.clip_key === "string" ? o.clip_key : undefined,
    out_fps: typeof o.out_fps === "number" ? o.out_fps : undefined,
    frames: typeof o.frames === "number" ? o.frames : undefined,
    applied: Array.isArray(o.applied) ? (o.applied as string[]) : [],
  };
}
