#!/usr/bin/env bash
# Vivijure Studio -- one-script deploy.
#
# Supply your keys in deploy.env (copy deploy.env.example), then run:  ./deploy.sh
# It is idempotent and re-runnable, and it FAILS CLOSED: any error stops the whole run so you
# never ship a half-configured studio. Read docs/DEPLOYMENT.md for what each key is and why.
#
# Two profiles (set VIVIJURE_PROFILE in deploy.env):
#   standard   -> studio core + cloud/own-GPU render + the media stack (5 always-on CPU containers
#                 reached over Workers VPC). deploy.sh AUTOMATES the media stack: it creates the
#                 Cloudflare tunnel + the 5 VPC Services and wires their ids in; you just run
#                 `docker compose up` for the containers (#519).
#   satellites -> also the 3 opt-in GPU satellites (upscale / lip-sync / speech-upscale), each on
#                 its own RunPod endpoint.
# The render strips the wrangler.toml.example blocks this deploy does not want: SATELLITE blocks
# unless the satellites profile, the LOCAL-GPU block unless INSTALL_LOCAL_GPU=1, and SELFHOST-SKIP
# (our-fleet-only) blocks always. The media-stack bindings are unconditional (standard).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

say()  { printf "\n==> %s\n" "$*"; }
info() { printf "    %s\n" "$*"; }
die()  { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

WR="npx wrangler"                 # the repo-pinned wrangler (run npm install first)

# CLI flags. --rotate-token forces a fresh STUDIO_API_TOKEN even if one already exists (finding
# F18-lite); by default a re-run KEEPS the existing token so saved studio logins keep working.
ROTATE_TOKEN=""
for arg in "$@"; do
  case "$arg" in
    --rotate-token) ROTATE_TOKEN=1 ;;
    *) die "unknown argument: $arg (supported: --rotate-token)" ;;
  esac
done

# cut off any accidental VAR= prefix and strip all whitespace/newlines, so a stray paste of
# "NAME=value" or a trailing newline cannot poison a stored secret (see docs/DEPLOYMENT.md).
strip_val() { printf "%s" "$1" | cut -d= -f2- | tr -d "[:space:]"; }

# ---- 0. load and check deploy.env -------------------------------------------
[ -f deploy.env ] || die "deploy.env not found. Run: cp deploy.env.example deploy.env  (then edit it)."
set -a; . ./deploy.env; set +a

VIVIJURE_PROFILE="${VIVIJURE_PROFILE:-standard}"
case "$VIVIJURE_PROFILE" in
  standard|satellites) ;;
  # Back-compat with the pre-#519 names. The media stack is STANDARD now, so both old names map onto
  # the new ones (minimal gained the media stack; full == standard + satellites). Warn, do not fail.
  minimal) info "VIVIJURE_PROFILE=minimal is deprecated -> using 'standard' (the media stack is standard now, #519)"; VIVIJURE_PROFILE=standard ;;
  full)    info "VIVIJURE_PROFILE=full is deprecated -> using 'satellites'"; VIVIJURE_PROFILE=satellites ;;
  *) die "VIVIJURE_PROFILE must be standard or satellites (got: $VIVIJURE_PROFILE)";;
esac
# local-gpu is a SEPARATE opt-in (it needs YOUR own local GPU box + a running local backend). Off by
# default: set INSTALL_LOCAL_GPU=1 in deploy.env once your local backend is up (docs/DEPLOYMENT.md).
INSTALL_LOCAL_GPU="${INSTALL_LOCAL_GPU:-}"

need() { local v; eval "v=\${$1:-}"; [ -n "$v" ] || die "deploy.env: $1 is required but empty -- $2"; }
need CLOUDFLARE_ACCOUNT_ID   "your Cloudflare account id"
need CLOUDFLARE_API_TOKEN    "your Cloudflare API token"
need RUNPOD_API_KEY          "your RunPod API key"
need RUNPOD_ENDPOINT_ID      "your RunPod backend endpoint id"
need R2_S3_ACCESS_KEY_ID     "R2 S3 access key id"
need R2_S3_SECRET_ACCESS_KEY "R2 S3 secret access key"
need DEPLOY_HOSTNAME         "the hostname your studio serves on"

# local-gpu door (opt-in): the module worker binds LOCAL_BACKEND_URL + LOCAL_BACKEND_TOKEN from the
# Secrets Store, so BOTH must be seeded before its deploy or a wrangler deploy hard-fails (CF 10182).
# Their values only exist AFTER you bring your local door container up (it prints them in its banner and
# holds them in its own .env), so there is no default to invent -- require them here, fail-closed and
# EARLY, before any tunnel / VPC service / worker is created (mirrors the satellites + planner-token
# prerequisites; #534).
if [ "$INSTALL_LOCAL_GPU" = "1" ]; then
  need LOCAL_BACKEND_URL   "bring your vivijure-local-12gb/-16gb door up FIRST, then copy its tunnel URL from the door startup banner (or the door .env) into deploy.env"
  need LOCAL_BACKEND_TOKEN "copy LOCAL_BACKEND_TOKEN from your door box .env (the door also prints it in its startup banner) into deploy.env"
