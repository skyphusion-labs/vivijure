#!/usr/bin/env bash
# Vivijure constellation deploy -- TOP orchestrator (DESIGN STUB).
#
# Shape locked 2026-07-01: a top orchestrator calls DOWN into each repo owns its own deploy or compose, and
# each repo also stands alone (a homelabber who only wants the local door runs just that one).
# This file is the TOP. Today it drives the STUDIO (this repo, a real call). The satellite calls
# are documented placeholders until each sibling repo lands its own deploy script in the fan-out.
#
# Run order matters: the GPU backend must exist before the studio can render against it, but the
# studio control plane can deploy first and simply have nothing to render until the backend is up.
# We deploy the studio here; the backend + doors are stood up from their own repos (see below).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf "\n==> %s\n" "$*"; }

say "Vivijure constellation deploy (top orchestrator)"

# 1. STUDIO control plane (THIS repo) -- REAL.
#    Reads deploy.env (VIVIJURE_PROFILE = standard | satellites). This is the Cloudflare Worker + D1 + R2
#    + AI Gateway + the render/cast/audio modules.
say "[1/4] studio control plane -> $ROOT/deploy.sh"
if [ -f "$ROOT/deploy.env" ]; then
  "$ROOT/deploy.sh"
else
  echo "    SKIP: $ROOT/deploy.env not found. Copy $ROOT/deploy.env.example and re-run to deploy the studio."
fi

# 2. GPU RENDER BACKEND (vivijure-backend, sibling repo) -- PLACEHOLDER.
#    RunPod Serverless endpoint from the backend image. Stood up from that repo owns its own deploy path
#    (RunPod template + endpoint + network volume + R2 model seed). When that script lands, wire it:
#    e.g.  ( cd ../vivijure-backend && ./deploy.sh )
say "[2/4] vivijure-backend (RunPod GPU) -- PLACEHOLDER (deploy from the vivijure-backend repo)"

# 3. LOCAL DOORS (vivijure-local-12gb / vivijure-local-16gb, sibling repos) -- PLACEHOLDER.
#    Homelab self-host render path via docker compose in each repo. Optional; only for operators
#    running their own GPU box. e.g.  ( cd ../vivijure-local-12gb && docker compose up -d )
say "[3/4] local-gpu doors -- PLACEHOLDER (docker compose in each vivijure-local-* repo)"

# 4. FINISH SATELLITES (vivijure-musetalk / -upscale / -audio-upscale) -- PLACEHOLDER.
#    Extra RunPod endpoints behind the studio satellites profile (finish-lipsync / finish-upscale /
#    speech-upscale). Stood up from their own repos, then set the endpoint ids in deploy.env and
#    re-run the studio with VIVIJURE_PROFILE=satellites.
say "[4/4] finish satellites -- PLACEHOLDER (per-repo endpoints; then studio VIVIJURE_PROFILE=satellites)"

say "Top orchestrator done. Only [1] runs today; [2]-[4] are stubs for the fan-out."
