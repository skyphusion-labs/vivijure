# Vivijure Module API

> Status: **IMPLEMENTED** (`vivijure-module/1`). The contract the core and modules share. This
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

## The hooks (vivijure-module/1)

A hook is a contract, not a function. Each has a stable name, a typed input, and a typed output.
Shapes live in `src/modules/types.ts`.

| Hook | Purpose | Cardinality |
|---|---|---|
| `keyframe` | Storyboard -> start keyframes (SDXL on GPU). | pick one |
| `motion.backend` | Keyframe (+ motion prompt) -> shot clip. GPU/RunPod and cloud providers are modules. | pick one per shot |
| `finish` | Post-process a clip: frame interpolation, upscale, face restore. | chain (0..n, ordered) |
| `score` | Add audio to a film: music, narration, beat-sync. | chain (0..n) |
| `plan.enhance` | Expand a storyboard before render: LLM auto-direction, camera/lighting enrichment. | chain (0..n) |
| `cast.image` | Portrait + bible -> LoRA training reference images. | pick one |
| `notify` | Film done -> deliver a render-complete notification (email, webhook, ...). | chain (0..n) |

`pick one` hooks resolve to a single module (the user's chosen backend). `chain` hooks run every
installed module in a declared order, each consuming the previous output.

## The module manifest (`module.json`)

Served by the module at `GET /module.json`. The core reads it once to register the module.

```jsonc
{
  "name": "finish-rife",                 // unique module id
  "version": "0.1.0",
  "api": "vivijure-module/1",            // contract version this module targets
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

## Invocation contract

The core calls a module over a **service binding** (RPC) or HTTP. One entry point per module:

```
POST /invoke
{
  "hook":    "finish",                   // which hook is being asked
  "input":   { ... },                    // the hook's typed input (see below)
  "config":  { ... },                    // the user's values, already validated vs config_schema
  "context": { "project": "neon", "job_id": "abc", "user_email": "..." }
}
->
{ "ok": true,  "output": { ... } }       // the hook's typed output
{ "ok": false, "error": "human-readable reason" }   // a module failure never crashes the core
```

A module is **stateless to the core**: it gets typed input + config, returns typed output. Where it
does the work (its own GPU, a cloud provider, a CPU container) is the module's business.

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
  user's choice; `chain` hooks fold every module in `ui.order`.
- **Frontend:** the core serves `GET /api/modules` (the merged manifests). The studio UI renders
  ONLY the sections, controls, and providers that are actually installed. A bare deploy is a lean
  studio; installing `finish-rife` makes the "Smooth motion" control appear, nowhere hardcoded.

```
GET /api/modules
{
  "api": "vivijure-module/1",
  "modules": [ { "name": "finish-rife", "hooks": ["finish"], "provides": [...], "config_schema": {...}, "ui": {...} } ],
  "hooks": { "finish": ["finish-rife"], "motion.backend": ["motion-runpod"] }
}
```

## Contributor flow

1. `git clone` the module template (a minimal worker + the shared `vivijure-module/1` types).
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
- **Phase 3 (backlog):** Workers for Platforms / dynamic dispatch so a module installs without
  redeploying the core. The frontend is already a projection of the registry, so it needs no change.

## Non-goals (v1)

- No module-to-module calls. Modules talk only to the core, through hooks. (Keeps the graph a star,
  not a web.)
- No dynamic install yet (Phase 3). v1 modules are bound at deploy.
- Capabilities beyond the render spine belong in modules, not inlined in the core.
