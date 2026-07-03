-- Vivijure Studio -- migration 0010: unguessable public ids (security finding F13, sprint S9).
--
-- The three externally-addressable resource tables (storyboard_projects, cast_members, renders)
-- used INTEGER PRIMARY KEY AUTOINCREMENT as their PUBLIC id, so every `:id` route param was a
-- trivially enumerable sequential integer (count 1, 2, 3 to walk the whole library; GET
-- /api/cast/export/:id could exfiltrate a character bundle by guessing its id). Single-operator
-- token gate or not, defense-in-depth requires the capability itself to be unguessable.
--
-- FIX (defense-in-depth, NOT an ownership model -- the studio stays single-operator): add a
-- `public_id` column carrying a UUID v4 (122 bits of entropy, UUID-class per the S9 contract). The
-- internal INTEGER PK and every internal FK (renders.project_id, renders.parent_id) are UNCHANGED;
-- public_id is the ONLY id that leaves the core over the API, and every `:id` route resolves
-- public_id -> internal row (a bare integer matches no public_id and 404s). New rows get their
-- public_id from crypto.randomUUID() in the insert path (cast-db / storyboard-projects-db /
-- renders-db); this migration backfills the EXISTING rows.
--
-- Backfill generates a canonical v4 UUID per row in pure SQL (randomblob is evaluated per row, so
-- each row gets a distinct value): 8-4-4-4-12 lowercase hex, version nibble 4, variant nibble in
-- [89ab] -- byte-for-byte the same shape crypto.randomUUID() emits, so one format serves both the
-- backfilled rows and every future insert. Apply with:
--   wrangler d1 migrations apply vivijure-studio
--
-- Fresh installs: 0001 creates these tables WITHOUT public_id, then this migration ADDs it, so the
-- ALTER never collides. Existing installs (0001..0009 already applied) run only this file. Both
-- converge on the same end state; 0001 is intentionally left untouched (wrangler tracks applied
-- migrations by filename).

-- ---------------------------------------------------------------------------
-- storyboard_projects
-- ---------------------------------------------------------------------------
ALTER TABLE storyboard_projects ADD COLUMN public_id TEXT;
UPDATE storyboard_projects SET public_id = (
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )
) WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_public_id
  ON storyboard_projects (public_id);

-- ---------------------------------------------------------------------------
-- cast_members
-- ---------------------------------------------------------------------------
ALTER TABLE cast_members ADD COLUMN public_id TEXT;
UPDATE cast_members SET public_id = (
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )
) WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cast_public_id
  ON cast_members (public_id);

-- ---------------------------------------------------------------------------
-- renders
-- ---------------------------------------------------------------------------
ALTER TABLE renders ADD COLUMN public_id TEXT;
UPDATE renders SET public_id = (
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )
) WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_renders_public_id
  ON renders (public_id);
