#!/usr/bin/env bash
# Push vivijure-studio runtime secrets to the deployed worker, from the crew-secrets env.
# Prereq: `source ~/.config/crew/load.sh` (so CF_AIG_TOKEN, RUNPOD_API_KEY, R2_* are set) and
# the worker already deployed (wrangler secret put needs an existing worker).
# Values are PIPED to wrangler, never echoed.
set -uo pipefail
put() { printf '%s' "$2" | npx --no-install wrangler secret put "$1" >/dev/null 2>&1 && echo "  set $1" || echo "  FAILED $1"; }

[ -n "${CF_AIG_TOKEN:-}" ]        && put CF_AIG_TOKEN          "$CF_AIG_TOKEN"        || echo "  skip CF_AIG_TOKEN (unset)"
[ -n "${XAI_API_KEY:-}" ]         && put XAI_API_KEY           "$XAI_API_KEY"         || echo "  skip XAI_API_KEY (unset)"
[ -n "${RUNPOD_API_KEY:-}" ]      && put RUNPOD_API_KEY        "$RUNPOD_API_KEY"      || echo "  skip RUNPOD_API_KEY (unset)"
[ -n "${RUNPOD_ENDPOINT_ID:-}" ] && put RUNPOD_ENDPOINT_ID    "$RUNPOD_ENDPOINT_ID"  || echo "  skip RUNPOD_ENDPOINT_ID (unset)"
put GATEWAY_ID         "${GATEWAY_ID:-skyphusion-llm}"
[ -n "${R2_ACCESS_KEY_ID:-}" ]    && put R2_S3_ACCESS_KEY_ID   "$R2_ACCESS_KEY_ID"    || echo "  skip R2_S3_ACCESS_KEY_ID (unset)"
[ -n "${R2_SECRET_ACCESS_KEY:-}" ]&& put R2_S3_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY" || echo "  skip R2_S3_SECRET_ACCESS_KEY (unset)"
[ -n "${R2_ENDPOINT:-}" ]         && put R2_S3_ENDPOINT        "$R2_ENDPOINT"         || echo "  skip R2_S3_ENDPOINT (unset)"
put R2_S3_BUCKET "${R2_S3_BUCKET:-vivijure}"
echo "done -- secrets pushed to vivijure-studio"
