# Changelog

Notable changes per release. SemVer-style (pre-1.0: PATCH for fixes / backend-only tweaks, MINOR
for new features). Newest first.

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