fi

# GATEWAY_ID is optional (finding F2): if unset, the deploy creates an authenticated AI Gateway with
# this default slug, so a first-time operator has no manual AI-Gateway prereq. Set it in deploy.env
# only to point at an existing gateway.
GATEWAY_ID="${GATEWAY_ID:-vivijure}"

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

export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN

# The module workers this profile deploys. Explicit (not a glob) so a work-in-progress module in
# modules/ is never picked up by accident, and the list matches the profile boundary in the docs.
# STANDARD = core render modules + the media-stack finish modules (film-titles /
# subtitle / beat-sync / audio-master), all reached over Workers VPC (provisioned in step 4, #519).
STANDARD_MODULES="own-gpu seedance kling keyframe cloud-keyframe finish-rife plan-enhance cast-image \
notify-email music-gen narration-gen dialogue-gen minimax-hailuo google-veo vidu-q3 alibaba-wan \
film-titles subtitle beat-sync audio-master"
# alibaba-wan-lora is DELISTED for v1.0 (#771): custom-LoRA path unverified; source kept, re-add when fixed.
# SATELLITES = the 3 opt-in GPU finish modules, each on its own separate RunPod endpoint.
SATELLITE_MODULES="finish-upscale finish-lipsync speech-upscale"
MODULES="$STANDARD_MODULES"
[ "$VIVIJURE_PROFILE" = satellites ] && MODULES="$STANDARD_MODULES $SATELLITE_MODULES"
# Opt-in: the local-GPU door module (only deployed when you run your own local backend).
[ "$INSTALL_LOCAL_GPU" = "1" ] && MODULES="$MODULES local-gpu"

say "Vivijure Studio deploy -- profile: $VIVIJURE_PROFILE, auth: $AUTH_MODE, hostname: $DEPLOY_HOSTNAME"

# ---- 1. D1 database ----------------------------------------------------------
say "Step 1/9: D1 database vivijure-studio"
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
say "Step 2/9: R2 buckets (vivijure, skyphusion-llm)"
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
say "Step 3/9: Cloudflare Secrets Store (module secrets)"
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
# store_has_secret NAME -> 0 if the store already holds a secret named NAME (word-exact, so
# CF_AIG_TOKEN never matches PLAN_ENHANCE_CF_AIG_TOKEN: the leading "_" is a word char).
store_has_secret() {
  $WR secrets-store secret list "$STORE_ID" --remote --per-page 100 2>/dev/null | grep -qw "$1"
}
seed_secret RUNPOD_API_KEY            "$RUNPOD_API_KEY"
seed_secret GATEWAY_ID                "$GATEWAY_ID"
seed_secret BACKEND_RUNPOD_ENDPOINT_ID "$RUNPOD_ENDPOINT_ID"
# The core also binds R2 S3 creds from the store (#473 core migration); seed them here so the core
# [[secrets_store_secrets]] blocks resolve to a value instead of empty. Both are need-required above.
seed_secret R2_S3_ACCESS_KEY_ID       "$R2_S3_ACCESS_KEY_ID"
seed_secret R2_S3_SECRET_ACCESS_KEY   "$R2_S3_SECRET_ACCESS_KEY"
if [ "$VIVIJURE_PROFILE" = satellites ]; then
  [ -n "${VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID:-}" ] || die "satellites profile: VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID required (finish-upscale)"
  [ -n "${MUSETALK_RUNPOD_ENDPOINT_ID:-}" ]      || die "satellites profile: MUSETALK_RUNPOD_ENDPOINT_ID required (finish-lipsync)"
  [ -n "${AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID:-}" ] || die "satellites profile: AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID required (speech-upscale)"
  seed_secret VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID "$VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID"
  seed_secret MUSETALK_RUNPOD_ENDPOINT_ID      "$MUSETALK_RUNPOD_ENDPOINT_ID"
  seed_secret AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID  "$AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID"
fi

# local-gpu door: seed the two backend secrets the module worker binds from the store (required +
# validated up top when INSTALL_LOCAL_GPU=1). Without these the local-gpu wrangler deploy in step 7
# fails CF 10182 on the unseeded store binding (#534).
if [ "$INSTALL_LOCAL_GPU" = "1" ]; then
  seed_secret LOCAL_BACKEND_URL   "$LOCAL_BACKEND_URL"
  seed_secret LOCAL_BACKEND_TOKEN "$LOCAL_BACKEND_TOKEN"
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

