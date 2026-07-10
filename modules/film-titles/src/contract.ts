// Vendored from src/modules/types.ts (vivijure-module/2). Copy only what this module needs so it
// stays independent of the core repo. Do not import from the core directly.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "motion.backend" | "finish" | "score" | "plan.enhance" | "film.finish";

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

// film.finish input (vivijure-module/2). The core hands the assembled+muxed film and PRESIGNED URLs
// (the core owns the R2 S3 creds; the module stays credentialless and just forwards to the container).
// title / credits are the film-specific TEXT; style/timing knobs live in the module config_schema.
export interface FilmTitleSpec { text: string; subtitle?: string; }
export interface FilmCreditSpec { lines: string[]; }
export interface FilmFinishInput {
  film_key: string;        // the assembled film R2 key (identity / output naming)
  video_url: string;       // presigned GET of the film (the container downloads it)
  output_url: string;      // presigned PUT for the result (the container uploads it)
  output_key: string;      // the R2 key behind output_url (returned to the core)
  width?: number;
  height?: number;
  fps?: number;
  title?: FilmTitleSpec;   // opening title card; absent -> no title card
  credits?: FilmCreditSpec; // end credit card; absent -> no credit card
}

// film.finish output: the (possibly new) film R2 key + what ran. film_key is invariant in identity
// terms but points at the carded film when cards were applied.
export interface FilmFinishOutput {
  film_key: string;
  applied: string[];
  degraded?: string;
  // Seconds this module prepended to the FRONT of the film (a title card); the core shifts an earlier
  // film.finish .srt sidecar by this so soft subtitles match the final film (#663). Absent / 0 => none.
  prepend_seconds?: number;
}
