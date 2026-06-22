# own-gpu

A first-class **`motion.backend`**-hook module (vivijure-module/1). It animates each start keyframe into
a clip (image-to-video, Wan2.2-I2V) on **your own GPU** via the **vivijure-backend** RunPod endpoint
(`i2v_clip` action).

This is the **clips stage**: it occupies the `motion.backend` slot, the one backend that turns
keyframes into motion. It is the BYO-GPU default (own keys, no per-clip rent), so it sorts ahead of the
cloud i2v modules (Veo, Sora, Kling, Hailuo, Seedance, Vidu, Wan cloud) that fill the same slot.

## Where it fits

```mermaid
flowchart LR
  cast["cast.image<br/>(character refs)"]
  kf["keyframe<br/>(SDXL)"]
  clips["clips<br/>(motion.backend: own-gpu i2v)"]
  dlg["dialogue<br/>(TTS)"]
  sp["speech<br/>(enhance)"]
  subgraph finish["finish chain"]
    rife["finish-rife · 10"]
    ls["finish-lipsync · 15"]
    up["finish-upscale · 20"]
    ov["text-overlay"]
  end
  asm["assemble"]
  mux["mux"]
  done["done"]

  cast -. "refs / LoRA" .-> kf
  kf -- "keyframe_key" --> clips --> dlg --> sp --> rife --> ls --> up --> ov --> asm --> mux --> done

  style clips fill:#dff,stroke:#0aa,stroke-width:2px
```

The seam is R2: unlike a cloud i2v backend, ours SHARES the `vivijure` bucket. It reads the keyframe by
key and WRITES the finished clip itself, so this module never downloads or re-uploads; it submits,
polls, and surfaces the `clip_key` the backend reported. The next stage (dialogue, then finish) drives
off that clip.

## Contract

- **Hook**: `motion.backend` (the clips backend slot). `ui { section: "motion", order: 5 }` -- low
  order so the own-GPU backend is the default pick over the rented cloud i2v modules.
- **Input** (`MotionBackendInput`): `shot_id`, `keyframe_url` (presigned, for cloud backends),
  `keyframe_key` (the R2 key this backend reads directly), `prompt`, `seconds`.
- **Config** (`config_schema`): `quality` (draft/standard/final), `fps`, `flow_shift` (motion amount),
  additive `negative_prompt`, `seed`.
- **Output** (`MotionBackendOutput`): `shot_id`, `clip_key`, `fps`, `frames`.
- **Async**: `POST /invoke` submits `i2v_clip` to RunPod and returns a poll token; `POST /poll` checks
  `/status/{jobId}` (with the GC-grace window, #141) and surfaces the clip on completion.
- **R2 transport**: the backend reads the keyframe and writes the clip in the shared bucket itself;
  this worker holds no R2 creds.

This is a producer stage, not a polish step: a real failure is an honest `ok:false` (no soft-degrade),
because a missing clip cannot be finished or assembled.

## Deploy

Service `vivijure-module-own-gpu`, bound into the core as `MODULE_OWN_GPU`. Secrets (set after deploy):
`RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` (the vivijure-backend endpoint id, kept secret). See
`wrangler.toml`.