# ---- 3 (cont.). resolve + seed the AI Gateway planner token BEFORE any deploy ---------------
# CF_AIG_TOKEN (core) and PLAN_ENHANCE_CF_AIG_TOKEN (plan-enhance) are load-bearing store bindings
# since the #473 core migration: `wrangler deploy` FAILS (code 10182) against a store secret that is
# not yet seeded. plan-enhance binds them in step 6 and the core in step 7, so BOTH must be in the
# store now -- this can no longer be a post-deploy "arm later" step. Three doors, in order:
# (1) pasted in deploy.env; (2) already in the store from a prior run; (3) auto-mint a purpose-named
# "AI Gateway Run"-only token (needs "Account API Tokens: Edit" on CLOUDFLARE_API_TOKEN). If ALL three
# miss we die HERE, before ANY worker is deployed -- a fail-closed prerequisite, not a silent degrade
# (the old "deploy anyway, planner unarmed" path is impossible once the token is a load-bearing store
# binding; findings F9/F16 updated).
say "Step 3/9 (cont.): resolve the AI Gateway planner token (required before deploy)"
arm_plan_enhance() { # $1 = the AIG token value -> the module-scoped store secret (per-function key)
  # plan-enhance binds CF_AIG_TOKEN from the store secret PLAN_ENHANCE_CF_AIG_TOKEN, and GATEWAY_ID
  # from the shared store secret already seeded above. Seed the module token into the store; a
  # `wrangler secret put` of either name on the module would collide with those store bindings (#479).
  seed_secret PLAN_ENHANCE_CF_AIG_TOKEN "$1"
}
if [ -n "${CF_AIG_TOKEN:-}" ]; then
  # Door 1: pasted in deploy.env. Seeds (or rotates) both store secrets from the paste.
  seed_secret CF_AIG_TOKEN "$CF_AIG_TOKEN"
  arm_plan_enhance "$(strip_val "$CF_AIG_TOKEN")"
  info "planner token seeded from deploy.env"
else
  # No paste. Try to reuse a prior run's store secrets (door 2), else auto-mint (door 3).
  REUSE_OK=""
  if store_has_secret CF_AIG_TOKEN && store_has_secret PLAN_ENHANCE_CF_AIG_TOKEN; then
    # Door 2: a prior run seeded both. Store secret VALUES cannot be read back, so we cannot probe the
    # gateway with them here; instead validate the underlying vivijure-planner-aig-run API token is
    # still ACTIVE before declaring the planner armed. Without this, a token revoked/deleted after a
    # prior run deploys green and then 401s at the FIRST planner call (#516). --check prints no secret
    # and returns: 0 active, 4 confirmed absent, 1 could-not-determine.
    CHK_ERRF="$(mktemp 2>/dev/null || printf '/tmp/vivijure-aig-chk.%s' "$$")"
    if python3 scripts/mint-aig-run-token.py --check 2>"$CHK_ERRF"; then CHK_RC=0; else CHK_RC=$?; fi
    CHK_REASON="$(cat "$CHK_ERRF" 2>/dev/null || true)"; rm -f "$CHK_ERRF"
    if [ "$CHK_RC" = 0 ]; then
      info "planner token already in the Secrets Store (prior run); its API token is still active -- reusing it"
      REUSE_OK=1
    elif [ "$CHK_RC" = 4 ]; then
      info "planner token is in the Secrets Store but its API token is gone/inactive -- re-minting (#516)"
      # REUSE_OK stays empty -> door 3 mints a fresh pair.
    else
      # Could not validate (e.g. the deploy token cannot list account API tokens). Do NOT nuke a
      # possibly-working setup by forcing a re-mint that would likely fail on the same missing scope:
      # reuse the stored token, but WARN loudly that it was not validated (#516).
      printf "\n"
      printf "  NOTE: could not validate the reused planner token (%s).\n" "${CHK_REASON:-unknown reason}"
      printf "  Reusing the stored CF_AIG_TOKEN unverified. If storyboard planning 401s at runtime, its\n"
      printf "  underlying API token was likely revoked: delete the CF_AIG_TOKEN and PLAN_ENHANCE_CF_AIG_TOKEN\n"
      printf "  store secrets, then re-run ./deploy.sh to re-mint (see docs/DEPLOYMENT.md 2d).\n\n"
      REUSE_OK=1
    fi
  fi
  if [ -z "$REUSE_OK" ]; then
    # Door 3: auto-mint a Run-only token. The mint response carries the secret value: it goes STRAIGHT
    # from the script into the store seed, never echoed or logged (same discipline as STUDIO_API_TOKEN).
    # Capture stderr so a failure's REAL reason reaches the operator (#515) instead of a guess.
    say "minting a Run-only planner token via the API"
    AIG_ERRF="$(mktemp 2>/dev/null || printf '/tmp/vivijure-aig-mint.%s' "$$")"
    if AIG_MINTED="$(python3 scripts/mint-aig-run-token.py 2>"$AIG_ERRF")"; then :; else AIG_MINTED=""; fi
    AIG_REASON="$(cat "$AIG_ERRF" 2>/dev/null || true)"; rm -f "$AIG_ERRF"
    if [ -n "$AIG_MINTED" ]; then
      seed_secret CF_AIG_TOKEN "$AIG_MINTED"
      info "CF_AIG_TOKEN auto-minted (vivijure-planner-aig-run)"
      arm_plan_enhance "$AIG_MINTED"
    else
      printf "\n"
      printf "  ====================== PLANNER TOKEN REQUIRED ======================\n"
      [ -n "$AIG_REASON" ] && printf "  mint failed: %s\n\n" "$AIG_REASON"
      printf "  CF_AIG_TOKEN could not be obtained, and it is REQUIRED before deploy: the core Worker and\n"
      printf "  the plan-enhance module BOTH bind it from the Secrets Store (#473), and wrangler fails a\n"
      printf "  deploy whose store secret is unseeded (code 10182). Fix, then re-run ./deploy.sh:\n"
      case "$AIG_REASON" in
        *"already exists"*)
          # rc 3: a stale same-name token is blocking the auto-mint; its value is unrecoverable.
          printf "    * A stale 'vivijure-planner-aig-run' API token is blocking the auto-mint (its value\n"
          printf "      cannot be re-read). Delete it (dashboard -> My Profile -> API Tokens -> delete\n"
          printf "      'vivijure-planner-aig-run'), then re-run ./deploy.sh to mint a fresh one, OR\n"
          printf "      paste any AI Gateway Run token into deploy.env:  CF_AIG_TOKEN=<token>\n"
          ;;
        *)
          printf "    1. Paste a token into deploy.env:  CF_AIG_TOKEN=<AI Gateway auth token, Run permission>\n"
          printf "       Mint it at https://dash.cloudflare.com/%s/ai/ai-gateway/gateways/%s\n" "$CLOUDFLARE_ACCOUNT_ID" "$GATEWAY_ID"
          printf "       (Settings -> Create authentication token -> Run), or\n"
          printf "    2. Grant your CLOUDFLARE_API_TOKEN the \"Account API Tokens: Edit\" scope so deploy.sh\n"
          printf "       auto-mints the Run-only token for you.\n"
          ;;
      esac
      printf "  ====================================================================\n\n"
      die "CF_AIG_TOKEN is required before deploy (see the steps above)"
    fi
  fi
