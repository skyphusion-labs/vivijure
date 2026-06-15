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
  | "keyframe"       // storyboard -> start keyframes (SDXL on GPU). Project-level pass, pick one.
  | "motion.backend" // keyframe (+ motion prompt) -> shot clip. GPU or cloud, pick one per shot.
  | "finish"         // post-process a clip: interpolation / upscale / face restore. Chainable.
  | "score"          // add audio to a film: music / narration / beat-sync. Chainable.
  | "plan.enhance";  // expand a storyboard before render: LLM auto-direction. Chainable.

export const HOOK_NAMES: readonly HookName[] = [
  "keyframe",
  "motion.backend",
  "finish",
  "score",
  "plan.enhance",
];

/** Whether a hook resolves to one module or folds every installed module. */
export const HOOK_CARDINALITY: Record<HookName, "pick_one" | "chain"> = {
  keyframe: "pick_one",
  "motion.backend": "pick_one",
  finish: "chain",
  score: "chain",
  "plan.enhance": "chain",
};

/** One-line description of each hook, for the self-assembling UI. Single source of truth: the
 *  frontend renders the hook panel from this (served via GET /api/modules), not a hardcoded copy. */
export const HOOK_BLURBS: Record<HookName, string> = {
  keyframe: "storyboard -> start keyframes (SDXL)",
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
  | { ok: true; output: O }                       // synchronous: the work is done
  | { ok: true; pending: true; poll: string }     // async: accepted; POST /poll with this token
  | { ok: false; error: string };

/** Body POSTed to a long-running module's `/poll` to check an async job. */
export interface PollRequest {
  poll: string;
}

/** A module's `/poll` response: still running, finished, or failed. The caller polls until it is no
 *  longer pending, so a Worker never holds one long-running `/invoke` request open. */
export type PollResponse<O = unknown> =
  | { ok: true; pending: true }                   // still running, poll again
  | { ok: true; output: O }                       // finished
  | { ok: false; error: string };

// --------------------------------------------------------------------------- hook payloads

// finish (v1, the reference hook) ----------------------------------------------------------------

/** What the core hands a `finish` module: a rendered clip and what is known about it. The clip is
 *  self-describing (a finish backend probes it), so the shape hints below are OPTIONAL -- the core
 *  passes them when it has them, but a finish module must not require them. */
export interface FinishInput {
  shot_id: string;
  clip_key: string;  // R2 key of the input clip (mp4)
  src_fps?: number;  // optional hints; the finish backend probes the clip if absent
  frames?: number;
  width?: number;
  height?: number;
}

/** What a `finish` module returns: the processed clip plus what it did. Duration is invariant
 *  (interpolation changes fps + frame count, never length). */
export interface FinishOutput {
  shot_id: string;
  clip_key: string; // R2 key of the FINISHED clip (may equal the input if it no-op'd)
  out_fps: number;
  frames: number;
  applied: string[]; // e.g. ["interpolate:2x", "face_restore:gfpgan"]; or ["passthrough:<reason>"] / ["noop:nothing-enabled"]
  degraded?: string; // set ONLY when the clip was passed through because the finish could not run
                     // (misconfig / backend down), carrying the reason; absent on success and on
                     // the intentional no-op, so a real degrade is never silent (finish-rife #77)
}

// plan.enhance (v1) -----------------------------------------------------------------------------

/** What the core hands a `plan.enhance` module: the storyboard to enrich (its scenes carry the shot
 *  prompts the module rewrites) plus the original brief for context. Structural passthrough -- a
 *  module rewrites scenes[].prompt and preserves every other field on the storyboard and scenes. */
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

/** What a `plan.enhance` module returns: the enriched storyboard plus optional human-readable notes
 *  on what it did (or why it passed through unchanged). */
export interface PlanEnhanceOutput {
  storyboard: PlanEnhanceStoryboard;
  notes?: string[];
}

// keyframe (v1) ---------------------------------------------------------------------------------

/** What the core hands a `keyframe` module: a project bundle to render START keyframes from. This
 *  is a PROJECT-level pass, not per-shot -- the GPU backend trains/reuses cast LoRAs once and emits
 *  every shot's keyframe in one job. A per-shot module would re-submit (and risk re-training the
 *  LoRA) on every shot = GPU waste; the project pass keeps GPU spend to genuinely GPU-bound work.
 *  The clip orchestrator (motion.backend) then animates each keyframe per shot. */
export interface KeyframeInput {
  project: string;     // project id; also the R2 key prefix the keyframes land under
  bundle_key: string;  // R2 key of the project bundle tarball (storyboard + cast refs / LoRAs)
  shot_ids?: string[]; // optional subset to (re)generate; omitted = every shot in the bundle
}
/** One generated start keyframe, already stored in R2 by the backend. */
export interface KeyframeShot {
  shot_id: string;
  keyframe_key: string; // R2 key of the PNG (renders/<project>/keyframes/<shot>.png)
}
/** What a `keyframe` module returns: every keyframe it generated, by shot. The core presigns each
 *  key into a fetchable keyframe_url when it hands them on to the motion.backend orchestrator. */
export interface KeyframeOutput {
  project: string;
  keyframes: KeyframeShot[];
}

// motion.backend (v1, forward-declared) ---------------------------------------------------------

/** What the core hands a `motion.backend` module for ONE shot: a start keyframe and the motion
 *  intent. The module turns it into a clip (on GPU or via a cloud i2v API). */
export interface MotionBackendInput {
  shot_id: string;
  keyframe_url: string;  // presigned, fetchable URL of the start keyframe (the core presigns private R2)
  keyframe_key?: string; // the underlying R2 key, for reference
  prompt: string;        // the motion prompt for the shot
  seconds: number;
}
/** What a `motion.backend` module returns: the rendered shot clip. */
export interface MotionBackendOutput {
  shot_id: string;
  clip_key: string;     // R2 key of the rendered clip (mp4)
  fps: number;
  frames: number;
}

// score (v1, forward-declared) ------------------------------------------------------------------

/** What the core hands a `score` module: the assembled (silent) film and its shape, plus optional
 *  storyboard context for mood/tempo. */
export interface ScoreInput {
  film_key: string;     // R2 key of the silent film (mp4)
  seconds: number;
  storyboard?: PlanEnhanceStoryboard;
}
/** What a `score` module returns: the film with audio applied (or muxed), and what it added. */
export interface ScoreOutput {
  film_key: string;     // R2 key of the scored film (mp4)
  applied: string[];    // e.g. ["music:minimax", "narration:tts"]
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
