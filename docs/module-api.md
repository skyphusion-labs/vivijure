# Vivijure Module API

> Status: **IMPLEMENTED** (`vivijure-module/2`; the `/1` window is closed, no longer accepted). The contract the core and modules share. This
> document is the design spec; `src/modules/types.ts` is the canonical TypeScript shape.

## Why this exists

Vivijure is a **host, not a monolith**. The studio core owns only what is always true (project,
storyboard, cast, the bundle, the render-orchestration spine, and a module registry). Every
*capability* beyond that is an opt-in **module worker** that plugs into the pipeline through a
typed contract.

Not everyone wants cloud rendering. Not everyone wants frame interpolation, or narration, or
lip-sync. So none of it is baked in. You install the modules you want; the studio assembles itself
around them, including its own UI. That is the fix for the old problem (a frontend jammed full of
features most people did not want): the studio can only ever show what is actually plugged in.

It is also the open-source play. Publish the core plus a module SDK under AGPL, and anyone can
write a module: a Kling motion backend, a whisper-captions scorer, a region-specific provider
swap. The community becomes the roadmap instead of one maintainer being the bottleneck for every
feature.

## Concepts (the five nouns)

| Noun | What it is |
|---|---|
| **Core** | This worker (`vivijure-studio`). Owns project/storyboard/cast/bundle/orchestration + the registry and the planner/cast UI. |
| **Hook** | A named extension point in the pipeline with ONE typed input and ONE typed output. The core invokes hooks; it does not know who answers. |
| **Module** | A worker that serves one or more hooks. Ships a manifest + an `invoke` entry point. |
| **Manifest** | A module's self-description: which hooks it serves, what config it exposes, how it surfaces in the UI. |
| **Registry** | The core's index of installed modules, built from their manifests. Drives the pipeline and feeds the frontend. |

## The hooks (vivijure-module/2)

A hook is a contract, not a function. Each has a stable name, a typed input, and a typed output.
Shapes live in `src/modules/types.ts`.

