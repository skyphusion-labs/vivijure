// F17 + #141 poll honesty (S4): a RunPod-backed module's /poll must
//   1. surface a backend error carried INSIDE `output` while the envelope status is stuck
//      non-terminal (the F17 hung-error job), and cancel the job to stop the worker billing;
//   2. tolerate a virgin endpoint's cold start (image pull outliving the #141 grace window)
//      by consulting /health before declaring a gone job failed.
// The fixture for (1) is the VERBATIM RunPod status record captured as F17 evidence
// (job e0d47f04-...-e2: handler ran 155ms, returned a structured config error inside output,
// status read IN_PROGRESS forever, worker held 344s until manual cancel).

import { describe, it, expect, vi, afterEach } from "vitest";
import kfWorker from "../modules/keyframe/src/index";
import {
  encodePoll,
  terminalErrorInOutput,
  workersStillCold,
  classifyGoneState,
  RUNPOD_COLD_GRACE_MS,
  RUNPOD_NOTFOUND_GRACE_MS,
} from "../modules/keyframe/src/keyframe";

// The F17 evidence record, verbatim (ids and all).
const F17_RECORD = {
  delayTime: 940,
  executionTime: 155,
  id: "e0d47f04-efbb-44a9-bf31-c49622e94df5-e2",
  output: {
    counts: {},
    error: {
      message: "R2 config incomplete; missing env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
      stage: "config",
    },
    job_id: "e0d47f04-efbb-44a9-bf31-c49622e94df5-e2",
    last_event: {
      event: "error",
      message: "R2 config incomplete; missing env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
      stage: "config",
      ts: 1782964482.248,
    },
    project: "untitled",
    started_ts: 1782964482.248,
    status: "error",
    updated_ts: 1782964482.248,
  },
  status: "IN_PROGRESS",
  workerId: "bpzisf8xlaxncu",
};

describe("terminalErrorInOutput (pure)", () => {
  it("extracts stage + message from the F17 evidence record's output", () => {
    expect(terminalErrorInOutput(F17_RECORD.output)).toBe(
      "R2 config incomplete; missing env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (stage: config)",
    );
  });
  it("accepts a plain-string error field", () => {
    expect(terminalErrorInOutput({ error: "boom" })).toBe("boom");
  });
  it("flags status=error even with no error detail", () => {
    expect(terminalErrorInOutput({ status: "error" })).toContain("no error detail");
  });
  it("is null for a normal progress snapshot (no false positive on healthy polls)", () => {
    expect(terminalErrorInOutput({ status: "running", keyframe_done: 3, counts: { shots: 8 } })).toBeNull();
    expect(terminalErrorInOutput({ keyframes: [{ shot_id: "s1", key: "k" }] })).toBeNull();
    expect(terminalErrorInOutput(undefined)).toBeNull();
    expect(terminalErrorInOutput(null)).toBeNull();
    expect(terminalErrorInOutput("string output")).toBeNull();
    expect(terminalErrorInOutput({ error: "" })).toBeNull();
  });
});

describe("workersStillCold (pure)", () => {
  it("true while the only worker is still initializing (virgin image pull)", () => {
    expect(workersStillCold({ workers: { idle: 0, initializing: 1, ready: 0, running: 0, throttled: 0, unhealthy: 0 } })).toBe(true);
  });
  it("true when throttled is the only sign of life", () => {
    expect(workersStillCold({ workers: { idle: 0, initializing: 0, ready: 0, running: 0, throttled: 1 } })).toBe(true);
  });
  it("false once any worker has come up (the F17 evidence health snapshot)", () => {
    expect(workersStillCold({ jobs: { completed: 0, failed: 3 }, workers: { idle: 1, initializing: 0, ready: 1, running: 0, throttled: 0, unhealthy: 0 } })).toBe(false);
  });
  it("false for a dead endpoint (nothing up, nothing coming) so a gone job still fails", () => {
    expect(workersStillCold({ workers: { idle: 0, initializing: 0, ready: 0, running: 0, throttled: 0, unhealthy: 0 } })).toBe(false);
  });
  it("false on malformed health payloads", () => {
    expect(workersStillCold(null)).toBe(false);
    expect(workersStillCold({})).toBe(false);
    expect(workersStillCold({ workers: "nope" })).toBe(false);
  });
});

describe("cold grace cap (pure)", () => {
  it("the cold cap is a superset of the normal grace window", () => {
    expect(RUNPOD_COLD_GRACE_MS).toBeGreaterThan(RUNPOD_NOTFOUND_GRACE_MS);
  });
  it("a job past normal grace but inside the cold cap classifies gone-grace under the cap", () => {
    const submitted = 1_000_000;
    const now = submitted + RUNPOD_NOTFOUND_GRACE_MS + 60_000; // 1min past normal grace
    expect(classifyGoneState(submitted, now)).toBe("gone-failed");
    expect(classifyGoneState(submitted, now, RUNPOD_COLD_GRACE_MS)).toBe("gone-grace");
  });
  it("a legacy token (no submit stamp) never gets the cold extension", () => {
    expect(classifyGoneState(undefined, 5, RUNPOD_COLD_GRACE_MS)).toBe("gone-failed");
  });
});

