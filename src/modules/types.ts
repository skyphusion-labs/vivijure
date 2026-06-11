// The Vivijure module contract (vivijure-module/1).
//
// This is the typed boundary between the studio CORE and the opt-in MODULE workers that plug into
// it. The core invokes hooks; it does not know who answers. A module declares which hooks it serves
// (its manifest) and implements one invoke entry point. See docs/module-api.md for the full design.
//
// Keep this file dependency-free: it is the shared shape both the core and every module import, so
// it must stay portable (a module in another repo vendors this exact contract).

/** The contract version a module targets. Bumped only on a breaking change to these shapes. */
export const MODULE_API = "vivijure-module/1" as const;

/** The pipeline extension points. `pick one` hooks resolve to a single module; `chain` hooks run
 *  every installed module in `ui.order`, each consuming the previous output. */
export type HookName =
  | "motion.backend" // keyframe (+ motion prompt) -> shot clip. GPU or cloud, pick one per shot.
  | "finish"         // post-process a clip: interpolation / upscale / face restore. Chainable.
  | "score"          // add audio to a film: music / narration / beat-sync. Chainable.
  | "plan.enhance";  // expand a storyboard before render: LLM auto-direction. Chainable.

export const HOOK_NAMES: readonly HookName[] = [
  "motion.backend",
  "finish",
  "score",
  "plan.enhance",
];

/** Whether a hook resolves to one module or folds every installed module. */
export const HOOK_CARDINALITY: Record<HookName, "pick_one" | "chain"> = {
  "motion.backend": "pick_one",
  finish: "chain",
  score: "chain",
  "plan.enhance": "chain",
};

/** One-line description of each hook, for the self-assembling UI. Single source of truth: the
 *  frontend renders the hook panel from this (served via GET /api/modules), not a hardcoded copy. */
export const HOOK_BLURBS: Record<HookName, string> = {
  "motion.backend": "keyframe -> shot clip (GPU or cloud)",
  finish: "interpolation / upscale / face restore",
  score: "music / narration / beat-sync",
  "plan.enhance": "LLM auto-direction",
};

// --------------------------------------------------------------------------- manifest

/** One configurable knob a module exposes. The UI renders the control from this; the core clamps
 *  the user's value against it before invoking. One declaration, one hop, same words down. */
export type ConfigField =
  | {
      type: "int" | "float";
      default: number;
      min?: number;
      max?: number;
      label?: string;
      enum_labels?: Record<string, string>;
    }
  | { type: "bool"; default: boolean; label?: string }
  | { type: "enum"; values: string[]; default: string; label?: string }
  | { type: "string"; default: string; label?: string };

export type ConfigSchema = Record<string, ConfigField>;

/** A user-facing capability a module offers (a module may offer several). */
export interface Provides {
  id: string;
  label: string;
}

/** Hints for the self-assembling studio UI. */
export interface ModuleUi {
  section?: string; // which studio area the module surfaces in (e.g. "finish")
  icon?: string;
  order?: number; // fold/render order within a chain hook
}

/** A module's self-description, served at GET /module.json. */
export interface ModuleManifest {
  name: string; // unique module id
  version: string;
  api: typeof MODULE_API;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
}

// --------------------------------------------------------------------------- invocation

/** Per-job context the core passes to every invoke (never secrets). */
export interface InvokeContext {
  project: string;
  job_id: string;
  user_email?: string;
}

/** The single entry point the core calls on a module: POST /invoke. */
export interface InvokeRequest<I = unknown> {
  hook: HookName;
  input: I;
  config: Record<string, unknown>; // already validated against the module's config_schema
  context: InvokeContext;
}

/** A module failure is data, never an exception across the wire: the core degrades, it does not
 *  crash, when a module returns `ok: false`. */
export type InvokeResponse<O = unknown> =
  | { ok: true; output: O }
  | { ok: false; error: string };

// --------------------------------------------------------------------------- hook payloads

// finish (v1, the reference hook) ----------------------------------------------------------------

/** What the core hands a `finish` module: a rendered clip and what is known about it. */
export interface FinishInput {
  shot_id: string;
  clip_key: string; // R2 key of the input clip (mp4)
  src_fps: number;
  frames: number;
  width: number;
  height: number;
}

/** What a `finish` module returns: the processed clip plus what it did. Duration is invariant
 *  (interpolation changes fps + frame count, never length). */
export interface FinishOutput {
  shot_id: string;
  clip_key: string; // R2 key of the FINISHED clip (may equal the input if it no-op'd)
  out_fps: number;
  frames: number;
  applied: string[]; // e.g. ["interpolate:2x", "face_restore:gfpgan"]
}

// --------------------------------------------------------------------------- registry view

/** One registered module as the core exposes it to the frontend (the manifest minus internals). */
export interface RegisteredModule extends ModuleManifest {
  binding: string; // the env binding that serves it (e.g. "MODULE_FINISH_RIFE")
}

/** One hook in the catalog the frontend renders the pipeline panel from, so the panel is a
 *  projection of the contract rather than a hardcoded list. */
export interface HookCatalogEntry {
  name: HookName;
  blurb: string;
  cardinality: "pick_one" | "chain";
}

/** GET /api/modules: the merged registry the studio UI renders itself from. */
export interface ModulesResponse {
  api: typeof MODULE_API;
  modules: RegisteredModule[];
  hooks: Partial<Record<HookName, string[]>>; // hook -> module names serving it
  catalog: HookCatalogEntry[];                 // every hook (name + blurb + cardinality)
}
