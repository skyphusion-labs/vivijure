# Vivijure Studio

**AI film production as a module host, not a monolith.**

Vivijure Studio is a Cloudflare Worker that owns what is always true: project, storyboard, cast,
bundle assembly, render orchestration, and a module registry. Every capability beyond that (GPU
keyframes, cloud motion, finish, score, cast image gen, notifications, ...) is an **opt-in module
worker** plugged into the pipeline through a typed hook contract.

You install the modules you want. The studio assembles itself around them, including its UI. The
bare studio is a clean slate; nothing is jammed in that you did not ask for. And because the plug
spec is public, anyone can write a module; the community is the roadmap.

Free, AGPL-3.0, for the people. The commercial tools sell you a walled box. We hand you the host and
the plug spec.

## Architecture

See **[docs/module-api.md](docs/module-api.md)** for the full contract. The short version:

- **Core** -- this worker. Owns projects, storyboard, cast, the render spine, and the registry;
  serves `GET /api/modules` so the frontend renders from what is installed.
- **Hooks** -- typed extension points (`keyframe`, `motion.backend`, `finish`, `score`,
  `plan.enhance`, `cast.image`, `notify`). See `src/modules/types.ts`.
- **Module** -- a worker that serves one or more hooks via `GET /module.json` and `POST /invoke`.
- **Conformance** -- every hook ships a contract test. A module is not done until it passes it.

The GPU render backend is [`vivijure-backend`](https://github.com/skyphusion-labs/vivijure-backend)
(RunPod serverless). The studio UI lives at `vivijure.skyphusion.org` (`/planner`, `/cast`,
`/modules`).

## Develop

```bash
npm install
npm run typecheck     # tsc --noEmit (CI gate)
npm test              # vitest
npm run dev           # wrangler dev
npm run deploy        # wrangler deploy
```

Configure secrets and bindings in `wrangler.toml` (committed). `account_id` comes from
`CLOUDFLARE_ACCOUNT_ID` in the environment, not from the file.

## Status

**v0.2.0:** Phase 1 complete. The render API, planner/cast frontends, and eleven reference modules
ship from this repo. See [CHANGELOG.md](CHANGELOG.md) for release notes and [CLAUDE.md](CLAUDE.md)
for agent conventions.