fi

# ---- 4. media stack: Cloudflare tunnel + Workers VPC services ----------------
# STANDARD as of #519. scripts/setup-media-vpc.py reuses-or-creates ONE cloudflared tunnel and the 5
# Workers VPC Services (video-finish / image-prep / audio-beat-sync / audio-mix / audio-master), and
# writes the tunnel CONNECTOR TOKEN to containers/tunnel.env (0600, for docker compose) -- the token
# never touches stdout or a log. Its JSON stdout carries only the NON-secret ids, which we render into
# the core wrangler.toml (envsubst below) and into the 5 media module tomls (the F8/#520 fix: no
# hardcoded prod VPC ids in the tracked configs). Idempotent: a re-run reuses the tunnel + services.
say "Step 4/9: media stack -- Cloudflare tunnel + Workers VPC services"
# Optional VIVIJURE_TUNNEL_NAME override (deploy.env) names the tunnel on a FIRST install; on an
# upgrade the script adopts whatever tunnel the existing VPC services already point at (#531).
media_args=(--token-file containers/tunnel.env)
[ -n "${VIVIJURE_TUNNEL_NAME:-}" ] && media_args+=(--tunnel-name "$VIVIJURE_TUNNEL_NAME")
if ! MEDIA_JSON="$(python3 scripts/setup-media-vpc.py "${media_args[@]}")"; then
  die "media-stack VPC setup failed (see the error above). The deploy token needs Cloudflare Tunnel: Write + Connectivity Directory: Admin -- see docs/DEPLOYMENT.md 2a."
fi
media_id() { printf "%s" "$MEDIA_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)[\"services\"][\"$1\"])"; }
# assign then export (separate, so a media_id failure is not masked -- SC2155); the guard below
# then fails closed on any empty id.
VPC_VIDEO_FINISH_ID="$(media_id video-finish)"
VPC_IMAGE_PREP_ID="$(media_id image-prep)"
VPC_AUDIO_BEAT_SYNC_ID="$(media_id audio-beat-sync)"
VPC_AUDIO_MIX_ID="$(media_id audio-mix)"
VPC_AUDIO_MASTER_ID="$(media_id audio-master)"
export VPC_VIDEO_FINISH_ID VPC_IMAGE_PREP_ID VPC_AUDIO_BEAT_SYNC_ID VPC_AUDIO_MIX_ID
for v in VPC_VIDEO_FINISH_ID VPC_IMAGE_PREP_ID VPC_AUDIO_BEAT_SYNC_ID VPC_AUDIO_MIX_ID VPC_AUDIO_MASTER_ID; do
  eval "vv=\${$v:-}"; [ -n "$vv" ] || die "media stack: $v came back empty from setup-media-vpc.py"
