-- Vivijure Studio -- user_prefs (migration 0002).
--
-- Per-user settings keyed by Cloudflare Access email. The first pref is
-- emailNotifications (default false): opt-in render-done mail. Read with
-- defaults via GET /api/prefs; written by PATCH /api/prefs.

CREATE TABLE IF NOT EXISTS user_prefs (
  user_email  TEXT PRIMARY KEY,
  prefs_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);
