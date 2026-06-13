"""Image-prep container: rembg background removal over HTTP.

The Worker presigns an R2 GET (source portrait) and PUT (cleaned PNG) and POSTs
both to /portrait/prep; we fetch the source, strip the background with rembg
(u2net), optionally composite onto black, and PUT the result. Image bytes never
touch the Worker. CPU-only onnxruntime; no R2 binding (presign keeps creds on
the Worker). See docs/image-prep-container.md.
"""
import asyncio
import logging
import os
import threading
from io import BytesIO

from aiohttp import ClientSession, ClientTimeout, web
from PIL import Image

# rembg is intentionally NOT imported at module load. `import rembg` pulls in
# pymatting, which JIT-compiles numba kernels on import (~46s on a cold cache,
# ~1.5s on the baked cache). Doing that before web.run_app binds :8000 trips the
# container runtime's port-ready check ("not listening on :8000").
#
# We do NOT warm at startup either: a background warm thread, on the small-core
# CF Container instance, contends for the GIL and DELAYS the bind across several
# port-ready polls until the cold-cache compile finishes (the cache is compiled
# for the build host's CPU, so it can miss on CF). The sibling audio container
# has no startup warm and cold-starts fine, so we match it: bind first, import
# rembg lazily on the first /portrait/prep. /health never touches rembg.

PORT = int(os.environ.get("PORT", "8000"))
DOWNLOAD_TIMEOUT_S = 30
UPLOAD_TIMEOUT_S = 30
MAX_INPUT_BYTES = 32 * 1024 * 1024  # 32 MB upper bound on a portrait

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("image-prep")

# Lazily-created ORT session, guarded so the background warm task and a
# concurrent first request don't both build it.
_SESSION = None
_SESSION_LOCK = threading.Lock()


def _get_session():
    global _SESSION
    if _SESSION is None:
        with _SESSION_LOCK:
            if _SESSION is None:
                from rembg import new_session  # deferred; see module note

                log.info("loading rembg u2net session...")
                _SESSION = new_session("u2net")
                log.info("rembg u2net session ready")
    return _SESSION


async def health(_req):
    return web.json_response({"ok": True})


async def prep(req):
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

    input_url = body.get("inputUrl")
    output_url = body.get("outputUrl")
    output_key = body.get("outputKey", "")
    background = body.get("background", "alpha")
    if not input_url or not output_url or background not in ("alpha", "black"):
        return web.json_response({"ok": False, "error": "bad input"}, status=400)

    # Fetch the source portrait.
    async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
        async with s.get(input_url) as r:
            if r.status != 200:
                return web.json_response({"ok": False, "error": f"input fetch {r.status}"}, status=502)
            data = b""
            async for chunk in r.content.iter_chunked(64 * 1024):
                data += chunk
                if len(data) > MAX_INPUT_BYTES:
                    return web.json_response({"ok": False, "error": "input too large"}, status=413)

    try:
        loop = asyncio.get_running_loop()
        out_bytes, w, h = await loop.run_in_executor(None, _process, data, background)
    except Exception as e:  # noqa: BLE001 - surface processing failure as 500
        log.exception("rembg failed")
        return web.json_response({"ok": False, "error": str(e)}, status=500)

    # PUT the cleaned PNG to the presigned output URL.
    async with ClientSession(timeout=ClientTimeout(total=UPLOAD_TIMEOUT_S)) as s:
        async with s.put(output_url, data=out_bytes, headers={"content-type": "image/png"}) as r:
            if r.status not in (200, 201, 204):
                return web.json_response({"ok": False, "error": f"output put {r.status}"}, status=502)

    return web.json_response({
        "ok": True,
        "key": output_key,
        "bytes": len(out_bytes),
        "width": w,
        "height": h,
        "background": background,
    })


def _process(data, background):
    from rembg import remove  # deferred; see module note

    cleaned = remove(data, session=_get_session())  # bytes in, PNG RGBA bytes out
    img = Image.open(BytesIO(cleaned)).convert("RGBA")
    if background == "black":
        bg = Image.new("RGB", img.size, "black")
        bg.paste(img, mask=img.split()[3])
        img = bg
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), img.size[0], img.size[1]


app = web.Application()
app.router.add_get("/health", health)
app.router.add_post("/portrait/prep", prep)

if __name__ == "__main__":
    log.info("image-prep listening on 0.0.0.0:%d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)
