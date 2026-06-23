-- Vivijure Studio -- operator_module_config (migration 0005).
--
-- INSTANCE-scoped, operator-set-once module config (NOT per-user: the identity strip (#292) zeroed
-- user_email, so this store is keyed on the module + field, one row per install-scope knob). It backs
-- config_schema fields marked scope:"install" (e.g. notify-email's notify_email recipient): the
-- operator sets them on the studio settings page, the core persists them HERE, and injects them into
-- the module invoke at hook time. Read/written via GET/PATCH /api/modules/:name/config.
--
-- Additive (CREATE TABLE only) -> rides the normal auto-apply; no manual gate.

CREATE TABLE IF NOT EXISTS operator_module_config (
  module_name  TEXT    NOT NULL,
  field_key    TEXT    NOT NULL,
  value_json   TEXT    NOT NULL,          -- JSON-encoded scalar (string/number/bool), clamped on write
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (module_name, field_key)
);
