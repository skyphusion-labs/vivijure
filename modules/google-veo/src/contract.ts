// Vendored subset of the Vivijure module contract (vivijure-module/2) for the google-veo module.
// Matches src/modules/types.ts for the shapes used here. Dependency-free.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "motion.backend" | "finish" | "score" | "plan.enhance";

export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string> }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "enum"; values: string[]; default: string; label?: string }
  | { type: "string"; default: string; label?: string };

export type ConfigSchema = Record<string, ConfigField>;

export interface Provides { id: string; label: string; }
export interface ModuleUi { section?: string; icon?: string; order?: number; locality?: "local" | "byo" | "cloud"; cost?: string; blurb?: string; limits?: string[]; }

export interface ModuleManifest {
  name: string;
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
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
  | { ok: true; pending: true; poll: string }
  | { ok: false; error: string };

export interface PollRequest {
  poll: string;
}
export type PollResponse<O = unknown> =
  | { ok: true; pending: true }
  | { ok: true; output: O }
  | { ok: false; error: string };

// motion.backend payloads (vivijure-module/2). keyframe_url is the presigned, fetchable URL of the
// start keyframe (the core presigns the private R2 object so a cloud backend can pull it).
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
}
