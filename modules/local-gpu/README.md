# local-gpu

A first-class **`motion.backend`**-hook module (vivijure-module/2). It animates each start keyframe
into a clip (image-to-video, **LTX-Video**) on the user's **own local consumer GPU** -- a 12GB-class
consumer card in their homelab -- via the **vivijure-local-12gb** job server (`i2v_clip` action).

This is the **local-consumer door**: the deliberate opposite of the RunPod datacenter backend
(`alibaba-wan`) and even of `own-gpu` (which still runs on a RunPod endpoint the user provisions).
Here the work happens on real silicon the user already owns -- no rent, no cloud GPU at all -- reached
over a Cloudflare tunnel that terminates at the box.

## One studio, two honest doors

The hook contract makes the motion backend pluggable. The control plane is unchanged; the user picks
the door:

```
DATACENTER door:  control plane --> alibaba-wan / own-gpu --/run--> RunPod --> vivijure-backend (Wan 2.2, H200/B200)
LOCAL door:       control plane --> local-gpu          --/run--> tunnel --> vivijure-local-12gb (LTX-Video, 12GB consumer GPU)
```

Both speak the SAME `i2v_clip` wire body (`buildI2vBody`); only the box behind the endpoint differs.
That sameness IS the swappability.

## Where it fits

It occupies the `motion.backend` slot (the one backend that turns keyframes into motion), `ui.order`
4 -- ahead of `own-gpu` (5) and the rented cloud i2v modules (Veo, Sora, Kling, Hailuo, Seedance,
Vidu, Wan cloud), because a truly-local card needs no rent at all.

The seam is R2: like `own-gpu`, the backend SHARES the `vivijure` bucket. It reads the keyframe by key
and WRITES the finished clip itself, so this module never downloads or re-uploads; it submits, polls,
and surfaces the `clip_key` the backend reported.

## Configuration

The planner-projected `config_schema` (the core clamps each value against it):

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `quality` | enum `draft` / `standard` / `final` | `standard` | i2v quality tier |
| `fps` | int (8..30) | `24` | output frame rate (LTX is comfortable at 24-30) |
| `flow_shift` | float (1..12) | `5.0` | motion amount (lower = faster) |
| `negative_prompt` | string | `""` | additive negative prompt |
| `seed` | int (>= -1) | `-1` | seed (`-1` = random) |

**Tier honesty (#124).** The `quality` enum is the core's shared vocabulary (`draft/standard/final`);
the core injects the chosen tier and `validateConfig` silently drops any value not in this enum, so the
names must match the core `QUALITY_TIERS` exactly. The local backend maps each tier to an **LTX engine
config a 12GB card can honestly deliver**: `final` here means the card's honest ceiling (LTX full-step
at its 12GB resolution/frame limit), NOT datacenter (Wan B200) parity. Same names, backend-specific
mapping -- exactly as the Wan backend maps the tiers to its step counts. See vivijure-local-12gb
`docs/i2v-model-selection.md` for the per-tier numbers.

To self-host (service `vivijure-module-local-gpu`, bound into the core as `MODULE_LOCAL_GPU`):

- **Env at deploy**: `CLOUDFLARE_ACCOUNT_ID` (account_id is injected, never hardcoded).
- **Secrets** (Cloudflare Secrets Store): `LOCAL_BACKEND_URL` (the tunnel hostname terminating at your
  homelab render box) and the optional `LOCAL_BACKEND_TOKEN` (a shared secret your server checks).
- **Provision**: run `vivijure-local-12gb` on your box (LTX-Video on a 12GB card), expose it via a
  Cloudflare tunnel, and point `LOCAL_BACKEND_URL` at it. The backend shares the `vivijure` R2 bucket
  and does the clip I/O. No R2 binding on this worker.

## Contract

- **Hook**: `motion.backend` (the clips backend slot). `ui { section: "motion", order: 4 }`.
- **Input** (`MotionBackendInput`): `shot_id`, `keyframe_url` (presigned, unused here -- the backend
  reads by key), `keyframe_key` (the R2 key the backend reads directly), `prompt`, `seconds`.
- **Output** (`MotionBackendOutput`): `shot_id`, `clip_key`, `fps`, `frames`.
- **Async + cancelable**: `POST /invoke` submits `i2v_clip` and returns a poll token; `POST /poll`
  checks `/status/{jobId}` (with the #141 grace window -- a local box restart loses the in-memory job,
  so a 404 past the window fails the shot rather than polling forever); `POST /cancel` stops an
  in-flight job so a cancelled render does not orphan the GPU (`cancelable: true`, the #327/#328
  discipline).
- **R2 transport**: the backend reads the keyframe and writes the clip in the shared bucket itself;
  this worker holds no R2 creds.

This is a producer stage, not a polish step: a real failure is an honest `ok:false` (no soft-degrade),
because a missing clip cannot be finished or assembled.

## License

**AGPL-3.0-only.** A labor of love, given freely: use it, learn from it, self-host it, build your own
creative visions on it. Run it as a network service and the AGPL has you share your changes back, so it
stays a commons. It is not for sale, and not to be resold as a SaaS.
