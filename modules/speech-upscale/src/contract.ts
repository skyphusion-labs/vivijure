// Vendored from src/modules/types.ts (vivijure-module/2). Copy only what this module needs so it
// stays independent of the core repo. Do not import from the core directly.
//
// speech-upscale is a `speech`-hook module: it enhances ONE shot's dialogue audio (audio_key in ->
// enhanced audio_key out). The speech chain runs between the dialogue (TTS) phase and the finish
// phase, so finish-lipsync (MuseTalk) drives off the cleaned audio. Pure audio -- no clip, no video.

export const MODULE_API = "vivijure-module/2" as const;

export type HookName = "motion.backend" | "dialogue" | "speech" | "finish" | "score" | "plan.enhance";

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

/** What the core hands a `speech` module: ONE shot's dialogue audio to enhance. Minimal -- the audio
 *  is self-describing, and speech operates purely on audio (no clip). */
export interface SpeechInput {
  shot_id: string;
  audio_key: string;  // R2 key of the shot's dialogue audio (from job.dialogue_audio[shot_id])
}

/** What a `speech` module returns: the (maybe enhanced) dialogue audio plus what it did. On success
 *  `audio_key` is the ENHANCED key and `applied` carries the real tag; on a soft-degrade the INPUT key
 *  passes through unchanged, `applied` is empty (no fake tag), and `degraded` carries the reason. */
export interface SpeechOutput {
  shot_id: string;
  audio_key: string;
  applied: string[];
  degraded?: string;
}
