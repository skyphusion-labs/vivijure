# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**Vivijure Studio: the module host for AI film production.** A single Cloudflare Worker (no
framework, no build step beyond TypeScript) that owns the core (project / storyboard / cast / render
orchestration) and a **module registry**. Every capability beyond the core is an opt-in module
worker plugged in through a typed hook contract. Read **docs/module-api.md** first; it is the
contract everything builds to. Currently **v0.3.0**, ~20+ modules shipped (cloud i2v, finish/lipsync,
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
   vivijure-musetalk  vivijure-   vivijure-audio-   vivijure-local-backend
   (lipsync module)   upscale     upscale           (self-host render path)
```

## Documentation map

Deep docs live in `docs/`; this file is the working method and conventions. When a change touches one
of these areas, update the matching doc.

- `docs/module-api.md` -- the typed hook contract (`vivijure-module/1`); read FIRST. A module builds to this.
- `docs/module-authoring.md` -- how to author a new module worker against the contract.
- `docs/CONTRACT.md` -- the core <-> backend render contract (bundle in, artifacts out).
- `docs/observability.md` -- the structured event/tail channel for tracing a render.
- `docs/DEPLOYMENT.md` + `docs/deploy-runbook.md` + `docs/deploy-config-injection.md` -- deploy, env, `account_id` injection.
- `docs/SECURITY.md` + `docs/legal/` -- security posture and the public-facing legal/AUP framing.

## Commands

```bash
npm run typecheck   # tsc --noEmit && tsc -p tsconfig.scripts.json -- the CI gate; run before pushing
npm test            # vitest run (690+ tests)
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
- **The module contract is sacred.** `src/modules/types.ts` is `vivijure-module/1`; a breaking change
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
