// Vendored from src/modules/types.ts (vivijure-module/1). Copy only what this module needs so it
// stays independent of the core repo. Do not import from the core directly.

export const MODULE_API = "vivijure-module/1" as const;

export type HookName = "motion.backend" | "finish" | "score" | "plan.enhance";

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
}

export interface InvokeContext { project: string; job_id: string; user_email?: string; }

export interface InvokeRequest<I = unknown> {
  hook: HookName;
  input: I;
  config: Record<string, unknown>;
  context: InvokeContext;
}

export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: true; pending: true; poll: string }
  | { ok: false; error: string };

export interface PollRequest { poll: string; }

export type PollResponse<O = unknown> =
  | { ok: true; pending: true }
  | { ok: true; output: O }
  | { ok: false; error: string };

// FinishInput as the core sends it, PLUS the optional dialogue `audio_key` lipsync needs. The core
// populates `audio_key` per shot from the dialogue stage (TTS of the shot's line); shots with no
// dialogue (or no speaking character) arrive without it and lipsync no-ops (passthrough). When the
// core gains the per-shot dialogue model, this field lights up with zero change to this module.
export interface FinishInput {
  shot_id: string;
  clip_key: string;
  audio_key?: string;   // the shot's dialogue audio (TTS); absent => no dialogue => no-op passthrough
  src_fps: number;
  frames: number;
  width: number;
  height: number;
}

export interface FinishOutput {
  shot_id: string;
  clip_key: string;
  out_fps: number;
  frames: number;
  applied: string[];   // ["lipsync:v15"] on success; ["noop:no-dialogue"] / ["passthrough:<reason>"] otherwise
  degraded?: string;   // reason, set ONLY on a real passthrough degrade (never on success or the no-op)
}