describe("keyframe /poll wiring (worker-level, stubbed fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { RUNPOD_API_KEY: "k", RUNPOD_ENDPOINT_ID: "ep123" } as unknown as Parameters<typeof kfWorker.fetch>[1];
  const pollReq = (poll: string) =>
    new Request("https://module/poll", { method: "POST", body: JSON.stringify({ poll }) });

  it("F17: surfaces the structured backend error on a stuck IN_PROGRESS job and cancels it", async () => {
    const urls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: RequestInit) => {
        urls.push({ url: String(u), method: init?.method ?? "GET" });
        if (String(u).includes("/status/")) {
          return new Response(JSON.stringify(F17_RECORD), { status: 200 });
        }
        return new Response("{}", { status: 200 }); // the cancel
      }),
    );
    const tok = encodePoll({ jobId: F17_RECORD.id, project: "untitled", submittedAt: Date.now() });
    const res = await kfWorker.fetch(pollReq(tok), env);
    const body = (await res.json()) as { ok: boolean; error?: string; pending?: boolean };
    expect(body.ok).toBe(false); // NEVER pending -- that was the 344s spend leak
    expect(body.error).toContain("R2 config incomplete");
    expect(body.error).toContain("stage: config");
    expect(body.error).toContain(F17_RECORD.id); // the job id the operator can act on
    const cancels = urls.filter((u) => u.url.includes("/cancel/") && u.method === "POST");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].url).toContain("/v2/ep123/cancel/" + F17_RECORD.id);
  });

  it("F17: the honest error survives a failed cancel (cancel is damage control, not a gate)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify(F17_RECORD), { status: 200 });
        throw new Error("cancel transport down");
      }),
    );
    const tok = encodePoll({ jobId: F17_RECORD.id, project: "untitled", submittedAt: Date.now() });
    const body = (await (await kfWorker.fetch(pollReq(tok), env)).json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("R2 config incomplete");
  });

  it("a healthy IN_PROGRESS job with a progress snapshot stays pending (no false positive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ id: "j1", status: "IN_PROGRESS", output: { status: "running", keyframe_done: 2 } }),
          { status: 200 },
        ),
      ),
    );
    const tok = encodePoll({ jobId: "j1", project: "p", submittedAt: Date.now() });
    const body = (await (await kfWorker.fetch(pollReq(tok), env)).json()) as { ok: boolean; pending?: boolean };
    expect(body).toEqual({ ok: true, pending: true });
  });

  it("cold start: a 404 past normal grace stays pending while /health shows no worker ever up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
        if (String(u).includes("/health")) {
          return new Response(JSON.stringify({ workers: { idle: 0, initializing: 1, ready: 0, running: 0, throttled: 0 } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    // 1 minute past the normal grace window, well inside the cold cap
    const tok = encodePoll({ jobId: "j-cold", project: "p", submittedAt: Date.now() - RUNPOD_NOTFOUND_GRACE_MS - 60_000 });
    const body = (await (await kfWorker.fetch(pollReq(tok), env)).json()) as { ok: boolean; pending?: boolean };
    expect(body).toEqual({ ok: true, pending: true });
  });

  it("cold start: the same 404 FAILS once a worker has come up (job really is gone)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
        if (String(u).includes("/health")) {
          return new Response(JSON.stringify({ workers: { idle: 1, initializing: 0, ready: 1, running: 0, throttled: 0 } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const tok = encodePoll({ jobId: "j-gone", project: "p", submittedAt: Date.now() - RUNPOD_NOTFOUND_GRACE_MS - 60_000 });
    const body = (await (await kfWorker.fetch(pollReq(tok), env)).json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("j-gone");
    expect(body.error).toContain("#141");
  });

  it("cold start: past the COLD cap the job fails even while /health still reads cold (no pending-forever)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
        if (String(u).includes("/health")) {
          return new Response(JSON.stringify({ workers: { idle: 0, initializing: 1, ready: 0, running: 0, throttled: 0 } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const tok = encodePoll({ jobId: "j-dead", project: "p", submittedAt: Date.now() - RUNPOD_COLD_GRACE_MS - 1_000 });
    const body = (await (await kfWorker.fetch(pollReq(tok), env)).json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("#141");
  });

  it("cold start: a broken /health reads as not-cold so the #141 verdict still fires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (String(u).includes("/status/")) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
        return new Response("oops", { status: 500 });
      }),
    );
    const tok = encodePoll({ jobId: "j-h500", project: "p", submittedAt: Date.now() - RUNPOD_NOTFOUND_GRACE_MS - 60_000 });
    const body = (await (await kfWorker.fetch(pollReq(tok), env)).json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("a 404 inside the NORMAL grace window stays pending without touching /health (post-submit race)", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(String(u));
        return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
      }),
    );
    const tok = encodePoll({ jobId: "j-fresh", project: "p", submittedAt: Date.now() });
    const body = (await (await kfWorker.fetch(pollReq(tok), env)).json()) as { ok: boolean; pending?: boolean };
    expect(body).toEqual({ ok: true, pending: true });
    expect(urls.some((u) => u.includes("/health"))).toBe(false);
  });
});
