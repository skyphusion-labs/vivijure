"""Audio-master container: ffmpeg film-level "master the bed" -- an optional music upscale (VHQ soxr
resample to 48 kHz + a gentle high-shelf "air" lift) followed by two-pass LUFS loudness normalization
to a web target.

A slim CPU/ffmpeg HTTP server, the partner of containers/audio-mix. CPU mastering is ffmpeg DSP, so it
must NEVER touch a GPU/RunPod (GPU money is for GPU work only); it runs as an always-on Workers VPC
container on the fleet, exactly like audio-mix + video-finish.

The Worker (audio-master module) presigns a short-lived R2 GET URL for the assembled bed and a PUT URL
for the mastered output, and POSTs them to /master. We download the bed, run the master DSP
(master_core.master_bed, in a thread executor), and PUT the mastered wav/mp3. Bytes never touch the
Worker; CPU-only ffmpeg; no R2 binding (presign keeps credentials on the Worker). Modeled on
containers/audio-mix/app.py. The HTTP contract is the POST /master handler below; the ffmpeg DSP lives
in master_core.py (test_local.py validates it).
"""
import asyncio
import logging
import os
import shutil
import subprocess
import tempfile

from aiohttp import ClientSession, ClientTimeout, web

from master_core import DEFAULT_TARGET_LUFS, master_bed
from url_guard import validate_fetch_url

PORT = int(os.environ.get("PORT", "8000"))
DOWNLOAD_TIMEOUT_S = 180
UPLOAD_TIMEOUT_S = 180
MAX_BED_BYTES = 256 * 1024 * 1024   # 256 MB: a film-length stereo bed is well under this
FORMATS = ("wav", "mp3")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audio-master")


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


async def master(req):
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

    audio_url = body.get("audioUrl")
    output_url = body.get("outputUrl")
    output_key = body.get("outputKey", "")
    fmt = str(body.get("format", "wav")).lower()

    if not audio_url:
        return web.json_response({"ok": False, "error": "audioUrl required"}, status=400)
    ok, why = validate_fetch_url(audio_url)
    if not ok:
        return web.json_response({"ok": False, "error": f"audioUrl blocked: {why}"}, status=400)
    if not output_url:
        return web.json_response({"ok": False, "error": "outputUrl required"}, status=400)
    ok, why = validate_fetch_url(output_url)
    if not ok:
        return web.json_response({"ok": False, "error": f"outputUrl blocked: {why}"}, status=400)
    if fmt not in FORMATS:
        return web.json_response({"ok": False, "error": f"format must be one of {list(FORMATS)}"}, status=400)

    try:
        target_lufs = float(body.get("targetLufs", DEFAULT_TARGET_LUFS))
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "targetLufs must be numeric"}, status=400)

    upscale = bool(body.get("upscale", True))

    # Optional film-length hint: when the module forwards the film length, master_core trims the bed to it so
    # the mastered output is film-length (tiny) instead of a raw, over-long music bed. Absent/invalid -> None
    # -> master the full bed (back-compat; video-finish still trims to the video length downstream).
    seconds = body.get("seconds")
    if seconds is not None:
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            return web.json_response({"ok": False, "error": "seconds must be numeric"}, status=400)
        if seconds <= 0:
            seconds = None

    work = tempfile.mkdtemp(prefix="amaster-")
    try:
        src = os.path.join(work, "in.bin")
        async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
            ok, info = await _download(s, audio_url, src, MAX_BED_BYTES)
        if not ok:
            status = 413 if info == "too large" else (400 if info.startswith("blocked:") else 502)
            return web.json_response({"ok": False, "error": f"audio {info}"}, status=status)

        loop = asyncio.get_running_loop()
        try:
            out_path, result = await loop.run_in_executor(
                None, master_bed, work, src, target_lufs, upscale, fmt, seconds,
            )
        except subprocess.CalledProcessError as e:
            log.exception("ffmpeg failed")
            return web.json_response({"ok": False, "error": f"ffmpeg failed: {e}"}, status=500)
        except Exception as e:  # noqa: BLE001
            log.exception("master failed")
            return web.json_response({"ok": False, "error": str(e)}, status=500)

        with open(out_path, "rb") as f:
            out_bytes = f.read()

        content_type = "audio/mpeg" if fmt == "mp3" else "audio/wav"
        async with ClientSession(timeout=ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:
            async with s.put(output_url, allow_redirects=False, data=out_bytes,
                             headers={"content-type": content_type}) as r:
                if r.status not in (200, 201, 204):
                    return web.json_response({"ok": False, "error": f"output put {r.status}"}, status=502)

        # `upscaled` reports whether the music-upscale lift actually ran (master_core tags it in
        # `applied`), so the module composes an HONEST `applied` from the container's structured facts
        # rather than trusting the request flag.
        upscaled = any(a.startswith("music-upscale") for a in result["applied"])
        log.info("/master ok key=%s bytes=%d dur=%.3f lufs=%.2f upscaled=%s",
                 output_key, len(out_bytes), result["durationSeconds"], result["lufs"], upscaled)
        return web.json_response({
            "ok": True,
            "key": output_key,
            "bytes": len(out_bytes),
            "format": fmt,
            "durationSeconds": result["durationSeconds"],
            "lufs": result["lufs"],
            "loudnessTargetLufs": target_lufs,
            "upscaled": upscaled,
        })
    finally:
        shutil.rmtree(work, ignore_errors=True)


app = web.Application(client_max_size=1024 * 1024)  # JSON bodies are small (URLs only)
app.router.add_get("/health", health)
app.router.add_post("/master", master)

if __name__ == "__main__":
    log.info("audio-master listening on 0.0.0.0:%d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)
