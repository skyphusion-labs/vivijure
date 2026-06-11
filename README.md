# Vivijure Studio

**AI film production as a module host, not a monolith.**

Vivijure Studio is a thin Cloudflare Worker that owns only what is always true -- project,
storyboard, cast, the render-orchestration spine, and a module registry. Every capability beyond
that (cloud rendering, frame interpolation, narration, lip-sync, ...) is an **opt-in module worker**
that plugs into the pipeline through a typed hook contract.

You install the modules you want. The studio assembles itself around them, including its UI. The
bare studio is a clean slate; nothing is jammed in that you did not ask for. And because the plug
spec is public, anyone can write a module -- the community is the roadmap.

Free, AGPL-3.0, for the people. The commercial tools sell you a walled box. We hand you the host and
the plug spec.

## Architecture

See **[docs/module-api.md](docs/module-api.md)** for the full contract. The short version:

- **Core** -- this worker. Owns the registry and the studio UI; serves `GET /api/modules` so the
  frontend renders itself from what is installed.
- **Hooks** -- typed extension points: `motion.backend`, `finish`, `score`, `plan.enhance`.
- **Module** -- a worker that serves one or more hooks, declared by a `module.json` manifest and a
  single `POST /invoke` entry point.
- **Conformance** -- every hook ships a contract test. A module is not done until it passes it.

The render API (storyboard / cast / render / scatter-gather) migrates in from `skyphusion-llm-public`
during Phase 1, behind the hook contracts. The GPU render backend is
[`vivijure-backend`](https://github.com/skyphusion-labs/vivijure-backend) (RunPod serverless).

## Develop

```bash
npm install
npm run bootstrap     # wrangler.example.toml -> wrangler.toml
npm run typecheck     # tsc --noEmit (CI gate)
npm test              # vitest
npm run dev           # wrangler dev
```

## Status

Phase 0: the module host + registry + the self-assembling studio shell. See
[CHANGELOG.md](CHANGELOG.md).
