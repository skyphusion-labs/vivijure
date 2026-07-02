#!/usr/bin/env bash
# Vivijure Studio -- one-script deploy.
#
# Supply your keys in deploy.env (copy deploy.env.example), then run:  ./deploy.sh
# It is idempotent and re-runnable, and it FAILS CLOSED: any error stops the whole run so you
# never ship a half-configured studio. Read docs/DEPLOYMENT.md for what each key is and why.
#
# Two profiles (set VIVIJURE_PROFILE in deploy.env):
#   minimal -> studio core + cloud/own-GPU render (Cloudflare + RunPod + AI Gateway only).
#   full    -> also the finish modules that need your own CPU boxes or a 2nd RunPod endpoint.
# A minimal deploy STRIPS the "# >>> OPTIONAL: ... # <<< OPTIONAL:" blocks from wrangler.toml.example
# so those extra bindings never dangle and break the deploy.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

say()  { printf "\n==> %s\n" "$*"; }
info() { printf "    %s\n" "$*"; }
die()  { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

WR="npx wrangler"                 # the repo-pinned wrangler (run npm install first)

# cut off any accidental VAR= prefix and strip all whitespace/newlines, so a stray paste of
# "NAME=value" or a trailing newline cannot poison a stored secret (see docs/DEPLOYMENT.md).
strip_val() { printf "%s" "$1" | cut -d= -f2- | tr -d "[:space:]"; }

# ---- 0. load and check deploy.env -------------------------------------------
[ -f deploy.env ] || die "deploy.env not found. Run: cp deploy.env.example deploy.env  (then edit it)."
set -a; . ./deploy.env; set +a

VIVIJURE_PROFILE="${VIVIJURE_PROFILE:-minimal}"
case "$VIVIJURE_PROFILE" in
  minimal|full) ;;
  *) die "VIVIJURE_PROFILE must be minimal or full (got: $VIVIJURE_PROFILE)";;
esac

need() { local v; eval "v=\${$1:-}"; [ -n "$v" ] || die "deploy.env: $1 is required but empty -- $2"; }
need CLOUDFLARE_ACCOUNT_ID   "your Cloudflare account id"
need CLOUDFLARE_API_TOKEN    "your Cloudflare API token"
need RUNPOD_API_KEY          "your RunPod API key"
need RUNPOD_ENDPOINT_ID      "your RunPod backend endpoint id"
need R2_S3_ACCESS_KEY_ID     "R2 S3 access key id"
need R2_S3_SECRET_ACCESS_KEY "R2 S3 secret access key"
need GATEWAY_ID              "AI Gateway slug"
need DEPLOY_HOSTNAME         "the hostname your studio serves on"

# Preflight: steps 1-6 run wrangler via npx (auto-fetches), but step 7 is "npm run deploy" ->
# bare "wrangler", which is only on PATH once node_modules exists. Without this, a fresh clone
# runs ~10 green minutes and dies at the LAST step with exit 127 "wrangler: not found"
# (cold-deploy verify, finding F13). Install up front so the failure cannot happen at the end.
if [ ! -d node_modules ]; then
  say "Preflight: installing npm dependencies (node_modules missing)"
  npm ci || die "npm ci failed -- fix the Node/npm install, then re-run ./deploy.sh"
fi
# Auth gate (#423, matches CI and docs/SECURITY.md). token (default) = the built-in bearer-token
# login: this script mints a 256-bit token, stores it as a worker secret, and prints it ONCE at
# the end -- no Zero Trust product needed. access = Cloudflare Access in front of the studio; the
# two Zero Trust identifiers are then required so the in-worker verification arms fail-closed.
AUTH_MODE="${AUTH_MODE:-token}"
case "$AUTH_MODE" in
  token)
    ACCESS_TEAM_DOMAIN=""; ACCESS_AUD=""   # rendered empty; the token gate ignores them
    ;;
  access)
    need ACCESS_TEAM_DOMAIN  "Cloudflare Access team domain -- required when AUTH_MODE=access"
    need ACCESS_AUD          "Cloudflare Access application AUD -- required when AUTH_MODE=access"
    ;;
  *) die "AUTH_MODE must be token or access (got: $AUTH_MODE)";;
esac

# derived defaults
R2_S3_BUCKET="${R2_S3_BUCKET:-vivijure}"
R2_S3_ENDPOINT="${R2_S3_ENDPOINT:-https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com}"
SPEND_RATE_LIMITER_NS_ID="${SPEND_RATE_LIMITER_NS_ID:-1001}"
WEB_ANALYTICS_TOKEN="${WEB_ANALYTICS_TOKEN:-}"

export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN

