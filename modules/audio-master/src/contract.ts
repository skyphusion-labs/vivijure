// Vendored from src/modules/types.ts (vivijure-module/2). Copy only what this module needs so it
// stays independent of the core repo. Do not import from the core directly.

export const MODULE_API = "vivijure-module/2" as const;

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

// master (v1) -----------------------------------------------------------------------------------

// The core hands the assembled bed and PRESIGNED URLs (it owns the R2 S3 creds; this module stays
// credentialless and forwards the URLs to the CPU container over Workers VPC), mirroring the subtitle /
// film.finish modules ("the core presigns the GET + the result PUT"). audio_key / output_key are the R2
// keys behind those URLs (identity + the key the core gets back); the container never sees R2 creds.
export interface MasterInput {
  film_id: string;     // the film this bed belongs to (output-key convention + logs)
  audio_key: string;   // R2 key of the assembled audio bed (the mix to master)
  audio_url: string;   // presigned GET of the assembled bed (the container downloads it)
  output_url: string;  // presigned PUT for the mastered bed (the container uploads it)
  output_key: string;  // the R2 key behind output_url (returned to the core)
  seconds?: number;    // film length hint, if known (the backend probes the bed if absent)
}

export interface MasterOutput {
  audio_key: string;   // R2 key of the MASTERED bed (may equal the input if it passed through)
  applied: string[];   // ["music-upscale:soxr48k", "loudnorm:-14LUFS"] on success; ["passthrough:<reason>"] otherwise
  degraded?: string;   // reason, set ONLY on a real passthrough degrade (never on success); see #77
}
