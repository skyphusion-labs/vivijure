# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

# ffmpeg ships ffprobe too. fonts-dejavu-core provides DejaVu Sans at
# /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf, which ffmpeg drawtext
# needs for the /overlay route added in #190. fontconfig supplies the
# runtime alias resolution that lets drawtext resolve font names (the
# text-overlay module passes font=<name> not fontfile=<path>, so fontconfig
# must be present so the name lookup does not fail).
#
# NOTE: the text-overlay module default is font=Arial. Debian fontconfig
# includes a metric-alias that maps Arial -> DejaVu Sans / Liberation Sans,
# so font=Arial resolves correctly here. If that alias is ever absent,
# drawtext will error; the fix is to change the module default to
# "DejaVu Sans" or switch to fontfile= with an explicit path.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        fonts-dejavu-core \
        fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY url_guard.py inspect_core.py app.py .

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

# Build-time drawtext sanity-check: prove DejaVuSans.ttf is reachable at
# the expected path and that ffmpeg drawtext can burn text. Fails fast if
# fonts-dejavu-core is ever dropped or moves its files. Uses fontfile= here
# (explicit path) rather than font= so the check is path-exact, independent
# of fontconfig alias resolution.
RUN ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=24:duration=0.1 \
        -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='vivijure':fontsize=24:fontcolor=white:x=10:y=10" \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p /tmp/drawtext_warm.mp4 \
    && rm -f /tmp/drawtext_warm.mp4 \
    && echo "drawtext sanity-encode OK"

# Build-time subtitles (libass) sanity-check: the /subtitle route burns captions
# via `-vf subtitles=<srt>`, which needs ffmpeg built WITH libass. Debian's ffmpeg
# is, but prove it: write a 1-cue SRT and burn it. Fails the build fast if a slim
# image ever ships an ffmpeg without the subtitles filter, instead of every
# /subtitle call erroring at runtime. force_style exercises the same font path
# (fontconfig -> DejaVu Sans) the module uses.
RUN printf '1\n00:00:00,000 --> 00:00:00,100\nvivijure\n' > /tmp/warm.srt \
    && ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=24:duration=0.1 \
        -vf "subtitles=/tmp/warm.srt:force_style='FontName=DejaVu Sans,FontSize=18'" \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p /tmp/subs_warm.mp4 \
    && rm -f /tmp/warm.srt /tmp/subs_warm.mp4 \
    && echo "subtitles (libass) sanity-encode OK"

EXPOSE 8000
CMD ["python", "app.py"]
