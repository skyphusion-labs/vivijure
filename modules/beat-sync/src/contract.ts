// Vendored subset of the Vivijure module contract (vivijure-module/1) for the beat-sync module.

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

export interface ScoreInput {
  film_key: string;
  seconds: number;
}

export interface ScoreOutput {
  film_key: string;
  applied: string[];
}

export interface TimedScene {
  index: number;
  start: number;
  end: number;
  targetSeconds: number;
}

export interface AudioBeatPlan {
  mode: "beat" | "duration";
  audioKey: string;
  durationSeconds: number;
  bpm?: number;
  beatCount?: number;
  suggestedShots: number;
  clipSeconds: number;
  filmSeconds: number;
  remainderSeconds: number;
  timedScenes: TimedScene[];
  note: string;
}

/** Beat analysis attaches the plan on the score output for the planner analyze route. */
export interface BeatSyncOutput extends ScoreOutput {
  beat_plan?: AudioBeatPlan;
}
