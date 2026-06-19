# Changelog

Notable changes per release. SemVer-style (pre-1.0: PATCH for fixes / backend-only tweaks, MINOR
for new features). Newest first.

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
