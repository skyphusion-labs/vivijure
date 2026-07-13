# Opt-in add-ons: what each one is, and how to turn it on

Vivijure's **standard install** already gives you a complete studio: you write a storyboard, render
it to video on rented GPUs (RunPod) or your own graphics card, and the **media stack** assembles the
result into one finished film, adds title cards and on-screen text, and polishes the audio. See
[quickstart.md](quickstart.md) to stand that up.

Everything on this page is **extra** -- an add-on beyond the standard install. You turn on only what
you want, when you want it. Each one is honest about what it needs from you, so you always know what
you are signing up for before you flip it on.

Where each piece sits on the map is in [constellation.md](constellation.md).

---

## What is already in your standard install (no action needed here)

These used to be opt-in "tiers"; as of #519 they are part of the **standard** install and ship on by
default. You do not turn them on from this page -- you set them up once when you deploy (covered by
[quickstart.md](quickstart.md) "Bring up the media stack" and [DEPLOYMENT.md](DEPLOYMENT.md) section
5). They are listed here so you know what you already have.

**The media stack** -- five always-on CPU containers on a computer you own, reached privately over
Workers VPC. Brought up together with `docker compose -f containers/compose.yaml up -d --build`:

- **video-finish** -- the film assembler: stitches your rendered clips into one movie and muxes in the
  audio. The film assembly step runs here, which is exactly why the media stack is standard now:
  without it, a render gives you a folder of separate clips, not a single movie.
- **image-prep** -- cleans up input images before they go to the GPU, for more reliable keyframes.
- **audio-beat-sync** -- finds the beat of your music bed (librosa) so cuts land on the beat.
- **audio-mix** -- mixes dialogue, ducked music, and loudness into one audio bed.
- **audio-master** -- final loudness/LUFS leveling across the whole film. A master miss soft-degrades
  to the un-mastered bed; it never fails your render.

**Text on screen** -- three modules that burn text using the `video-finish` container:

- **film-titles** -- opening title and end-credit cards for the whole film, added after the film is
  assembled. No GPU re-render.
- **subtitle** -- burns a time-synced subtitle track (an SRT file) into the film as open captions
  viewers cannot turn off.