# The module workers this profile deploys. Explicit (not a glob) so a work-in-progress module in
# modules/ is never picked up by accident, and the list matches the profile boundary in the docs.
MIN_MODULES="own-gpu seedance kling keyframe cloud-keyframe finish-rife plan-enhance cast-image \
notify-email music-gen narration-gen dialogue-gen minimax-hailuo google-veo vidu-q3 alibaba-wan \
alibaba-wan-lora"
OPT_MODULES="finish-upscale text-overlay film-titles subtitle beat-sync audio-master \
finish-lipsync speech-upscale"
if [ "$VIVIJURE_PROFILE" = full ]; then MODULES="$MIN_MODULES $OPT_MODULES"; else MODULES="$MIN_MODULES"; fi

say "Vivijure Studio deploy -- profile: $VIVIJURE_PROFILE, auth: $AUTH_MODE, hostname: $DEPLOY_HOSTNAME"

# ---- 1. D1 database ----------------------------------------------------------
say "Step 1/8: D1 database vivijure-studio"
D1_ID="$($WR d1 info vivijure-studio --json 2>/dev/null \
  | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); print(d.get(\"uuid\") or d.get(\"database_id\") or \"\")
except Exception:
    print(\"\")" 2>/dev/null || true)"
if [ -z "$D1_ID" ]; then
  out="$($WR d1 create vivijure-studio 2>&1)" || { printf "%s\n" "$out"; die "d1 create failed"; }
  D1_ID="$(printf "%s" "$out" | grep -oE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" | head -1)"
  [ -n "$D1_ID" ] || { printf "%s\n" "$out"; die "could not read the new D1 id"; }
  info "created D1 vivijure-studio ($D1_ID)"
else
  info "D1 vivijure-studio already exists ($D1_ID)"
fi
export D1_DATABASE_ID="$D1_ID"

# ---- 2. R2 buckets -----------------------------------------------------------
say "Step 2/8: R2 buckets (vivijure, skyphusion-llm)"
for b in vivijure skyphusion-llm; do
  if $WR r2 bucket info "$b" >/dev/null 2>&1; then
    info "bucket $b already exists"
  else
    if out="$($WR r2 bucket create "$b" 2>&1)"; then
      info "created bucket $b"
    elif printf "%s" "$out" | grep -qiE "already|exists|10004"; then
      info "bucket $b already exists"
    else
      printf "%s\n" "$out"
      # A fresh account that never enabled R2 fails here with API code 10042; the raw error does
      # not say what to do. R2 enable is a one-time ToS + billing gate that cannot be scripted.
      if printf "%s" "$out" | grep -q "10042"; then
        die "R2 is not enabled on this account. Enable it once (ToS + billing) at https://dash.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/r2 then re-run ./deploy.sh"
      fi
      die "r2 bucket create $b failed"
    fi
  fi
done

# ---- 3. Secrets Store (module secrets) --------------------------------------
say "Step 3/8: Cloudflare Secrets Store (module secrets)"
STORE_ID="$($WR secrets-store store list --remote 2>/dev/null | grep -oE "[0-9a-f]{32}" | head -1 || true)"
if [ -z "$STORE_ID" ]; then
  out="$($WR secrets-store store create vivijure --remote 2>&1)" || { printf "%s\n" "$out"; die "store create failed"; }
  STORE_ID="$(printf "%s" "$out" | grep -oE "[0-9a-f]{32}" | head -1)"
  [ -n "$STORE_ID" ] || { printf "%s\n" "$out"; die "could not read the new store id"; }
  info "created Secrets Store ($STORE_ID)"
else
  info "using Secrets Store $STORE_ID"
fi

seed_secret() {   # name value
  local name="$1" val id
  val="$(strip_val "$2")"
  [ -n "$val" ] || die "refusing to seed empty secret $name"
  id="$($WR secrets-store secret list "$STORE_ID" --remote --per-page 100 2>/dev/null \
        | grep -w "$name" | grep -oiE "[0-9a-f]{32}" | head -1 || true)"
  if [ -n "$id" ]; then
    printf "%s" "$val" | $WR secrets-store secret update "$STORE_ID" --secret-id "$id" --scopes workers --remote >/dev/null
    info "updated $name"
  else
    printf "%s" "$val" | $WR secrets-store secret create "$STORE_ID" --name "$name" --scopes workers --remote >/dev/null
    info "created $name"
  fi
}
seed_secret RUNPOD_API_KEY            "$RUNPOD_API_KEY"
seed_secret GATEWAY_ID                "$GATEWAY_ID"
seed_secret BACKEND_RUNPOD_ENDPOINT_ID "$RUNPOD_ENDPOINT_ID"
if [ "$VIVIJURE_PROFILE" = full ]; then
  [ -n "${VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID:-}" ] || die "full profile: VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID required (finish-upscale)"
  [ -n "${MUSETALK_RUNPOD_ENDPOINT_ID:-}" ]      || die "full profile: MUSETALK_RUNPOD_ENDPOINT_ID required (finish-lipsync)"
  seed_secret VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID "$VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID"
  seed_secret MUSETALK_RUNPOD_ENDPOINT_ID      "$MUSETALK_RUNPOD_ENDPOINT_ID"
