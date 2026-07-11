// The Vivijure module contract (vivijure-module/2).
//
// This is the typed boundary between the studio CORE and the opt-in MODULE workers that plug into
// it. The core invokes hooks; it does not know who answers. A module declares which hooks it serves
// (its manifest) and implements one invoke entry point. See docs/module-api.md for the full design.
//
// Keep this file dependency-free: it is the shared shape both the core and every module import, so
// it must stay portable (a module in another repo vendors this exact contract).

/** The contract version a module targets. Bumped only on a breaking change to these shapes. */
export const MODULE_API = "vivijure-module/2" as const;
// Contract versions the host + conformance ACCEPT. The host is /2 (the identity strip dropped the
// legacy per-operator identity field from NotifyInput + InvokeContext -- a breaking narrowing for a
// consumer that read it, so change-control bumps the version). /1 is accepted TRANSITIONALLY so
// first-party /1 modules keep loading while they migrate: they never read that field, so a /2 host
// (which sends none) is functionally fine for them. A simultaneous 28-module cutover would be riskier.
export type ModuleApi = "vivijure-module/1" | "vivijure-module/2";
// A SET of currently-supported contract epochs, not a brittle exact-match. The /1 deprecation
// window from #293 is CLOSED (#294): every first-party module is /2 and /1 manifests are rejected.
// The ModuleApi union above keeps /1 nameable as a historical epoch; this Set is the policy.
export const SUPPORTED_MODULE_APIS: ReadonlySet<ModuleApi> = new Set(["vivijure-module/2"]);

/** The pipeline extension points. `pick one` hooks resolve to a single module; `chain` hooks run
 *  every installed module in `ui.order`, each consuming the previous output. */
export type HookName =
  | "keyframe"       // storyboard -> start keyframes (SDXL on GPU). Project-level pass, pick one.
  | "motion.backend" // keyframe (+ motion prompt) -> shot clip. GPU or cloud, pick one per shot.
  | "finish"         // post-process a clip: interpolation / upscale / face restore. Chainable.
  | "score"          // add audio to a film: music / narration / beat-sync. Chainable.
  | "dialogue"       // per-shot dialogue lines -> TTS audio (one voice per cast member). Pick one.
  | "speech"         // per-shot dialogue audio -> cleaned / enhanced dialogue audio. Post-dialogue, pre-finish. Chainable.
  | "plan.enhance"   // expand a storyboard before render: LLM auto-direction. Chainable.
  | "cast.image"     // character portrait + bible -> LoRA training reference images. Cast-prep, pick one.
  | "notify"         // film done -> deliver a render-complete notification (email / webhook / ...). Chain.
  | "master"         // assembled film's audio bed -> mastered audio (music upscale + loudness). Pre-mux. Chain.
  | "film.finish";   // assembled+muxed film -> film with title / credit cards. Post-mux, before done. Chain.

export const HOOK_NAMES: readonly HookName[] = [
  "keyframe",
  "motion.backend",
  "finish",
  "score",
  "dialogue",
  "speech",
  "plan.enhance",
  "cast.image",
  "notify",
  "master",
  "film.finish",
];

/** Whether a hook resolves to one module or folds every installed module. */
export const HOOK_CARDINALITY: Record<HookName, "pick_one" | "chain"> = {
  keyframe: "pick_one",
  "motion.backend": "pick_one",
  finish: "chain",
  score: "chain",
  dialogue: "pick_one",
  speech: "chain",
  "plan.enhance": "chain",
  "cast.image": "pick_one",
  notify: "chain",
  master: "chain",
  "film.finish": "chain",
};

/** One-line description of each hook, for the self-assembling UI. Single source of truth: the
 *  frontend renders the hook panel from this (served via GET /api/modules), not a hardcoded copy. */
