// Vendored subset of the Vivijure module contract (vivijure-module/1) for the music-gen module.

export const MODULE_API = "vivijure-module/1" as const;

export type HookName = "score";

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

export interface PlanEnhanceScene {
  prompt: string;
  [k: string]: unknown;
}
export interface PlanEnhanceStoryboard {
  scenes: PlanEnhanceScene[];
  [k: string]: unknown;
}

export interface ScoreInput {
  film_key: string;
  seconds: number;
  storyboard?: PlanEnhanceStoryboard;
}

export interface ScoreOutput {
  film_key: string;
  applied: string[];
}
