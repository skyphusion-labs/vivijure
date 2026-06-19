# Vivijure Studio

Write a storyboard. Render it to video on your own GPU. No subscription, no account wall, no
lock-in. You bring the GPU and the keys; the studio brings the pipeline.

Vivijure is a self-hosted AI film studio built on Cloudflare Workers. It runs free on the
Workers free tier and connects to whatever GPU backend you attach -- RunPod, your own box, or
a cloud motion API. You own every artifact.

## Showcase: the first full run

[![NEON HALFLIFE, the first full Vivijure film, a 1080p anime cyberpunk render, ten shots, click to play the MP4](https://assets.skyphusion.net/neon-halflife-run1.jpg)](https://assets.skyphusion.net/neon-halflife-run1.mp4)

*[NEON HALFLIFE](https://assets.skyphusion.net/neon-halflife-run1.mp4): the first film rendered end to end on Vivijure. 1080p, ten shots, 30 seconds. Motion on a self-hosted GPU (the `own-gpu` Wan I2V backend). Click the frame above to play, or [download the MP4](https://assets.skyphusion.net/neon-halflife-run1.mp4) (29 MB).*

This clip is **silent on purpose.** Vivijure assembles a silent picture by default; scoring (a music bed, TTS narration, beat-synced cuts) is an opt-in Audio step you run after the picture locks. This is the picture straight off the pipeline, before any audio pass.

What makes it the proof and not just a demo: this was the first unattended full run, and it came out clean. Zero clips dropped (ten of ten shots rendered). It also recovered itself: the finish phase stalled partway through, the orchestrator re-adopted the in-flight work, and the film finished, all of it across a session restart with nobody watching. The system healing its own stall, unattended, is the part we are actually proud of.

## Ecosystem

```
slate  -->  vivijure  -->  vivijure-backend
```

| Repo | Role |
|---|---|
| [slate](https://github.com/skyphusion-labs/slate) | Collaborative AI screenwriter Discord bot -- shapes the film in-channel, then hands it to vivijure to render |
| **[vivijure](https://github.com/skyphusion-labs/vivijure)** | **AI film studio control plane (Cloudflare Worker) -- planner, cast, render UI; orchestrates render jobs** |
| [vivijure-backend](https://github.com/skyphusion-labs/vivijure-backend) | GPU render backend (RunPod serverless) -- SDXL keyframes, i2v, finish, assemble |

**Storyboard planner** -- write scenes, edit shot prompts, and set per-shot cast assignments before bundling:

![Storyboard planner scene editor showing shot cards with prompts, act labels, and character slots](docs/screenshots/planner-storyboard.png)

**Cast** -- register characters with portraits and visual bibles; Slate syncs here directly from Discord:

![Cast page showing character list with portraits and the Companion Robot detail panel](docs/screenshots/cast-page.png)

**Module host** -- installed modules appear here; each stage (plan, cast, keyframe, motion, finish, score) is served by a swappable module worker:

![Modules page showing installed modules panel and stage configuration](docs/screenshots/modules-page.png)

**Render history** -- honest per-render status (in-flight, stalled, failed, done) with inline error snippets:

![Render history tab showing neon_halflife and fur_and_circuits renders with live status badges](docs/screenshots/planner-render-history.png)

## What you can do

- **Write a storyboard** -- scenes, shot descriptions, character beats -- in the planner.
- **Generate SDXL keyframes** per shot on your GPU (preview before committing to full motion).
- **Animate** each shot with Wan I2V on your own GPU or a cloud motion model (Kling, Seedance,
  Gen-4.5, Hailuo) -- mix and match per shot.
- **Cast characters** -- upload portraits, generate LoRA training sets, train a character LoRA
  on your GPU so your cast looks consistent across shots.
- **Score the film** -- attach a music bed, narrate it with TTS, or beat-sync cuts.
- **Download the assembled silent MP4** or mux in audio without touching the GPU at all.

Everything beyond keyframes uses your own R2 bucket for artifacts; you are never renting storage
from us.

## Why not just use a SaaS?

Because you run Proxmox. Because you have a V100 or an H100 and you do not want to pay $0.80 a
second to someone else's GPU. Because you want to swap the motion model, adjust the sampler,
and not file a support ticket to do it.

Vivijure is for the creative homelabber who is priced out of subscription AI video tools and
prefers to own the stack. The control plane is on Cloudflare's free tier (no server to run);
the GPU work hits whatever endpoint you point it at; the artifacts land in your R2 bucket.

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/skyphusion-labs/vivijure
cd vivijure
npm install

# 2. Configure
#    Edit wrangler.toml: add your R2 bucket, D1 database, and module service bindings.
#    Set secrets (RunPod key, CF Access token for R2, AI Gateway) via wrangler secret put.

# 3. Develop locally
npm run dev        # wrangler dev -- hot reload at localhost:8787

# 4. Deploy
npm run deploy     # wrangler deploy
```

See [CLAUDE.md](CLAUDE.md) for conventions and [docs/module-authoring.md](docs/module-authoring.md)
for how to write your own module worker.

## Architecture

Vivijure is a **module host, not a monolith**. The core worker owns what is always true --
project, storyboard, cast, bundle assembly, render orchestration, and a module registry. Every
capability beyond that is an opt-in **module worker** plugged into the pipeline through a typed
hook contract.

Install only the modules you want. The studio UI assembles itself from `GET /api/modules` -- it
never hardcodes a feature section. Install none and you get a clean, empty studio.

```
core (this worker)
  |-- keyframe hook      --> your SDXL keyframe module (GPU)
  |-- motion.backend     --> GPU i2v module OR cloud motion module (per shot)
  |-- finish             --> interpolation / upscale (optional chain)
  |-- score              --> music / narration / beat-sync (optional chain)
  |-- plan.enhance       --> LLM auto-direction before render (optional)
  |-- cast.image         --> portrait -> LoRA training set (optional)
  '-- notify             --> render-done email / webhook (optional)
```

The module contract is `vivijure-module/1` in [`src/modules/types.ts`](src/modules/types.ts).
A module is a Cloudflare Worker that serves `GET /module.json` (manifest) and `POST /invoke`
(run a hook). That is the whole interface; a module in another language, on another platform,
works fine as long as it speaks JSON over HTTP.

See [docs/module-api.md](docs/module-api.md) for the full contract and
[docs/module-authoring.md](docs/module-authoring.md) for the step-by-step guide.

The GPU render backend is [`vivijure-backend`](https://github.com/skyphusion-labs/vivijure-backend)
(RunPod serverless, SDXL + Wan I2V + ffmpeg assemble). The studio UI lives at
`vivijure.skyphusion.org` (`/planner`, `/cast`, `/modules`).

## Develop

```bash
npm run typecheck     # tsc --noEmit (CI gate -- run before pushing)
npm test              # vitest
npm run dev           # wrangler dev
npm run deploy        # wrangler deploy
```

`account_id` comes from `CLOUDFLARE_ACCOUNT_ID` in the environment, not hardcoded. All bindings
are in `wrangler.toml` (committed); secrets go in via `wrangler secret put`.

## License

AGPL-3.0. Free as in yours.