export const HOOK_BLURBS: Record<HookName, string> = {
  keyframe: "storyboard -> start keyframes (SDXL)",
  "motion.backend": "keyframe -> shot clip (GPU or cloud)",
  finish: "interpolation / upscale / face restore",
  score: "music / narration / beat-sync",
  dialogue: "spoken lines -> per-character voice (TTS)",
  speech: "clean / enhance dialogue audio",
  "plan.enhance": "LLM auto-direction",
  "cast.image": "character refs from a portrait + bible",
  notify: "render-complete notification (email / webhook)",
  master: "film-level audio mastering: music upscale + loudness",
  "film.finish": "title / credit cards on the finished film",
};

// --------------------------------------------------------------------------- manifest

/** Where a config field's value is sourced from.
 *  - "render"  (default when omitted): per-render config, chosen at submit time (e.g. quality_tier).
 *  - "install": operator-set-once, instance-wide config, persisted in the operator-config store and
 *    injected at invoke time (e.g. notify-email's recipient address). The UI surfaces these on a
 *    studio settings page, not the per-render panel. ADDITIVE: a field with no `scope` is "render",
 *    so this marker narrows nothing -- every existing module + vendored /1 contract stays valid. */
export type ConfigScope = "render" | "install";

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
      scope?: ConfigScope;
    }
  | { type: "bool"; default: boolean; label?: string; scope?: ConfigScope }
  | { type: "enum"; values: string[]; default: string; label?: string; scope?: ConfigScope }
  | { type: "string"; default: string; label?: string; scope?: ConfigScope };

export type ConfigSchema = Record<string, ConfigField>;

/** A user-facing capability a module offers (a module may offer several). */
export interface Provides {
  id: string;
  label: string;
}

/** Hints for the self-assembling studio UI. The honest-framing fields below (locality / cost / blurb /
 *  limits) are OPTIONAL + additive (NO MODULE_API bump): the planner two-door backend selector (#379)
 *  reads them and OMITS each when absent (never fabricated). `locality` is the load-bearing one -- it
 *  drives the door tag AND the core's local-vs-cloud classification (cloudMotionModules /
 *  gpuDoorMotionModules in the registry; an undeclared locality classifies as cloud), so every
 *  motion.backend module SHOULD declare it. The rest are display-only (and `limits`, when absent,
 *  falls back to the module config_schema knob ranges). */
export interface ModuleUi {
  section?: string; // which studio area the module surfaces in (e.g. "finish")
  icon?: string;
  order?: number; // fold/render order within a chain hook
  locality?: "local" | "byo" | "cloud"; // door class: homelab card (local) / your own RunPod endpoint+keys (byo) / pay-per-render provider (cloud)
  cost?: string;   // short cost-model tag, display only (e.g. "Pay per render", "Free after hardware")
  blurb?: string;  // one honest positioning sentence, display only
  limits?: string[]; // honest capability-ceiling bullets, display only (absent => fall back to config_schema)
}

/** OPTIONAL, additive (no MODULE_API bump, same pattern as `cancelable`): a finish module's declared
 *  artifact conventions, so the core's R2-authoritative mid-chain recovery (#141/#166) can predict the
 *  module's output key and reconstruct its `applied` marker from the manifest instead of
 *  reverse-engineering module internals by binding-name regex. A finish module SHOULD declare this;
 *  one that does not gets NO R2 shortcut (its GC'd/frozen steps pend to the deadline honestly). */
export interface FinishArtifactsDecl {
  /** How the module names its output clip in R2:
   *  - `shot_named`: `renders/<project>/clips/<shot_id><filename>` (the module names off the shot id;
   *    e.g. finish-rife's `filename: "_finished.mp4"`).
   *  - `append_suffix`: insert `suffix` into the INPUT clip key before its extension (the
   *    append-convention modules; e.g. lip-sync `_ls`, upscale `_up`). */
  output_key:
    | { kind: "shot_named"; filename: string }
    | { kind: "append_suffix"; suffix: string };
  /** Rules reconstructing the `applied` marker from the step's validated config; FIRST match wins.
   *  `when` (optional) gates a rule on a config knob equaling a literal; `tag` is a template where
   *  `{knob}` reads the knob and `{knob|default}` supplies the value when the knob is absent
   *  (e.g. `"lipsync:{version|v15}"`, `"interpolate:{interpolation_factor|2}x"`). No rules / no
   *  match -> the core marks the adopted step `<binding>:r2-adopted` so the adoption is never silent. */
  applied?: Array<{ when?: { knob: string; equals: string | number | boolean }; tag: string }>;
}