| Hook | Purpose | Cardinality |
|---|---|---|
| `keyframe` | Storyboard -> start keyframes. Backend-selectable: GPU SDXL or GPUless cloud (e.g. cloud-keyframe) are modules. | pick one |
| `motion.backend` | Keyframe (+ motion prompt) -> shot clip. GPU/RunPod and cloud providers are modules. | pick one per shot |
| `finish` | Post-process a clip: frame interpolation, lip-sync (MuseTalk), upscale (CUDA Real-ESRGAN), face restore. | chain (0..n, ordered) |
| `score` | Add audio to a film: music, narration, beat-sync. | chain (0..n) |
| `dialogue` | Per-shot dialogue lines -> speech audio (TTS, one voice per cast member). Runs after clips, before finish; its audio feeds the lip-sync finish module. | pick one |
| `speech` | Per-shot dialogue AUDIO -> cleaned/enhanced dialogue audio (e.g. speech upscale). Runs after `dialogue`, before `finish`, so lip-sync consumes the improved track. | chain (0..n) |
| `plan.enhance` | Expand a storyboard before render: LLM auto-direction, camera/lighting enrichment. | chain (0..n) |
| `cast.image` | Portrait + bible -> LoRA training reference images. | pick one |
| `notify` | Film done -> deliver a render-complete notification (email, webhook, ...). | chain (0..n) |
| `master` | Assembled film's audio bed -> mastered audio (music upscale + LUFS loudness). Film-level, runs after the audio mix is built (assemble), before the final mux; fail-safe (a master miss muxes the un-mastered bed). The audio sibling of `finish` (clips) and the dialogue/speech lane (per-shot voice). | chain (0..n) |
| `film.finish` | Assembled + muxed film -> film with opening title / end-credit cards. Post-mux, before done. Runs on both the single-film path (`/api/render/film`) and the scatter/gather finalize (`runScatterFilmFinish`); fail-safe on both. Scatter threads async submit+poll per chain step so a long `film.finish` survives across gather ticks (#602). | chain (0..n) |

`pick one` hooks resolve to a single module (the user's chosen backend). `chain` hooks run every
installed module in a declared order, each consuming the previous output.

## The module manifest (`module.json`)

Served by the module at `GET /module.json`. The core reads it once to register the module.

```jsonc
{
  "name": "finish-rife",                 // unique module id
  "version": "0.1.0",
  "api": "vivijure-module/2",            // contract version this module targets (/1 is closed)
  "hooks": ["finish"],                   // which hooks it serves
  "provides": [                          // user-facing capabilities (one module may offer several)
    { "id": "interpolate", "label": "Smooth motion (frame interpolation)" },
    { "id": "face_restore", "label": "Relock faces" }
  ],
  "config_schema": {                     // typed knobs; the UI renders these, the core validates them
    "interpolation_factor": { "type": "int", "min": 1, "max": 8, "default": 2,
                              "label": "Smoothness", "enum_labels": { "1": "off", "2": "2x", "4": "4x" } },
    "face_restore":         { "type": "enum", "values": ["none", "gfpgan"], "default": "none",
                              "label": "Face restore" }
  },
  "ui": { "section": "finish", "icon": "wand", "order": 10 }   // hints for the self-assembling UI
}
```

The `config_schema` is the single source of truth for a module's knobs. The frontend renders the
controls from it; the core clamps/validates against it before invoking. One declaration, one hop,
same words down. No separate override grab-bag.

A field may carry an optional `"scope"`:

- **`"render"`** (the default when omitted): a per-render knob, chosen at submit time, flowing through
  the per-render config path -- the behavior every field has always had.
- **`"install"`**: operator-set-**once**, instance-wide config (e.g. `notify-email`'s `notify_email`
  recipient). The operator sets it on the studio **settings** page; the core persists it in the
  operator-config store and injects it into the module invoke at hook time. The value lives only in
  that store, read/written via `GET/PATCH /api/modules/:name/config` -- it never rides the public
  `/api/modules` projection (only the schema marker does, so the settings UI can render the control).

`scope` is additive: an unmarked field is a `"render"` field, so adding it broke nothing and bumped no
contract version. See CONTRACT.md 4.1.1 / 4.1.2 for the full spec.

## Invocation contract

The core calls a module over a **service binding** (RPC) or HTTP. One entry point per module:

```
POST /invoke
{
  "hook":    "finish",                   // which hook is being asked
  "input":   { ... },                    // the hook's typed input (see below)
  "config":  { ... },                    // the user's values, already validated vs config_schema
  "context": { "project": "neon", "job_id": "abc" }
}
->
{ "ok": true,  "output": { ... } }       // the hook's typed output
{ "ok": false, "error": "human-readable reason" }   // a module failure never crashes the core
```

A module is **stateless to the core**: it gets typed input + config, returns typed output. Where it
does the work (its own GPU, a cloud provider, a CPU container) is the module's business.

### Async + cancel

A long-running hook answers `/invoke` with `{ ok: true, pending: true, poll }` and the core POSTs
`{ poll }` to `POST /poll` until it is done. A module doing real backend work (a GPU render) SHOULD
also set `cancelable: true` and serve `POST /cancel { poll }` -> `{ ok: true }` (cancelled, or already
terminal: idempotent) / `{ ok: false, error }`. The module decodes the token to its own backend job id
and cancels with its own creds. Without `/cancel`, a cancelled render or a stall-recovery adopt
ORPHANS the GPU job (it keeps billing after the work is satisfied); the core honest-degrade-logs that
orphan rather than hide it (#327 / #328). Full envelope spec in CONTRACT.md section 4.

This is NOT just for GPU hooks: a CPU-container `film.finish` module (subtitle burn, title cards)
whose encode outlasts a request budget on a long film ALSO answers `pending` + `poll`, so the core
drives submit+poll across ticks and no single request holds the encode open (#602). Such a module
stays FAIL-SAFE -- a poll failure soft-degrades (ships the film uncarded), it never fails the render.

### Declared finish artifacts (`finish_artifacts`, optional + additive)

A `finish` module SHOULD declare its artifact conventions in the manifest so the core's
R2-authoritative recovery (a step whose backend job was GC'd or froze mid-chain, #141/#166) can
predict the module's output key and reconstruct its `applied` marker FROM THE MANIFEST -- the core
never pattern-matches module names to guess conventions. Two shapes:

```ts
finish_artifacts: {
  // How the module names its output clip in R2, one of:
  output_key: { kind: "shot_named", filename: "_finished.mp4" }   // renders/<project>/clips/<shot_id><filename>
  output_key: { kind: "append_suffix", suffix: "_ls" }            // input clip key + suffix before its extension
  // Optional rules reconstructing `applied` from the validated config; FIRST match wins. `when`
  // gates a rule on a knob equaling a literal; {knob|default} in a tag reads the knob (else default).
  applied: [
    { when: { knob: "interpolate", equals: false }, tag: "noop:interpolate-off" },
    { tag: "interpolate:{interpolation_factor|2}x" },
  ]
}
```

A finish module WITHOUT the declaration gets no R2 shortcut: its stuck steps pend to the hard
deadline honestly instead of the core guessing where its output landed. Present-but-malformed
`finish_artifacts` REJECTS the manifest at registration.

### Keyframe display label (`keyframe_label`, optional + additive)

A `keyframe` module MAY declare `keyframe_label`: a compact display token for the keyframe-stage
backend or model (e.g. `"SDXL"`). The planner UI is a projection of the registry, so it reads this
token and renders it inline (the regen confirm, the keyframes-only badge, the "no `<label>` keyframe
pass" copy) instead of hardcoding a model name that would drift. The frontend picks the token from the
`ui.order`-first keyframe module that declares one and falls back to `"SDXL"` when none does, so the
copy is never blank.

```jsonc
{ "hooks": ["keyframe"], "keyframe_label": "SDXL" }
```

Leave it out when the model is not a single fixed name (e.g. a user-selectable model enum): an
undeclared label is honest, and the fallback covers the copy. `keyframe_label` is OPTIONAL and
additive (no MODULE_API bump); present-but-empty-or-non-string REJECTS the manifest at registration.

### Dialogue-aware finish order (`finish_consumes_audio`, optional + additive)

A `finish` module MAY declare `finish_consumes_audio: true` to say it drives its output from the
shot dialogue audio (`FinishInput.audio_key`) and is calibrated to the SOURCE frame rate, i.e. it
lip-syncs. The core reads this (never a module name) to run such a module FIRST in the finish chain
for a shot that HAS a dialogue line, so it lip-syncs the native-fps clip BEFORE any interpolation.
Without it, a lip-sync run on already-interpolated footage smears the mouth shapes across the doubled
frames (the breathy look, vivijure #584).

The rule is a STABLE partition of the chain: audio-consuming modules move ahead of the rest, `ui.order`
preserved within each group. With `finish-rife` (order 10), `finish-lipsync` (order 15,
`finish_consumes_audio`), and `finish-upscale` (order 20):

- a shot WITH a dialogue line runs `finish-lipsync` -> `finish-rife` -> `finish-upscale`;
- a shot with NO line keeps the plain `ui.order` (`finish-rife` -> `finish-lipsync` -> `finish-upscale`),
  where lip-sync no-ops because it has no `audio_key`.

```jsonc
{ "hooks": ["finish"], "ui": { "order": 15 }, "finish_consumes_audio": true }
```

The module declares only its OWN nature; the cross-module ordering policy lives in the core. Because
the reorder changes each step INPUT clip, the `#583` step-input provenance hash
(`finishStepInputHash`, CONTRACT.md 3.3.1) differs across the two orderings on its own, with no
special-case. `finish_consumes_audio` is OPTIONAL and additive (no MODULE_API bump); absent/false =>
the chain folds purely in `ui.order`.

### Fixed duration grid (`duration_grid`, optional + additive)

A `motion.backend` module whose engine renders on a FIXED duration grid (a pinned output fps plus
per-quality-tier frame ceilings, e.g. CogVideoX: 8fps, `draft` capped at 25 frames) MAY declare the
grid so the core can warn AT STORYBOARD TIME that a shot's planned seconds will be clamped, instead
of the clamp staying silent until the clip lands short (vivijure #707). A tier's maximum deliverable
seconds is `max_frames / fps`. Tier keys match the render quality tiers the module accepts.

```jsonc
{
  "hooks": ["motion.backend"],
  "duration_grid": {
    "fps": 8,
    "tiers": { "draft": { "max_frames": 25 }, "standard": { "max_frames": 49 }, "final": { "max_frames": 49 } }
  }
}
```

The module RELAYS what its backend actually enforces (e.g. read from the backend's own health/info
endpoint, best-effort) -- it must never fabricate a grid, and it declares nothing when the backend
has no fixed grid (a flexible engine like LTX simply omits the field). The core's preflight compares
each shot's planned seconds against the selected tier's ceiling and emits a WARNING per clamped shot
(never an error: clamping is legitimate behavior; silence was the bug). `duration_grid` is OPTIONAL
and additive (no MODULE_API bump); absent => no declared constraint, no preflight check.

## Worked example: the `finish` hook

This is the whole contract for one hook, end to end. It is also the first real module.

### Types (canonical TS shapes)

```ts
// What the core hands a finish module: a rendered clip and what is known about it.
interface FinishInput {
  shot_id: string;
  clip_key: string;     // R2 key of the input clip (mp4)
  src_fps: number;
  frames: number;
  width: number;
  height: number;
}

// What a finish module returns: the processed clip plus what it did.
interface FinishOutput {
  shot_id: string;
  clip_key: string;     // R2 key of the FINISHED clip (may equal input if it no-op'd)
  out_fps: number;
  frames: number;
  applied: string[];    // e.g. ["interpolate:2x", "face_restore:gfpgan"]
}
```

Invariant for `finish`: every clip in one render is processed with the SAME config, so all outputs
share fps + codec and the off-GPU concat stays a stream-copy (no re-encode). The module enforces
this; the core passes one config for the whole render.

### The module's job

1. Read `clip_key` from R2.
2. Apply the configured passes (RIFE interpolation, then/or face restore), best-effort: a pass
   whose model is unavailable is skipped, not fatal.
3. Write the finished clip back to R2, return `FinishOutput`.

The render engine for this lives on the GPU side (the `finish.py` module already drafted in
`vivijure-backend`); the module worker is the thin contract wrapper around it.

### Conformance

Every hook ships a conformance suite. A `finish` module is conformant if, given a known input clip
and a config, it:
- returns a valid `FinishOutput` with `applied` reflecting the config,
- preserves the clip's duration (interpolation changes fps + frame count, never length),
- degrades a missing pass to a no-op instead of erroring,
- is idempotent under an empty config (returns the input unchanged).

The conformance checks live in `src/modules/conformance.ts`: `checkManifest` (the `module.json`),
`checkInvokeResponse` (the `{ ok, ... }` envelope), and `checkHookOutput(hook, output)` (the typed
PAYLOAD a success returns). The last one matters because the envelope and the payload are two
different promises: a `finish` module can return a perfectly well-formed `{ ok: true, output: {} }`
and still break the contract, because `{}` is not a `FinishOutput`. The harness validates the
REQUIRED fields of each hook's output shape (optional hint fields are not demanded), so "envelope-ok"
is not mistaken for "contract-ok". `npm run conformance` runs the suite (`tests/conformance.test.ts`
for the shape checks, `tests/conformance.live.test.ts` for a live module). The live spec is opt-in:
point it at a deployed module to verify its `module.json` + `invoke` (envelope AND payload) end to
end:

```
MODULE_URL=https://my-module.example.workers.dev npm run conformance
```

Green means the module plugs into ANY Vivijure deployment. This is what keeps the ecosystem
trustworthy: implementing the interface is not enough, you have to pass the contract.

## The registry + the self-assembling frontend

On boot, the core reads each bound module's `module.json` and indexes them by hook. Then:

- **Pipeline:** at each hook, the core invokes the installed module(s). `pick one` hooks use the
  user's choice; `chain` hooks fold every module in `ui.order` (the `finish` chain applies one dialogue-aware exception -- see `finish_consumes_audio` above).
- **Frontend:** the core serves `GET /api/modules` (the merged manifests). The studio UI renders
  ONLY the sections, controls, and providers that are actually installed. A bare deploy is a lean
  studio; installing `finish-rife` makes the "Smooth motion" control appear, nowhere hardcoded.

```
GET /api/modules
{
  "api": "vivijure-module/2",
  "modules": [ { "name": "finish-rife", "hooks": ["finish"], "provides": [...], "config_schema": {...}, "ui": {...} } ],
  "hooks": { "finish": ["finish-rife"], "motion.backend": ["motion-runpod"] }
}
```

## Contributor flow

1. `git clone` the module template (a minimal worker + the shared `vivijure-module/2` types).
2. Implement one hook's `invoke(input, config, context) -> output`.
3. `npm run conformance` until green.
4. Install it: add a service binding (now) or publish to the dispatch namespace (later).

That is the whole barrier to entry. One hook, one green suite.

## Rollout

- **Phase 0 (done, v0.1.0):** contract + registry + self-assembling UI shell.
- **Phase 1 (done, v0.2.0):** render API migrated behind hooks; reference modules bound at deploy;
  planner/cast/library routes live in this worker.
- **Phase 2 (done for production cutover):** `vivijure.skyphusion.org` points here; render + planner
  stripped from `skyphusion-llm-public`. Optional polish (render SSE stream, further core extraction)
  remains fair game.
- **Phase 3 (done, v0.8.0):** Workers for Platforms / dynamic dispatch so a module installs without
  redeploying the core (opt-in, paid; a standard self-host never needs it). The frontend is already a
  projection of the registry, so it needed no change.

## Non-goals (v1)

- No module-to-module calls. Modules talk only to the core, through hooks. (Keeps the graph a star,
  not a web.)
- Dynamic install shipped in Phase 3 (WfP dynamic dispatch, v0.8.0); it is opt-in and paid, and the
  default self-host still binds modules at deploy.
- Capabilities beyond the render spine belong in modules, not inlined in the core.
