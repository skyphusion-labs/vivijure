// Vendored subset of the Vivijure module contract (vivijure-module/2) for the keyframe module.
// Matches src/modules/types.ts for the shapes used here. Dependency-free.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "keyframe" | "motion.backend" | "finish" | "score" | "plan.enhance";

export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string> }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "enum"; values: string[]; default: string; label?: string }
  | { type: "string"; default: string; label?: string };

export type ConfigSchema = Record<string, ConfigField>;

export interface Provides { id: string; label: string; }
export interface ModuleUi { section?: string; icon?: string; order?: number; }

export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
  /** This module implements POST /cancel (it is async + GPU-backed), so the core can stop an in-flight
   *  RunPod job instead of orphaning it. OPTIONAL/additive, mirrors src/modules/types.ts. */
  cancelable?: boolean;
  /** #454: compact display token for the keyframe-stage backend/model (e.g. "SDXL"), which the planner
   *  projects inline. OPTIONAL/additive, mirrors src/modules/types.ts. */
  keyframe_label?: string;
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
// pending + a poll token, and the caller drives /poll until it is done.
export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: true; pending: true; poll: string; jobId?: string } // jobId: optional/additive (#318) -- backend RunPod job id for the progress snapshot read; no MODULE_API bump
  | { ok: false; error: string };

export interface PollRequest {
  poll: string;
}
export type PollResponse<O = unknown> =
  | { ok: true; pending: true }
  | { ok: true; output: O }
  | { ok: false; error: string };

// POST /cancel: stop the in-flight RunPod job named by this poll token. The module decodes the token to
// its RunPod job id and cancels with its own key+endpoint. Best-effort + idempotent (an already-terminal
// or unknown job is a success), so the core can treat ok:true as "not running on our account" (#327/#328).
export interface CancelRequest {
  poll: string;
}
export type CancelResponse =
  | { ok: true }
  | { ok: false; error: string };

// keyframe payloads (vivijure-module/2). A PROJECT-level pass: one job renders every shot's start
// keyframe (the GPU backend trains/reuses cast LoRAs once), so it is NOT per-shot. The keyframes
// are written to R2 by the backend; this module reports their keys, the core presigns them.
export interface KeyframeInput {
  project: string;
  bundle_key: string;
  shot_ids?: string[];
  pretrained_loras?: Record<string, string>;
}
export interface KeyframeShot {
  shot_id: string;
  keyframe_key: string;
}
export interface KeyframeOutput {
  project: string;
  keyframes: KeyframeShot[];
  /** slot -> R2 key of the cast LoRA this render trained or reused; the core records a freshly
   *  trained adapter back onto the cast member so it is reused across projects. Optional. */
  trained_loras?: Record<string, string>;
}
