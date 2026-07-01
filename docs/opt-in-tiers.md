# Opt-in services: what each one is, and how to turn it on

Vivijure starts small on purpose. A first deploy gives you the **core studio + cloud render**: you
write a storyboard, and the Studio renders it to video on rented GPUs (RunPod) or your own graphics
card. That is the whole minimal profile, and it works with just your Cloudflare and RunPod keys. See
[quickstart.md](quickstart.md).

Everything on this page is **extra**. You turn on only what you want, when you want it. Each service
here is honest about what it needs from you, so you always know what you are signing up for before you
flip it on.

## How to read this page

Each service below tells you four things:

- **What it is** -- in plain words.
- **What you get** -- why you would turn it on.
- **What it needs** -- the box or endpoint you must stand up first.
- **How to turn it on** -- the switch, once its dependency is running.

> **The golden rule.** Every service here is wired into the Studio by a *binding* in `wrangler.toml`.
> A binding that points at something you have not built yet will make the deploy **fail** (Cloudflare
> calls this a "dangling binding"). So the order is always: **stand up the dependency first, then flip
> the switch.** The minimal profile leaves all of these switched off, which is why it just works.
>
> The one switch: your `deploy.env` sets `VIVIJURE_PROFILE`. `minimal` (the default) leaves every
> service on this page off. `full` keeps them all on -- use it only after you have stood up every
> dependency below. To turn on just one or two, leave the profile `minimal` and uncomment only the
> blocks you want in `wrangler.toml.example`, following each "How to turn it on" note.

Where each service sits on the map is in [constellation.md](constellation.md) (the "Finish helper
engines" and the CPU containers).

---

## Tier 1: The finish fleet (your own always-on CPU boxes)

These are small helper programs that do ffmpeg/CPU work, not GPU work. They run **always-on** as
Docker containers on a computer you own, and the Studio reaches them privately over a Cloudflare VPC
link. Bring the whole set up at once:

```bash
docker compose -p vivijure-media -f containers/compose.yaml up -d --build
```

Then, in the Cloudflare dashboard, create one **VPC Service** per container pointing at it, and put
each service id into the matching `[[vpc_services]]` block in `wrangler.toml.example`.

### video-finish
- **What it is:** the film assembler. It stitches your rendered clips into one movie and muxes in the
  audio.
- **What you get:** a single finished film file instead of a folder of separate clips. It also powers
  title cards, on-screen text, and burned-in subtitles (the three modules just below).
- **What it needs:** the `video-finish` container running, and its `VIDEO_FINISH_VPC` service id set.
- **How to turn it on:** stand up the container, set the id, then keep the `film-titles`,
  `text-overlay`, and `subtitle` module bindings.

### image-prep
- **What it is:** an image cleanup helper that prepares pictures before they go to the GPU.
- **What you get:** more reliable keyframes from messy input images.
- **What it needs:** the `image-prep` container running, and its `IMAGE_PREP_VPC` service id set.

### audio-beat-sync
- **What it is:** a music analyzer (it uses librosa to find the beat).
- **What you get:** cuts that land on the beat of your music bed, so a scored film feels edited to the
  music.
- **What it needs:** the `audio-beat-sync` container running, its `AUDIO_BEAT_SYNC_VPC` id set, and the
  `beat-sync` module binding kept.

### audio-master
- **What it is:** a final audio polish step (loudness/LUFS leveling and music upscale).
- **What you get:** film-level, even loudness across the whole movie, instead of a raw music bed.
- **What it needs:** the `audio-master` container running, its `AUDIO_MIX_VPC` id set, and the
  `audio-master` module binding kept.
- **Good to know:** if this step ever misses, the film still finishes with the un-mastered bed. It
  never fails your render.

---

## Tier 2: Finish engines on rented GPUs (extra RunPod endpoints)

These do GPU finish work, so they run as their **own** RunPod Serverless endpoints, separate from the
main render backend. For each one you turn on: create the endpoint on RunPod, then put its endpoint id
into the account Secrets Store secret named below.

### finish-upscale (video upscale)
- **What it is:** a video upscaler (Real-ESRGAN, 2x or 4x).
- **What you get:** sharper, higher-resolution clips.
- **What it needs:** a RunPod endpoint running the `vivijure-upscale` image; its id in the store secret
  `VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID`; and the `finish-upscale` (`MODULE_UPSCALE`) binding kept.

### finish-lipsync (talking characters)
- **What it is:** a lip-sync engine (MuseTalk). It rewrites a character's mouth to match spoken lines.
- **What you get:** characters whose lips move in time with their dialogue.
- **What it needs:** a RunPod endpoint running the `vivijure-musetalk` image; its id in the store secret
  `MUSETALK_RUNPOD_ENDPOINT_ID`; and the `finish-lipsync` (`MODULE_LIPSYNC`) binding kept. It works best
  with `speech-upscale` on.

### speech-upscale
- **What it is:** a speech cleanup step for dialogue audio.
- **What you get:** clearer spoken lines, which makes lip-sync land better.
- **What it needs:** its module endpoint set, and the `speech-upscale` (`MODULE_SPEECH_UPSCALE`) binding
  kept.

---

## Tier 3: Text on screen (needs video-finish from Tier 1)

These three modules all burn text using the `video-finish` container, so turn on **video-finish first**.

### film-titles
- **What it is:** opening title and end-credit cards for the whole film.
- **What you get:** a real title card at the start and credits at the end, added after the film is
  assembled. No GPU re-render.
- **How to turn it on:** with `video-finish` up, keep the `film-titles` (`MODULE_FILM_TITLES`) binding.

### text-overlay
- **What it is:** on-screen text (titles, credits, lower-thirds, captions) burned into a shot.
- **What you get:** labels and captions baked into the video.
- **How to turn it on:** with `video-finish` up, keep the `text-overlay` (`MODULE_TEXT_OVERLAY`) binding.

### subtitle
- **What it is:** burns a time-synced subtitle track (an SRT file) into the film.
- **What you get:** open captions viewers cannot turn off, baked into the picture.
- **How to turn it on:** with `video-finish` up, keep the `subtitle` (`MODULE_SUBTITLE`) binding.

---

## Tier 4: Watching your studio (observability)

### tail consumer (logs to your dashboards)
- **What it is:** a log shipper. It sends the Studio's render logs and errors to your own Grafana/Loki
  dashboards.
- **What you get:** live tracing of a render from outside the Worker, so you can see what happened and
  why. See [observability.md](observability.md).
- **What it needs:** your own `vivijure-tail` Worker deployed first, then the `tail_consumers` line kept.

---

## Tier 5: Install modules without redeploying (Workers for Platforms)

- **What it is:** dynamic dispatch. It lets you install a new module by uploading it on its own, with no
  redeploy of the Studio core.
- **What you get:** add or swap capabilities on a live studio, and let the community ship modules into
  your namespace.
- **What it needs:** Workers for Platforms turned on for your Cloudflare account (a **paid** add-on) and
  a dispatch namespace created out of band. Full details in [module-dispatch.md](module-dispatch.md).
- **Good to know:** self-hosting never needs this. It is a convenience for operators who want
  install-without-redeploy. The minimal profile does not use it.

---

*Turn on nothing here and you still have a complete studio that writes, renders, and assembles films.
Every tier above is a step up you take when you want it, not a hoop you jump through to start.*