done
# Fill each media module's service_id placeholder with its real VPC service id (idempotent: matches the
# committed REPLACE_WITH_* placeholder OR a prior id). Mirrors the store_id rewrite above.
set_module_vpc() { sed -i -E "s|^service_id = \"[^\"]*\"|service_id = \"$2\"|" "modules/$1/wrangler.toml"; }
for m in film-titles subtitle; do set_module_vpc "$m" "$VPC_VIDEO_FINISH_ID"; done
set_module_vpc beat-sync    "$VPC_AUDIO_BEAT_SYNC_ID"
set_module_vpc audio-master "$VPC_AUDIO_MASTER_ID"
info "media stack: tunnel + 5 VPC services ready; token -> containers/tunnel.env (0600)"

# ---- 5. render wrangler.toml from the template ------------------------------
say "Step 5/9: render wrangler.toml ($VIVIJURE_PROFILE profile)"
command -v envsubst >/dev/null || die "envsubst not found -- install gettext (apt-get install gettext-base)"
export AUTH_MODE ACCESS_TEAM_DOMAIN ACCESS_AUD D1_DATABASE_ID SPEND_RATE_LIMITER_NS_ID
export R2_S3_ENDPOINT R2_S3_BUCKET   # #238 follow-up: now rendered into [vars], not put as secrets
# VPC_* ids are already exported by step 4 (the media stack is provisioned before this render).
VARS="\$AUTH_MODE \$ACCESS_TEAM_DOMAIN \$ACCESS_AUD \$D1_DATABASE_ID \$VPC_VIDEO_FINISH_ID \$VPC_IMAGE_PREP_ID \$VPC_AUDIO_BEAT_SYNC_ID \$VPC_AUDIO_MIX_ID \$SPEND_RATE_LIMITER_NS_ID \$R2_S3_ENDPOINT \$R2_S3_BUCKET"

# Strip the wrangler.toml.example blocks this deploy does not want, then envsubst the rest:
#   SELFHOST-SKIP -- OUR-fleet-only (e.g. the vivijure-tail consumer); ALWAYS stripped for a self-host.
#   SATELLITE     -- the 3 opt-in GPU finish modules; stripped unless VIVIJURE_PROFILE=satellites.
#   LOCAL-GPU     -- the local-GPU door binding; stripped unless INSTALL_LOCAL_GPU=1 (else it dangles
#                    10143, the local-gpu module being deployed only with a local backend).
# The media-stack bindings are unconditional (standard, #519) -- nothing strips them.
KEEP_SAT=0; [ "$VIVIJURE_PROFILE" = satellites ] && KEEP_SAT=1
KEEP_LGPU=0; [ "$INSTALL_LOCAL_GPU" = "1" ] && KEEP_LGPU=1
awk -v sat="$KEEP_SAT" -v lgpu="$KEEP_LGPU" '
  /^# >>> SELFHOST-SKIP:/ { skip=1; next }
  /^# <<< SELFHOST-SKIP:/ { skip=0; next }
  /^# >>> SATELLITE:/      { skip=(sat==1?0:1); next }
  /^# <<< SATELLITE:/      { skip=0; next }
  /^# >>> LOCAL-GPU:/      { skip=(lgpu==1?0:1); next }
  /^# <<< LOCAL-GPU:/      { skip=0; next }
  !skip { print }
' wrangler.toml.example > .wrangler.stage.toml
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
# Point the CORE at YOUR store too (the step-3 module loop only did the modules). The template ships
# the REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID placeholder in every core [[secrets_store_secrets]] block;
# fill it with your real store id or `wrangler deploy` of the core dies on the literal placeholder
# (#473 core store migration; #479). Same idempotent rewrite as the module configs (matches the
# placeholder OR a prior id inside the quotes, so a re-run is a no-op).
sed -i -E "s/store_id = \"[^\"]*\"/store_id = \"$STORE_ID\"/g" wrangler.toml
info "wired your store id into the core config"

