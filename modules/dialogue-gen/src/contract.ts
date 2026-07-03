// Vendored subset of the Vivijure module contract (vivijure-module/2) for the dialogue-gen module.
// Modules vendor this file; they never import the core. Keep it dependency-free.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "dialogue";

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

export interface InvokeContext { project: string; job_id: string; }
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

// One spoken line for one shot. `voice_id` is the cast member's assigned Aura-1 speaker; absent or
// unknown falls back to the default speaker at synth time (the core resolves slot -> cast -> voice).
export interface DialogueLine {
  shot_id: string;
  text: string;
  voice_id?: string;
}

// The core sends every speaking shot in ONE batch so a film's dialogue is a single submit+poll, not
// N module round-trips. `project` is the R2 key prefix the per-shot audio lands under.
export interface DialogueInput {
  project: string;
  lines: DialogueLine[];
}

// One synthesized line: the R2 key of its audio and the voice actually used (post-fallback), so the
// core can attach audio_key to the shot's FinishInput and a caller can see which speaker spoke.
export interface DialogueShotAudio {
  shot_id: string;
  audio_key: string;
  voice_id: string;
}

export interface DialogueOutput {
  project: string;
  audio: DialogueShotAudio[];
  applied: string[];
}
