"""Pure ffmpeg DSP for the audio-master container: film-level "master the bed" -- an optional music
upscale (VHQ soxr resample to 48 kHz + a gentle high-shelf "air" lift) followed by two-pass LUFS
loudness normalization to a web target. STDLIB ONLY (no runpod / boto3) so it imports and runs in a
plain Python with just ffmpeg/ffprobe on PATH -- which is what test_local.py drives directly on local
files. app.py is the thin HTTP server (presigned-R2 GET in / PUT out) layer over this.

Lifted from containers/audio-mix/mix_core.py (the old, never-wired /music-upscale branch) so the
mastering pass is a first-class module under the `master` hook, not a buried step in the mixer. It is
NOT a neural model -- a high-quality resample + air lift that restores presence lost to a low-bitrate
source, then a clean, consistent level. It sets level and sample rate; it does NOT hallucinate detail.
"""
import json as _json
import os
import re
import subprocess

DEFAULT_TARGET_LUFS = -14.0           # streaming web target; two-pass loudnorm
LOUDNORM_TP = -1.5                    # true-peak ceiling (dBTP)
LOUDNORM_LRA = 11.0                   # loudness range target

# Music-upscale ("air" lift) DSP. A gentle high-shelf boost that restores presence lost to a
# low-bitrate source, applied alongside the VHQ soxr resample to 48 kHz.
MUSIC_LIFT_GAIN_DB = 2.5              # gentle high-shelf boost (dB)
MUSIC_LIFT_FREQ = 9000.0             # shelf corner (Hz) -- "air" band
MUSIC_LIFT_Q = 0.7                   # shelf width (Q)


def _run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def _probe_duration(path):
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    )
    return max(0.01, float(proc.stdout.strip()))


def _measure_loudnorm(path, target_lufs):
    """First loudnorm pass: measure the file's loudness stats. Returns the dict of
    measured_* values the second pass needs (input_i is the integrated LUFS).
    loudnorm prints a JSON block to stderr at the end of the run."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path,
         "-af", f"loudnorm=I={target_lufs}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    # The JSON block is the last {...} in stderr.
    m = re.findall(r"\{[^{}]*\}", proc.stderr, re.DOTALL)
    if not m:
        raise RuntimeError("loudnorm produced no JSON measurement")
    return _json.loads(m[-1])


def master_bed(work, in_path, target_lufs=DEFAULT_TARGET_LUFS, upscale=True, fmt="wav", seconds=None):
    """CPU "mastering" pass for a film's audio bed: an optional VHQ soxr resample to 48 kHz + gentle
    high-shelf air lift (when `upscale`), then two-pass LUFS loudnorm to `target_lufs`. ffmpeg DSP only.
    When `seconds` is a positive film-length hint, the bed is cut to that length up front (pass 1) so the
    mastered output is film-length rather than the raw (possibly over-long) source bed -- a music-gen bed can
    run far longer than the film. A film-length wav is tiny and never trips the downstream video-finish
    audio-ingest bound; loudnorm then measures the shipped portion, not a tail that gets discarded.
    Returns (out_path, {durationSeconds, lufs, applied}). The two-pass loudnorm (measure -> apply with
    the measured values) is the same discipline the mixer uses, so the bed lands at a clean, consistent
    level. `applied` lists the human-readable tags the module surfaces (the honest #77 record)."""
    applied = []

    # Pass 1: prepare a lossless 48k stereo intermediate (pcm so loudnorm measures the true signal, not
    # a re-encoded one). With upscale: VHQ soxr resample + a gentle high-shelf "air" lift. Without:
    # a plain 48k resample (loudnorm still runs -- mastering is loudness even when upscale is off).
    lifted = os.path.join(work, "prepped.wav")
    if upscale:
        chain = (
            "aresample=48000:resampler=soxr:precision=28,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"highshelf=gain={MUSIC_LIFT_GAIN_DB}:frequency={MUSIC_LIFT_FREQ}:width_type=q:width={MUSIC_LIFT_Q}"
        )
        applied.append("music-upscale:soxr48k")
    else:
        chain = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
    # Optional film-length trim: cut the bed to `seconds` (the film-length hint) BEFORE mastering, so the
    # mastered output is film-length, not the raw (possibly over-long) source bed. `-t` caps at EOF, so a
    # hint at or beyond the source length is a harmless no-op.
    trim = []
    try:
        _sec = float(seconds) if seconds is not None else 0.0
    except (TypeError, ValueError):
        _sec = 0.0
    if _sec > 0:
        trim = ["-t", f"{_sec:.3f}"]
    _run([
        "ffmpeg", "-y", "-i", in_path, *trim, "-af", chain,
        "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", lifted,
    ])

    # Pass 2: measure -> apply two-pass loudnorm, then encode to the requested format.
    stats = _measure_loudnorm(lifted, target_lufs)
    apply_af = (
        f"loudnorm=I={target_lufs}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}:"
        f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
        f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
        f"offset={stats['target_offset']}:linear=true:print_format=summary"
    )
    out_path = os.path.join(work, f"mastered.{fmt}")
    codec = ["-c:a", "libmp3lame", "-b:a", "192k"] if fmt == "mp3" else ["-c:a", "pcm_s16le"]
    _run([
        "ffmpeg", "-y", "-i", lifted, "-af", apply_af,
        "-ar", "48000", "-ac", "2", *codec, out_path,
    ])
    applied.append(f"loudnorm:{target_lufs:g}LUFS")

    final_stats = _measure_loudnorm(out_path, target_lufs)
    return out_path, {
        "durationSeconds": round(_probe_duration(out_path), 3),
        "lufs": round(float(final_stats["input_i"]), 2),
        "applied": applied,
    }
