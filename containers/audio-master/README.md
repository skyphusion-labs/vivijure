# audio-master container

The CPU backend for the **`master`** hook (the `audio-master` module worker dispatches here). A slim
ffmpeg RunPod serverless endpoint that "masters" a film's audio bed: an optional **music upscale** (VHQ
soxr resample to 48 kHz + a gentle high-shelf "air" lift) followed by **two-pass LUFS loudness
normalization** to a web target. No GPU.

The DSP was lifted out of `containers/audio-mix` (the old, never-wired `/music-upscale` branch) so the
mastering pass is a first-class module under `master`, not a buried step in the mixer.

## Shape

- `master_core.py` -- the pure ffmpeg DSP (`master_bed`). STDLIB only; `test_local.py` drives it on
  local files (no R2, no RunPod).
- `rp_handler.py` -- the RunPod serverless handler. R2 in / R2 out: reads `audio_key`, writes
  `output_key` in the shared bucket itself (boto3 S3), so the module worker holds no R2 creds.
- `Dockerfile` -- `python:3.11-slim` + ffmpeg (with libsoxr) + runpod + boto3; a build-time
  sanity-encode proves the soxr + air-lift + loudnorm chain links before the first job.

## Job I/O

Input (the module's `buildRunPodBody`):

```json
{ "audio_key": "renders/<p>/audio/bed.wav", "output_key": "renders/<p>/audio/bed_mastered.wav",
  "target_lufs": -14, "upscale": true, "format": "wav", "seconds": 42 }
```

Output (the module's `parseBackendOutput` reads `audio_key` + `applied`):

```json
{ "audio_key": "renders/<p>/audio/bed_mastered.wav",
  "applied": ["music-upscale:soxr48k", "loudnorm:-14LUFS"],
  "durationSeconds": 42.0, "lufs": -14.05, "loudnessTargetLufs": -14, "format": "wav" }
```

A failure returns `{ "error": ... }` (the RunPod job is FAILED); the module then soft-degrades to the
ORIGINAL bed (passthrough), never dropping the film (#249 / #77).

## Endpoint env (set on the RunPod endpoint, never in the module worker)

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` -- creds for the shared bucket
the endpoint reads/writes by key.

## Local check

```bash
python test_local.py   # needs ffmpeg + ffprobe (with libsoxr) on PATH
```
