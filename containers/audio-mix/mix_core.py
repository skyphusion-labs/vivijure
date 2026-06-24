"""Pure ffmpeg DSP for the audio-mix container: multi-track mix + sidechain duck
+ two-pass LUFS loudnorm. STDLIB ONLY (no aiohttp) so it imports and runs in a
plain Python with just ffmpeg/ffprobe on PATH -- which is what test_local.py
drives directly on local files. app.py is the thin aiohttp HTTP layer over this.

The duck is the whole point: a flat amix sounds amateur. Music (main) is pulled
under the dialogue (sidechain key) via sidechaincompress, then the full mix is
loudness-normalized to a web target with two-pass loudnorm (measure -> apply).
"""
import json as _json
import os
import re
import subprocess

ROLES = ("dialogue", "music", "sfx")
DEFAULT_TARGET_LUFS = -14.0           # streaming web target; two-pass loudnorm
LOUDNORM_TP = -1.5                    # true-peak ceiling (dBTP)
LOUDNORM_LRA = 11.0                   # loudness range target

# Sidechain duck defaults (music = main, dialogue = key). threshold is linear
# (0..1); below it the compressor is inactive, above it the music is pulled down
# by `ratio`. attack/release are milliseconds. These give an audible but musical
# duck: the bed drops ~10-12 dB under speech and recovers in the gaps.
DUCK_THRESHOLD = 0.02
DUCK_RATIO = 12.0
DUCK_ATTACK_MS = 20.0
DUCK_RELEASE_MS = 300.0


def _run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def _probe_duration(path):
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    )
    return max(0.01, float(proc.stdout.strip()))


def _count_audio_streams(path):
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=index", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    )
    return len([ln for ln in proc.stdout.splitlines() if ln.strip()])


def _combine(labels, out, parts):
    """Combine N stream labels into one with amix (normalize=0 so per-track gains
    are honored; loudnorm fixes the overall level afterward). A single label is
    returned as-is -- no redundant amix node."""
    if len(labels) == 1:
        return labels[0]
    src = "".join(f"[{l}]" for l in labels)
    parts.append(f"{src}amix=inputs={len(labels)}:normalize=0:dropout_transition=0[{out}]")
    return out


def _build_filtergraph(tracks):
    """Build the mix+duck filter_complex from the parsed track list (input order
    matches ffmpeg -i order, so input index == position in `tracks`).

    Returns (filter_complex, out_label, did_duck). Every input is first resampled
    to 48k stereo and gain-adjusted. Dialogue + sfx ride on top; music is ducked
    under the dialogue via sidechaincompress (music = main, dialogue = key) when
    both are present, else the mix is flat.
    """
    parts = []
    by_role = {r: [] for r in ROLES}
    for i, t in enumerate(tracks):
        lbl = f"n{i}"
        parts.append(
            f"[{i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"volume={t['gainDb']:.3f}dB[{lbl}]"
        )
        by_role[t["role"]].append(lbl)

    dia, mus, sfx = by_role["dialogue"], by_role["music"], by_role["sfx"]
    did_duck = False

    if dia and mus:
        dia_bus = _combine(dia, "diabus", parts)
        mus_bus = _combine(mus, "musbus", parts)
        # Dialogue feeds both the final mix and the sidechain key, so split it.
        parts.append(f"[{dia_bus}]asplit=2[diamix][diakey]")
        parts.append(
            f"[{mus_bus}][diakey]sidechaincompress="
            f"threshold={DUCK_THRESHOLD}:ratio={DUCK_RATIO}:"
            f"attack={DUCK_ATTACK_MS}:release={DUCK_RELEASE_MS}:makeup=1[ducked]"
        )
        did_duck = True
        final = ["diamix", "ducked"]
        if sfx:
            final.append(_combine(sfx, "sfxbus", parts))
    else:
        # No duck possible (missing dialogue or music): flat mix of whatever is present.
        final = []
        if dia:
            final.append(_combine(dia, "diabus", parts))
        if mus:
            final.append(_combine(mus, "musbus", parts))
        if sfx:
            final.append(_combine(sfx, "sfxbus", parts))

    out_label = _combine(final, "mix", parts)
    return ";".join(parts), out_label, did_duck

# The standalone "master the bed" pass (VHQ soxr resample + high-shelf air lift + two-pass loudnorm)
# was LIFTED OUT of this mixer into its own first-class module under the `master` hook
# (modules/audio-master + containers/audio-master). This container stays the multi-track MIX + duck;
# film-level mastering of the assembled bed is the master module's job now.


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


def mix_tracks(work, tracks, target_lufs, fmt):
    """Mix + duck -> two-pass loudnorm -> encode. `tracks` is a list of
    {path, role, gainDb}. Returns (out_path, result) where
    result = {durationSeconds, lufs, ducked}."""
    # Add inputs in list order so input index == position (the filtergraph relies on this).
    inputs = []
    for t in tracks:
        inputs += ["-i", t["path"]]
    filter_complex, out_label, did_duck = _build_filtergraph(tracks)

    # Pass 1: mix + duck into a lossless intermediate (pcm so loudnorm measures
    # the true mix, not a re-encoded one).
    intermediate = os.path.join(work, "mixed.wav")
    _run([
        "ffmpeg", "-y", *inputs,
        "-filter_complex", filter_complex,
        "-map", f"[{out_label}]",
        "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le",
        intermediate,
    ])

    # Pass 2a: measure loudness. Pass 2b: apply with the measured values (linear
    # normalization for accuracy when the source is not wildly out of range).
    stats = _measure_loudnorm(intermediate, target_lufs)
    apply_af = (
        f"loudnorm=I={target_lufs}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}:"
        f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
        f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
        f"offset={stats['target_offset']}:linear=true:print_format=summary"
    )

    out_path = os.path.join(work, f"final.{fmt}")
    codec = ["-c:a", "libmp3lame", "-b:a", "192k"] if fmt == "mp3" else ["-c:a", "pcm_s16le"]
    _run([
        "ffmpeg", "-y", "-i", intermediate,
        "-af", apply_af,
        "-ar", "48000", "-ac", "2", *codec,
        out_path,
    ])

    # Verify: re-measure the final output's integrated loudness for an honest report.
    final_stats = _measure_loudnorm(out_path, target_lufs)
    return out_path, {
        "durationSeconds": round(_probe_duration(out_path), 3),
        "lufs": round(float(final_stats["input_i"]), 2),
        "ducked": did_duck,
    }
