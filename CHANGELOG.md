# Changelog

Notable changes per release. SemVer-style (pre-1.0: PATCH for fixes / backend-only tweaks, MINOR
for new features). Newest first.

## v0.1.0

**Phase 0: the module host.** First cut of Vivijure Studio as a standalone Cloudflare Worker --
the new, clean home for the studio, split out of `skyphusion-llm-public` so the AI Playground stops
sharing a roof with a film studio.

This release is the spine, deliberately free of any render feature:

- **The module contract (`vivijure-module/1`)** in `src/modules/types.ts`: the typed boundary
  between the core and opt-in module workers -- hooks (`motion.backend`, `finish`, `score`,
  `plan.enhance`), the `module.json` manifest, the `invoke` envelope, and the `finish` hook payloads
  worked out in full as the reference.
- **The registry** in `src/modules/registry.ts`: discovers `MODULE_*` service bindings, reads + 
  validates each manifest (best-effort -- a bad or unreachable module is dropped, never fatal),
  clamps user config against a module's declared schema, and indexes everything by hook.
- **`GET /api/modules`** plus the **self-assembling frontend** (`public/`): the studio UI is a
  projection of the registry. Zero modules installed is a valid, lean studio; installing a module
  makes its section appear, hardcoded nowhere.
- **`docs/module-api.md`**: the full design spec.
- Tests cover manifest + config validation, hook indexing, the response shape, and discovery against
  faked bindings.

The render API does not move in this release; the core never grows a feature it could host as a
module instead. Phase 1 migrates the render routes in behind the hooks, and `finish` ships as
module #1.
