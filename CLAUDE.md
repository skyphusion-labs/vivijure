# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**Vivijure Studio: the module host for AI film production.** A single Cloudflare Worker (no
framework, no build step beyond TypeScript) that owns the core (project / storyboard / cast / render
orchestration) and a **module registry**. Every capability beyond the core is an opt-in module
worker plugged in through a typed hook contract. Read **docs/module-api.md** first; it is the
contract everything builds to. Pre-1.0 (the current version is the latest `v*` git tag; see
CHANGELOG.md), ~25 modules shipped (cloud i2v, finish/lipsync,
audio, cast-image, dialogue, titles).

The GPU render backend is `vivijure-backend` (RunPod serverless). Production UI:
**vivijure.skyphusion.org**.

## The Vivijure constellation (the same map is in each repo's README)

```
   friends + Slate (Discord)
            |
            v
        slate  -->  vivijure (studio control plane / JSON API)   <-- THIS REPO
                        |
                        v
                  vivijure-backend (GPU render: keyframes -> i2v -> assemble)
                        |
            +-----------+-------------+-------------------+
            |           |             |                   |
   vivijure-musetalk  vivijure-   vivijure-audio-   vivijure-local-12gb
   (lipsync module)   upscale     upscale           (self-host render path)
```

## Documentation map

Deep docs live in `docs/`; this file is the working method and conventions. When a change touches one
of these areas, update the matching doc.

- `docs/module-api.md` -- the typed hook contract (`vivijure-module/2`; `/1` is closed); read FIRST. A module builds to this.
- `docs/module-authoring.md` -- how to author a new module worker against the contract.
- `docs/CONTRACT.md` -- the core <-> backend render contract (bundle in, artifacts out).
- `docs/mcp.md` -- the Studio MCP Worker (`src/mcp.ts`): drive the studio API from an agent; opt-in, deploys separately.
- `docs/observability.md` -- the structured event/tail channel for tracing a render.
- `docs/DEPLOYMENT.md` + `docs/deploy-runbook.md` + `docs/deploy-config-injection.md` -- deploy, env, `account_id` injection.
- `docs/demo-studio.md` -- the public, read-only, zero-spend demo studio (`demo.vivijure.com`, `AUTH_MODE=demo`): the binding-absence rule, D1 seed procedure, and live-verify list.
- `docs/dev-modbound.md` -- run the core + every module worker as one local dev so `/api/modules` returns the REAL catalog (no GPU, no prod data). The dev-parity env for driving planner/module flows locally.
- `docs/SECURITY.md` + `docs/legal/` -- security posture and the public-facing legal/AUP framing.

## Commands

```bash
npm run typecheck   # tsc --noEmit && tsc -p tsconfig.scripts.json -- the CI gate; run before pushing
npm test            # vitest run (1200+ tests)
npm run conformance # the module conformance suites (a module must pass these to be installable)
npm run dev         # wrangler dev
npm run deploy      # wrangler deploy
```

### Verifying changes

Vitest is the suite (`npm test`), and every hook ships a **conformance** test (`npm run conformance`)
that a module must pass to be installable -- a module that implements the interface but fails
conformance is not done. For end-to-end render behavior, verify against a live `wrangler dev` and
assert on the structured event channel (`docs/observability.md`), not prose. Always `npm run typecheck`
first, green, before considering a change done.

## Architecture

- **Thin core + module registry.** The Worker owns project/storyboard/cast state and render
  orchestration; everything else is a module worker behind a typed hook. `src/` holds the core
  (orchestration, cast DB, bundle assembly, audio/beat staging, preflight); `modules/` holds the
  shipped module workers.
- **The module contract is sacred.** `src/modules/types.ts` is `vivijure-module/2`; a breaking change
  bumps the api version. Module repos vendor this exact file -- keep it dependency-free. One typed
  input/output per hook; a module declares its knobs in `config_schema` and the core clamps against it.
- **The frontend is a projection of the registry.** The UI renders from `GET /api/modules`; never
  hardcode a per-feature section. If a feature needs the UI to know about it, it is a module.
