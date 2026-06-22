# Changelog

Notable changes per release. SemVer-style (pre-1.0: PATCH for fixes / backend-only tweaks, MINOR
for new features). Newest first.

## v0.2.4

**Cloud i2v duration enum fix.** Unblocks the cloud motion backends for short shots.

- **kling + wan duration snap (#241):** the Kling ({5,10}) and Wan 2.6 ({5,10,15}) cloud i2v modules accept only a discrete duration enum, not a continuous range; the old continuous clamp passed a 4s shot straight through and the provider 400'd at submit (so a cloud talking render failed before any clip rendered). Duration now snaps UP to the smallest allowed value at or above the per-shot seconds (4s -> 5; a 7s shot -> 10, never clipped shorter than the shot). The other six cloud modules likely share the bug; tracked as follow-up.
- **683 tests**, typecheck-clean.

## v0.2.3

**Finish-chain self-heal: a GC'd or frozen mid-chain finish step now recovers from R2.** Builds on v0.2.2's silent-render fixes.

- **R2-presence advance for any finish step (#239):** when a finish step's RunPod poll job is GC'd-after-complete (a 404) or freezes IN_PROGRESS (poll pends forever), and that step's OWN expected output is already in R2, the orchestrator folds it in and advances to the next module -- instead of polling a ghost job to the hard deadline. This fixes the wedge where RIFE completed and its output landed in R2 but the finish chain never advanced, so lip-sync was never dispatched and the shot pended forever. Per-step advance on the step's own artifact (not final-artifact adoption), so the remaining modules still run -- it cannot ship a half-finished clip.
- **682 tests**, typecheck-clean.

## v0.2.2

**The talking-character showcase fix: a scatter film keeps its voice end to end.** Builds on v0.2.1's self-heal so the orchestration now reliably delivers per-shot dialogue + lip-sync through gather and assemble.

- **Scatter keeps clip audio (#234):** when a render has dialogue, the gather concat now preserves each lip-synced clip's baked-in audio (and silent-pads an audio-less clip to a uniform track), instead of stripping all audio and producing a silent film.
- **No mid-chain finish adoption (#234):** a finish shot whose module fails mid-chain is no longer adopted from its intermediate R2 clip as "done" -- only the chain's final artifact is adoptable, so a failed lip-sync can no longer masquerade as a finished (silent) clip.
- **Bounded finish-step retry (#234):** a transient finish-module blip (5xx / timeout / lost poll token) re-dispatches the step up to 3 attempts; a deterministic reject (4xx / no face) still fails loud -- so a momentary MuseTalk cold-start no longer silences a shot.
- **Watchdog spares D1-blocked shards (#230):** a shard that is merely retrying a transient D1 error is no longer declared dead by the watchdog.
- **voiced-verify (#236):** a `scripts/` checker that gates a render on per-shot lip-sync + non-silent audio (volumedetect), not just stream presence.
- **677 tests**, typecheck-clean.

## v0.2.1

**Production hardening: tag-gated deploys + render self-heal.** First release cut under the new tag gate.

- **Tag-gated deploys (#228):** a push/merge to `main` now runs typecheck + test only; the Cloudflare deploy (module workers -> D1 migrations -> core) fires ONLY on a pushed `v*` SemVer tag. A merge can no longer redeploy production or interrupt an in-flight render.
- **D1 transient self-heal (#229):** the render-advance hot path retries transient `D1_ERROR` internal blips (4 attempts, short backoff) while constraint / SQL errors still fail fast, so a momentary D1 hiccup no longer wedges a shard until the watchdog -- the every-60s sweep now genuinely self-heals.
- **trainLoras fails hard (#227):** a render bound to a character with no trained cast LoRA now 400s naming the character ("train them on the Cast page first") instead of silently inline-retraining the LoRA every render.
- **665 tests**, typecheck-clean.

## v0.2.0

**Phase 1: render API + studio UI.** The film studio is fully home in this worker; the AI Playground
(`skyphusion-llm-public`) no longer owns render or planner routes.

- **Render spine:** film orchestrator (keyframe -> motion -> finish -> assemble), scatter-gather,
  render-from-keyframes, regen-shot, cron sweep for orphaned jobs, module-driven overrides UI.
- **Cast:** training-set gen via `cast.image`, LoRA train/status, portrait + multi-scene image chat,
  ref/source management, artifact copy from chat outputs.
- **Library:** renders CRUD, finalize / animate-cloud / animate-hybrid, adopt backfill, prefs,
  notify hook (`notify-email` module).
- **Authoring:** plan / refine / yaml / markers / bundle / score-bed / beat analyze / enhance chain.
- **Eleven module workers** bound in `wrangler.toml` (keyframe, own-gpu, seedance, kling, finish-rife,
  cast-image, notify-email, music-gen, narration-gen, beat-sync, plan-enhance).
- **368+ tests**, typecheck-clean CI.

## v0.1.0

**Phase 0: the module host.** First cut of Vivijure Studio as a standalone Cloudflare Worker, split
out of `skyphusion-llm-public` so the AI Playground and the film studio no longer share a roof.

- **The module contract (`vivijure-module/1`)** in `src/modules/types.ts`: hooks, manifest,
  `invoke` envelope, reference `finish` payloads.
- **The registry** in `src/modules/registry.ts`: discovers `MODULE_*` bindings, validates manifests,
  clamps config, indexes by hook.
- **`GET /api/modules`** plus the **self-assembling frontend** (`public/`): UI is a projection of
  the registry; zero modules installed is a valid lean studio.
- **`docs/module-api.md`**: the design spec.
- Tests cover manifest validation, hook indexing, discovery against faked bindings.
