# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this repo is

`vivijure` is the **constellation HUB**: docs, legal, and the monolith history. It is **not** the
deployed studio. The live surfaces live in sibling repos (below); issues that used to be filed here
were transferred to **`vivijure-cf`**. Treat this repo as the umbrella + orientation point, not a
deployable app.

## The constellation (where the real work lives)

- **`vivijure-cf`** = THE CF studio panel (deploys the live `vivijure-studio` Worker; tag-gated).
  Depends on published `@skyphusion-labs/vivijure-core`. Version: see that repo's `package.json` /
  latest `v*` tag.
- **`vivijure-local`** = LOCAL panel (Node/SQLite/MinIO); fleet door on propagandhi. Core is a
  published dependency (extraction done). Pins may lag cf.
- **`vivijure-core`** = shared orchestration + module contract SoT (`vivijure-module/2`).
- **`vivijure-control-plane`** = hosted multi-tenant provisioner (`STUDIO_RELEASE` for new tenants;
  own `v*` line). Not the studio UI.
- **`vivijure-mcp`** = agent MCP door package/Worker (`studio-mcp.*`); tools proxy studio HTTP API.
- **`vivijure-android`** / **`vivijure-ios`** = first-party NATIVE clients (`org.skyphusion.vivijure`),
  mobile front ends to the Storyboard Planner. They are STUDIO API CALLERS, not satellites: each
  drives the full operator route surface over a user-pasted Bearer (Android
  `EncryptedSharedPreferences`, iOS Keychain). Any audit of "who calls the studio API" that omits
  them is wrong -- and one did, because this list did.
- **`vivijure-backend`** = clean-room RunPod GPU render engine (image line `backend-v*` / GHCR tags).
- Satellites: **`vivijure-musetalk`**, **`vivijure-upscale`**, **`vivijure-audio-upscale`**,
  **`vivijure-wan-train`** (cast-LoRA; image line `train-*`; first-class member),
  **`vivijure-blender`** (headless Blender compositor grade, the `finish-blender` door),
  **`vivijure-local-12gb`** / **`vivijure-local-16gb`** (homelab i2v doors).
  None of these call the studio API -- the studio dispatches TO them. That is what makes a satellite
  a satellite, so "does not call `/api/`" describes the whole class and distinguishes none of them.
- **`slate`** = Discord front door (not multi-tenant hostable).
- **`vivijure-com`** = marketing site (vivijure.com), not the app.

## TWO version lines (do not conflate)

- **`backend-v*` / GPU image tags** = RunPod images (`vivijure-backend`, satellites `train-*`, etc.).
- **`v*` on panel repos** = studio / control-plane / local Worker-or-host deploys.

Always say which line. Pin panels' RunPod endpoints on a proven backend release. **Never freeze open
sprint boards or specific RunPod endpoint IDs in docs memory as "current forever".**

## Where live truth lives (read before acting)

- **GitHub is the system of record for state.** Open studio issues in **`vivijure-cf`** (and
  control-plane issues in `vivijure-control-plane`).
- **RunPod endpoints/pins drift** -- map of record is fleet runbooks + live RunPod API; do not
  re-assert ids/pins here.
- Module types/contract: **`vivijure-core`**, not hub or host `src/modules/*` after extraction.
- Ignore Cursor `AGENTS.md` if present.

## Hard invariants (get these wrong and it is serious)

- **CSAM bright-line (NON-NEGOTIABLE):** absolute zero-tolerance ban INCLUDING synthetic/AI-generated
  (18 U.S.C. 1466A / 2252A): detect, refuse, preserve, report to NCMEC + LE. The one exception to the
  no-surveillance ethos. Never soften or hedge it.
- **Clean room:** `vivijure-backend` shares ZERO code with the deleted `wavevryn` fork; no named
  third-party credit anywhere.
- **TWO panels:** CF (`vivijure-cf`) and LOCAL (`vivijure-local`). Product parity required; pins may lag.
- **Demo:** `demo.vivijure.com` is `AUTH_MODE=demo`; `DEMO_RENDER_ENABLED=false` intentional.
- **Tag-gated deploy** on panel/plane repos: merge to main = CI only; a SemVer tag fires deploy.
  Verify the **ARTIFACT** (deployed worker `modified_on`, pullable image, rendered output), never the
  pipeline's opinion of it.
- **SecurePod smoke before prod** for GPU images; **FLUX self-host OUT** of the default hosted thesis.
- **Absolute hosted/self-host parity:** same-time releases, no community edition, no pay gates.
- **RunPod money = GPU work only;** the GPUless cost-door is the hedge against our own GPU bill.
- **Consumer RunPod access:** a consumer reaches RunPod through our product or not at all; BYOK is
  the only exception, where the tenant brings their own account and is RunPod's customer directly.
  Forbids tenant dashboard access, any RunPod key issued to a tenant on our account, and any
  unmediated tenant-workload surface.
- **Typecheck is the CI gate** on TS repos; `npm run typecheck` before push where applicable.

## Conventions

- **No em-dashes (U+2014) or en-dashes (U+2013).** Use commas, semicolons, parentheses, or `--`.
- Handle / username is `skyphusion` across all services. Public AGPL, OSS-first.
- **Never a plaintext secret in a tracked file.** Presence-check with `${var:+SET}` only.
- Vanilla JS/HTML/CSS on panel frontends: no framework, no build step (deliberate).
- The frontend is a projection of the registry (`GET /api/modules`); a feature the UI must know about
  is a module, not a hardcoded section.

## Crew + commits

- Crew work runs as the member's own login shell (`sudo -u <member> bash -lc`), lands under the
  member's `skyphusion-<member>` identity, one-reviewer-per-PR, author never self-merges. Conrad devs
  only on his laptop (`Conrad Rockenhaus <conrad@skyphusion.org>`).
- Conventional Commits (`feat(scope):`, `fix(scope):`, `docs:`); body explains the why, references the
  tracking issue.
