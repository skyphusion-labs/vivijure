# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

# ffmpeg ships ffprobe too. The master is pure ffmpeg DSP (soxr resample + high-shelf lift +
# two-pass loudnorm) plus libmp3lame for the mp3 output, all of which the slim-image ffmpeg
# provides. No GPU, no fonts/drawtext (audio only).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY master_core.py url_guard.py app.py .

# Build-time sanity-encode: prove the exact filter chain the master relies on links and runs in this
# slim ffmpeg -- the soxr resampler + high-shelf "air" lift + two-pass-capable loudnorm + libmp3lame.
# A slim ffmpeg built without libsoxr would fail HERE at build, not at the first real job; it also
# pages the encoders in so the first cold job pays no load cost.
RUN ffmpeg -y \
        -f lavfi -i "sine=frequency=440:duration=0.3:sample_rate=22050" \
        -af "aresample=48000:resampler=soxr:precision=28,highshelf=gain=2.5:frequency=9000:width_type=q:width=0.7,loudnorm=I=-14:TP=-1.5:LRA=11" \
        -ac 2 -ar 48000 -c:a libmp3lame -b:a 192k /tmp/warm.mp3 \
    && ffprobe -v error -select_streams a -show_entries stream=sample_rate -of csv=p=0 /tmp/warm.mp3 | grep -q 48000 \
    && rm -f /tmp/warm.mp3 \
    && echo "audio-master soxr+lift+loudnorm sanity OK"

EXPOSE 8000
CMD ["python", "app.py"]