/** A module's self-description, served at GET /module.json. */
export interface ModuleManifest {
  name: string; // unique module id
  version: string;
  api: ModuleApi;
  hooks: HookName[];
  provides?: Provides[];
  config_schema?: ConfigSchema;
  ui?: ModuleUi;
  /** Async modules SHOULD set this true and implement POST /cancel so the core can STOP an in-flight
   *  job (cancel a render, recover an adopted keyframe phase) instead of orphaning GPU. OPTIONAL and
   *  additive (no MODULE_API bump, same as the #318 jobId field). Absent/false => the core cannot
   *  cancel this module's jobs and will HONESTLY degrade-log any orphan rather than hide it. */
  cancelable?: boolean;
  /** Finish modules SHOULD declare their artifact conventions (see FinishArtifactsDecl) so the core's
   *  R2-authoritative recovery works from the manifest, not from binding-name pattern-matching. */
  finish_artifacts?: FinishArtifactsDecl;
  /** OPTIONAL, additive (no MODULE_API bump, same pattern as `cancelable`). A keyframe module's
   *  compact display token for the keyframe-stage backend/model (e.g. "SDXL"), which the planner UI
   *  projects inline instead of hardcoding a model name. Distinct from provides[].label, which is
   *  the section-title-length label ("GPU Keyframe (SDXL on RunPod)"); this is the short inline noun. */
  keyframe_label?: string;
  /** OPTIONAL, additive (no MODULE_API bump, same pattern as `cancelable`). A finish module sets this
   *  true when it drives its output from the shot dialogue audio (`FinishInput.audio_key`), i.e. it
   *  lip-syncs. It carries TWO facts the core needs: (a) this finish step CONSUMES the shot dialogue
   *  audio, and (b) it MUST therefore run on the NATIVE-fps clip, before any finish step that resamples
   *  time (interpolation). A lip-sync model maps audio to mouth shapes calibrated to the source frame
   *  rate, so lip-syncing already-interpolated footage smears the mouth shapes across the doubled
   *  frames (vivijure #584). The core uses this to run audio-consuming finish modules FIRST in the
   *  chain for a shot that HAS a dialogue line, preserving `ui.order` among the rest; a shot with no
   *  line keeps the plain `ui.order` (such a module no-ops there, having no `audio_key`). Absent/false
   *  means ordered purely by `ui.order` (the legacy behavior). The module declares only its OWN nature;
   *  the cross-module ordering policy stays in the core. */
  finish_consumes_audio?: boolean;
  /** OPTIONAL, additive (no MODULE_API bump, same pattern as `cancelable`). A motion.backend module
   *  whose engine renders on a FIXED duration grid (pinned fps + per-tier frame caps, e.g. CogVideoX:
   *  8fps, draft <= 25 frames) declares the grid so the core can warn AT STORYBOARD TIME that a shot's
   *  planned seconds will be clamped, instead of the clamp staying silent until the clip lands (#707).
   *  The module RELAYS what its backend declares (best-effort; e.g. from the backend's /health);
   *  ABSENT means no declared constraint -- the module must never fabricate a grid. Tier keys match
   *  the render quality tiers the module accepts (e.g. draft/standard/final). */
  duration_grid?: DurationGridDecl;
}

/** A fixed duration grid for a motion backend (#707): the pinned output fps and the per-quality-tier
 *  frame ceilings. A tier's maximum deliverable seconds = max_frames / fps. */