fi

# Point every module we are about to deploy at YOUR store. The committed configs ship the
# REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID placeholder (no real store id in the public repo); this
# rewrite fills it. The pattern matches whatever is inside the quotes (placeholder OR a prior id),
# so a re-run is idempotent.
info "wiring your store id into the module configs"
for m in $MODULES; do
  f="modules/$m/wrangler.toml"
  [ -f "$f" ] || die "missing $f"
  sed -i -E "s/store_id = \"[^\"]*\"/store_id = \"$STORE_ID\"/g" "$f"
done

# ---- 4. render wrangler.toml from the template ------------------------------
say "Step 4/8: render wrangler.toml ($VIVIJURE_PROFILE profile)"
command -v envsubst >/dev/null || die "envsubst not found -- install gettext (apt-get install gettext-base)"
export AUTH_MODE ACCESS_TEAM_DOMAIN ACCESS_AUD D1_DATABASE_ID WEB_ANALYTICS_TOKEN SPEND_RATE_LIMITER_NS_ID
export VPC_VIDEO_FINISH_ID="${VPC_VIDEO_FINISH_ID:-}" VPC_IMAGE_PREP_ID="${VPC_IMAGE_PREP_ID:-}" \
       VPC_AUDIO_BEAT_SYNC_ID="${VPC_AUDIO_BEAT_SYNC_ID:-}" VPC_AUDIO_MIX_ID="${VPC_AUDIO_MIX_ID:-}"
VARS="\$AUTH_MODE \$ACCESS_TEAM_DOMAIN \$ACCESS_AUD \$D1_DATABASE_ID \$VPC_VIDEO_FINISH_ID \$VPC_IMAGE_PREP_ID \$VPC_AUDIO_BEAT_SYNC_ID \$VPC_AUDIO_MIX_ID \$SPEND_RATE_LIMITER_NS_ID \$WEB_ANALYTICS_TOKEN"

if [ "$VIVIJURE_PROFILE" = minimal ]; then
  # drop each OPTIONAL block whole (markers + body): these need OUR fleet or a 2nd endpoint.
  awk "/^# >>> OPTIONAL:/{skip=1;next} /^# <<< OPTIONAL:/{skip=0;next} !skip" wrangler.toml.example > .wrangler.stage.toml
else
  # full: keep the bodies, drop only the marker + its two description lines (cosmetic).
  awk "/^# >>> OPTIONAL:/{skipn=2;next} skipn>0{skipn--;next} /^# <<< OPTIONAL:/{next} {print}" wrangler.toml.example > .wrangler.stage.toml
  for v in VPC_VIDEO_FINISH_ID VPC_IMAGE_PREP_ID VPC_AUDIO_BEAT_SYNC_ID VPC_AUDIO_MIX_ID; do
    eval "vv=\${$v:-}"; [ -n "$vv" ] || die "full profile: $v required (set it in deploy.env, or use VIVIJURE_PROFILE=minimal)"
  done
fi
envsubst "$VARS" < .wrangler.stage.toml > wrangler.toml
rm -f .wrangler.stage.toml
# retarget the route: the template ships OUR production hostname; point it at yours.
sed -i -E "s|^pattern = \"[^\"]+\"|pattern = \"$DEPLOY_HOSTNAME\"|" wrangler.toml
# No domain? A *.workers.dev DEPLOY_HOSTNAME cannot be a custom-domain route (Cloudflare rejects
# it) -- serve on the built-in workers.dev subdomain instead: flip workers_dev on and drop the
# [[routes]] block entirely. Found as cold-run F1: this used to require hand-editing the template.
case "$DEPLOY_HOSTNAME" in
  *.workers.dev)
    sed -i -E "s|^workers_dev = false|workers_dev = true|" wrangler.toml
    sed -i "/^\[\[routes\]\]/,/^custom_domain = true/d" wrangler.toml
    info "workers.dev target: workers_dev=true, custom-domain route dropped"
    ;;
esac
# fail-closed: no leftover placeholder, AUTH_MODE rendered non-empty, and in access mode the
# Access vars must be present + non-empty (empty would unarm the F2 backstop -> DENY-everything).
if grep -q "\${" wrangler.toml; then grep -n "\${" wrangler.toml; die "unsubstituted placeholder left in wrangler.toml"; fi
grep -Eq "AUTH_MODE = \".+\"" wrangler.toml || die "AUTH_MODE is empty after render -- refusing to deploy an unauthenticated studio"
if [ "$AUTH_MODE" = access ]; then
  grep -Eq "ACCESS_AUD = \".+\"" wrangler.toml && grep -Eq "ACCESS_TEAM_DOMAIN = \".+\"" wrangler.toml \
    || die "F2 Access vars are empty after render -- refusing to deploy an unauthenticated studio"
