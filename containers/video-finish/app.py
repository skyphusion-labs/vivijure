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
import base64
import json as _json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid

from aiohttp import ClientSession, ClientTimeout, web

from url_guard import validate_fetch_url
import inspect_core

PORT = int(os.environ.get("PORT", "8000"))
DOWNLOAD_TIMEOUT_S = 120
UPLOAD_TIMEOUT_S = 120
MAX_CLIP_BYTES = 256 * 1024 * 1024   # 256 MB per clip
MAX_AUDIO_BYTES = 256 * 1024 * 1024   # 256 MB: match the per-clip bound. A lossless film-length bed
# shares a clip's size envelope, and the bed is ALWAYS trimmed to the video duration downstream
# (_assemble / _remux_audio_only, `-t vdur`), so a long source yields a film-length track, not a bloated one.
# A too-tight 64 MB cap silently dropped a legitimate multi-minute lossless bed -> silent film (the #77/#249 bug).
MAX_CLIPS = 80
MAX_KEYFRAME_BYTES = 32 * 1024 * 1024   # keyframe PNG for content-inspect (#523 Layer 2)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("video-finish")


# ---------------------------------------------------------------------------
# Async job+poll mode (#602). A film.finish encode (subtitle burn / title cards)
# on a long film can outlast a single Worker request budget; the synchronous
# route then dies before the container PUTs, so the film.finish step never
# completes. The async layer mirrors the GPU-satellite job+poll shape: submit
# returns 202 + a job id immediately, the work runs in a background task and
# PUTs the finished MP4 to the presigned R2 URL on completion, and a status
# route reports pending / completed / failed. The synchronous routes stay
# unchanged for back-compat (an old core / an old module still uses them).
#
# Jobs live in-process (no external store): a container restart drops them, at
# which point /async/status/<id> answers not_found and the CORE re-submits
# (its output key is deterministic, so a re-run is idempotent) or adopts the R2
# artifact if the encode had finished -- the same R2-authoritative recovery the
# synchronous #600 path already relies on.

# Reap a finished job this long after completion so a crashed/abandoned poller
# cannot leak memory; the core polls far more often than this.
JOB_TTL_S = 3600
JOBS = {}  # job_id -> {"status": "pending"|"completed"|"failed", "result"?, "error"?, "at": monotonic}


