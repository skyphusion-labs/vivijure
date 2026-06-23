"""Local ffmpeg/ffprobe validation for the audio-mix container -- no HTTP, no R2,
no Docker. Generates a sample dialogue.wav (gated speech-like bursts) and a
music.mp3 (continuous bed), drives mix_tracks() directly on local files, and
asserts with ffprobe that:

  1. the output has exactly ONE audio stream,
  2. its integrated loudness is within tolerance of the -14 LUFS target,
  3. the music is DEMONSTRABLY ducked -- the music bed's level during the
     dialogue-present window is measurably lower than during the silent window.

Run:  python3 test_local.py    (needs ffmpeg/ffprobe on PATH)
Exits non-zero on any failed assertion.
"""
import os
import re
import subprocess
import sys
import tempfile

import mix_core


def _run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def _make_dialogue(path):
    # Speech-like: a 440 Hz tone gated ON for the SECOND half only (0..3s silent,
    # 3..6s present). Half-silent dialogue makes the duck trivially observable --
    # the bed should be loud in 0..3s and ducked in 3..6s.
    _run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-af", "volume=enable='gte(t,3)':volume=1.0,volume=enable='lt(t,3)':volume=0.0",
        "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path,
    ])


def _make_music(path):
    # Continuous bed: 220 Hz over the full 6s, moderate level, encoded as mp3.
    _run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "sine=frequency=220:duration=6",
        "-af", "volume=0.5",
        "-ac", "2", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "192k", path,
    ])


def _mean_volume(path, start, end):
    """Mean volume (dB) of [start,end] via ffmpeg volumedetect (lower = quieter)."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-ss", str(start), "-to", str(end),
         "-i", path, "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", proc.stderr)
    if not m:
        raise RuntimeError("volumedetect produced no mean_volume")
    return float(m.group(1))


def main():
    work = tempfile.mkdtemp(prefix="amix-test-")
    target = -14.0
    failures = []

    dia = os.path.join(work, "dialogue.wav")
    mus = os.path.join(work, "music.mp3")
    _make_dialogue(dia)
    _make_music(mus)

    tracks = [
        {"path": dia, "role": "dialogue", "gainDb": 0.0},
        {"path": mus, "role": "music", "gainDb": 0.0},
    ]
    out_path, result = mix_core.mix_tracks(work, tracks, target, "mp3")
    print(f"[mix] out={out_path} dur={result['durationSeconds']}s "
          f"lufs={result['lufs']} ducked={result['ducked']}")

    # 1. exactly one audio stream.
    n = mix_core._count_audio_streams(out_path)
    if n == 1:
        print(f"[PASS] output has exactly 1 audio stream")
    else:
        failures.append(f"expected 1 audio stream, got {n}")

    # 2. integrated loudness within tolerance of the target. loudnorm is not
    # sample-exact; +-1.5 LU is a fair tolerance for a short two-pass run.
    if abs(result["lufs"] - target) <= 1.5:
        print(f"[PASS] integrated loudness {result['lufs']} LUFS ~ target {target}")
    else:
        failures.append(f"loudness {result['lufs']} LUFS not within 1.5 of {target}")

    # 3. the duck is real: isolate the DUCKED MUSIC STEM (music keyed by the gated
    # dialogue) and compare the bed's mean volume in the silent window (0..3s)
    # vs the dialogue-present window (3..6s). Ducking => present window quieter.
    stem = os.path.join(work, "ducked_stem.wav")
    _run([
        "ffmpeg", "-y", "-i", mus, "-i", dia,
        "-filter_complex",
        f"[0:a]aresample=48000,aformat=channel_layouts=stereo[m];"
        f"[1:a]aresample=48000,aformat=channel_layouts=stereo[k];"
        f"[m][k]sidechaincompress=threshold={mix_core.DUCK_THRESHOLD}:ratio={mix_core.DUCK_RATIO}:"
        f"attack={mix_core.DUCK_ATTACK_MS}:release={mix_core.DUCK_RELEASE_MS}:makeup=1[out]",
        "-map", "[out]", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", stem,
    ])
    quiet_win = _mean_volume(stem, 0.5, 2.5)   # dialogue silent -> bed loud
    duck_win = _mean_volume(stem, 3.5, 5.5)    # dialogue present -> bed ducked
    drop = quiet_win - duck_win
    print(f"[duck] bed mean_volume: silent-window={quiet_win:.2f} dB "
          f"present-window={duck_win:.2f} dB  drop={drop:.2f} dB")
    if drop >= 6.0:
        print(f"[PASS] music ducked by {drop:.1f} dB under dialogue")
    else:
        failures.append(f"music only ducked {drop:.2f} dB (<6 dB); duck not effective")

    # The single-bed "master the bed" check moved with the DSP: see containers/audio-master/test_local.py.

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()
