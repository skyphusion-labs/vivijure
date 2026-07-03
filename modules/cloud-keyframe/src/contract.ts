// Vendored subset of the Vivijure module contract (vivijure-module/2) for the cloud-keyframe module.
// Matches src/modules/types.ts for the shapes used here. Dependency-free (a module in another repo
// vendors this exact contract).

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "keyframe" | "motion.backend" | "finish" | "score" | "plan.enhance" | "cast.image";

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

// keyframe payloads (vivijure-module/2). A PROJECT-level pass: one job renders every shot's start
// keyframe. The keyframes are written to R2 by the module; this reports their keys, the core presigns
// them for the motion.backend stage.
export interface KeyframeInput {
  project: string;     // project id; also the R2 key prefix the keyframes land under
  bundle_key: string;  // R2 key of the project bundle tarball (storyboard + cast portraits / refs)
  shot_ids?: string[]; // optional subset to (re)generate; omitted = every shot in the bundle
  /** slot -> R2 key of pretrained cast LoRAs. A GPUless module ignores this (no LoRA); it conditions
   *  on the cast PORTRAITS packed in the bundle instead. */
  pretrained_loras?: Record<string, string>;
}
export interface KeyframeShot {
  shot_id: string;
  keyframe_key: string; // R2 key of the PNG (renders/<project>/keyframes/<shot>.png)
}
export interface KeyframeOutput {
  project: string;
  keyframes: KeyframeShot[];
  /** slot -> R2 key of a cast LoRA trained/reused; a GPUless module trains none, so it omits this. */
  trained_loras?: Record<string, string>;
}
