"""Video-finish container: ffmpeg clip assembly + audio mux over HTTP.

The Worker presigns short-lived R2 GET URLs for the per-shot clips (in order)
and an optional soundtrack, plus a PUT URL for the final MP4, and POSTs them to
/finish. We download the clips, normalize each (scale/pad to WxH, fps, libx264),
concat them (hard cut or film-style xfade crossfade), optionally mux the
soundtrack (aac, -shortest), and PUT the finished MP4. Bytes never touch the
Worker. CPU-only ffmpeg; no R2 binding (presign keeps creds on the Worker).

This is the off-GPU tail of the render pipeline: it replicates
vivijure-serverless assemble.py (assemble_silent / assemble_with_audio) so the
output matches what the pod used to produce, but runs on a cheap CPU container
instead of GPU-billed seconds. See docs/video-finish-container.md.
"""
import asyncio
import logging
import os
import shutil
import subprocess
import tempfile

from aiohttp import ClientSession, ClientTimeout, web

PORT = int(os.environ.get("PORT", "8000"))
DOWNLOAD_TIMEOUT_S = 120
UPLOAD_TIMEOUT_S = 120
MAX_CLIP_BYTES = 256 * 1024 * 1024   # 256 MB per clip
MAX_AUDIO_BYTES = 64 * 1024 * 1024   # 64 MB soundtrack
MAX_CLIPS = 80

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("video-finish")


async def health(_req):
    # Cheap readiness probe; does not shell out to ffmpeg.
    return web.json_response({"ok": True})


async def _download(session, url, path, cap):
    async with session.get(url) as r:
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


async def finish(req):
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

    clips = body.get("clips")
    output_url = body.get("outputUrl")
    output_key = body.get("outputKey", "")
    audio_url = body.get("audioUrl")
    # v0.155.0: audio-only remux. The caller (add-audio / add-narration) feeds a
    # single ALREADY-FINISHED render MP4 + a bed and just wants the audio track
    # added. Stream-copy the video (no scale/pad/re-encode), so the output keeps
    # the source's native resolution and quality. Without this the clip went
    # through _normalize, which forced the container's default 1920x1080 and a
    # lossy libx264 pass, upscaling a 1280x720 hybrid/cloud render.
    remux_audio_only = bool(body.get("remuxAudioOnly", False))
    if not isinstance(clips, list) or not clips:
        return web.json_response({"ok": False, "error": "clips must be a non-empty array"}, status=400)
    if len(clips) > MAX_CLIPS:
        return web.json_response({"ok": False, "error": f"too many clips (>{MAX_CLIPS})"}, status=400)
    if not output_url:
        return web.json_response({"ok": False, "error": "outputUrl required"}, status=400)
    if remux_audio_only and len(clips) != 1:
        return web.json_response(
            {"ok": False, "error": "remuxAudioOnly requires exactly one clip"}, status=400)
    try:
        width = int(body.get("width", 1920))
        height = int(body.get("height", 1080))
        fps = int(body.get("fps", 24))
        crf = int(body.get("crf", 18))
        crossfade = float(body.get("crossfade", 0.0))
        trim_join_frames = float(body.get("trimJoinFrames", 1))
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "bad numeric input"}, status=400)
    preset = str(body.get("preset", "medium"))

    work = tempfile.mkdtemp(prefix="vfinish-")
    try:
        # Download clips (in order) + optional soundtrack.
        srcs = []
        async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
            for i, c in enumerate(clips):
                url = c.get("url") if isinstance(c, dict) else None
                if not url:
                    return web.json_response({"ok": False, "error": f"clips[{i}].url missing"}, status=400)
                p = os.path.join(work, f"clip_{i:03d}.mp4")
                ok, info = await _download(s, url, p, MAX_CLIP_BYTES)
                if not ok:
                    status = 413 if info == "too large" else 502
                    return web.json_response({"ok": False, "error": f"clips[{i}] {info}"}, status=status)
                target = c.get("targetSeconds")
                try:
                    target = float(target) if target is not None else None
                except (TypeError, ValueError):
                    target = None
                srcs.append((p, target))
            audio_path = None
            if audio_url:
                audio_path = os.path.join(work, "audio.bin")
                ok, info = await _download(s, audio_url, audio_path, MAX_AUDIO_BYTES)
                if not ok:
                    audio_path = None
                    log.warning("audio fetch failed (%s); finishing silent", info)

        loop = asyncio.get_running_loop()
        try:
            if remux_audio_only:
                out_path, secs, has_audio = await loop.run_in_executor(
                    None, _remux_audio_only, work, srcs[0][0], audio_path,
                )
            else:
                out_path, secs, has_audio = await loop.run_in_executor(
                    None, _assemble, work, srcs, audio_path,
                    width, height, fps, crf, preset, crossfade, trim_join_frames,
                )
        except subprocess.CalledProcessError as e:
            log.exception("ffmpeg failed")
            return web.json_response({"ok": False, "error": f"ffmpeg failed: {e}"}, status=500)
        except Exception as e:  # noqa: BLE001
            log.exception("assemble failed")
            return web.json_response({"ok": False, "error": str(e)}, status=500)

        with open(out_path, "rb") as f:
            out_bytes = f.read()

        async with ClientSession(timeout=ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:
            async with s.put(output_url, data=out_bytes,
                             headers={"content-type": "video/mp4"}) as r:
                if r.status not in (200, 201, 204):
                    return web.json_response({"ok": False, "error": f"output put {r.status}"}, status=502)

        return web.json_response({
            "ok": True,
            "key": output_key,
            "bytes": len(out_bytes),
            "durationSeconds": round(secs, 3),
            "shots": len(srcs),
            "hasAudio": has_audio,
            "width": width,
            "height": height,
        })
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def _probe_duration(path):
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    )
    return max(0.1, float(proc.stdout.strip()))


