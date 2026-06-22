# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

# ffmpeg ships ffprobe too. The mix is pure ffmpeg DSP (amix +
# sidechaincompress + loudnorm) plus libmp3lame for the mp3 output, all of
# which the slim-image ffmpeg provides. No fonts/drawtext here (audio only).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY mix_core.py url_guard.py app.py .

# Build-time sanity-encode: prove the exact filter chain /mix relies on links
# and runs in this slim ffmpeg -- sidechaincompress + loudnorm + libmp3lame.
# Fails the build fast if a slim-image ffmpeg ever ships without one of them,
# and pages the encoders in so the first real /mix pays no load cost. The
# Worker side still warms /health before /mix.
RUN ffmpeg -y \
        -f lavfi -i "sine=frequency=440:duration=0.3" \
        -f lavfi -i "sine=frequency=220:duration=0.3" \
        -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.05:ratio=8[d];[d]loudnorm=I=-14:TP=-1.5:LRA=11[a]" \
        -map "[a]" -ac 2 -ar 48000 -c:a libmp3lame -b:a 192k /tmp/warm.mp3 \
    && ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 /tmp/warm.mp3 | grep -q mp3 \
    && rm -f /tmp/warm.mp3 \
    && echo "audio-mix filter sanity-encode OK"

# Same fail-fast for the /music-upscale chain: the soxr resampler + high-shelf "air" lift. A slim
# ffmpeg built without libsoxr would fail HERE at build, not at the first /music-upscale request.
RUN ffmpeg -y \
        -f lavfi -i "sine=frequency=440:duration=0.2:sample_rate=22050" \
        -af "aresample=48000:resampler=soxr:precision=28,highshelf=gain=2.5:frequency=9000:width_type=q:width=0.7" \
        -ac 2 -ar 48000 -c:a pcm_s16le /tmp/soxr.wav \
    && ffprobe -v error -select_streams a -show_entries stream=sample_rate -of csv=p=0 /tmp/soxr.wav | grep -q 48000 \
    && rm -f /tmp/soxr.wav \
    && echo "music-upscale soxr+lift sanity OK"

EXPOSE 8000
CMD ["python", "app.py"]