# fail-closed: no leftover placeholder, AUTH_MODE rendered non-empty, and in access mode the
# Access vars must be present + non-empty (empty would unarm the F2 backstop -> DENY-everything).
if grep -q "\${" wrangler.toml; then grep -n "\${" wrangler.toml; die "unsubstituted placeholder left in wrangler.toml"; fi
if grep -q "REPLACE_WITH_" wrangler.toml; then grep -n "REPLACE_WITH_" wrangler.toml; die "unfilled store_id placeholder left in wrangler.toml -- the step-4 store wiring failed"; fi
grep -Eq "AUTH_MODE = \".+\"" wrangler.toml || die "AUTH_MODE is empty after render -- refusing to deploy an unauthenticated studio"
if [ "$AUTH_MODE" = access ]; then
  grep -Eq "ACCESS_AUD = \".+\"" wrangler.toml && grep -Eq "ACCESS_TEAM_DOMAIN = \".+\"" wrangler.toml \
    || die "F2 Access vars are empty after render -- refusing to deploy an unauthenticated studio"
fi
info "rendered wrangler.toml ($(wc -l < wrangler.toml) lines), route -> $DEPLOY_HOSTNAME"

# ---- ALLOW_UNAUTHENTICATED loudness (S9 W4) ---------------------------------------------------
# (a) NO normal deploy.sh path sets ALLOW_UNAUTHENTICATED: it is not in the [vars] block of
#     wrangler.toml.example, not in the envsubst VARS list, and never exported here, so a plain
#     `./deploy.sh` can only ever render the fail-closed token/access gate. The ONLY way the flag
#     reaches the worker is a deliberate operator hand-edit of wrangler.toml [vars] -- and even then
#     it opens nothing unless AUTH_MODE is unset (src/auth-gate.ts scopes the hatch to the legacy
#     path; token/access modes IGNORE it). This deploy always renders AUTH_MODE=$AUTH_MODE.
# (b) If the flag IS present in the rendered config (or forced via the environment), SHOUT about it.
#     An open-door opt-out must never be quiet, even when it is currently inert.
UNAUTH_ON=""
grep -Eq '^ALLOW_UNAUTHENTICATED[[:space:]]*=[[:space:]]*"true"' wrangler.toml && UNAUTH_ON=1
[ "${ALLOW_UNAUTHENTICATED:-}" = "true" ] && UNAUTH_ON=1
if [ -n "$UNAUTH_ON" ]; then
  printf "\n"
  printf "  #########################################################################\n"
  printf "  ##  WARNING: ALLOW_UNAUTHENTICATED=true IS PRESENT IN THIS DEPLOY       ##\n"
  printf "  #########################################################################\n"
  printf "  This is the in-Worker auth OPT-OUT -- a DEV / own-reverse-proxy escape hatch ONLY.\n"
  printf "  It opens /api/* to UNAUTHENTICATED callers when AUTH_MODE is unset; anyone who reaches\n"
  printf "  the hostname could then read and delete your projects. This deploy renders\n"
  printf "  AUTH_MODE=%s, which still gates /api/* (the flag is inert here), but it does NOT belong\n" "$AUTH_MODE"
  printf "  in a normal deploy. Remove ALLOW_UNAUTHENTICATED from wrangler.toml unless you are\n"
  printf "  consciously running an open dev studio behind your own auth. See docs/SECURITY.md.\n"
  printf "  #########################################################################\n\n"
fi

# ---- 6. D1 migrations --------------------------------------------------------
say "Step 6/9: apply D1 migrations"
$WR d1 migrations apply vivijure-studio --remote

# ---- 7. module workers (BEFORE the core) ------------------------------------
say "Step 7/9: deploy module workers -- these MUST ship before the core"
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

# ---- 8. core worker ----------------------------------------------------------
say "Step 8/9: deploy the core studio worker"
npm run deploy

# ---- 9. core worker secrets (applied live; safe after deploy) ---------------
say "Step 9/9: set core worker secrets"
put_secret() { printf "%s" "$(strip_val "$2")" | $WR secret put "$1" >/dev/null && info "set $1"; }
# Only CLOUDFLARE_ACCOUNT_ID stays a direct worker secret here; STUDIO_API_TOKEN is the only other one
# (set below). Every former worker secret (RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID, R2_S3_ACCESS_KEY_ID,
# R2_S3_SECRET_ACCESS_KEY, GATEWAY_ID, CF_AIG_TOKEN, PLAN_ENHANCE_CF_AIG_TOKEN) now binds from the
# Secrets Store, all seeded in step 3 BEFORE the deploys. Putting any of them as a worker secret would
# collide with the core's [[secrets_store_secrets]] binding of the same name (#473 core store migration; #479).
put_secret CLOUDFLARE_ACCOUNT_ID    "$CLOUDFLARE_ACCOUNT_ID"
# R2_S3_ENDPOINT + R2_S3_BUCKET are NOT secrets -- they render into [vars] (see step 5). #238 follow-up.

