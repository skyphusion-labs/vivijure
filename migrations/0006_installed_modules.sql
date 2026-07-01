-- Vivijure Studio -- installed_modules (migration 0006).
--
-- Phase 3 (Workers for Platforms / dynamic dispatch). A dispatch-world module is NOT an env binding the
-- registry can scan (every module lives behind ONE namespace binding, MODULE_DISPATCH); so the set of
-- installed modules moves into D1, one row per installed module (docs/module-dispatch.md section 3.1).
-- The registry reads these rows, reconstructs each RegisteredModule from the stored manifest, and
-- resolves it at hook time via env.MODULE_DISPATCH.get(script_name). Legacy MODULE_* service bindings
-- keep discovering from env in parallel (dual-resolution, section 6.3); this table is dispatch-only.
--
-- manifest_json is captured at UPLOAD time, after the module passes conformance (section 4.3), because
-- a dispatch module is not enumerable from env; a later module redeploy re-runs the upload path, so the
-- stored copy never silently drifts. `api` is stored so an epoch the host no longer supports is filtered
-- out. `enabled` is the fast kill switch (disable = one write; the script stays resident, section 4.4).
-- A `tenant` column stays addable without a rewrite (single-namespace v1, section 3.1 / risk #2).
--
-- Additive (CREATE TABLE only) -> rides the normal auto-apply; no manual gate.

CREATE TABLE IF NOT EXISTS installed_modules (
  name          TEXT    PRIMARY KEY,      -- the module id (matches manifest.name)
  script_name   TEXT    NOT NULL,         -- the user-Worker script name inside the dispatch namespace
  manifest_json TEXT    NOT NULL,         -- the module.json captured + conformance-checked at upload
  api           TEXT    NOT NULL,         -- manifest.api, so an unsupported epoch is filtered out
  installed_at  INTEGER NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1
);