> **Runtime honesty (#519 / #524).** The media stack is standard at INSTALL time, but "installed" is
> not the same as "reachable at render time" -- your box can be off, or the tunnel down, when assembly
> fires. If `video-finish` is unreachable then (after the bounded retry), the film still COMPLETES: it
> delivers the rendered per-shot clips (or, at the mux step, the silent assembled film) with a loud
> "finish unavailable" status, rather than hard-failing after the GPU spend or silently shipping as if
> finished. A genuine finish ERROR still fails the render loud. See
> [observability.md](observability.md) for the `film.finish_unavailable` event.

---

## How to read the add-ons below

Each add-on tells you four things:

- **What it is** -- in plain words.
- **What you get** -- why you would turn it on.
- **What it needs** -- the box or endpoint you must stand up first.
- **How to turn it on** -- the switch, once its dependency is running.

> **The golden rule.** Every add-on here is wired into the Studio by a *binding* in `wrangler.toml`. A
> binding that points at something you have not built yet makes the deploy **fail** (Cloudflare calls
> this a "dangling binding"). So the order is always: **stand up the dependency first, then flip the
> switch.** `deploy.sh` protects you with comment markers: it strips each opt-in block unless its
> profile or flag is set, so a binding can never dangle.
>
> The profile switch: your `deploy.env` sets `VIVIJURE_PROFILE`. **`standard`** (the default) is the
> core + render + media stack described above. **`satellites`** also deploys the three GPU finish
> endpoints below. (The old `minimal` / `full` names still work as aliases and print a deprecation
> note: `minimal` -> `standard`, `full` -> `satellites`.) The local-GPU render door is a separate flag,
> `INSTALL_LOCAL_GPU=1`.

---

## The GPU finish satellites (extra RunPod endpoints) -- profile: `satellites`

These do GPU finish work, so they run as their **own** RunPod Serverless endpoints, separate from the
main render backend. For each one you turn on: create the endpoint on RunPod, set its R2 env (see the
shared note just below), then put its endpoint id into the account Secrets Store secret named.

> **Every satellite endpoint needs R2 credentials in its RunPod env (#522).** Each satellite reads its
> inputs from, and writes its outputs to, YOUR R2 bucket directly, so its RunPod endpoint template must
> set `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` (the same R2 values
> the backend endpoint uses; [DEPLOYMENT.md](DEPLOYMENT.md) section 4). `scripts/runpod-provision.py
> --satellite <upscale|lipsync|audio-upscale>` sets these four vars on the endpoint for you from your
> `deploy.env` (recommended; see each tier below), or set them by hand -- the `deploy.sh` path itself
> only collects the endpoint *ids*. Miss them and the first full render
> fails at finish with the satellite's honest error (`R2 mode needs R2_ENDPOINT_URL +
> R2_ACCESS_KEY_ID/SECRET in the endpoint env`), correctly, after the keyframe/i2v GPU spend. **RunPod
> gotcha:** changing an endpoint's template env does NOT reach already-warm workers -- FlashBoot keeps
> cached containers, so trigger an **endpoint release** (redeploy/bump the endpoint) for env changes to
> take effect.

### finish-upscale (video upscale)
- **What it is:** a video upscaler (Real-ESRGAN, 2x or 4x).
- **What you get:** sharper, higher-resolution clips.
- **What it needs:** a RunPod endpoint running the `vivijure-upscale` image, with the four R2 env vars
  above set on it; its id in the store secret `VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID`; and the
  `finish-upscale` (`MODULE_UPSCALE`) binding kept.
- **Provision it:** `python3 scripts/runpod-provision.py --satellite upscale` sets the image (pinned
  release tag) + the four R2 env vars from your `deploy.env`. Put the printed
  `VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID` in deploy.env.

### finish-lipsync (talking characters)
- **What it is:** a lip-sync engine (MuseTalk). It rewrites a character's mouth to match spoken lines.
- **What you get:** characters whose lips move in time with their dialogue.
- **What it needs:** a RunPod endpoint running the `vivijure-musetalk` image, with the four R2 env vars
  above set on it; its id in the store secret `MUSETALK_RUNPOD_ENDPOINT_ID`; and the `finish-lipsync`
  (`MODULE_LIPSYNC`) binding kept. It works best with `speech-upscale` on.
- **Provision it:** `python3 scripts/runpod-provision.py --satellite lipsync` sets the image + the four
  R2 env vars from your `deploy.env`. Put the printed `MUSETALK_RUNPOD_ENDPOINT_ID` in deploy.env.

### speech-upscale
- **What it is:** a speech cleanup step for dialogue audio.
- **What you get:** clearer spoken lines, which makes lip-sync land better.
- **What it needs:** a RunPod endpoint running the `vivijure-audio-upscale` image (resemble-enhance),
  with the four R2 env vars above set on it; its id is bound from the account Secrets Store as this
  module's `RUNPOD_ENDPOINT_ID` (store secret `AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID`), alongside the shared
  `RUNPOD_API_KEY` -- the same store-bound pattern as finish-upscale / finish-lipsync (#238), not a
  per-module `wrangler secret put`. `deploy.sh` (satellites profile) seeds the id from
  `AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID` in `deploy.env`. Keep the `speech-upscale`
  (`MODULE_SPEECH_UPSCALE`) binding.
- **Provision it:** `python3 scripts/runpod-provision.py --satellite audio-upscale` sets the image +
  the four R2 env vars from your `deploy.env`. Put the printed `AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID` in deploy.env.

---

## Watching your studio (observability)

### tail consumer (logs to your dashboards)
- **What it is:** a log shipper. It sends the Studio's render logs and errors to your own Grafana/Loki
  dashboards.
- **What you get:** live tracing of a render from outside the Worker, so you can see what happened and
  why. See [observability.md](observability.md).
- **What it needs:** your own `vivijure-tail` Worker deployed first, then the `tail_consumers` line kept
  (`deploy.sh` strips this our-fleet-only block by default, so a stock deploy is poll-only).

---

## Install modules without redeploying (Workers for Platforms)

- **What it is:** dynamic dispatch. It lets you install a new module by uploading it on its own, with no
  redeploy of the Studio core.
- **What you get:** add or swap capabilities on a live studio, and let the community ship modules into
  your namespace.
- **What it needs:** Workers for Platforms turned on for your Cloudflare account (a **paid** add-on) and
  a dispatch namespace created out of band. Full details in [module-dispatch.md](module-dispatch.md).
- **Good to know:** self-hosting never needs this. It is a convenience for operators who want
  install-without-redeploy. The standard install does not use it.

---

## Render on your own GPU (the local doors)

If you would rather not rent GPUs at all, the **local-GPU doors** are a separate self-hosted render
backend you run on your own graphics card: `vivijure-local-12gb` (LTX, 12 GB class) and
`vivijure-local-16gb` (CogVideoX, 16 GB class). They plug in through the same contract as the RunPod
backend. Set `INSTALL_LOCAL_GPU=1` for `deploy.sh` to keep the local-GPU binding, and follow the door
repo's own README. Note the serverless RunPod backend and the local doors are different render paths;
consumer cards belong to the local doors, never the rented serverless pool.

---

*Turn on nothing on this page and you still have a complete studio that writes, renders, assembles,
titles, and scores films. Every add-on above is a step up you take when you want it, not a hoop you
jump through to start.*
