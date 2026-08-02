# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this repo is

`vivijure` is the **constellation HUB**: docs, legal, and the monolith history. It is **not** the
deployed studio. The live surfaces live in sibling repos (below); issues that used to be filed here
were transferred to `vivijure-cf`. Treat this repo as the umbrella + orientation point, not a
deployable app.

## The constellation (where the real work lives)

- **`vivijure-cf`** = THE studio panel (deploys the live `vivijure-studio` Worker on Cloudflare; the
  monolith is retired, never tag it). Current line v1.7.x; embeds an internal `core` pkg.
- **`vivijure-control-plane`** = the hosted multi-tenant plane (own repo + release line, v1.4.x).
- **`vivijure-backend`** = the clean-room RunPod GPU render engine (image tag line `backend-vX.Y.Z`).
- **`vivijure-local`** (+ `-local-backend`) = the self-host Node/SQLite/MinIO studio + its local-GPU
  door, on the GPU boxes.
- Satellites: `vivijure-musetalk` (lip-sync), `vivijure-upscale`, `vivijure-audio-upscale`,
  `vivijure-wan-train` (cast-LoRA training).

## Where live truth lives (read before acting)

- **The orientation hub is the project MEMORY, not this file.** `vivijure-system-map` is the READ-FIRST
  map (the two version lines, the two panels, the RunPod endpoint shape, the local-GPU doors, the hard
  rules). Load the vivijure project memory before doing constellation work; it is the single unified
  home for the whole constellation (working ANY vivijure repo loads it).
- **GitHub is the system of record for state.** Open issues in `vivijure-cf` + `vivijure-control-plane`.
- **RunPod endpoints/pins drift** -- the map of record is `fleet-chezmoi/docs/runbooks/vivijure-runpod-endpoints.md`
  plus the live RunPod API; memory must not re-assert ids/pins.

## Hard invariants (get these wrong and it is serious)

- **CSAM bright-line (NON-NEGOTIABLE):** absolute zero-tolerance ban INCLUDING synthetic/AI-generated
  (18 U.S.C. 1466A / 2252A): detect, refuse, preserve, report to NCMEC + LE. The one exception to the
  no-surveillance ethos. Never soften or hedge it.
- **Clean room:** `vivijure-backend` shares ZERO code with the deleted `wavevryn` fork; no named
  third-party credit anywhere.
- **TWO version lines, do not conflate:** `backend-vX.Y.Z` (the RunPod GPU image) vs `vX.Y.Z` (the
  panel/studio deploy). Always say which line. Pin BOTH panels' RunPod endpoints on a backend release.
- **Tag-gated deploy:** merge to main = CI only; a SemVer tag fires the deploy. Verify the ARTIFACT
  (the deployed worker `modified_on`, a pullable image, the rendered output), never the pipeline's
  opinion of it. A green build is not a pullable image.
- **Absolute hosted/self-host parity:** same-time releases, no community edition, no pay gates.
- **RunPod money = GPU work only;** the GPUless cost-door (cloud keyframe + cloud i2v) is the hedge
  against our own GPU bill.
- **Consumer RunPod access:** a consumer reaches RunPod through our product or not at all; BYOK is
  the only exception, where the tenant brings their own account and is RunPod's customer directly.
  Both a compliance line (the resale test is whose workload runs) and a security boundary (direct
  reach is a credential against our account, on our budget). Forbids tenant dashboard access, any
  RunPod key issued to a tenant on our account, and any unmediated tenant-workload surface; "just
  scope the key" reads as a security improvement and violates this.

## Conventions

- **No em-dashes (U+2014) or en-dashes (U+2013).** Use commas, semicolons, parentheses, or `--`.
- Handle / username is `skyphusion` across all services. Public AGPL, OSS-first.
- **Never a plaintext secret in a tracked file.** Presence-check with `${var:+SET}` only.
- Vanilla JS/HTML/CSS on the local panel frontend: no framework, no build step (deliberate).
- The frontend is a projection of the registry (`GET /api/modules`); a feature the UI must know about
  is a module, not a hardcoded section.

## Crew + commits

- Crew work runs as the member's own login shell (`sudo -u <member> bash -lc`), lands under the
  member's `skyphusion-<member>` identity, one-reviewer-per-PR, author never self-merges. Conrad devs
  only on his laptop (`Conrad Rockenhaus <conrad@skyphusion.org>`); on a crew box the `conrad` user is
  the god process (Mackaye).
- Conventional Commits (`feat(scope):`, `fix(scope):`, `docs:`); body explains the why, references the
  tracking issue.
