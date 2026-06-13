-- Vivijure Studio -- D1 schema of record (migration 0001).
--
-- Authored 2026-06-13 as part of the Phase-1 render-migration standup (epic #25, closes #11).
-- The render-island modules (renders-db.ts, cast-db.ts, storyboard-projects-db.ts) were moved in
-- with NO CREATE TABLE anywhere; this file is the canonical, replayable schema, reconstructed from
-- the columns those modules read/write. Fresh DB by design (Conrad: "just use a clean db" -- no
-- migration of the old playground data). Apply with:
--   wrangler d1 migrations apply vivijure-studio
-- Ownership model: every row is scoped by user_email; handlers filter on it. (The "anonymous"
-- fallback in shared.ts:getUserEmail is a Stage-2 hardening item, vivijure#4.)

-- ---------------------------------------------------------------------------
-- storyboard_projects: a user's named planning project (prefs + last storyboard).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storyboard_projects (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email           TEXT    NOT NULL,
  slug                 TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  prefs_json           TEXT    NOT NULL DEFAULT '{}',
  last_storyboard_json TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- Per-user slug uniqueness (allocateProjectSlug relies on it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_slug
  ON storyboard_projects (user_email, slug);

-- ---------------------------------------------------------------------------
-- cast_members: a user's character (bible, portrait/ref images, trained LoRA).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cast_members (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email       TEXT    NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_cast_user_slug
  ON cast_members (user_email, slug);

-- ---------------------------------------------------------------------------
-- renders: one submitted render job (RunPod), its lifecycle, output + metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS renders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email        TEXT    NOT NULL,
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
-- List endpoint hot path (v0.55.0): renders for a user, optionally a project, newest first.
CREATE INDEX IF NOT EXISTS idx_renders_user_project_submitted
  ON renders (user_email, project_id, submitted_at DESC);
-- Scatter/finalize children lookup by parent.
CREATE INDEX IF NOT EXISTS idx_renders_parent
  ON renders (parent_id);