fi
info "rendered wrangler.toml ($(wc -l < wrangler.toml) lines), route -> $DEPLOY_HOSTNAME"

# ---- 5. D1 migrations --------------------------------------------------------
say "Step 5/8: apply D1 migrations"
$WR d1 migrations apply vivijure-studio --remote

# ---- 6. module workers (BEFORE the core) ------------------------------------
say "Step 6/8: deploy module workers -- these MUST ship before the core"
for m in $MODULES; do
  info "deploying vivijure-module-$m"
  # Retry a transient Cloudflare API flake (e.g. 10013 on the per-worker /subdomain call) so a
  # single hiccup does not abort the whole ordered deploy under set -e.
  n=0
  until $WR deploy -c "modules/$m/wrangler.toml"; do
    n=$((n+1)); [ "$n" -ge 3 ] && die "module $m failed to deploy after 3 attempts"
    info "  transient deploy failure for $m -- retry $n/3"; sleep 3
  done
done
info "deployed $(printf "%s" "$MODULES" | wc -w) module worker(s)"

# ---- 7. core worker ----------------------------------------------------------
say "Step 7/8: deploy the core studio worker"
npm run deploy

# ---- 8. core worker secrets (applied live; safe after deploy) ---------------
say "Step 8/8: set core worker secrets"
put_secret() { printf "%s" "$(strip_val "$2")" | $WR secret put "$1" >/dev/null && info "set $1"; }
put_secret CLOUDFLARE_ACCOUNT_ID    "$CLOUDFLARE_ACCOUNT_ID"
put_secret RUNPOD_API_KEY           "$RUNPOD_API_KEY"
put_secret RUNPOD_ENDPOINT_ID       "$RUNPOD_ENDPOINT_ID"
put_secret R2_S3_ACCESS_KEY_ID      "$R2_S3_ACCESS_KEY_ID"
put_secret R2_S3_SECRET_ACCESS_KEY  "$R2_S3_SECRET_ACCESS_KEY"
put_secret R2_S3_ENDPOINT           "$R2_S3_ENDPOINT"
put_secret R2_S3_BUCKET             "$R2_S3_BUCKET"
put_secret GATEWAY_ID               "$GATEWAY_ID"
if [ "$AUTH_MODE" = token ]; then
  # Mint the studio API token: 256 bits of randomness, hex. Stored as a worker secret; printed
  # ONCE in the final banner below and NEVER written to any file. openssl is near-universal;
  # python3 (already required by step 1) is the fallback.
  if command -v openssl >/dev/null; then
    STUDIO_API_TOKEN="$(openssl rand -hex 32)"
  else
    STUDIO_API_TOKEN="$(python3 -c "import secrets; print(secrets.token_hex(32))")"
  fi
  put_secret STUDIO_API_TOKEN "$STUDIO_API_TOKEN"
fi

say "Done. Your studio is live at: https://$DEPLOY_HOSTNAME"
if [ "$AUTH_MODE" = token ]; then
cat <<MSG

  ============================= SAVE THIS NOW =============================
  Your studio API token (shown ONCE, stored nowhere else):

      $STUDIO_API_TOKEN

  This is your login. Open https://$DEPLOY_HOSTNAME and paste it when the
  studio asks; API callers send it as  Authorization: Bearer <token>.
  Lost it? Re-run:  openssl rand -hex 32 | npx wrangler secret put STUDIO_API_TOKEN
  (then paste the new value in the studio). See docs/SECURITY.md section 1b.
  =========================================================================

  Optional hardening (teams/orgs): put Cloudflare Access in front of the hostname
  and redeploy with AUTH_MODE=access. See docs/SECURITY.md.

  Profile: $VIVIJURE_PROFILE. To add the finish modules later, set VIVIJURE_PROFILE=full in
  deploy.env (with the extra endpoint + VPC ids) and re-run ./deploy.sh.
MSG
else
cat <<MSG

  REQUIRED next step (security): put Cloudflare Access IN FRONT of https://$DEPLOY_HOSTNAME
  (Zero Trust -> Access -> Applications). AUTH_MODE=access arms the in-worker backstop with
  ACCESS_TEAM_DOMAIN/ACCESS_AUD, but you still need the Access app itself on the hostname,
  or anyone can read and delete your projects. See docs/SECURITY.md.

  Profile: $VIVIJURE_PROFILE. To add the finish modules later, set VIVIJURE_PROFILE=full in
  deploy.env (with the extra endpoint + VPC ids) and re-run ./deploy.sh.
MSG
fi
