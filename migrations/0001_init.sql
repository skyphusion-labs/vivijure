-- Vivijure Studio -- D1 schema of record (migration 0001).
--
-- Authored 2026-06-13 as part of the Phase-1 render-migration standup (epic #25, closes #11).
-- The render-island modules (renders-db.ts, cast-db.ts, storyboard-projects-db.ts) were moved in
-- with NO CREATE TABLE anywhere; this file is the canonical, replayable schema, reconstructed from
-- the columns those modules read/write. Fresh DB by design (Conrad: "just use a clean db" -- no
-- migration of the old playground data). Apply with:
--   wrangler d1 migrations apply vivijure-studio
--
-- SQUASHED 2026-07-02 (cold-deploy dry run, finding F12): this file now creates the POST-#292
-- identity-strip schema directly. The strip (drop user_email everywhere; global slug uniqueness;
-- singleton user_prefs) originally shipped as migrations/manual/0004_drop_user_email.sql, which the
-- migrations_dir scan never auto-applies -- so a fresh install got the pre-strip schema while the
-- code writes post-strip shapes, and EVERY write path failed (project create, prefs save, cast add,
-- render insert). Squashing is safe for existing installs: wrangler d1 tracks applied migrations by
-- FILENAME, so a database that already ran the old 0001 never re-runs this file, and prod applied
-- manual/0004 in its supervised window, landing on this exact end state. An install that ran the
-- old 0001 but never applied manual/0004 is broken today regardless; it must apply manual/0004 once.

-- ---------------------------------------------------------------------------
-- storyboard_projects: a named planning project (prefs + last storyboard).
-- Single-operator studio: no per-user scoping (identity strip, #292).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storyboard_projects (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                 TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  prefs_json           TEXT    NOT NULL DEFAULT '{}',
  last_storyboard_json TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- Global slug uniqueness (allocateProjectSlug relies on it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug
  ON storyboard_projects (slug);

-- ---------------------------------------------------------------------------
-- cast_members: a character (bible, portrait/ref images, trained LoRA).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cast_members (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  bible            TEXT,
  portrait_key     TEXT,
  portrait_mime    TEXT,
  ref_keys_json    TEXT    NOT NULL DEFAULT '[]',   -- [{key,mime}]
  source_keys_json TEXT,                            -- [{key,mime}] (v0.90.0)
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  lora_key         TEXT,
  lora_status      TEXT,                            -- idle|training|ready|failed
  lora_job_id      TEXT,
  lora_error       TEXT,
  lora_trained_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cast_slug
  ON cast_members (slug);

-- ---------------------------------------------------------------------------
-- renders: one submitted render job (RunPod), its lifecycle, output + metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS renders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            TEXT    NOT NULL UNIQUE,        -- RunPod job id; ON CONFLICT(job_id) DO NOTHING
  project           TEXT,
  bundle_key        TEXT,
  quality_tier      TEXT,                           -- draft|standard|final
  render_overrides  TEXT,                           -- JSON
  status            TEXT    NOT NULL,
  submitted_at      INTEGER NOT NULL,               -- unix seconds
  updated_at        INTEGER,
  completed_at      INTEGER,
  output_key        TEXT,
  output_json       TEXT,                           -- JSON
  error             TEXT,
  execution_time_ms INTEGER,
  delay_time_ms     INTEGER,
  label             TEXT,
  keyframes_json    TEXT,                           -- JSON array of KeyframeRef
  mode              TEXT,                           -- full|keyframes-only|finalized|cloud-finalized
  locked_shots_json TEXT,                           -- JSON array
  project_id        INTEGER,                        -- logical FK -> storyboard_projects(id)
  folder_path       TEXT,                           -- free-form "/"-delimited
  tags_json         TEXT,                           -- JSON array
  parent_id         INTEGER,                        -- logical FK -> renders(id) (scatter/finalize)
  finish_state      TEXT,                           -- NULL|finishing|done|failed
  notified_at       INTEGER                         -- unix seconds; set when render-done mail claimed
);
-- List endpoint hot path (v0.55.0): renders, optionally per project, newest first.
CREATE INDEX IF NOT EXISTS idx_renders_project_submitted
  ON renders (project_id, submitted_at DESC);
-- Scatter/finalize children lookup by parent.
CREATE INDEX IF NOT EXISTS idx_renders_parent
  ON renders (parent_id);
