// Vendored subset of the Vivijure module contract (vivijure-module/2) for the local-gpu module.
// Matches vivijure/src/modules/types.ts for the shapes used here. Dependency-free, so this module
// stays independent of the core repo (a module vendors its own copy of the contract).

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "motion.backend" | "keyframe" | "finish" | "score" | "plan.enhance";

export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string>; scope?: "render" | "install" }
  | { type: "bool"; default: boolean; label?: string; scope?: "render" | "install" }
  | { type: "enum"; values: string[]; default: string; label?: string; scope?: "render" | "install" }
  | { type: "string"; default: string; label?: string; scope?: "render" | "install" };

export type ConfigSchema = Record<string, ConfigField>;

export interface Provides {
  id: string;
  label: string;
}
export interface ModuleUi { section?: string; icon?: string; order?: number; locality?: "local" | "byo" | "cloud"; cost?: string; blurb?: string; limits?: string[]; }

export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
  /** Advertise POST /cancel so the core can stop an in-flight job rather than orphan the GPU. */
  cancelable?: boolean;
  /** OPTIONAL, additive: a fixed duration grid (pinned fps + per-tier frame caps) RELAYED from the
   *  backend's /health, so core preflight can warn about duration clamping at storyboard time (#707).
   *  Omitted when the backend declares none or is unreachable -- absence is honest, never fabricated. */
  duration_grid?: DurationGridDecl;
}

/** A fixed duration grid (#707): pinned output fps + per-quality-tier frame ceilings; a tier's
 *  maximum deliverable seconds = max_frames / fps. */
export interface DurationGridDecl {
  fps: number;
  tiers: Record<string, { max_frames: number }>;
}

export interface InvokeContext {
  project: string;
  job_id: string;
}

export interface InvokeRequest<I = unknown> {
  hook: HookName;
  input: I;
  config: Record<string, unknown>;
  context: InvokeContext;
}

// A module may answer synchronously (output) or, for a long-running job, asynchronously: return
// pending + a poll token, and the caller drives /poll until it is done. jobId (optional/additive) is
// the backend job id, surfaced so the core can read sub-phase progress; omitted here (the local
// backend reports its own progress to R2, like vivijure-backend's ProgressEmitter).
export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: true; pending: true; poll: string; jobId?: string }
  | { ok: false; error: string };

export interface PollRequest {
  poll: string;
}
export type PollResponse<O = unknown> =
  | { ok: true; pending: true }
  | { ok: true; output: O }
  | { ok: false; error: string };

// Body POSTed to /cancel to STOP an in-flight async job, identified by the same poll token /invoke
// returned. The module decodes it to ITS backend job id and cancels with ITS OWN creds.
export interface CancelRequest {
  poll: string;
}
// Best-effort + idempotent: cancelling an already-terminal or unknown job is a success (ok:true), so
// the core reads ok:true as "this job will not keep running". A module that cannot cancel returns
// ok:false with a reason, and the core degrade-LOGS the orphan rather than hiding it.
export type CancelResponse = { ok: true } | { ok: false; error: string };

// motion.backend payloads (vivijure-module/2). keyframe_url is the presigned, fetchable URL of the
// start keyframe (for cloud backends that pull over the internet); keyframe_key is the underlying R2
// key (a backend that shares the bucket reads it directly).
export interface MotionBackendInput {
  shot_id: string;
  keyframe_url: string;
  keyframe_key?: string;
  prompt: string;
  seconds: number;
}
export interface MotionBackendOutput {
  shot_id: string;
  clip_key: string;
  fps: number;
  frames: number;
  /** When the local backend reports tier honesty (12gb final distilled:true, 16gb distilled:false). */
  distilled?: boolean;
}
