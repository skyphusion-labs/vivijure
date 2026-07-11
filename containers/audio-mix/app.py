"""Audio-mix container: ffmpeg multi-track mix + sidechain duck + LUFS loudnorm.

The partner to the talking/scored films: a slim CPU/ffmpeg container that mixes
a film's audio tracks PROPERLY -- dialogue + music (+ optional sfx) -- with the
music ducked UNDER the speech (sidechaincompress keyed on the dialogue) and the
whole mix loudness-normalized to a web target (two-pass loudnorm, -14 LUFS by
default). A flat amix sounds amateur; the duck keeps speech intelligible.

The Worker presigns short-lived R2 GET URLs for each track and a PUT URL for the
mixed output, and POSTs them to /mix. We download the tracks, build the
filtergraph, mix + duck + two-pass loudnorm (mix_core.mix_tracks, run in a thread
executor), and PUT the mixed mp3/wav. Bytes never touch the Worker; CPU-only
ffmpeg; no R2 binding (presign keeps credentials on the Worker). Modeled on
containers/video-finish/app.py. The HTTP contract is the POST /mix handler
below; the ffmpeg DSP lives in mix_core.py (test_local.py validates it).
"""
import asyncio
import logging
import os
import shutil
import subprocess
import tempfile

from aiohttp import ClientSession, ClientTimeout, web

from mix_core import DEFAULT_TARGET_LUFS, ROLES, mix_tracks
from url_guard import validate_fetch_url

PORT = int(os.environ.get("PORT", "8000"))
DOWNLOAD_TIMEOUT_S = 120
UPLOAD_TIMEOUT_S = 120
MAX_TRACK_BYTES = 128 * 1024 * 1024   # 128 MB per track
MAX_TRACKS = 16

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audio-mix")


async def health(_req):
    # Cheap readiness probe; does not shell out to ffmpeg.
    return web.json_response({"ok": True})


async def _download(session, url, path, cap):
    ok, why = validate_fetch_url(url)
    if not ok:
        return False, f"blocked: {why}"
    async with session.get(url, allow_redirects=False) as r:  # a redirect could sidestep the allowlist; R2 never redirects
        if r.status != 200:
            return False, f"fetch {r.status}"
        total = 0
        with open(path, "wb") as out:
            async for chunk in r.content.iter_chunked(256 * 1024):
                total += len(chunk)
                if total > cap:
                    return False, "too large"
                out.write(chunk)
    return True, total


async def mix(req):
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

    tracks = body.get("tracks")
    output_url = body.get("outputUrl")
    output_key = body.get("outputKey", "")
    fmt = str(body.get("format", "mp3")).lower()

    if not isinstance(tracks, list) or not tracks:
        return web.json_response({"ok": False, "error": "tracks must be a non-empty array"}, status=400)
    if len(tracks) > MAX_TRACKS:
        return web.json_response({"ok": False, "error": f"too many tracks (>{MAX_TRACKS})"}, status=400)
    if not output_url:
        return web.json_response({"ok": False, "error": "outputUrl required"}, status=400)
    ok, why = validate_fetch_url(output_url)
    if not ok:
        return web.json_response({"ok": False, "error": f"outputUrl blocked: {why}"}, status=400)
    if fmt not in ("mp3", "wav"):
        return web.json_response({"ok": False, "error": "format must be mp3 or wav"}, status=400)

    try:
        target_lufs = float(body.get("loudnessTargetLufs", DEFAULT_TARGET_LUFS))
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "loudnessTargetLufs must be numeric"}, status=400)

    # Validate + normalize the track specs before any download.
    parsed = []
    for i, t in enumerate(tracks):
        if not isinstance(t, dict):
            return web.json_response({"ok": False, "error": f"tracks[{i}] must be an object"}, status=400)
        url = t.get("url")
        role = t.get("role")
        if not url:
            return web.json_response({"ok": False, "error": f"tracks[{i}].url missing"}, status=400)
        if role not in ROLES:
            return web.json_response(
                {"ok": False, "error": f"tracks[{i}].role must be one of {list(ROLES)}"}, status=400)
        try:
            gain_db = float(t.get("gainDb", 0.0))
        except (TypeError, ValueError):
            return web.json_response({"ok": False, "error": f"tracks[{i}].gainDb must be numeric"}, status=400)
        parsed.append({"url": url, "role": role, "gainDb": gain_db})

    work = tempfile.mkdtemp(prefix="amix-")
    try:
        async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
            for i, t in enumerate(parsed):
                p = os.path.join(work, f"track_{i:02d}.bin")
                ok, info = await _download(s, t["url"], p, MAX_TRACK_BYTES)
                if not ok:
                    status = 413 if info == "too large" else (400 if info.startswith("blocked:") else 502)
                    return web.json_response({"ok": False, "error": f"tracks[{i}] {info}"}, status=status)
                t["path"] = p

        loop = asyncio.get_running_loop()
        try:
            out_path, result = await loop.run_in_executor(
                None, mix_tracks, work, parsed, target_lufs, fmt,
            )
        except subprocess.CalledProcessError as e:
            log.exception("ffmpeg failed")
            return web.json_response({"ok": False, "error": f"ffmpeg failed: {e}"}, status=500)
        except Exception as e:  # noqa: BLE001
            log.exception("mix failed")
            return web.json_response({"ok": False, "error": str(e)}, status=500)

        with open(out_path, "rb") as f:
            out_bytes = f.read()

        content_type = "audio/mpeg" if fmt == "mp3" else "audio/wav"
        async with ClientSession(timeout=ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:
            async with s.put(output_url, allow_redirects=False, data=out_bytes,
                             headers={"content-type": content_type}) as r:
                if r.status not in (200, 201, 204):
                    return web.json_response({"ok": False, "error": f"output put {r.status}"}, status=502)

        log.info("/mix ok key=%s bytes=%d dur=%.3f lufs=%.2f ducked=%s",
                 output_key, len(out_bytes), result["durationSeconds"], result["lufs"], result["ducked"])
        return web.json_response({
            "ok": True,
            "key": output_key,
            "bytes": len(out_bytes),
            "format": fmt,
            "durationSeconds": result["durationSeconds"],
            "lufs": result["lufs"],
            "loudnessTargetLufs": target_lufs,
            "ducked": result["ducked"],
            "tracks": len(parsed),
        })
    finally:
        shutil.rmtree(work, ignore_errors=True)


app = web.Application(client_max_size=1024 * 1024)  # JSON bodies are small (URLs only)
app.router.add_get("/health", health)
app.router.add_post("/mix", mix)
# The single-bed "master the bed" pass (formerly POST /music-upscale here) was lifted out into its own
# first-class module under the `master` hook (modules/audio-master + containers/audio-master). This
# container stays the multi-track MIX + duck only.

if __name__ == "__main__":
    log.info("audio-mix listening on 0.0.0.0:%d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)
