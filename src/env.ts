// Worker Env binding for the Vivijure studio core.
//
// Hand-authored interface mirroring wrangler.example.toml (the committed template; the real
// wrangler.toml is gitignored). Adding a binding: update wrangler.example.toml, then mirror it here.
//
// MODULE BINDINGS: opt-in module workers attach as service bindings named `MODULE_<NAME>` (Fetcher).
// They are NOT statically listed here because the whole point is that a deployment installs only the
// modules it wants; the registry discovers them at runtime by scanning for the `MODULE_` prefix (see
// src/modules/registry.ts). The index signature below types that convention without forcing any
// specific module to exist.

export interface Env {
  // Static frontend (the studio UI), served via Workers Assets.
  ASSETS: Fetcher;

  // Phase 1+ (render API migration): these arrive as the render routes move in from
  // skyphusion-llm-public. Declared optional so the Phase 0 module-host skeleton typechecks and
  // deploys without them. (R2_RENDERS is already its own bucket, `vivijure`.)
  AI?: Ai;
  GATEWAY_ID?: string;
  R2_RENDERS?: R2Bucket;
  DB?: D1Database;

  // Opt-in module workers: `MODULE_<NAME>` service bindings. Discovered by the registry.
  [key: `MODULE_${string}`]: Fetcher | undefined;
}
