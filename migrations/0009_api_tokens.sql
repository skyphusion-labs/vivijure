-- #445: named per-consumer bearer tokens beside the operator login. Only the SHA-256 hex hash of
-- a token is ever stored; the plaintext exists once, at mint time, in the operator's 600-mode file.
CREATE TABLE IF NOT EXISTS api_tokens (
  name       TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash);
