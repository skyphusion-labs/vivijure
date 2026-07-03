// Vendored subset of the Vivijure module contract (vivijure-module/2).
//
// A module vendors the contract so it stays independent of the core's repo (the design intent: a
// module in another repo ships its own copy of these shapes). This is the minimal slice the
// plan-enhance module needs; it matches src/modules/types.ts in the core for every shape it uses.
// Keep dependency-free.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "motion.backend" | "finish" | "score" | "plan.enhance";

export type ConfigField =
  | { type: "int" | "float"; default: number; min?: number; max?: number; label?: string; enum_labels?: Record<string, string> }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "enum"; values: string[]; default: string; label?: string }
  | { type: "string"; default: string; label?: string };

export type ConfigSchema = Record<string, ConfigField>;

export interface Provides {
  id: string;
  label: string;
}

export interface ModuleUi {
  section?: string;
  icon?: string;
  order?: number;
}

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

export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: false; error: string };

// plan.enhance payloads (vivijure-module/2). The storyboard is passed through structurally: the
// module reads + rewrites scenes[].prompt and preserves every other field on the storyboard and on
// each scene.
export interface PlanEnhanceScene {
  prompt: string;
  [k: string]: unknown;
}
export interface PlanEnhanceStoryboard {
  scenes: PlanEnhanceScene[];
  [k: string]: unknown;
}
export interface PlanEnhanceInput {
  storyboard: PlanEnhanceStoryboard;
  brief?: string;
}
export interface PlanEnhanceOutput {
  storyboard: PlanEnhanceStoryboard;
  notes?: string[];
}
