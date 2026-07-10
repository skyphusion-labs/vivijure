"""Async job+poll layer tests (#602) for the video-finish container. Exercises the
submit -> background-run -> status lifecycle with STUBBED work coroutines (no ffmpeg,
no network), plus the sync-route validation back-compat. Requires aiohttp, so it runs
INSIDE the built image (see the Dockerfile test stage), not in the stdlib-only local env.

Run (inside the image):  python3 test_async.py
Exits non-zero on any failed assertion.
"""
import asyncio
import sys

from aiohttp.test_utils import TestClient, TestServer

import app


def check(name, cond):
    if cond:
        print(f"  ok  {name}")
    else:
        print(f"FAIL  {name}")
        check.failed += 1
check.failed = 0


async def _poll_terminal(client, job_id, tries=100):
    body = {"status": "pending"}
    for _ in range(tries):
        r = await client.get(f"/async/status/{job_id}")
        body = await r.json()
        if body.get("status") != "pending":
            return r.status, body
        await asyncio.sleep(0.02)
    return None, body


async def main():
    async def ok_work(body):
        # A trivial completed job; proves the runner records the result verbatim.
        return {"ok": True, "key": body.get("outputKey", ""), "stub": True}

    async def bad_work(body):
        raise app._JobError(400, "bad input")

    async def crash_work(body):
        raise RuntimeError("kaboom")

    app.ASYNC_WORKS = {"film-titles": ok_work, "subtitle": bad_work, "boom": crash_work}

    client = TestClient(TestServer(app.app))
    await client.start_server()
    try:
        # 1) submit -> 202 + jobId + pending
        r = await client.post("/async/film-titles", json={"outputKey": "renders/x/film-ff0.mp4"})
        check("submit returns 202", r.status == 202)
        body = await r.json()
        check("submit ok+jobId+pending", body.get("ok") is True and isinstance(body.get("jobId"), str) and body.get("status") == "pending")
        st, sbody = await _poll_terminal(client, body["jobId"])
        check("completed 200", st == 200)
        check("completed status", sbody.get("status") == "completed")
        check("result forwarded", sbody.get("result", {}).get("key") == "renders/x/film-ff0.mp4")

        # 2) a _JobError work -> job failed carrying the message
        r2 = await client.post("/async/subtitle", json={})
        b2 = await r2.json()
        _, sb2 = await _poll_terminal(client, b2["jobId"])
        check("job failed status", sb2.get("status") == "failed")
        check("job failed error", sb2.get("error") == "bad input")

        # 3) an unexpected crash -> job failed (surfaced, not hidden)
        r3 = await client.post("/async/boom", json={})
        b3 = await r3.json()
        _, sb3 = await _poll_terminal(client, b3["jobId"])
        check("crash -> failed", sb3.get("status") == "failed" and "kaboom" in sb3.get("error", ""))

        # 4) unknown async route -> 404
        r4 = await client.post("/async/does-not-exist", json={})
        check("unknown route 404", r4.status == 404)

        # 5) unknown job id -> 404 not_found (the core distinguishes this)
        r5 = await client.get("/async/status/deadbeefcafe")
        b5 = await r5.json()
        check("unknown job 404", r5.status == 404 and b5.get("status") == "not_found")

        # 6) sync route back-compat: validation still 400s in-request (no async, no ffmpeg)
        r6 = await client.post("/film-titles", json={})
        check("sync film-titles validation 400", r6.status == 400)
        r7 = await client.post("/subtitle", json={})
        check("sync subtitle validation 400", r7.status == 400)
    finally:
        await client.close()


asyncio.run(main())
if check.failed:
    print(f"\n{check.failed} FAILED")
    sys.exit(1)
print("\nall async-layer tests passed")