def _normalize(src, dst, *, width, height, fps, crf, preset, cap):
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps}"
    )
    cmd = ["ffmpeg", "-y", "-i", src, "-vf", vf, "-an",
           "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p"]
    if cap and cap > 0.15:
        cmd += ["-t", f"{cap:.3f}"]
    cmd.append(dst)
    _run(cmd)


def _concat_hard(norms, out):
    list_file = os.path.join(os.path.dirname(out), "concat.txt")
    with open(list_file, "w") as f:
        f.write("\n".join(f"file '{p}'" for p in norms) + "\n")
    _run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", out])


def _concat_crossfade(norms, out, crossfade, *, crf, preset):
    if len(norms) == 1:
        _run(["ffmpeg", "-y", "-i", norms[0], "-c", "copy", out])
        return
    xf = max(0.1, min(crossfade, 1.5))
    current = norms[0]
    work = os.path.dirname(out)
    for i, nxt in enumerate(norms[1:], start=1):
        offset = max(0.0, _probe_duration(current) - xf)
        step = os.path.join(work, f"xfade_{i:03d}.mp4")
        _run([
            "ffmpeg", "-y", "-i", current, "-i", nxt,
            "-filter_complex",
            f"[0:v][1:v]xfade=transition=fade:duration={xf:.3f}:offset={offset:.3f}[v]",
            "-map", "[v]", "-an", "-c:v", "libx264", "-preset", preset,
            "-crf", str(crf), "-pix_fmt", "yuv420p", step,
        ])
        current = step
    _run(["ffmpeg", "-y", "-i", current, "-c", "copy", out])


def _remux_audio_only(work, video_path, audio_path):
    # v0.155.0: add (or replace) the audio track on a single finished MP4 without
    # touching the video. Stream-copy `-c:v copy` keeps the source resolution,
    # fps, and quality exactly (a 1280x720 hybrid render stays 720p; no upscale,
    # no re-encode). Mirrors _assemble's audio-length handling: pin the output to
    # the VIDEO duration with `-t`, padding a short bed with silence (`apad`) and
    # cutting a long one. Explicit `-map` selects video from the clip and audio
    # from the bed (any pre-existing audio on the clip is dropped).
    out = os.path.join(work, "final.mp4")
    has_audio = bool(audio_path) and os.path.isfile(audio_path)
    if not has_audio:
        # No bed: passthrough copy with faststart (still resolution-preserving).
        _run(["ffmpeg", "-y", "-i", video_path, "-c", "copy", "-movflags", "+faststart", out])
        return out, _probe_duration(out), False
    vdur = _probe_duration(video_path)
    cmd = [
        "ffmpeg", "-y", "-i", video_path, "-i", audio_path,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-af", "apad",
    ]
    if vdur and vdur > 0:
        cmd += ["-t", f"{vdur:.3f}"]
    else:
        cmd += ["-shortest"]
    cmd += ["-movflags", "+faststart", out]
    _run(cmd)
    return out, _probe_duration(out), True


def _assemble(work, srcs, audio_path, width, height, fps, crf, preset, crossfade, trim_join_frames):
    # Tail-trim one (or N) frames off every clip but the last, ONLY on hard
    # cuts -- mirrors assemble._trim_seconds_for_join (continuity de-dupe).
    trim_tail = (trim_join_frames / max(1, fps)) if crossfade <= 0 else 0.0
    last = len(srcs) - 1
    norms = []
    for i, (src, target) in enumerate(srcs):
        cap = target
        tail = trim_tail if (trim_tail > 0 and i < last) else 0.0
        if tail > 0:
            base = cap if cap else _probe_duration(src)
            cap = max(0.1, base - tail)
        dst = os.path.join(work, f"norm_{i:03d}.mp4")
        _normalize(src, dst, width=width, height=height, fps=fps, crf=crf, preset=preset, cap=cap)
        norms.append(dst)

    silent = os.path.join(work, "_silent.mp4")
    if crossfade > 0 and len(norms) > 1:
        _concat_crossfade(norms, silent, crossfade, crf=crf, preset=preset)
    else:
        _concat_hard(norms, silent)

    out = os.path.join(work, "final.mp4")
    has_audio = bool(audio_path) and os.path.isfile(audio_path)
    if has_audio:
        # v0.137.3: pin the output to the VIDEO length, bulletproof. The earlier
        # `-af apad -shortest` did not hold: `-shortest` cut the output to the
        # (shorter) audio, truncating the video. Probe the video duration and
        # force it with `-t`, padding the audio with silence (`apad`) to fill a
        # short bed; a long bed is cut to the video. Explicit `-map` so the right
        # streams are selected. Output is always exactly the video's duration.
        vdur = _probe_duration(silent)
        cmd = [
            "ffmpeg", "-y", "-i", silent, "-i", audio_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-af", "apad",
        ]
        if vdur and vdur > 0:
            cmd += ["-t", f"{vdur:.3f}"]
        else:
            cmd += ["-shortest"]
        cmd += ["-movflags", "+faststart", out]
        _run(cmd)
    else:
        # Web-playable silent: stream-copy with faststart (no re-encode).
        _run(["ffmpeg", "-y", "-i", silent, "-c", "copy", "-movflags", "+faststart", out])
    return out, _probe_duration(out), has_audio


app = web.Application(client_max_size=1024 * 1024)  # JSON bodies are small (URLs only)
app.router.add_get("/health", health)
app.router.add_post("/finish", finish)

if __name__ == "__main__":
    log.info("video-finish listening on 0.0.0.0:%d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)