# The planner token is already resolved + seeded (step 3); it is a hard deploy prerequisite now, so
# by here it always exists. What remains is the AI Gateway itself, a RUNTIME (not deploy) dependency.
# Ensure the AI Gateway exists (finding F2). When GATEWAY_ID was not supplied we create it here with
# authentication + cache_invalidate_on_update ON at birth (a fresh gateway otherwise defaults to
# authentication=false, which breaks Unified Billing). Best-effort: a deploy token without
# "AI Gateway: Edit" cannot create it, so this never fails the deploy -- the banner prints the one
# manual step. An already-existing gateway is a no-op success.
GW_CREATE_OK="$(python3 scripts/create-gateway.py 2>/dev/null || true)"
if [ "$GW_CREATE_OK" = ok ]; then info "AI Gateway '$GATEWAY_ID' present (created if missing)"; else info "could not create the AI Gateway via API -- see the banner below"; fi

# Unified Billing ALSO requires the gateway itself to be AUTHENTICATED (empirically proven in
# the cold run: authentication=false passes planner calls through keyless and the provider
# 401s even with a valid token). Flip it via the API; else the banner points at the toggle.
GW_AUTH_OK="$(python3 scripts/enable-gateway-auth.py 2>/dev/null || true)"
if [ "$GW_AUTH_OK" = ok ]; then info "AI Gateway authentication: on"; else info "could not enable gateway authentication via API -- see the banner below"; fi
STUDIO_TOKEN_MINTED=""
if [ "$AUTH_MODE" = token ]; then
  if [ -z "$ROTATE_TOKEN" ] && $WR secret list 2>/dev/null | grep -q '"STUDIO_API_TOKEN"'; then
    # A prior run already minted the login. Re-minting every deploy would silently invalidate every
    # saved studio login (finding F18-lite), so keep it. Pass --rotate-token to force a new one.
    info "STUDIO_API_TOKEN already set on the worker (prior run); keeping it (use --rotate-token to mint a new one)"
  else
    # Mint the studio API token: 256 bits of randomness, hex. Stored as a worker secret; printed
    # ONCE in the final banner below and NEVER written to any file. openssl is near-universal;
    # python3 (already required by step 1) is the fallback.
    if command -v openssl >/dev/null; then
      STUDIO_API_TOKEN="$(openssl rand -hex 32)"
    else
      STUDIO_API_TOKEN="$(python3 -c "import secrets; print(secrets.token_hex(32))")"
    fi
    put_secret STUDIO_API_TOKEN "$STUDIO_API_TOKEN"
    STUDIO_TOKEN_MINTED=1
  fi
fi

# ---- post-deploy gate self-check (S9 W3): PROVE the studio is fail-closed --------------------
# A novice must never ship an OPEN studio without seeing red. We hit a real /api/* route with NO
# bearer and REQUIRE 403 -- the deny the token/access gate returns for an unauthenticated caller
# (src/index.ts gates EVERY /api/* before routing). Anything else fails the deploy LOUDLY. This is
# the v0.12.0 live-matrix proof, now automatic on every deploy. deploy.sh only ever renders
# AUTH_MODE=token|access (validated up top), and ALLOW_UNAUTHENTICATED has no effect in either
# mode, so a no-bearer /api/* is ALWAYS expected to 403 here. Edge propagation can lag a few
# seconds after deploy, so we retry a non-403 for ~60s before declaring failure; a clean 403 passes
# immediately.
gate_selfcheck() {
  local url="https://$DEPLOY_HOSTNAME/api/modules" code="000" n=0 max=12
  say "Post-deploy check: proving /api/* is gated (a no-bearer request must get 403)"
  if ! command -v curl >/dev/null 2>&1; then
    info "curl not found -- cannot auto-verify the gate. Verify by hand (must print 403):"
    info "  curl -s -o /dev/null -w '%{http_code}' $url"
    return 0
  fi
  while [ "$n" -lt "$max" ]; do
    # NO Authorization header on purpose: this is the unauthenticated caller the gate must deny.
    code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || printf "000")"
    [ "$code" = "403" ] && { info "gate OK: no-bearer $url -> 403 (fail-closed confirmed)"; return 0; }
    n=$((n+1))
    [ "$n" -lt "$max" ] && { info "  not gated yet (HTTP $code); edge may still be propagating -- retry $n/$max"; sleep 5; }
  done
  # Still not 403 after the budget. A 200 means the API answered an unauthenticated caller: OPEN.
  printf "\n"
  printf "  #########################################################################\n"
  printf "  ##  DEPLOY GATE CHECK FAILED -- YOUR STUDIO MAY BE OPEN                 ##\n"
  printf "  #########################################################################\n"
  printf "  A no-bearer GET %s returned HTTP %s (expected 403).\n" "$url" "$code"
  if [ "$code" = "200" ]; then
    printf "  A 200 means the API served an UNAUTHENTICATED caller -- anyone can read and delete\n"
    printf "  your projects. Do NOT use this studio until this returns 403.\n"
  else
    printf "  Could not confirm the fail-closed gate (last HTTP %s). Check the deploy output above\n" "$code"
    printf "  and re-run; if it persists, the studio auth may be misconfigured.\n"
  fi
  printf "  Verify by hand (must print 403):  curl -s -o /dev/null -w '%%{http_code}' %s\n" "$url"
  printf "  See docs/SECURITY.md.\n"
  printf "  #########################################################################\n\n"
  die "post-deploy gate self-check failed (HTTP $code from a no-bearer /api/* request)"
}
gate_selfcheck

