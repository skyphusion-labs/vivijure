# audio-master container

The CPU backend for the **`master`** hook (the `audio-master` module worker calls it over Workers VPC).
A slim ffmpeg HTTP server that "masters" a film's audio bed: an optional **music upscale** (VHQ soxr
resample to 48 kHz + a gentle high-shelf "air" lift) followed by **two-pass LUFS loudness
normalization** to a web target. No GPU -- CPU mastering must never touch a GPU/RunPod (GPU money is for
GPU work only); it runs as an always-on Workers VPC container on the fleet, like audio-mix + video-finish.

The DSP was lifted out of `containers/audio-mix` (the old, never-wired `/music-upscale` branch) so the
mastering pass is a first-class module under `master`, not a buried step in the mixer.

## Shape

- `master_core.py` -- the pure ffmpeg DSP (`master_bed`). STDLIB only; `test_local.py` drives it on
  local files (no R2, no HTTP).
- `app.py` -- the aiohttp HTTP server (`GET /health`, `POST /master`). The Worker presigns a short-lived
  R2 GET URL for the bed + a PUT URL for the output and POSTs them; bytes never touch the Worker.
- `url_guard.py` -- SSRF allowlist (vendored byte-for-byte from audio-mix): every request-supplied URL
  is validated (https + R2 host) before any fetch.
- `Dockerfile` -- `python:3.11-slim` + ffmpeg (with libsoxr) + aiohttp; a build-time sanity-encode
  proves the soxr + air-lift + loudnorm chain links before the first job. `CMD python app.py`, port 8000.

## HTTP contract

`GET /health` -> `{ "ok": true }`

`POST /master` (the module's `buildMasterBody`):

```json
{ "audioUrl": "https://<acct>.r2.cloudflarestorage.com/...?sig=get",
  "outputUrl": "https://<acct>.r2.cloudflarestorage.com/...?sig=put",
  "outputKey": "renders/<p>/audio/bed_mastered.wav",
  "targetLufs": -14, "upscale": true, "format": "wav" }
```

Response (the module composes `applied` from the structured facts):

```json
{ "ok": true, "key": "renders/<p>/audio/bed_mastered.wav", "bytes": 1234567,
  "format": "wav", "durationSeconds": 42.0, "lufs": -14.05,
  "loudnessTargetLufs": -14, "upscaled": true }
```

A failure returns `{ "ok": false, "error": ... }` with a non-2xx status; the module then soft-degrades to
the ORIGINAL bed (passthrough), never dropping the film (#249 / #77).

## No credentials

The container holds NO R2 creds. The Worker presigns the GET + PUT URLs (credentials stay on the
Worker); the container only downloads `audioUrl`, masters, and uploads to `outputUrl`. `url_guard.py`
rejects any non-R2 / non-https / IP-literal URL before fetching.

## Local check

```bash
python test_local.py   # needs ffmpeg + ffprobe (with libsoxr) on PATH
```