export interface DurationGridDecl {
  fps: number;
  tiers: Record<string, { max_frames: number }>;
}

// --------------------------------------------------------------------------- invocation

/** Per-job context the core passes to every invoke (never secrets). */
export interface InvokeContext {
  project: string;
  job_id: string;
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
  | { ok: true; pending: true; poll: string; jobId?: string } // async: accepted; POST /poll with this token.
  //   jobId (#318, OPTIONAL/additive -- no MODULE_API bump): the backend RunPod job id, so the core can
  //   read that job's progress snapshot (counts.keyframe_done) for sub-phase progress. Omit -> graceful
  //   degrade (no sub-progress).
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

/** Body POSTed to a long-running module's `/cancel` to STOP an in-flight async job. The token is the
 *  same one `/invoke` returned (and `/poll` consumes); the module decodes it to ITS backend job id and
 *  cancels with ITS OWN backend creds, because the core never holds them. This is the contract's only
 *  honest way to stop GPU work: without it, a cancelled render or an adopted keyframe phase orphans the
 *  job and bleeds money after the work it was for is already satisfied (#327 / #328). */
export interface CancelRequest {
  poll: string;
}

/** A module's `/cancel` response. BEST-EFFORT + idempotent: cancelling an already-terminal or unknown
 *  job is a success (`ok: true`), so the core can read `ok: true` as "this job will not keep running on
 *  our account". A module that cannot cancel returns `ok: false` with a reason, and the core
 *  degrade-LOGS the orphan rather than hiding it (a silent orphan is the bug). */
export type CancelResponse =
  | { ok: true }
  | { ok: false; error: string };

// --------------------------------------------------------------------------- hook payloads

// finish (v1, the reference hook) ----------------------------------------------------------------

/** What the core hands a `finish` module: a rendered clip and what is known about it. The clip is
 *  self-describing (a finish backend probes it), so the shape hints below are OPTIONAL -- the core
 *  passes them when it has them, but a finish module must not require them. */
export interface FinishInput {
  shot_id: string;
  clip_key: string;  // R2 key of the input clip (mp4)
  audio_key?: string; // R2 key of the shot's dialogue audio (TTS); set only for a shot with a line.
                      // A finish module that lip-syncs (finish-lipsync) consumes it; others ignore it.
                      // Absent => a silent shot, so lip-sync no-ops (passthrough).
  src_fps?: number;  // optional hints; the finish backend probes the clip if absent
  frames?: number;
  width?: number;
  height?: number;
  // #583 provenance: the core-computed param-hash of this step's inputs (finishStepInputHash), passed
  // so the producer can STAMP it verbatim to `<output_key>.hash` (artifact first, sidecar last). OPAQUE
  // to the module -- forward it into the RunPod job unchanged; never parse/recompute it. Optional +
  // additive (no api bump); absent on a legacy core, in which case the producer writes NO sidecar.
  output_hash?: string;
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

// dialogue (v1) ---------------------------------------------------------------------------------

/** One spoken line for one shot. `voice_id` is resolved by the core (slot -> cast member -> voice),
 *  so the module just synthesizes; absent/unknown falls back to a default speaker at synth time. */
export interface DialogueLine {
  shot_id: string;
  text: string;
  voice_id?: string;
}

/** What the core hands a `dialogue` module: every speaking shot in ONE batch (so a film's dialogue is
 *  a single submit+poll, not N round-trips). `project` is the R2 key prefix the audio lands under. */
export interface DialogueInput {
  project: string;
  lines: DialogueLine[];
}

/** One synthesized line: the R2 key of its audio and the voice actually used. The core attaches
 *  `audio_key` to that shot's FinishInput so a lip-sync finish module can drive the mouth from it. */
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

// speech (v1) -----------------------------------------------------------------------------------

/** What the core hands a `speech` module: ONE shot's dialogue audio to enhance / clean. The audio is
 *  self-describing (a speech backend probes it), so this is deliberately minimal. The speech chain runs
 *  AFTER the dialogue phase (the audio exists) and BEFORE finish (so a lip-sync finish module drives the
 *  mouth from the cleaned audio). */
export interface SpeechInput {
  shot_id: string;
  audio_key: string; // R2 key of the shot's dialogue audio (TTS), from job.dialogue_audio[shot_id]
}

/** What a `speech` module returns: the (maybe enhanced) dialogue audio plus what it did. On a real
 *  enhancement `audio_key` is the NEW cleaned key; on an honest soft-degrade it is the input key passed
 *  through unchanged, `applied` carries no fake tag, and `degraded` carries the reason. A speech step is
 *  a POLISH step: it NEVER fails the render on a miss -- only malformed I/O fails loud (cf #249/#77). */
export interface SpeechOutput {
  shot_id: string;
  audio_key: string;  // R2 key of the enhanced audio, or the input key passed through on a soft-degrade
  applied: string[];  // e.g. ["speech-upscale:resemble-enhance"]; or [] on passthrough
  degraded?: string;  // set ONLY when the audio was passed through because the work could not run
                      // (disabled / backend down / no audio), carrying the reason; absent on success
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
  /** slot -> R2 key of pretrained cast LoRAs; scatter shards reuse adapters trained once up front. */
  pretrained_loras?: Record<string, string>;
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
  /** slot -> R2 key of the cast LoRA this render trained or reused. The core records a freshly
   *  trained adapter back onto the cast member (lora_status=ready) so it is reused across every
   *  project instead of retrained each render. Optional + additive: a module that does no LoRA
   *  work omits it. */
  trained_loras?: Record<string, string>;
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
  /** OPTIONAL, additive (no MODULE_API bump): tier-honesty signal from the backend -- true when the
   *  clip was rendered with a DISTILLED variant of the model (e.g. the 12gb door's final-tier 13B
   *  distilled), false when the full model ran. The module relays what its backend reports and OMITS
   *  the field when the backend says nothing (#705); the core retains it per shot and surfaces it on
   *  the film summary's clip_deliveries. Absence is honest, never a fabricated false. */
  distilled?: boolean;
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
  degraded?: string;    // the shared chain convention (as on FinishOutput / MasterOutput /
                        // SpeechOutput / FilmFinishOutput): set ONLY when the module could not do
                        // what was asked and passed through / partially applied, carrying the
                        // reason. A degrade is never silent -- the consumer records it.
}

// cast.image (v1) -------------------------------------------------------------------------------

/** What the core hands a `cast.image` module: one cast member's seed material to generate LoRA
 *  TRAINING reference images from -- a portrait (the identity seed), optional human-uploaded source
 *  photos for extra conditioning, and the bible/style that shape the prompts. A CAST-PREP pass,
 *  upstream of keyframe: the generated images become the cast member's training refs. The portrait /
 *  source URLs are presigned + fetchable (the core presigns the private R2 objects so a cloud image
 *  model can pull them), mirroring how motion.backend gets keyframe_url. */
export interface CastImageInput {
  cast_id: number;
  portrait_url: string;   // presigned URL of the character portrait (the generation seed)
  portrait_key?: string;  // the underlying R2 key, for reference
  source_urls?: string[]; // optional presigned URLs of human-uploaded reference photos (extra conditioning)
  bible?: string;         // character bible/description; composed into each prompt (capped)
  art_style?: string;     // optional art-style lead (e.g. "anime"); blank keeps the photographic templates
}

/** What a `cast.image` module returns: the generated training reference images (already stored in
 *  R2), ready to feed LoRA training, plus what it did. The core appends these to the cast member's
 *  ref set. */
export interface CastImageOutput {
  cast_id: number;
  images: { key: string; mime: string }[]; // R2 keys of the generated reference images
  applied: string[];                        // e.g. ["model:flux-2-klein-9b", "generated:10"]
}

// notify (v1) -----------------------------------------------------------------------------------

/** What the core hands a `notify` module when a film reaches "done": the completion event + the facts
 *  a notifier needs to deliver (a presigned download_url, the project name, the owner address). A
 *  TERMINAL side-effect hook -- fired once on the done-transition, `chain` (every installed notifier
 *  delivers independently: email AND webhook AND ...). A notifier with nothing to do for its channel
 *  (e.g. no recipient address) returns an empty `delivered`, never an error. */
export interface NotifyInput {
  event: "render.complete";
  film_id: string;
  project: string;
  download_url?: string; // presigned link to the finished film (the core presigns it)
  seconds?: number;      // film length, if known
}

/** What a `notify` module returns: the channels it delivered on (for the core's log / summary). */
export interface NotifyOutput {
  delivered: string[]; // e.g. ["email:owner@example.com"]
}

// master (v1) -----------------------------------------------------------------------------------

/** What the core hands a `master` module: the assembled film's AUDIO BED (the mixed score / narration
 *  track), to polish at FILM level before the final mux. This is the audio sibling of `finish` (which
 *  polishes a clip) and the dialogue/`speech` lane (which polishes per-shot voice): `master` operates
 *  once, on the whole film's audio, AFTER the mix is built (score + narration) and BEFORE the audio is
 *  muxed onto the silent film. `audio_key` is the R2 key of that bed; the core presigns a GET of it
 *  (`audio_url`) and a PUT for the mastered output (`output_url` / `output_key`) so the module stays
 *  CREDENTIALLESS and forwards them to its CPU container -- exactly as the subtitle / film.finish modules
 *  get a presigned video_url + output_url. A music-video maker reaches for `master` as cleanly as a
 *  dialogue maker reaches for the voice lane. */
export interface MasterInput {
  film_id: string;     // the film this bed belongs to (for the output-key convention + logs)
  audio_key: string;   // R2 key of the assembled audio bed (the mix to master)
  audio_url: string;   // presigned GET of the assembled bed (the container downloads it)
  output_url: string;  // presigned PUT for the mastered bed (the container uploads it)
  output_key: string;  // the R2 key behind output_url (returned to the core)
  seconds?: number;    // film length hint, if known (the module probes the bed if absent)
}

/** What a `master` module returns: the mastered audio bed plus what it did. Length is invariant
 *  (mastering changes level / sample rate, never duration). HONEST soft-degrade, exactly as a `finish`
 *  module: when the master cannot run (misconfig / backend down) the module passes the INPUT bed
 *  through (`audio_key` unchanged) and sets `degraded` with the reason -- never a fake `applied` tag,
 *  never a dropped bed. A real degrade is therefore never silent (#249 / #77). */
export interface MasterOutput {
  audio_key: string;   // R2 key of the MASTERED bed (may equal the input if it passed through / no-op'd)
  applied: string[];   // e.g. ["music-upscale:soxr48k", "loudnorm:-14LUFS"]; or ["passthrough:<reason>"]
  degraded?: string;   // set ONLY when the bed was passed through because the master could not run,
                       // carrying the reason; absent on success + on the intentional no-op (#77)
}

// film.finish (v1) ------------------------------------------------------------------------------

/** One time-synced caption cue handed to a `film.finish` subtitle module, in seconds from the
 *  assembled film's 0-based start. Structurally mirrors src/captions.ts CaptionCue; declared here so
 *  the contract stays self-contained -- a module in another repo vendoring this file gets the caption
 *  shape too, without importing a core-only module. */
export interface FilmFinishCaption {
  start: number;
  end: number;
  text: string;
}

/** What the core hands a `film.finish` module: the assembled+muxed film to put title / credit cards
 *  (and/or burned-or-sidecar subtitles) on, by R2 transport. The module reads `video_url` (a presigned
 *  GET of the input film) and writes its result to `output_url` (a presigned PUT at `output_key`),
 *  exactly as a finish backend reads/writes a clip. `title` / `credits` carry the card text (absent =>
 *  no cards, the module passes the film through); `captions` carries the time-synced dialogue cues for a
 *  subtitle module (empty => it no-ops); `sidecar_url` / `sidecar_key` are a presigned PUT for an
 *  optional .srt sidecar. This runs POST-mux, before done, as a `chain`: every installed film.finish
 *  module folds in `ui.order`, and the core presigns a FRESH GET (of the PRIOR step's film) + PUT (to a
 *  new key) per step, so step N+1 reads what step N wrote rather than the original (#14). */
export interface FilmFinishInput {
  film_key: string;    // R2 key of the input film (the prior step's output, or the original on step 1)
  video_url: string;   // presigned GET of the input film (the module fetches it)
  output_url: string;  // presigned PUT the module writes the carded film to
  output_key: string;  // the R2 key behind output_url (so the core knows where the result landed)
  title?: { text: string; subtitle?: string }; // opening title card text; absent => no title card
  credits?: { lines: string[] };               // end-credit lines; absent => no credit card
  captions: FilmFinishCaption[];                // time-synced dialogue cues; empty => subtitle no-op
  sidecar_url: string; // presigned PUT for an optional .srt subtitle sidecar (ignored by non-subtitle modules)
  sidecar_key: string; // the R2 key behind sidecar_url
}

/** What a `film.finish` module returns: the (maybe new) film key plus what it did. The chain is
 *  FAIL-SAFE -- a module that cannot run passes the film through with `film_key` UNCHANGED (the input
 *  film key, never omitted) and reports it via the soft-degrade convention, never dropping a
 *  fully-rendered film (#190). `applied` carries the module name on success, or a "passthrough:<reason>"
 *  / "noop:no-cards" tag on a soft-degrade; `degraded` (the shared chain convention, as on FinishOutput
 *  / MasterOutput / SpeechOutput) is set ONLY when the film shipped UNCARDED, carrying the reason -- the
 *  one signal that requested cards were NOT applied (#207). The core records the chain outcome on the
 *  job rather than dropping it. */
export interface FilmFinishOutput {
  film_key: string;   // R2 key of the film; on a passthrough it is the INPUT film_key UNCHANGED (never
                      // omitted), so the core always gets a usable key. REQUIRED to match the
                      // conformance checker (HOOK_OUTPUT_CHECKS["film.finish"]) and every shipping
                      // module (subtitle / film-titles both always return it).
  applied?: string[]; // module name on success; "passthrough:<reason>" / "noop:no-cards" on a soft-degrade.
                      // OPTIONAL by decision (S4 consistency pass): every SHIPPING module always returns
                      // it, but module repos vendor this file, so requiring it now would compile-break +
                      // conformance-fail external modules built against the shipped v2 -- an api bump for
                      // a field the core already defaults (film-orchestrator reads `applied ?? []`).
                      // Conformance enforces the TYPE when present (string[]); requiring it outright is
                      // queued for the next genuine api bump.
  degraded?: string;  // set ONLY when the film was passed through UNCARDED, carrying the reason (#207)
  // Seconds this module PREPENDED to the FRONT of the film (an opening title card). The core shifts any
  // .srt sidecar written by an EARLIER film.finish step (the subtitle module, ui.order 5, runs before
  // film-titles at 10) forward by this so the soft subtitles line up with the FINAL film, not the
  // pre-card timeline (#663). Absent / 0 => no front prepend: credits are appended at the END, so they
  // never shift cues, and a passthrough / noop applied no card. OPTIONAL + additive (no api bump): a
  // module that does not prepend simply omits it, and conformance enforces the type only when present.
  prepend_seconds?: number;
}

// --------------------------------------------------------------------------- registry view

/** One registered module, INTERNAL to the core: the manifest plus a `binding` REF telling the core how
 *  to reach it. The ref is transport-encoded (resolved by registry.resolveFetcher):
 *   - `MODULE_<NAME>` -> a service binding on env (the legacy, in-tree, deploy-wired path), or
 *   - `dispatch:<script>` -> a user-Worker script uploaded into the Workers-for-Platforms dispatch
 *     namespace, reached via env.MODULE_DISPATCH.get(<script>) at request time (installed without a core
 *     redeploy; see docs/module-dispatch.md). The `dispatch:` prefix cannot collide with a real
 *     `MODULE_*` env key, so a single string persists a module's transport through job state and both
 *     kinds re-resolve uniformly across requests.
 *  The ref is internal topology and NEVER leaves the core -- toPublic strips it (see PublicModule). */
export interface RegisteredModule extends ModuleManifest {
  binding: string; // transport-encoded ref: "MODULE_<NAME>" (service) or "dispatch:<script>" (WfP)
}

/** One registered module as the core exposes it to the frontend over GET /api/modules: the manifest
 *  ONLY, with the internal `binding` ref stripped. The unauthenticated registry route must not leak
 *  which env binding OR namespace script serves a hook (internal module-host topology); the studio UI
 *  never needs it -- it renders from the manifest, and the core resolves the transport itself. (Info
 *  disclosure, #18.) */
export type PublicModule = ModuleManifest;

/** One hook in the catalog the frontend renders the pipeline panel from, so the panel is a
 *  projection of the contract rather than a hardcoded list. */
export interface HookCatalogEntry {
  name: HookName;
  blurb: string;
  cardinality: "pick_one" | "chain";
}

/** Core-owned render config the frontend projects (so the planner stops hand-authoring it in markup).
 *  Distinct from module config_schema: these are cross-cutting choices the HOST owns (e.g. the quality
 *  tier the core injects into the keyframe + motion modules), not knobs a single module declares.
 *  Sourced from the one core constant (QUALITY_TIERS / DEFAULT_QUALITY_TIER in render-module-config). */
export interface RenderConfigProjection {
  quality_tiers: { value: string; label: string; blurb: string }[];
  default_tier: string;
}

/** GET /api/modules: the merged registry the studio UI renders itself from. Carries the PUBLIC
 *  module view (no internal `binding`); the hook index maps each hook to the module NAMES serving
 *  it, so the frontend has everything it needs to project the pipeline without seeing topology. */
export interface ModulesResponse {
  api: ModuleApi;
  modules: PublicModule[];
  hooks: Partial<Record<HookName, string[]>>; // hook -> module names serving it
  catalog: HookCatalogEntry[];                 // every hook (name + blurb + cardinality)
  render: RenderConfigProjection;              // core-owned render config (tiers); additive (#projection)
  /** What TRANSPORTS this host offers, the CORE describing ITSELF -- orthogonal to `api` (which is the
   *  module contract version, unchanged by dispatch). `dispatch: true` means this deployment speaks
   *  Workers-for-Platforms dynamic dispatch (a module can be installed without a core redeploy).
   *  `readonly: true` (#625) means this deployment accepts no mutations (the public demo studio,
   *  AUTH_MODE=demo): the frontend disables mutation affordances off this ONE projected capability
   *  instead of growing per-feature demo branches; omitted everywhere else. A module never reads
   *  this; an operator / the studio UI / a health probe does. OPTIONAL + additive:
   *  a deploy without WfP omits it, and NO MODULE_API bump (docs/module-dispatch.md section 5.3). */
  host?: {
    dispatch: boolean;
    readonly?: boolean;
    // #631 Phase B (demo deploys only): `render.available` true => the click-to-render menu is live
    // (the backend is reachable + enabled); false => renders are paused. `assistant` carries the OSS
    // "free model" note so it renders wherever the assistant surfaces, from THIS projection (constraint 9),
    // never a hardcoded page branch. Both omitted off-demo. A module never reads these; the UI does.
    render?: { available: boolean };
    assistant?: { model: string; note: string };
  };
}
