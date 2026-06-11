# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

Vivijure Studio: the **module host** for AI film production. A single Cloudflare Worker (no
framework, no build step beyond TypeScript) that owns the core (project / storyboard / cast / render
orchestration) and a **module registry**. Every capability beyond the core is an opt-in module
worker plugged in through a typed hook contract. Read **docs/module-api.md** first -- it is the
contract everything builds to.

This worker was split out of `skyphusion-llm-public` (the AI Playground) so the studio has its own
home. The GPU render backend is `vivijure-backend` (RunPod serverless).

## Commands

```bash
npm run typecheck   # tsc --noEmit -- the CI gate; run before pushing
npm test            # vitest run
npm run dev         # wrangler dev
npm run deploy      # wrangler deploy
```

## Conventions

- **No em-dashes (U+2014) or en-dashes (U+2013) anywhere.** Use commas, semicolons, parentheses, or
  a double hyphen `--`.
- **No framework, no build step, no CSS preprocessor.** Vanilla JS/HTML/CSS frontend is deliberate.
- **Minimal runtime deps.** Justify any new one.
- **The module contract is sacred.** `src/modules/types.ts` is `vivijure-module/1`; a breaking change
  bumps the api version. Modules in other repos vendor this exact file -- keep it dependency-free.
- **One typed input/output per hook. No override grab-bag.** A module declares its knobs in its
  `config_schema`; the core clamps against it. One declaration, one hop, same words down.
- **The frontend is a projection of the registry.** Never hardcode a per-feature section in the UI;
  it renders from `GET /api/modules`. If a feature needs the UI to know about it, it is a module.
- **Mirror every binding** in `wrangler.example.toml` and the hand-authored `Env` (`src/env.ts`).
  The real `wrangler.toml` is gitignored.

## Module conformance

Every hook ships a conformance suite a module must pass to be installable. When you add or change a
hook, add/update its conformance test. A module that implements the interface but fails conformance
is not done.

## Roadmap (phases)

0. Module host + registry + self-assembling UI. (done -- v0.1.0)
1. Migrate the render routes in from `skyphusion-llm-public` behind the hooks; ship `finish` as
   module #1; share D1 + R2 with the old worker (no data migration); split the dual-purpose Workflow.
2. Point `vivijure.skyphusion.org` at this worker; strip render + the planner frontend out of
   `skyphusion-llm-public`.
3. Workers for Platforms / dynamic dispatch (install a module without redeploying the core).
