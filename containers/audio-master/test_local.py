"""Local DSP check for the audio-master container -- runs master_core.master_bed directly on a
synthesized bed (no R2, no HTTP, just ffmpeg/ffprobe on PATH). Mirrors containers/audio-mix/
test_local.py: it validates the ffmpeg mastering chain, the layer app.py wraps with presigned-R2 HTTP I/O.

    python test_local.py
"""
import os
import subprocess
import sys
import tempfile

import master_core


def _run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def _sr_ch(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=sample_rate,channels", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True).stdout.strip()
    return out


def main():
    failures = []
    target = master_core.DEFAULT_TARGET_LUFS
    work = tempfile.mkdtemp(prefix="amaster-test-")

    # A low-rate, quiet mono music source: the worst case the master should rescue (resample to 48k
    # stereo, lift, and bring to the loudness target).
    lo = os.path.join(work, "lo.wav")
    _run(["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=4:sample_rate=22050",
          "-af", "volume=-26dB", "-ac", "1", lo])

    # 1. upscale ON: soxr 48k + air lift + loudnorm.
    up_out, up_res = master_core.master_bed(work, lo, target, True, "wav")
    up_srch = _sr_ch(up_out)
    print(f"[upscale=on] out={up_out} sr/ch={up_srch} lufs={up_res['lufs']} applied={up_res['applied']}")
    if up_srch.startswith("48000") and up_srch.endswith("2"):
        print("[PASS] mastered output is 48k stereo")
    else:
        failures.append(f"upscale output not 48k stereo: {up_srch}")
    if abs(up_res["lufs"] - target) <= 1.5:
        print(f"[PASS] mastered loudness {up_res['lufs']} LUFS ~ target {target}")
    else:
        failures.append(f"upscale loudness {up_res['lufs']} not within 1.5 of {target}")
    if "music-upscale:soxr48k" in up_res["applied"] and any(a.startswith("loudnorm:") for a in up_res["applied"]):
        print("[PASS] applied tags record the upscale + loudnorm (honest #77 record)")
    else:
        failures.append(f"upscale applied tags missing expected entries: {up_res['applied']}")

    # 2. upscale OFF: loudnorm only (still 48k stereo, still at target), NO music-upscale tag.
    off_out, off_res = master_core.master_bed(work, lo, target, False, "wav")
    print(f"[upscale=off] out={off_out} sr/ch={_sr_ch(off_out)} lufs={off_res['lufs']} applied={off_res['applied']}")
    if abs(off_res["lufs"] - target) <= 1.5:
        print(f"[PASS] loudnorm-only loudness {off_res['lufs']} LUFS ~ target {target}")
    else:
        failures.append(f"loudnorm-only loudness {off_res['lufs']} not within 1.5 of {target}")
    if "music-upscale:soxr48k" not in off_res["applied"]:
        print("[PASS] upscale OFF does not claim a music-upscale tag")
    else:
        failures.append("upscale OFF wrongly tagged music-upscale")

    # 3. mp3 output format re-encodes.
    mp3_out, _ = master_core.master_bed(work, lo, target, True, "mp3")
    codec = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_name", "-of", "csv=p=0", mp3_out],
        capture_output=True, text=True, check=True).stdout.strip()
    if codec == "mp3":
        print("[PASS] mp3 format re-encodes to mp3")
    else:
        failures.append(f"mp3 format produced codec {codec}")

    # 4. film-length trim: `seconds` cuts the mastered bed to the film length so an over-long source bed
    # (the music-gen 381s-vs-short-film case) does not ship a bloated audio track. The synthesized source is
    # 4s; trimming to 2.0s must yield a ~2.0s mastered output, and the untrimmed baseline stays ~4.0s.
    full_out, full_res = master_core.master_bed(work, lo, target, True, "wav")
    trim_out, trim_res = master_core.master_bed(work, lo, target, True, "wav", 2.0)
    print(f"[trim] full={full_res['durationSeconds']}s trimmed(2.0)={trim_res['durationSeconds']}s")
    if abs(trim_res["durationSeconds"] - 2.0) <= 0.15:
        print("[PASS] seconds=2.0 trims the mastered bed to ~2.0s")
    else:
        failures.append(f"seconds trim produced {trim_res['durationSeconds']}s, expected ~2.0s")
    if full_res["durationSeconds"] > 3.5:
        print(f"[PASS] no-seconds baseline keeps full length ({full_res['durationSeconds']}s)")
    else:
        failures.append(f"no-seconds baseline unexpectedly short: {full_res['durationSeconds']}s")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()
