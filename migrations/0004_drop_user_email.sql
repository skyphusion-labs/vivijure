-- Vivijure Studio -- drop user_email (migration 0004).
--
-- Vivijure is a SINGLE-OPERATOR studio; user_email was legacy multi-tenant cruft from the AI
-- Playground. Removing the tenancy/identity primitive is a deliberate anti-SaaS design (memory:
-- vivijure-user-email-strip): with no tenant/identity seam, a forker cannot trivially turn the AGPL
-- studio into a hosted multi-tenant SaaS. This drops the column from every table and re-keys the
-- formerly per-user indexes to global.
--
-- DESTRUCTIVE (drops columns / recreates a table -- irreversible). It is intentionally kept OUT of
-- the auto additive-only `wrangler d1 migrations apply` CI step; it is applied in a SUPERVISED
-- window with a prod D1 backup taken first (manual gate, owned by infra). SQLite supports
-- ALTER TABLE DROP COLUMN (>= 3.35), but only when the column is unreferenced by an index -- hence
-- each DROP INDEX precedes its DROP COLUMN. user_prefs keys user_email as its PRIMARY KEY (a PK
-- column cannot be dropped in place), so it is recreated as a global singleton.

-- storyboard_projects: per-user slug-unique -> global slug-unique.
DROP INDEX IF EXISTS idx_projects_user_slug;
ALTER TABLE storyboard_projects DROP COLUMN user_email;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON storyboard_projects (slug);

-- cast_members: per-user slug-unique -> global slug-unique.
DROP INDEX IF EXISTS idx_cast_user_slug;
ALTER TABLE cast_members DROP COLUMN user_email;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cast_slug ON cast_members (slug);

-- renders: list hot path no longer scoped by user.
DROP INDEX IF EXISTS idx_renders_user_project_submitted;
ALTER TABLE renders DROP COLUMN user_email;
CREATE INDEX IF NOT EXISTS idx_renders_project_submitted ON renders (project_id, submitted_at DESC);

-- user_prefs: per-user (PK = user_email) -> global studio singleton. A PK column cannot be dropped
-- in place, so recreate with a fixed single-row id. Collapse to the most-recent existing row (with
-- one operator there is at most one meaningful row); defaults apply if the table was empty.
CREATE TABLE user_prefs_new (
  id          INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton: exactly one row
  prefs_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);
INSERT INTO user_prefs_new (id, prefs_json, updated_at)
  SELECT 1, prefs_json, updated_at FROM user_prefs ORDER BY updated_at DESC LIMIT 1;
DROP TABLE user_prefs;
ALTER TABLE user_prefs_new RENAME TO user_prefs;
