#!/usr/bin/env bash
# Prove the squashed fresh-install migration chain produces the SAME schema as prod's real history.
#
# Background (cold-deploy dry run 2026-07-02, finding F12): the #292 identity strip shipped as
# migrations/manual/0004_drop_user_email.sql, applied to prod by hand in a supervised window; the
# auto-applied numbered chain kept building the PRE-strip schema, so every fresh install got a
# database the code cannot write to. The fix squashed the 0004 end state into 0001/0002. This script
# is the standing proof that the two build paths converge:
#
#   path A (prod history):  old 0001 + 0002 (from the pre-squash git revision) + 0003 + manual/0004 + 0005 + 0006
#   path B (fresh install): squashed 0001 + 0002 + 0003 + 0005 + 0006
#
# It diffs a normalized structural dump (tables, columns, indexes; ordering-insensitive). Exit 0 =
# equivalent. Requires: sqlite3 >= 3.35 (ALTER TABLE DROP COLUMN), python3, git.
#
# PRE_SQUASH_REV pins the last revision whose 0001/0002 are the pre-squash originals; do not float
# it to a branch name, the whole point is replaying the historical path.
set -euo pipefail
cd "$(dirname "$0")/.."

PRE_SQUASH_REV="${PRE_SQUASH_REV:-v0.9.0}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

git show "$PRE_SQUASH_REV:migrations/0001_init.sql"       > "$T/old_0001.sql"
git show "$PRE_SQUASH_REV:migrations/0002_user_prefs.sql" > "$T/old_0002.sql"

# Path A: prod's real history (old chain + the supervised manual strip, in its numeric position).
sqlite3 -bail "$T/a.db" < "$T/old_0001.sql"
sqlite3 -bail "$T/a.db" < "$T/old_0002.sql"
sqlite3 -bail "$T/a.db" < migrations/0003_cast_voice.sql
sqlite3 -bail "$T/a.db" < migrations/manual/0004_drop_user_email.sql
sqlite3 -bail "$T/a.db" < migrations/0005_operator_module_config.sql
sqlite3 -bail "$T/a.db" < migrations/0006_installed_modules.sql

# Path B: what a fresh install builds (the auto-applied numbered chain as checked out).
for f in 0001_init 0002_user_prefs 0003_cast_voice 0005_operator_module_config 0006_installed_modules; do
  sqlite3 -bail "$T/b.db" < "migrations/$f.sql"
done

python3 scripts/schema_dump.py "$T/a.db" > "$T/a.txt"
python3 scripts/schema_dump.py "$T/b.db" > "$T/b.txt"

if diff -u "$T/a.txt" "$T/b.txt"; then
  echo "OK: fresh-install chain is schema-equivalent to prod's migration history."
else
  echo "FAIL: fresh-install schema diverges from prod's end state (diff above)." >&2
  exit 1
fi
