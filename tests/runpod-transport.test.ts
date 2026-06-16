import { describe, it, expect } from "vitest";
import {
  runpodRequest,
  submitRenderJob,
  pollRenderJob,
  type RunpodTransportOpts,
} from "../src/runpod-submit";
import type { Env } from "../src/env";

// Issue #13: the shared RunPod transport (retry + timeout). These tests drive a
// MOCK fetch + a no-op sleep so the retry/backoff logic runs with zero network
// and zero wall-clock delay -- the live endpoint (t9wcvlxh8rc5la) is never hit.

const env = { RUNPOD_API_KEY: "k", RUNPOD_ENDPOINT_ID: "ep" } as unknown as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const okEnvelope = { id: "job-1", status: "IN_QUEUE" };

// A fetch double driven by a list of per-call steps. Each step either returns a
// Response or throws (to simulate a network error / timeout). The last step
// repeats if more calls arrive than steps provided. Records every call.
function mockFetch(steps: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return step();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Deterministic, instant transport opts: no real sleep, fixed jitter, tiny base.
function fastOpts(fetchImpl: typeof fetch, extra: Partial<RunpodTransportOpts> = {}): RunpodTransportOpts {
  return {
    fetchImpl,
    sleep: async () => {},
    random: () => 0,
    backoffBaseMs: 1,
    ...extra,
  };
}

const spec = { method: "POST" as const, url: "https://api.runpod.ai/v2/ep/run", body: "{}", label: "submit" };

describe("runpodRequest retry/timeout transport", () => {
  it("succeeds on the first try with no retry", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse(okEnvelope)]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.view.jobId).toBe("job-1");
    expect(calls.length).toBe(1);
  });

  it("retries a transient 5xx then succeeds", async () => {
    const { fn, calls } = mockFetch([
      () => jsonResponse({ error: "upstream" }, 503),
      () => jsonResponse(okEnvelope),
    ]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("retries a 429 then succeeds", async () => {
    const { fn, calls } = mockFetch([
      () => jsonResponse({ error: "rate limited" }, 429),
      () => jsonResponse(okEnvelope),
    ]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("retries a network error then succeeds", async () => {
    const { fn, calls } = mockFetch([
      () => { throw new Error("ECONNRESET"); },
      () => jsonResponse(okEnvelope),
    ]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("gives up after maxAttempts on a persistent 5xx, surfacing the status", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse({ error: "server exploded" }, 500)]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(3); // default RUNPOD_MAX_ATTEMPTS
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.error).toContain("server exploded");
    }
  });

  it("gives up after maxAttempts on a persistent network error", async () => {
    const { fn, calls } = mockFetch([() => { throw new Error("ETIMEDOUT"); }]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(3);
    if (!r.ok) {
      expect(r.error).toContain("network error");
      expect(r.error).toContain("ETIMEDOUT");
      expect(r.status).toBeUndefined();
    }
  });

  it("honors a custom maxAttempts", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse({ error: "nope" }, 502)]);
    const r = await runpodRequest(env, spec, fastOpts(fn, { maxAttempts: 2 }));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(2);
  });

  it("does NOT retry a terminal 4xx", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse({ error: "bad request" }, 400)]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(1); // one shot, no retry
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("bad request");
    }
  });

  it("does NOT retry a 401 auth failure", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse({ error: "unauthorized" }, 401)]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("passes an AbortSignal (the per-attempt timeout) on every fetch", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse(okEnvelope)]);
    await runpodRequest(env, spec, fastOpts(fn));
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a config error without fetching when secrets are unset", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse(okEnvelope)]);
    const bad = { RUNPOD_API_KEY: "", RUNPOD_ENDPOINT_ID: "" } as unknown as Env;
    const r = await runpodRequest(bad, spec, fastOpts(fn));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
    if (!r.ok) expect(r.error).toContain("RUNPOD_API_KEY");
  });

  it("surfaces a non-JSON 200 body as a terminal error (no retry)", async () => {
    const { fn, calls } = mockFetch([
      () => new Response("<html>nope</html>", { status: 200 }),
    ]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(1);
    if (!r.ok) expect(r.error).toContain("non-JSON");
  });

  it("rejects an unrecognized envelope shape", async () => {
    const { fn } = mockFetch([() => jsonResponse({ not: "a job" })]);
    const r = await runpodRequest(env, spec, fastOpts(fn));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unrecognized envelope");
  });
});

describe("public submitters wire through the shared transport", () => {
  it("submitRenderJob posts to /run with the built payload and 'submit' label", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse({ error: "boom" }, 500)]);
    const r = await submitRenderJob(env, { bundleKey: "bundles/myfilm.tar.gz" }, fastOpts(fn));
    expect(calls[0].url).toBe("https://api.runpod.ai/v2/ep/run");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.input.project).toBe("myfilm");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("RunPod submit failed"); // label preserved
  });

  it("pollRenderJob does a GET to /status with no body or content-type", async () => {
    const { fn, calls } = mockFetch([() => jsonResponse({ id: "j", status: "COMPLETED" })]);
    const r = await pollRenderJob(env, "job-1", fastOpts(fn));
    expect(calls[0].url).toBe("https://api.runpod.ai/v2/ep/status/job-1");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});
