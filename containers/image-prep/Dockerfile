# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    U2NET_HOME=/app/models \
    NUMBA_CACHE_DIR=/app/numba-cache \
    NUMBA_CPU_NAME=generic \
    NUMBA_CPU_FEATURES= \
    MPLCONFIGDIR=/tmp/mpl-cache

# libgomp1 = OpenMP runtime onnxruntime + numpy link against.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Eager model fetch + numba-cache warmup. Two things bake into the image layer
# here, both load-bearing for cold-start:
#   1. u2net.onnx (~170 MB) under U2NET_HOME=/app/models, so the first request
#      doesn't pay the model download (rembg reads U2NET_HOME, not REMBG_HOME).
#   2. pymatting's numba kernels. `import rembg` pulls in pymatting, which
#      JIT-compiles ~46s of numba kernels on a COLD cache. With NUMBA_CACHE_DIR
#      on the ephemeral /tmp that recompile happened on every cold start and
#      blew past the container runtime's port-ready window ("not listening on
#      :8000"). Pointing NUMBA_CACHE_DIR at /app/numba-cache (an image-layer
#      path) persists the compiled .nbi cache into the image.
#
# Two things make the baked cache actually load at runtime:
#   - The `touch`: numba stamps each cache entry with the source file's
#     full-precision st_mtime (e.g. ...078.137631), but buildkit truncates
#     mtimes to whole seconds on layer export (...078.0). The sub-second
#     mismatch invalidates EVERY kernel and forces a 46s recompile despite the
#     baked cache. Pinning pymatting's sources to a whole-second mtime first
#     makes the baked stamp match what the runtime sees.
#   - NUMBA_CPU_NAME=generic (ENV block): numba otherwise compiles for the build
#     host's exact CPU and keys the cache on it, so it MISSES when the container
#     runs on a different CPU (the CF Container host is not the build host).
#     Generic x86-64 makes the cache portable, so the ~1.5s warm import holds on
#     Cloudflare, not just locally.
# rembg is also imported lazily (not at module load, not warmed at startup) in
# app.py, so the port binds immediately regardless of cache state.
RUN find /usr/local/lib/python3.11/site-packages/pymatting -name '*.py' -exec touch -d '@1700000000' {} + \
    && python -c "from rembg import new_session; new_session('u2net'); print('rembg warm OK')" \
    && test -d /app/numba-cache && echo "numba cache baked: $(find /app/numba-cache -name '*.nbi' | wc -l) kernels"

COPY url_guard.py app.py .

EXPOSE 8000
CMD ["python", "app.py"]