say "Done. Your studio is live at: https://$DEPLOY_HOSTNAME"
if [ "$AUTH_MODE" = token ] && [ -n "$STUDIO_TOKEN_MINTED" ]; then
cat <<MSG

  ============================= SAVE THIS NOW =============================
  Your studio API token (shown ONCE, stored nowhere else):

      $STUDIO_API_TOKEN

  This is your login. Open https://$DEPLOY_HOSTNAME and paste it when the
  studio asks; API callers send it as  Authorization: Bearer <token>.
  Lost it or want a fresh one? Re-run:  ./deploy.sh --rotate-token
  (mints a new token and invalidates the old one). See docs/SECURITY.md section 1b.
  =========================================================================

  Optional hardening (teams/orgs): put Cloudflare Access in front of the hostname
  and redeploy with AUTH_MODE=access. See docs/SECURITY.md.

  Profile: $VIVIJURE_PROFILE. Bring the media-stack containers up on your box:
      docker network create vivijure   # once, if it does not exist
      docker compose -f containers/compose.yaml up -d --build
  To add the GPU satellites later, set VIVIJURE_PROFILE=satellites in deploy.env (with the 3 extra
  RunPod endpoint ids) and re-run ./deploy.sh.
MSG
elif [ "$AUTH_MODE" = token ]; then
cat <<MSG

  Login unchanged: your existing STUDIO_API_TOKEN was kept, so saved studio logins keep working.
  Need a fresh token? Re-run:  ./deploy.sh --rotate-token  (invalidates the old one).

  Profile: $VIVIJURE_PROFILE. Bring the media-stack containers up on your box:
      docker network create vivijure   # once, if it does not exist
      docker compose -f containers/compose.yaml up -d --build
  To add the GPU satellites later, set VIVIJURE_PROFILE=satellites in deploy.env (with the 3 extra
  RunPod endpoint ids) and re-run ./deploy.sh.
MSG
else
cat <<MSG

  REQUIRED next step (security): put Cloudflare Access IN FRONT of https://$DEPLOY_HOSTNAME
  (Zero Trust -> Access -> Applications). AUTH_MODE=access arms the in-worker backstop with
  ACCESS_TEAM_DOMAIN/ACCESS_AUD, but you still need the Access app itself on the hostname,
  or anyone can read and delete your projects. See docs/SECURITY.md.

  Profile: $VIVIJURE_PROFILE. Bring the media-stack containers up on your box:
      docker network create vivijure   # once, if it does not exist
      docker compose -f containers/compose.yaml up -d --build
  To add the GPU satellites later, set VIVIJURE_PROFILE=satellites in deploy.env (with the 3 extra
  RunPod endpoint ids) and re-run ./deploy.sh.
MSG
fi

# ---- planner status (finding F16): tell the operator exactly where the planner stands --------
if [ "$GW_AUTH_OK" = ok ]; then
cat <<MSG

  Planner: ARMED. Storyboard planning bills your AI Gateway credits -- load them on the
  gateway's Credits page if you have not (the planner will not run on a \$0.00 balance).
  How to load credits: see docs/DEPLOYMENT.md (AI Gateway credits).
MSG
else
cat <<MSG

  ====================== PLANNER NOT FULLY ARMED YET ======================
MSG
if [ "$GW_CREATE_OK" != ok ]; then
cat <<MSG
  The AI Gateway "$GATEWAY_ID" could not be created automatically (your deploy token likely lacks
  "AI Gateway: Edit"). Create it once: dashboard -> AI Gateway -> Create Gateway, name it
  "$GATEWAY_ID", and turn ON "Authenticated Gateway". Then re-run ./deploy.sh.
MSG
fi
if [ "$GW_AUTH_OK" != ok ]; then
cat <<MSG
  The gateway must also have AUTHENTICATION ENABLED (a Unified Billing requirement; without
  it planner calls pass through keyless and fail). Flip the toggle: dashboard -> AI Gateway ->
  your gateway -> Settings -> "Authenticated Gateway". No re-deploy needed after the toggle.
MSG
fi
cat <<MSG
  Everything else about your studio works now.
  =========================================================================
MSG
fi
