// Vendored from src/modules/types.ts (vivijure-module/1). Copy only what this module needs so it
// stays independent of the core repo. Do not import from the core directly.

export const MODULE_API = "vivijure-module/1" as const;

export type HookName = "master" | "score" | "finish";

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

// master (v1) -----------------------------------------------------------------------------------

export interface MasterInput {
  film_id: string;     // the film this bed belongs to (output-key convention + logs)
  audio_key: string;   // R2 key of the assembled audio bed (the mix to master)
  seconds?: number;    // film length hint, if known (the backend probes the bed if absent)
}

export interface MasterOutput {
  audio_key: string;   // R2 key of the MASTERED bed (may equal the input if it passed through)
  applied: string[];   // ["music-upscale:soxr48k", "loudnorm:-14LUFS"] on success; ["passthrough:<reason>"] otherwise
  degraded?: string;   // reason, set ONLY on a real passthrough degrade (never on success); see #77
}
