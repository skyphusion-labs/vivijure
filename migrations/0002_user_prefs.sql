-- Vivijure Studio -- user_prefs (migration 0002).
--
-- Studio-wide settings singleton. The first pref is emailNotifications (default false): opt-in
-- render-done mail. Read with defaults via GET /api/prefs; written by PATCH /api/prefs.
--
-- SQUASHED 2026-07-02 (cold-deploy dry run, finding F12): originally per-user keyed on the
-- Cloudflare Access email (PK = user_email); the #292 identity strip (migrations/manual/0004)
-- recreated it as this global singleton, and user-prefs.ts writes (id, prefs_json, updated_at).
-- A fresh install building the old shape had NO id column, so every prefs write failed. Same
-- filename-tracking safety argument as 0001; see the 0001 header.

CREATE TABLE IF NOT EXISTS user_prefs (
  id          INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton: exactly one row
  prefs_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);
