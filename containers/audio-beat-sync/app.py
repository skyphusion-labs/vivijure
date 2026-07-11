"""Audio beat-sync container: librosa beat analysis over HTTP.

The Worker presigns a short-lived R2 GET URL and POSTs { audioUrl, ... } to
/analyze; we stream the bytes, run librosa.beat.beat_track, fit clip
boundaries onto beats, and return the snake_case AudioBeatPlan shape the
Worker's parseAudioBeatPlan expects. CPU-only; no R2 binding (presign keeps
credentials on the Worker). See docs/audio-beat-sync-container.md.
"""
import asyncio
import logging
import os
import tempfile

import librosa
import numpy as np
from aiohttp import ClientSession, ClientTimeout, web

from url_guard import validate_fetch_url

PORT = int(os.environ.get("PORT", "8000"))
DOWNLOAD_TIMEOUT_S = 30
MAX_AUDIO_BYTES = 64 * 1024 * 1024  # 64 MB upper bound

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audio-beat-sync")


async def health(_req):
    # Cheap readiness probe; does NOT touch librosa.
    return web.json_response({"ok": True})


async def analyze(req):
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

    audio_url = body.get("audioUrl")
    audio_key = body.get("audioKey", "")  # echoed back; not used for fetch
    try:
        clip_s = float(body.get("clipSeconds", 8.0))
        min_scene_s = float(body.get("minSceneS", 2.5))
        max_scene_s = float(body.get("maxSceneS", 12.0))
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "bad numeric input"}, status=400)
    mode = body.get("mode", "beat")
    force_shots = body.get("forceShots")

    if not audio_url or clip_s <= 0 or mode not in ("beat", "duration"):
        return web.json_response({"ok": False, "error": "bad input"}, status=400)
    ok, why = validate_fetch_url(audio_url)
    if not ok:
        return web.json_response({"ok": False, "error": f"audioUrl blocked: {why}"}, status=400)

    fd, path = tempfile.mkstemp(suffix=".bin")
    os.close(fd)
    try:
        async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
            async with s.get(audio_url, allow_redirects=False) as r:  # a redirect could sidestep the allowlist; R2 never redirects
                if r.status != 200:
                    return web.json_response(
                        {"ok": False, "error": f"audio fetch {r.status}"}, status=502
                    )
                total = 0
                with open(path, "wb") as out:
                    async for chunk in r.content.iter_chunked(64 * 1024):
                        total += len(chunk)
                        if total > MAX_AUDIO_BYTES:
                            return web.json_response(
                                {"ok": False, "error": "audio too large"}, status=413
                            )
                        out.write(chunk)

        loop = asyncio.get_running_loop()
        plan = await loop.run_in_executor(
            None, _compute, path, clip_s, mode, min_scene_s, max_scene_s, force_shots, audio_key
        )
        return web.json_response({"ok": True, **plan})
    except Exception as e:  # noqa: BLE001 - surface any analysis failure as 500
        log.exception("analyze failed")
        return web.json_response({"ok": False, "error": str(e)}, status=500)
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def _compute(path, clip_s, mode, min_s, max_s, force_shots, audio_key):
    y, sr = librosa.load(path, sr=22050, mono=True)
    duration_s = float(len(y)) / sr

    if mode == "duration":
        if force_shots:
            n = int(force_shots)
        else:
            n = max(1, int(round(duration_s / clip_s)))
        return {
            "mode": "duration",
            "audio_key": audio_key,
            "duration_seconds": duration_s,
            "suggested_shots": n,
            "clip_seconds": clip_s,
            "film_seconds": duration_s,
            "remainder_seconds": 0.0,
            "timed_scenes": [],
            "note": f"Duration sync, {n} shots x {clip_s:.1f}s.",
        }

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    # Walk beats; close a boundary once the span passes clip_s (and at least
    # min_s), or force-close at max_s, so each shot lands on a beat.
    scenes = []
    span_start = 0.0
    for t in beat_times + [duration_s]:
        span = t - span_start
        if (span >= clip_s and span >= min_s) or (span >= max_s):
            scenes.append({"start": span_start, "end": t})
            span_start = t
    if not scenes:
        scenes.append({"start": 0.0, "end": duration_s})
    elif span_start < duration_s:
        scenes[-1]["end"] = duration_s  # absorb the tail into the last shot

    timed = [
        {
            "index": i,
            "start": s["start"],
            "end": s["end"],
            "target_seconds": round(s["end"] - s["start"], 3),
        }
        for i, s in enumerate(scenes)
    ]
    bpm = float(np.atleast_1d(tempo)[0])
    return {
        "mode": "beat",
        "audio_key": audio_key,
        "duration_seconds": duration_s,
        "bpm": bpm,
        "beat_count": len(beat_times),
        "suggested_shots": len(timed),
        "clip_seconds": clip_s,
        "film_seconds": duration_s,
        "remainder_seconds": 0.0,
        "timed_scenes": timed,
        "note": f"Beat sync, {bpm:.0f} BPM, {len(beat_times)} beats -> {len(timed)} shots (boundaries on beats).",
    }


app = web.Application()
app.router.add_get("/health", health)
app.router.add_post("/analyze", analyze)

if __name__ == "__main__":
    log.info("audio-beat-sync listening on 0.0.0.0:%d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)