class _JobError(Exception):
    """A work coroutine failure carrying the HTTP status the SYNC route should
    return; the ASYNC path records .message as the job error. Keeps both paths on
    one validation/error body."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _reap_jobs(now):
    stale = [k for k, v in JOBS.items()
             if v.get("status") in ("completed", "failed") and now - v.get("at", now) > JOB_TTL_S]
    for k in stale:
        JOBS.pop(k, None)


async def _run_job(job_id, work_coro):
    try:
        result = await work_coro
        JOBS[job_id] = {"status": "completed", "result": result, "at": time.monotonic()}
    except _JobError as e:
        log.warning("async job %s failed: %s", job_id, e.message)
        JOBS[job_id] = {"status": "failed", "error": e.message, "at": time.monotonic()}
    except Exception as e:  # noqa: BLE001
        log.exception("async job %s crashed", job_id)
        JOBS[job_id] = {"status": "failed", "error": str(e), "at": time.monotonic()}


async def async_submit(req):
    # POST /async/<route> -- accept a film.finish job and run it in the background.
    route = req.match_info.get("route", "")
    work = ASYNC_WORKS.get(route)
    if work is None:
        return web.json_response({"ok": False, "error": f"unknown async route {route!r}"}, status=404)
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
    now = time.monotonic()
    _reap_jobs(now)
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "at": now}
    asyncio.create_task(_run_job(job_id, work(body)))
    log.info("/async/%s accepted job=%s", route, job_id)
    return web.json_response({"ok": True, "jobId": job_id, "status": "pending"}, status=202)


async def async_status(req):
    # GET /async/status/<jobId> -- report a background job. not_found (HTTP 404)
    # means the container never had (or has since dropped) this job; the core
    # decides whether to adopt an R2 artifact or re-submit.
    job_id = req.match_info.get("jobId", "")
    j = JOBS.get(job_id)
    if j is None:
        return web.json_response({"ok": True, "status": "not_found"}, status=404)
    if j["status"] == "pending":
        return web.json_response({"ok": True, "status": "pending"})
    if j["status"] == "completed":
        return web.json_response({"ok": True, "status": "completed", "result": j["result"]})
    return web.json_response({"ok": True, "status": "failed", "error": j.get("error", "job failed")})



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
    # keepClipAudio: the clips carry per-clip lip-synced dialogue (talking film) that
    # must survive the concat. Set by the orchestrator when job.dialogue_audio is
    # populated. Default False = the historical silent-concat behavior.
    keep_clip_audio = bool(body.get("keepClipAudio", False))
    if not isinstance(clips, list) or not clips:
        return web.json_response({"ok": False, "error": "clips must be a non-empty array"}, status=400)
    if len(clips) > MAX_CLIPS:
        return web.json_response({"ok": False, "error": f"too many clips (>{MAX_CLIPS})"}, status=400)
    if not output_url:
        return web.json_response({"ok": False, "error": "outputUrl required"}, status=400)
    ok, why = validate_fetch_url(output_url)
    if not ok:
        return web.json_response({"ok": False, "error": f"outputUrl blocked: {why}"}, status=400)
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
                    status = 413 if info == "too large" else (400 if info.startswith("blocked:") else 502)
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
                    # The caller ASKED for this bed; a "finished" film that lost its music without saying so is
                    # the exact silent-degrade of #77 / #249. The bed is trimmed to the video length downstream,
                    # so an over-cap source is a legitimately long bed, not a reason to go silent -- fail loud and
                    # let the core surface a real per-render error rather than ship a silent green.
                    status = 413 if info == "too large" else (400 if str(info).startswith("blocked:") else 502)
                    log.warning("audio bed fetch failed (%s); failing loud (no silent finish)", info)
                    return web.json_response({"ok": False, "error": f"audio bed {info}"}, status=status)

        loop = asyncio.get_running_loop()
        clip_durations = None  # per-clip assembled seconds (#697/#698); only the concat path reports them
        try:
            if remux_audio_only:
                out_path, secs, has_audio = await loop.run_in_executor(
                    None, _remux_audio_only, work, srcs[0][0], audio_path,
                )
            else:
                out_path, secs, has_audio, clip_durations = await loop.run_in_executor(
                    None, _assemble, work, srcs, audio_path,
                    width, height, fps, crf, preset, crossfade, trim_join_frames,
                    keep_clip_audio,
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
            async with s.put(output_url, allow_redirects=False, data=out_bytes,
                             headers={"content-type": "video/mp4"}) as r:
                if r.status not in (200, 201, 204):
                    return web.json_response({"ok": False, "error": f"output put {r.status}"}, status=502)

        return web.json_response({
            "ok": True,
            "key": output_key,
            "bytes": len(out_bytes),
            "durationSeconds": round(secs, 3),
            "shots": len(srcs),
            # [assemble] instrumentation (#287): clips received vs downloaded vs output duration,
            # so a partial assemble is diagnosable from logs (worker-sent-fewer vs fetch-dropped).
            "clipsReceived": len(clips),
            "hasAudio": has_audio,
            "width": width,
            "height": height,
            # ACTUAL per-clip assembled seconds in submit order (#697/#698); null on the remux path.
            "clipDurations": clip_durations,
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


def _probe_audio(path):
    """Probe the first audio stream of path.
    Returns (has_audio, sample_rate, channel_layout).
    sample_rate and channel_layout are None when has_audio is False.
    Falls back to stereo/44100 if the layout string is absent or unknown.
    """
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channel_layout",
         "-of", "default=noprint_wrappers=1", path],
        capture_output=True, text=True, check=True,
    )
    out = proc.stdout.strip()
    if not out:
        return False, None, None
    info = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k.strip()] = v.strip()
    sample_rate = int(info.get("sample_rate") or 44100)
    layout = info.get("channel_layout", "") or "stereo"
    if layout in ("unknown", "0 channels", ""):
        layout = "stereo"
    return True, sample_rate, layout


def _normalize(src, dst, *, width, height, fps, crf, preset, cap, keep_audio=False, ensure_audio=False):
    """Scale/pad/fps-normalize src to dst.
    keep_audio=False (default): strip audio (-an). Used by _assemble's silent path
    and the silent-film path of _assemble_film_titles.
    keep_audio=True: re-encode the source's audio to AAC (192k). Used by
    _assemble_film_titles when the input film has a score/narration to preserve.
    ensure_audio=True: GUARANTEE a canonical 48k stereo AAC track on the output --
    re-encode the source's audio if present, else synthesize silence (anullsrc).
    Used by _assemble's talking-film path so EVERY clip carries a uniform audio
    stream and _concat_hard (-c copy) preserves the per-clip lip-synced dialogue;
    a dialogue-less shot still gets a matching silent track so the concat layout
    stays consistent. Takes precedence over keep_audio.
    """
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps}"
    )
    cmd = ["ffmpeg", "-y", "-i", src]
    synth_silence = False
    if ensure_audio:
        has_a, _, _ = _probe_audio(src)
        if not has_a:
            synth_silence = True
            cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    cmd += ["-vf", vf]
    if ensure_audio:
        cmd += ["-map", "0:v:0", "-map", ("1:a:0" if synth_silence else "0:a:0"),
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    elif keep_audio:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-an"]
    cmd += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p"]
    if cap and cap > 0.15:
        cmd += ["-t", f"{cap:.3f}"]
    elif synth_silence:
        cmd += ["-shortest"]  # bound the infinite anullsrc track to the video length
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


def _assemble(work, srcs, audio_path, width, height, fps, crf, preset, crossfade, trim_join_frames,
              keep_clip_audio=False):
    # keep_clip_audio: the clips carry per-clip lip-synced dialogue (talking film).
    # The crossfade concat path drops audio (-an) and acrossfade is not wired, so
    # dialogue forces a hard cut; every clip is normalized with ensure_audio so the
    # hard-cut concat (-c copy) preserves the dialogue uniformly.
    effective_crossfade = 0.0 if keep_clip_audio else crossfade
    # Tail-trim one (or N) frames off every clip but the last, ONLY on hard
    # cuts -- mirrors assemble._trim_seconds_for_join (continuity de-dupe).
    trim_tail = (trim_join_frames / max(1, fps)) if effective_crossfade <= 0 else 0.0
    last = len(srcs) - 1
    norms = []
    for i, (src, target) in enumerate(srcs):
        cap = target
        tail = trim_tail if (trim_tail > 0 and i < last) else 0.0
        if tail > 0:
            base = cap if cap else _probe_duration(src)
            cap = max(0.1, base - tail)
        dst = os.path.join(work, f"norm_{i:03d}.mp4")
        _normalize(src, dst, width=width, height=height, fps=fps, crf=crf, preset=preset,
                   cap=cap, ensure_audio=keep_clip_audio)
        norms.append(dst)

    # ACTUAL per-clip assembled seconds (#697/#698): the normalized (tail-trimmed, capped) duration each
    # clip contributes to the film, in submit order. Probed ONCE here and reused by the drop-guard below;
    # returned so the Worker can gate a truncated clip against its plan and time captions to the real cut.
    norm_durations = [round(_probe_duration(n) or 0.0, 3) for n in norms]

    silent = os.path.join(work, "_silent.mp4")
    if effective_crossfade > 0 and len(norms) > 1:
        _concat_crossfade(norms, silent, effective_crossfade, crf=crf, preset=preset)
    else:
        _concat_hard(norms, silent)  # -c copy; preserves per-clip audio when ensure_audio kept it

    # Fail loud: the concat must NEVER silently drop a clip (a scatter render once shipped 1 of 3
    # shots). If the assembled film is materially shorter than the sum of its (tail-trimmed) inputs,
    # a clip was dropped at concat -- raise so the caller fails rather than ship a partial film.
    _sil = _probe_duration(silent) or 0.0
    _sum_in = sum(norm_durations)
    if _sum_in > 0 and _sil < _sum_in * 0.85:
        raise RuntimeError(
            f"concat dropped clips: assembled {_sil:.2f}s < sum of {len(norms)} inputs {_sum_in:.2f}s")

    out = os.path.join(work, "final.mp4")
    has_bed = bool(audio_path) and os.path.isfile(audio_path)
    if has_bed and keep_clip_audio:
        # Talking film WITH a music/score bed: MIX the bed under the per-clip
        # dialogue (amix) rather than replacing it. Pin to the video length, same
        # bulletproof `-t vdur` as the bed-only path below; `apad` fills a short bed.
        vdur = _probe_duration(silent)
        cmd = [
            "ffmpeg", "-y", "-i", silent, "-i", audio_path,
            "-filter_complex",
            "[1:a]apad[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0[a]",
            "-map", "0:v:0", "-map", "[a]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        ]
        if vdur and vdur > 0:
            cmd += ["-t", f"{vdur:.3f}"]
        else:
            cmd += ["-shortest"]
        cmd += ["-movflags", "+faststart", out]
        _run(cmd)
    elif has_bed:
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
        # Web-playable: stream-copy with faststart (no re-encode). Preserves the
        # per-clip dialogue when ensure_audio kept it on the concat; silent otherwise.
        _run(["ffmpeg", "-y", "-i", silent, "-c", "copy", "-movflags", "+faststart", out])
    # Honest: probe the actual output rather than assuming bed == audio (a talking
    # film has audio with no bed; a failed bed mux would not).
    has_audio = _probe_audio(out)[0]
    return out, _probe_duration(out), has_audio, norm_durations



# ---------------------------------------------------------------------------
# /overlay: burn text overlays onto a single clip via ffmpeg drawtext (#190).
#
# The caller (the text-overlay module worker) reads the clip from R2 and POSTs
# the raw bytes here; the processed bytes are returned in the response body.
# This bypasses the 1 MB JSON body limit by streaming the video directly and
# reading the spec from the X-Overlay-Spec header (base64-encoded JSON).
#
# Header X-Overlay-Spec: base64( { "filter": "<ffmpeg -vf value>", "output_key": "..." } )
# Request body:  raw video bytes (Content-Type: video/mp4)
# Response body: raw video bytes on success; JSON {ok:false, error} on failure.

MAX_OVERLAY_CLIP_BYTES = 256 * 1024 * 1024   # 256 MB (same cap as regular clips)


def _draw_overlay(src, dst, vf_filter, *, crf=18, preset="medium"):
    """Run ffmpeg drawtext on `src`, writing to `dst`. Re-encodes with libx264 so
    the overlay is baked in (stream-copy cannot apply a video filter). Audio is
    stream-copied unchanged; `-movflags +faststart` keeps the output web-playable."""
    cmd = [
        "ffmpeg", "-y", "-i", src,
        "-vf", vf_filter,
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        dst,
    ]
    _run(cmd)


async def overlay(req):
    # Parse the overlay spec from the header (base64 JSON: {filter, output_key}).
    spec_b64 = req.headers.get("X-Overlay-Spec", "").strip()
    if not spec_b64:
        return web.json_response({"ok": False, "error": "X-Overlay-Spec header required"}, status=400)
    try:
        spec = _json.loads(base64.b64decode(spec_b64))
    except Exception:
        return web.json_response({"ok": False, "error": "X-Overlay-Spec: invalid base64 JSON"}, status=400)

    vf_filter = spec.get("filter", "").strip() if isinstance(spec, dict) else ""
    if not vf_filter:
        return web.json_response({"ok": False, "error": "X-Overlay-Spec: filter is required"}, status=400)

    # Stream the raw clip bytes from the request body (bypass the 1 MB JSON body limit).
    total = 0
    chunks = []
    try:
        async for chunk in req.content.iter_chunked(256 * 1024):
            total += len(chunk)
            if total > MAX_OVERLAY_CLIP_BYTES:
                return web.json_response({"ok": False, "error": "clip too large"}, status=413)
            chunks.append(chunk)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"read body failed: {e}"}, status=400)

    if total == 0:
        return web.json_response({"ok": False, "error": "clip body required"}, status=400)

    clip_bytes = b"".join(chunks)
    work = tempfile.mkdtemp(prefix="voverlay-")
    try:
        src_path = os.path.join(work, "in.mp4")
        dst_path = os.path.join(work, "out.mp4")
        with open(src_path, "wb") as f:
            f.write(clip_bytes)

        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, _draw_overlay, src_path, dst_path, vf_filter)
        except subprocess.CalledProcessError as e:
            log.exception("ffmpeg drawtext failed for key=%s", spec.get("output_key", "?"))
            return web.json_response({"ok": False, "error": f"ffmpeg failed: {e}"}, status=500)
        except Exception as e:  # noqa: BLE001
            log.exception("overlay failed")
            return web.json_response({"ok": False, "error": str(e)}, status=500)

        with open(dst_path, "rb") as f:
            out_bytes = f.read()

        log.info("overlay ok key=%s in=%d out=%d", spec.get("output_key", "?"), len(clip_bytes), len(out_bytes))
        return web.Response(body=out_bytes, content_type="video/mp4")
    finally:
        shutil.rmtree(work, ignore_errors=True)




# ---------------------------------------------------------------------------
# /film-titles: prepend a title card and/or append a credits card to an
# assembled film. Title and credits are synthetic black-background segments
# generated with `lavfi color` + ffmpeg drawtext; each segment is normalized
# to the same codec/resolution so _concat_hard can join them with -c copy.
#
# Audio note: all segments use -an (matches _normalize / _assemble). The
# caller re-adds audio via /finish remuxAudioOnly if needed.
#
# Pure helper functions (_escape_drawtext, _title_card_filter,
# _credits_card_filter) are factored out for unit-testability.

def _escape_drawtext(text):
    """Escape text for use in an ffmpeg drawtext text= value.
    Mirrors modules/text-overlay overlay.ts escapeDrawtext: backslash first,
    then colon, then single-quote (order is critical to avoid double-escaping).
    """
    return (text
            .replace("\\", "\\\\")
            .replace(":", "\\:")
            .replace("'", "\\'"))


def _title_card_filter(text, *, subtitle=None, font="DejaVu Sans",
                       font_size=80, sub_font_size=48, color="white"):
    """Build a drawtext -vf filter string for a title card.
    Title is vertically centered (or offset upward when subtitle is present);
    subtitle appears below at a smaller size. Pure function; no I/O.
    """
    t = _escape_drawtext(text)
    if subtitle:
        # Each drawtext filter evaluates its own text_h independently, so use
        # fixed pixel offsets from h/2: title above the midline, subtitle below.
        gap = 16
        vf = (
            f"drawtext=font='{font}':text='{t}':fontsize={font_size}"
            f":fontcolor={color}:x=(w-text_w)/2:y=(h/2-text_h-{gap})"
            f",drawtext=font='{font}':text='{_escape_drawtext(subtitle)}'"
            f":fontsize={sub_font_size}:fontcolor={color}"
            f":x=(w-text_w)/2:y=(h/2+{gap})"
        )
    else:
        vf = (
            f"drawtext=font='{font}':text='{t}':fontsize={font_size}"
            f":fontcolor={color}:x=(w-text_w)/2:y=(h-text_h)/2"
        )
    return vf


def _credits_card_filter(lines, duration, *, font="DejaVu Sans",
                         font_size=48, color="white", line_spacing=20):
    """Build a scrolling-credits -vf filter for a list of text lines.
    Lines scroll upward from the bottom of the frame to above the top over
    `duration` seconds. One drawtext segment per line. Pure function; no I/O.
    """
    line_height = font_size + line_spacing
    total_h = len(lines) * line_height
    filters = []
    for i, line in enumerate(lines):
        t = _escape_drawtext(line)
        # y_i(t) = h - (t/duration)*(h+total_h) + i*line_height
        # t=0   -> y_0 = h              (block starts below the frame)
        # t=dur -> y_0 = -total_h       (block ends above the frame)
        y_expr = f"h-(t/{duration:.3f})*(h+{total_h})+{i * line_height}"
        filters.append(
            f"drawtext=font='{font}':text='{t}':fontsize={font_size}"
            f":fontcolor={color}:x=(w-text_w)/2:y=({y_expr})"
        )
    return ",".join(filters)


def _make_card(dst, *, width, height, fps, crf, preset, duration, vf_filter,
               audio_sample_rate=None, audio_channel_layout=None):
    """Generate a title or credit card MP4: black lavfi background + drawtext.

    audio_sample_rate / audio_channel_layout: when both are provided the card
    gets a matching silent AAC audio track (anullsrc) so it can be hard-concat'd
    with an audio-bearing film without stream-count mismatch.
    When absent, the card is video-only (-an), matching a silent film.
    """
    lavfi_src = f"color=c=black:s={width}x{height}:r={fps}:d={duration:.3f}"
    if audio_sample_rate is not None and audio_channel_layout is not None:
        anull_src = f"anullsrc=r={audio_sample_rate}:cl={audio_channel_layout}"
        _run([
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", lavfi_src,
            "-f", "lavfi", "-i", anull_src,
            "-vf", vf_filter,
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-t", f"{duration:.3f}",   # cap the infinite anullsrc to card duration
            dst,
        ])
    else:
        _run([
            "ffmpeg", "-y", "-f", "lavfi", "-i", lavfi_src,
            "-vf", vf_filter,
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p",
            dst,
        ])


def _assemble_film_titles(work, film_path, title_spec, credits_spec,
                           width, height, fps, crf, preset):
    """Assemble [title_card?, film_norm, credits_card?] into a single MP4.

    Audio handling:
    - Probes the input film for an audio stream.
    - If the film HAS audio (score / narration): each card gets a matching
      silent AAC track (anullsrc at the same rate/layout) so all three
      segments have video+audio and _concat_hard (-c copy) works cleanly.
      The film is normalized with keep_audio=True so its audio is preserved.
    - If the film has NO audio (silent picture): all segments are video-only
      (-an), the original path.

    Returns (out_path, duration_seconds).
    """
    # Probe the input film's audio before generating any segment.
    has_audio, aud_rate, aud_layout = _probe_audio(film_path)
    card_audio = (
        {"audio_sample_rate": aud_rate, "audio_channel_layout": aud_layout}
        if has_audio else {}
    )
    log.info("/film-titles audio probe: has_audio=%s rate=%s layout=%s",
             has_audio, aud_rate, aud_layout)

    segments = []

    if title_spec:
        text = str(title_spec.get("text", "")).strip()
        raw_sub = title_spec.get("subtitle")
        subtitle = str(raw_sub).strip() if raw_sub else None
        try:
            secs = max(0.5, min(float(title_spec.get("seconds", 5.0)), 120.0))
        except (TypeError, ValueError):
            secs = 5.0
        if text:
            card = os.path.join(work, "title_card.mp4")
            _make_card(card, width=width, height=height, fps=fps, crf=crf,
                       preset=preset, duration=secs,
                       vf_filter=_title_card_filter(text, subtitle=subtitle),
                       **card_audio)
            segments.append(card)

    film_norm = os.path.join(work, "film_norm.mp4")
    _normalize(film_path, film_norm, width=width, height=height, fps=fps,
               crf=crf, preset=preset, cap=None, keep_audio=has_audio)
    segments.append(film_norm)

    if credits_spec:
        raw_lines = credits_spec.get("lines", [])
        lines = [str(l).strip() for l in raw_lines if str(l).strip()]
        try:
            secs = max(0.5, min(float(credits_spec.get("seconds", 8.0)), 120.0))
        except (TypeError, ValueError):
            secs = 8.0
        if lines:
            card = os.path.join(work, "credits_card.mp4")
            _make_card(card, width=width, height=height, fps=fps, crf=crf,
                       preset=preset, duration=secs,
                       vf_filter=_credits_card_filter(lines, secs),
                       **card_audio)
            segments.append(card)

    out = os.path.join(work, "with_titles.mp4")
    _concat_hard(segments, out)
    return out, _probe_duration(out)


async def _film_titles_work(body):
    """The /film-titles work: validate, download the film, prepend/append cards,
    PUT the result. Shared by the synchronous route and the async job runner.
    Raises _JobError(status, message) on any failure; returns the result dict."""
    video_url = body.get("videoUrl")
    output_url = body.get("outputUrl")
    output_key = body.get("outputKey", "")
    title_spec = body.get("title") if isinstance(body.get("title"), dict) else None
    credits_spec = body.get("credits") if isinstance(body.get("credits"), dict) else None

    if not video_url:
        raise _JobError(400, "videoUrl required")
    if not output_url:
        raise _JobError(400, "outputUrl required")
    ok, why = validate_fetch_url(output_url)
    if not ok:
        raise _JobError(400, f"outputUrl blocked: {why}")
    if not title_spec and not credits_spec:
        raise _JobError(400, "at least one of title or credits is required")

    try:
        width = int(body.get("width", 1920))
        height = int(body.get("height", 1080))
        fps = int(body.get("fps", 24))
        crf = int(body.get("crf", 18))
    except (TypeError, ValueError):
        raise _JobError(400, "bad numeric input")
    preset = str(body.get("preset", "medium"))

    work = tempfile.mkdtemp(prefix="vftitles-")
    try:
        async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
            film_path = os.path.join(work, "film.mp4")
            ok, info = await _download(s, video_url, film_path, MAX_CLIP_BYTES)
            if not ok:
                sc = 413 if info == "too large" else (400 if info.startswith("blocked:") else 502)
                raise _JobError(sc, f"film {info}")

        loop = asyncio.get_running_loop()
        try:
            out_path, secs = await loop.run_in_executor(
                None, _assemble_film_titles,
                work, film_path, title_spec, credits_spec,
                width, height, fps, crf, preset,
            )
        except subprocess.CalledProcessError as e:
            log.exception("ffmpeg failed in /film-titles")
            raise _JobError(500, f"ffmpeg failed: {e}")
        except Exception as e:  # noqa: BLE001
            log.exception("/film-titles assemble failed")
            raise _JobError(500, str(e))

        with open(out_path, "rb") as f:
            out_bytes = f.read()

        async with ClientSession(timeout=ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:
            async with s.put(output_url, allow_redirects=False, data=out_bytes,
                             headers={"content-type": "video/mp4"}) as r:
                if r.status not in (200, 201, 204):
                    raise _JobError(502, f"output put {r.status}")

        log.info("/film-titles ok key=%s bytes=%d dur=%.3f", output_key, len(out_bytes), secs)
        return {
            "ok": True,
            "key": output_key,
            "bytes": len(out_bytes),
            "durationSeconds": round(secs, 3),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def film_titles(req):
    """POST /film-titles -- synchronous: prepend a title card and/or append a
    credits card. Body + behavior unchanged; the work lives in _film_titles_work
    so the async job runner shares it. See _film_titles_work for the body schema."""
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
    try:
        return web.json_response(await _film_titles_work(body))
    except _JobError as e:
        return web.json_response({"ok": False, "error": e.message}, status=e.status)


# ---------------------------------------------------------------------------
# /subtitle: burn a time-synced SRT onto the assembled film (and/or write a
# soft .srt sidecar) via the ffmpeg subtitles (libass) filter.
#
# The caller (the subtitle module worker) already FORMATTED the SRT from the
# core's timed cues; this route never re-times. It writes the SRT to disk,
# burns it with `-vf subtitles=<srt>:force_style=...`, re-encodes video
# (libx264) since a filtered video cannot be stream-copied, stream-copies the
# audio so dialogue/score survive, and PUTs the result. In sidecar / both
# modes it also PUTs the raw .srt to a presigned sidecarUrl. Bytes never touch
# the Worker. Presigned URLs keep R2 creds on the Worker.
#
# Pure helpers (_escape_subtitles_path, _ass_alignment, _ass_colour,
# _subtitle_filter) are factored out for unit-testability.

MAX_SRT_BYTES = 512 * 1024   # an SRT for a short film is a few KB; 512 KB is a generous ceiling

# position -> libass Alignment (numpad layout): bottom-center 2, top-center 8, middle-center 5.
_SUB_ALIGNMENT = {"bottom": 2, "top": 8, "middle": 5}
# A few named colors -> ASS &HAABBGGRR (alpha 00 = opaque). Names keep the config human-friendly;
# an ASS &H... value passes straight through for full control.
_SUB_COLOUR = {
    "white": "&H00FFFFFF",
    "black": "&H00000000",
    "yellow": "&H0000FFFF",
    "red": "&H000000FF",
    "green": "&H0000FF00",
    "cyan": "&H00FFFF00",
}


def _escape_subtitles_path(path):
    """Escape a path for use inside an ffmpeg subtitles= filter value. The filtergraph splits
    options on ':' and treats '\\' and "'" specially, so escape those three (backslash first to
    avoid double-escaping)."""
    return (path
            .replace("\\", "\\\\")
            .replace(":", "\\:")
            .replace("'", "\\'"))


def _ass_alignment(position):
    return _SUB_ALIGNMENT.get(str(position or "bottom"), 2)


def _ass_colour(color):
    """Resolve a config color to an ASS &HAABBGGRR string. A named color maps via the table; an
    explicit &H... value passes through; anything else falls back to opaque white."""
    if isinstance(color, str):
        if color.startswith("&H"):
            return color
        mapped = _SUB_COLOUR.get(color.lower())
        if mapped:
            return mapped
    return "&H00FFFFFF"


def _subtitle_filter(srt_path, style):
    """Build the ffmpeg -vf subtitles filter string for an SRT burn. Pure; no I/O.
    style: {font, fontSize, color, position, box, marginV}. `box` == "box" draws an opaque box
    behind the text (BorderStyle 3); otherwise the text is outlined (BorderStyle 1, Outline 2)."""
    style = style if isinstance(style, dict) else {}
    font = str(style.get("font") or "DejaVu Sans")
    try:
        size = int(style.get("fontSize") or 28)
    except (TypeError, ValueError):
        size = 28
    try:
        margin_v = int(style.get("marginV") if style.get("marginV") is not None else 36)
    except (TypeError, ValueError):
        margin_v = 36
    alignment = _ass_alignment(style.get("position"))
    primary = _ass_colour(style.get("color"))
    if style.get("box") == "box":
        border_style, outline, shadow = 3, 0, 0
    else:
        border_style, outline, shadow = 1, 2, 0
    force_style = (
        f"FontName={font},FontSize={size},PrimaryColour={primary},"
        f"Alignment={alignment},MarginV={margin_v},"
        f"BorderStyle={border_style},Outline={outline},Shadow={shadow}"
    )
    return f"subtitles={_escape_subtitles_path(srt_path)}:force_style='{force_style}'"


def _burn_subtitles(src, dst, vf_filter, crf=18, preset="medium"):
    """Burn captions onto src via the subtitles filter, writing to dst. Re-encodes video with
    libx264 (a filtered video cannot be stream-copied); audio is stream-copied unchanged so the
    dialogue/score survive; `-movflags +faststart` keeps the output web-playable."""
    cmd = [
        "ffmpeg", "-y", "-i", src,
        "-vf", vf_filter,
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        dst,
    ]
    _run(cmd)


async def _subtitle_work(body):
    """The /subtitle work: burn a time-synced SRT onto the film and/or write a
    soft .srt sidecar. Shared by the synchronous route and the async job runner.
    Raises _JobError(status, message) on failure; returns the result dict."""
    srt_text = body.get("srt")
    mode = str(body.get("mode", "burn"))
    video_url = body.get("videoUrl")
    output_url = body.get("outputUrl")
    output_key = body.get("outputKey", "")
    sidecar_url = body.get("sidecarUrl")
    sidecar_key = body.get("sidecarKey", "")
    style = body.get("style") if isinstance(body.get("style"), dict) else {}

    if not isinstance(srt_text, str) or not srt_text.strip():
        raise _JobError(400, "srt required")
    if len(srt_text.encode("utf-8")) > MAX_SRT_BYTES:
        raise _JobError(413, "srt too large")
    if mode not in ("burn", "sidecar", "both"):
        raise _JobError(400, "mode must be burn|sidecar|both")

    want_burn = mode in ("burn", "both")
    want_sidecar = mode in ("sidecar", "both")

    if want_burn:
        if not video_url:
            raise _JobError(400, "videoUrl required for burn")
        if not output_url:
            raise _JobError(400, "outputUrl required for burn")
        ok, why = validate_fetch_url(output_url)
        if not ok:
            raise _JobError(400, f"outputUrl blocked: {why}")
    if want_sidecar:
        if not sidecar_url:
            raise _JobError(400, "sidecarUrl required for sidecar mode")
        ok, why = validate_fetch_url(sidecar_url)
        if not ok:
            raise _JobError(400, f"sidecarUrl blocked: {why}")

    try:
        crf = int(body.get("crf", 18))
    except (TypeError, ValueError):
        raise _JobError(400, "bad numeric input")
    preset = str(body.get("preset", "medium"))

    work = tempfile.mkdtemp(prefix="vfsubs-")
    try:
        srt_path = os.path.join(work, "subs.srt")
        with open(srt_path, "w", encoding="utf-8") as f:
            f.write(srt_text)

        # Sidecar first: a soft .srt is cheap and independent of the (heavier) burn.
        sidecar_done = False
        if want_sidecar:
            async with ClientSession(timeout=ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:
                async with s.put(sidecar_url, allow_redirects=False, data=srt_text.encode("utf-8"),
                                 headers={"content-type": "application/x-subrip"}) as r:
                    if r.status not in (200, 201, 204):
                        raise _JobError(502, f"sidecar put {r.status}")
            sidecar_done = True

        burned = False
        out_secs = 0.0
        if want_burn:
            async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
                film_path = os.path.join(work, "film.mp4")
                ok, info = await _download(s, video_url, film_path, MAX_CLIP_BYTES)
                if not ok:
                    sc = 413 if info == "too large" else (400 if info.startswith("blocked:") else 502)
                    raise _JobError(sc, f"film {info}")

            vf = _subtitle_filter(srt_path, style)
            out_path = os.path.join(work, "subbed.mp4")
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, _burn_subtitles, film_path, out_path, vf, crf, preset)
            except subprocess.CalledProcessError as e:
                log.exception("ffmpeg subtitles burn failed key=%s", output_key)
                raise _JobError(500, f"ffmpeg failed: {e}")
            except Exception as e:  # noqa: BLE001
                log.exception("/subtitle burn failed")
                raise _JobError(500, str(e))

            with open(out_path, "rb") as f:
                out_bytes = f.read()
            async with ClientSession(timeout=ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:
                async with s.put(output_url, allow_redirects=False, data=out_bytes,
                                 headers={"content-type": "video/mp4"}) as r:
                    if r.status not in (200, 201, 204):
                        raise _JobError(502, f"output put {r.status}")
            burned = True
            out_secs = _probe_duration(out_path)

        log.info("/subtitle ok key=%s burned=%s sidecar=%s dur=%.3f",
                 output_key, burned, sidecar_done, out_secs)
        return {
            "ok": True,
            "key": output_key if burned else "",
            "burned": burned,
            "sidecar": sidecar_done,
            "sidecarKey": sidecar_key if sidecar_done else "",
            "durationSeconds": round(out_secs, 3),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def subtitle(req):
    """POST /subtitle -- synchronous: burn a time-synced SRT and/or write a soft
    .srt sidecar. Body + behavior unchanged; the work lives in _subtitle_work so
    the async job runner shares it. See _subtitle_work for the body schema."""
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
    try:
        return web.json_response(await _subtitle_work(body))
    except _JobError as e:
        return web.json_response({"ok": False, "error": e.message}, status=e.status)


# ---------------------------------------------------------------------------
# /inspect: content validation (#523 Layer 2). The studio Worker cannot decode
# pixels; this catches the noise class Layer 1 (structural) cannot. Presigned
# GET URLs only (bytes never touch the Worker); read-only, no PUT. Returns a
# verdict the core folds into the shot: "corrupt" (keyframe mismatch, confident)
# fails the shot before finish/upscale spend; "suspect" (chroma-noise heuristic)
# is a warn/degrade marker; "ok" passes.
# ---------------------------------------------------------------------------
async def inspect(req):
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)
    clip_url = body.get("clipUrl")
    keyframe_url = body.get("keyframeUrl")
    if not clip_url:
        return web.json_response({"ok": False, "error": "clipUrl required"}, status=400)
    work = tempfile.mkdtemp(prefix="inspect-")
    try:
        clip_path = os.path.join(work, "clip.mp4")
        kf_path = None
        async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
            ok, info = await _download(s, clip_url, clip_path, MAX_CLIP_BYTES)
            if not ok:
                sc = 413 if info == "too large" else (400 if str(info).startswith("blocked:") else 502)
                return web.json_response({"ok": False, "error": f"clip {info}"}, status=sc)
            if keyframe_url:
                kf_path = os.path.join(work, "keyframe.png")
                kok, kinfo = await _download(s, keyframe_url, kf_path, MAX_KEYFRAME_BYTES)
                if not kok:
                    # keyframe is optional -- a failed keyframe fetch drops to the content-only heuristic,
                    # it never fails the inspect (honest degrade of the check itself).
                    log.warning("/inspect keyframe fetch failed: %s (falling back to content-only)", kinfo)
                    kf_path = None
        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(None, inspect_core.inspect, clip_path, kf_path)
        except Exception as e:  # noqa: BLE001
            log.exception("/inspect failed")
            return web.json_response({"ok": False, "error": f"inspect failed: {e}"}, status=500)
        log.info("/inspect verdict=%s ratio=%.3f kf_sim=%s",
                 result["verdict"], result["metrics"].get("chroma_structure_ratio", 0.0),
                 result.get("keyframe_similarity"))
        return web.json_response({"ok": True, **result})
    finally:
        shutil.rmtree(work, ignore_errors=True)


# The film.finish routes exposed for async job+poll (#602). Assemble/mux (/finish),
# /overlay and /inspect stay synchronous -- they are not the single-step-exceeds-budget
# film.finish class this addresses.
ASYNC_WORKS = {
    "film-titles": _film_titles_work,
    "subtitle": _subtitle_work,
}

app = web.Application(client_max_size=1024 * 1024)  # JSON bodies are small (URLs + a short SRT)
app.router.add_get("/health", health)
app.router.add_post("/finish", finish)
app.router.add_post("/overlay", overlay)
app.router.add_post("/film-titles", film_titles)
app.router.add_post("/subtitle", subtitle)
app.router.add_post("/inspect", inspect)
app.router.add_post("/async/{route}", async_submit)
app.router.add_get("/async/status/{jobId}", async_status)

if __name__ == "__main__":
    log.info("video-finish listening on 0.0.0.0:%d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)
