#!/usr/bin/env bash
# studio-consumer-token.sh -- mint / revoke / list named per-consumer studio API tokens (#445).
#
# A named token is an ADDITIONAL bearer beside the operator login (STUDIO_API_TOKEN): each
# consumer (a bot, a satellite) gets its own credential, independently issuable and revocable, so
# rotating one never touches the others or the operator. Only the SHA-256 hash lands in D1
# (api_tokens, migration 0009); the plaintext exists exactly once, in the 600-mode file this
# script writes at mint time. It is NEVER printed to the terminal.
#
# Usage:
#   scripts/studio-consumer-token.sh mint <name> [--out <file>]   # default out: ./<name>.token
#   scripts/studio-consumer-token.sh revoke <name>
#   scripts/studio-consumer-token.sh list
#
# Requires: npx wrangler (authed to the studio account), openssl. Uses the remote D1 database, so
# run it from the repo root with the same credentials deploy.sh uses.
set -euo pipefail

DB_NAME="vivijure-studio"
WR="npx wrangler"

die() { echo "error: $*" >&2; exit 1; }

d1() { $WR d1 execute "$DB_NAME" --remote --command "$1"; }

# Consumer names travel into SQL and filenames: keep them boring.
check_name() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "name must match [a-z0-9][a-z0-9_-]{0,63}"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  mint)
    name="${1:-}"; shift || true
    check_name "$name"
    out="./${name}.token"
    if [ "${1:-}" = "--out" ]; then out="${2:?--out needs a path}"; fi
    [ -e "$out" ] && die "$out already exists; refusing to overwrite a credential file"
    token="$(openssl rand -hex 32)"
    hash="$(printf %s "$token" | openssl dgst -sha256 -hex | awk '{print $NF}')"
    # INSERT (not upsert): re-minting an existing name must be an explicit revoke + mint with a
    # fresh name-or-decision, never a silent overwrite of a credential some consumer still holds.
    d1 "INSERT INTO api_tokens (name, token_hash) VALUES ('${name}', '${hash}');" >/dev/null
    ( umask 177; printf '%s\n' "$token" > "$out" )
    unset token
    echo "minted named token '${name}'; plaintext written ONLY to ${out} (mode 600)."
    echo "hand it to the consumer (e.g. STUDIO_API_TOKEN in its .env), then delete the file."
    ;;
  revoke)
    name="${1:-}"; check_name "$name"
    d1 "UPDATE api_tokens SET revoked_at = datetime('now') WHERE name = '${name}' AND revoked_at IS NULL;" >/dev/null
    echo "revoked '${name}' (idempotent; a token already revoked or unknown is a no-op)."
    ;;
  list)
    d1 "SELECT name, created_at, revoked_at FROM api_tokens ORDER BY created_at;"
    ;;
  *)
    die "usage: $0 mint <name> [--out <file>] | revoke <name> | list"
    ;;
esac
