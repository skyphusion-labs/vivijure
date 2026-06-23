"""RunPod serverless handler for the audio-master endpoint (R2 in / R2 out).

The thin transport layer over master_core.master_bed: it reads the input audio bed FROM R2 by key,
runs the CPU ffmpeg master (optional soxr upscale + two-pass LUFS loudnorm), and writes the mastered
bed BACK to R2 by key -- exactly the R2 transport the GPU finish endpoints use for clips, so the
audio-master MODULE worker holds no R2 creds (the endpoint owns them). CPU only; no GPU.

Job input (the module's buildRunPodBody):
  { audio_key, output_key, target_lufs, upscale, format, seconds? }
Job output (the module's parseBackendOutput reads audio_key + applied):
  { audio_key: <output_key>, applied: [...], durationSeconds, lufs, loudnessTargetLufs, format }

A raised exception / returned {"error": ...} marks the RunPod job FAILED; the module then soft-degrades
to the ORIGINAL bed (passthrough), never dropping the film (#249 / #77). The mastering itself is a
polish, so the FAIL path is intentionally simple: do the work or report why, never half-write.
"""
import os
import shutil
import tempfile

import boto3
import runpod
from botocore.config import Config

from master_core import DEFAULT_TARGET_LUFS, master_bed

FORMATS = ("wav", "mp3")
MAX_BED_BYTES = 256 * 1024 * 1024   # 256 MB: a film-length stereo bed is well under this


def _r2_client():
    """An S3 client pointed at the shared R2 bucket. Creds come from the endpoint env (never the
    module worker): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET."""
    account = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
        region_name="auto",
    )


def _coerce(job_input):
    """Validate + normalize the job input. Returns (params, error): exactly one is None."""
    audio_key = job_input.get("audio_key")
    output_key = job_input.get("output_key")
    if not isinstance(audio_key, str) or not audio_key:
        return None, "audio_key required"
    if not isinstance(output_key, str) or not output_key:
        return None, "output_key required"
    fmt = str(job_input.get("format", "wav")).lower()
    if fmt not in FORMATS:
        return None, f"format must be one of {list(FORMATS)}"
    try:
        target_lufs = float(job_input.get("target_lufs", DEFAULT_TARGET_LUFS))
    except (TypeError, ValueError):
        return None, "target_lufs must be numeric"
    upscale = bool(job_input.get("upscale", True))
    return {"audio_key": audio_key, "output_key": output_key, "fmt": fmt,
            "target_lufs": target_lufs, "upscale": upscale}, None


def handler(job):
    p, err = _coerce(job.get("input") or {})
    if err:
        return {"error": err}

    bucket = os.environ["R2_BUCKET"]
    s3 = _r2_client()
    work = tempfile.mkdtemp(prefix="amaster-")
    try:
        src = os.path.join(work, "in.bin")
        s3.download_file(bucket, p["audio_key"], src)
        if os.path.getsize(src) > MAX_BED_BYTES:
            return {"error": "audio bed too large"}

        out_path, result = master_bed(work, src, p["target_lufs"], p["upscale"], p["fmt"])

        content_type = "audio/mpeg" if p["fmt"] == "mp3" else "audio/wav"
        s3.upload_file(out_path, bucket, p["output_key"], ExtraArgs={"ContentType": content_type})

        return {
            "audio_key": p["output_key"],
            "applied": result["applied"],
            "durationSeconds": result["durationSeconds"],
            "lufs": result["lufs"],
            "loudnessTargetLufs": p["target_lufs"],
            "format": p["fmt"],
        }
    except Exception as e:  # noqa: BLE001 -- any failure is reported as a job error; the module degrades
        return {"error": f"audio-master failed: {e}"}
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
