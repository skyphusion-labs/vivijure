# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

# ffmpeg ships ffprobe too; that is the only system dependency. Unlike the
# audio (librosa/numba) and image-prep (rembg/pymatting) containers there is no
# JIT warmup to bake -- ffmpeg is a plain subprocess, so /finish has no cold
# compile penalty and the bind is immediate.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

# Build-time libx264 sanity-encode. ffmpeg has no JIT/model cache to bake (unlike
# the numba/pymatting fix the audio + image-prep containers needed), so the only
# "warm" that makes sense is proving the encoder links and paging it in: encode a
# 1-frame testsrc with the exact codec /finish uses. Fails the build fast if a
# slim-image ffmpeg ever ships without libx264, and the first real /finish then
# pays no encoder-load cost. Bind is immediate at runtime: app.py registers
# /health and binds :8000 before any ffmpeg subprocess (no startup warm thread to
# starve the port-ready check). Worker side still wraps /finish in a warm-/health
# + retry-on-503 cold-start guard (see callVideoFinish).
RUN ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=24:duration=0.1 \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p -movflags +faststart /tmp/warm.mp4 \
    && ffprobe -v error -show_entries stream=codec_name -of csv=p=0 /tmp/warm.mp4 | grep -q h264 \
    && rm -f /tmp/warm.mp4 \
    && echo "libx264 sanity-encode OK"

EXPOSE 8000
CMD ["python", "app.py"]