- **Honest failures.** A finish/polish step that genuinely fails (after bounded retry + R2 reclaim)
  fails the render with the real per-shot error; it never silently advances to done and ships a
  raw/unfinished clip with `applied=[]` (#245 / #249). A degrade is never silent.

## Conventions

- **No em-dashes (U+2014) or en-dashes (U+2013) anywhere.** Use commas, semicolons, parentheses, or `--`.
- **No framework, no build step, no CSS preprocessor.** Vanilla JS/HTML/CSS frontend is deliberate.
- **Minimal runtime deps.** Justify any new one.
- **Mirror every binding** in `wrangler.toml` and the hand-authored `Env` (`src/env.ts`). The committed
  config is `wrangler.toml.example`; `account_id` is never hardcoded (injected via `CLOUDFLARE_ACCOUNT_ID`).
- **`npm run typecheck` is the gate.** `tsc` is not part of vitest, so type errors pass tests silently.

## Repo standard (aviation-grade governance)

**Every NEW constellation repo gets the FULL standard applied AT CREATION, never backfilled.** All 8
existing repos were brought to this standard 2026-07-01; a new repo is not "done" until it meets it. This
is the definition of done for a new repo, run it like adding a `.gitignore`:

1. **Default branch `main`** (never `master`).
2. **`ci` workflow** for the language (TS: `tsc --noEmit` + vitest; Python: pytest), on GitHub-hosted
   `ubuntu-latest` (fork-safe) for public repos, `permissions: contents: read`.
3. **`coverage` workflow** if there is testable code. For a thin wrapper with nothing meaningfully
   coverable (e.g. a single RunPod `handler.py` with heavy top-level GPU imports), do NOT fabricate
   coverage; substitute a minimal `ci` gate = `ruff check --select E9,F .` + `python -m py_compile handler.py`.
4. **CodeQL** default setup enabled.
5. **Branch protection on `main`:** PR required; `required_status_checks.contexts` = the repo's real
   `ci` + `coverage` (+ the `CodeQL` umbrella, never a sub-job like `Analyze (python)`); `strict: true`;
   `enforce_admins: false` (admin override); no force-push, no deletion.
6. **Discovery:** homepage -> the main `vivijure` repo (the studio -> its welcome page); topics set.
   **License** AGPL-3.0 unless it is an explicit public-docs/CC0 case.

Two hard constraints, learned the hard way:
- **Verify-before-require ordering:** a status check can only be made REQUIRED after it exists and has
  posted GREEN on a real run, else every merge blocks forever (phantom block). Land the workflow ->
  confirm it runs green -> then add its exact context to `required_status_checks`. A repo with
  `required_status_checks:null` needs a full protection PUT (a surgical PATCH 404s), preserving other settings.
- **Branch protection MUST be in place BEFORE flipping a repo public** (plus a grep-zero
  secrets/topology scan). The checklist above satisfies the protection half.

Full rationale + the closing 8/8 state live in the project memory (`vivijure-new-repo-standard`,
`vivijure-repo-governance-ci-sprint`).

## Roadmap (phases)

0. Module host + registry + self-assembling UI. (**done**, v0.1.0)
1. Render routes behind hooks; reference modules; shared D1 + R2. (**done**, v0.2.0)
2. Production DNS on `vivijure.skyphusion.org`; render + planner split out of `prism`
   (formerly `skyphusion-llm-public`). (**done**)
3. **Workers for Platforms / dynamic dispatch** -- install a module without redeploying the core.
   (**unblocked**: WfP is enabled account-wide as of 2026-06-30; module = user Worker in a dispatch
   namespace, vivijure = the dynamic-dispatch/outbound Worker for auth/routing/quota.)

## Crew + identity

- Crew members work as their own Unix + gh identity. The FIRST command in any op is the member's own
  login shell: `sudo -u <member> bash -lc '<ops>'` (loads their `$HOME`, their `~/dev/vivijure` clone,
  their gh/CF/RunPod creds). Commits/PRs land under the member's `skyphusion-<member>` identity, not Conrad's.
- Operating memory for this repo lives in the per-project memory (`MEMORY.md` + `seg-*`/`crew-*` under
  `~/.claude/projects/-home-conrad-dev-vivijure/memory/`); load it before acting.
- **HARD AUP line:** the CSAM bright line is absolute (see the vivijure project memory). Non-negotiable.

## Commits & versioning

Conventional Commits (`feat(scope):`, `fix(scope):`, `docs:`); body explains the why. SemVer-style
`0.MINOR.PATCH` while pre-1.0 (PATCH for fixes/backend tweaks, MINOR for features). A release commit
bumps `package.json` `version` and adds a top-of-file `CHANGELOG.md` entry.
