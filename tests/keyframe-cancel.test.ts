import { describe, it, expect, vi, afterEach } from "vitest";
import { cancelModule } from "../src/modules/registry";
import { cancelInFlightKeyframe, cancelFilmJob, filmJobDocKey, type FilmJob } from "../src/film-orchestrator";
import type { Env } from "../src/env";
import kfWorker, { MANIFEST } from "../modules/keyframe/src/index";
import { encodePoll } from "../modules/keyframe/src/keyframe";

// A service-binding-shaped fake module worker: answers GET /module.json with the given manifest and
// records every POST /cancel it receives. Lets us assert the orchestrator actually issues a cancel.
function fakeModule(manifest: Record<string, unknown>, cancelStatus = 200) {
  const calls: { cancel: string[] } = { cancel: [] };
  const fetcher = {
    async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) {
        return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/cancel")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { poll?: string };
        calls.cancel.push(String(body.poll));
        return new Response(JSON.stringify(cancelStatus === 200 ? { ok: true } : { ok: false, error: "x" }), { status: cancelStatus });
      }
      return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
    },
  };
  return { fetcher, calls };
}

const KF_MANIFEST = (over: Record<string, unknown> = {}) => ({
  name: "keyframe", version: "0.1.0", api: "vivijure-module/2", hooks: ["keyframe"], cancelable: true, ...over,
});

const filmJob = (over: Partial<FilmJob> = {}): FilmJob => ({
  film_id: "film-test", project: "p", bundle_key: "bundles/p.tar.gz", scenes: [],
  motion_backend: null, motion_config: {}, finish_config: {}, speech_config: {},
  film_finish_config: {}, master_config: {}, keyframes_only: true, clips_only: false,
  keyframe_binding: "MODULE_KEYFRAME", phase: "keyframe", created_at: 0, phase_started_at: 0,
  keyframe_poll: "tok-1", ...over,
} as FilmJob);

describe("cancelModule (registry primitive)", () => {
  it("POSTs /cancel and returns the module's CancelResponse on ok", async () => {
    const { fetcher, calls } = fakeModule(KF_MANIFEST());
    const r = await cancelModule(fetcher, { poll: "tok-9" });
    expect(r).toEqual({ ok: true });
    expect(calls.cancel).toEqual(["tok-9"]);
  });
  it("a non-200 is DATA, not a throw", async () => {
    const fetcher = { async fetch() { return new Response("nope", { status: 500 }); } };
    const r = await cancelModule(fetcher, { poll: "t" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("/cancel -> 500");
  });
  it("an unreachable binding is DATA, not a throw", async () => {
    const fetcher = { async fetch(): Promise<Response> { throw new Error("boom"); } };
    const r = await cancelModule(fetcher, { poll: "t" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("unreachable");
  });
});

describe("keyframe module: cancelable + POST /cancel", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { RUNPOD_API_KEY: "k", RUNPOD_ENDPOINT_ID: "ep123" } as unknown as Parameters<typeof kfWorker.fetch>[1];
  const cancelReq = (poll: string) =>
    new Request("https://module/cancel", { method: "POST", body: JSON.stringify({ poll }) });

  it("advertises cancelable in its manifest", () => {
    expect(MANIFEST.cancelable).toBe(true);
  });
  it("cancels the RunPod job named by the poll token (200 -> ok:true), hitting /cancel/<jobId>", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { seen.push(String(u)); return new Response("{}", { status: 200 }); }));
    const tok = encodePoll({ jobId: "job-abc-e1", project: "p" });
    const res = await kfWorker.fetch(cancelReq(tok), env);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen[0]).toContain("/v2/ep123/cancel/job-abc-e1");
  });
  it("treats a 404 (job already GC'd / terminal) as an idempotent success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    const res = await kfWorker.fetch(cancelReq(encodePoll({ jobId: "j", project: "p" })), env);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("surfaces any other status as ok:false so the core degrade-logs the orphan", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 502 })));
    const res = await kfWorker.fetch(cancelReq(encodePoll({ jobId: "j", project: "p" })), env);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("502");
  });
  it("a bad poll token is DATA (ok:false), never a crash, and never calls RunPod", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const res = await kfWorker.fetch(cancelReq("not-base64-json"), env);
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("cancelInFlightKeyframe (the #327/#328 fix: stop the GPU, never orphan)", () => {
  it("issues a cancel for the in-flight keyframe job when the module is cancelable", async () => {
    const { fetcher, calls } = fakeModule(KF_MANIFEST());
    const env = { MODULE_KEYFRAME: fetcher } as unknown as Env;
    await cancelInFlightKeyframe(env, filmJob({ keyframe_poll: "tok-77" }));
    expect(calls.cancel).toEqual(["tok-77"]);
  });
  it("does NOT cancel (and does not crash) when the module is not cancelable -- honest-degrade path", async () => {
    const { fetcher, calls } = fakeModule(KF_MANIFEST({ cancelable: false }));
    const env = { MODULE_KEYFRAME: fetcher } as unknown as Env;
    await cancelInFlightKeyframe(env, filmJob());
    expect(calls.cancel).toEqual([]);
  });
  it("is a no-op when there is no in-flight keyframe job (wrong phase / no poll token)", async () => {
    const { fetcher, calls } = fakeModule(KF_MANIFEST());
    const env = { MODULE_KEYFRAME: fetcher } as unknown as Env;
    await cancelInFlightKeyframe(env, filmJob({ phase: "clips" }));
    await cancelInFlightKeyframe(env, filmJob({ keyframe_poll: undefined }));
    expect(calls.cancel).toEqual([]);
  });
  it("NAMES the orphaned RunPod job id in the honest-degrade WARN (so an operator can kill it by hand)", async () => {
    const { fetcher } = fakeModule(KF_MANIFEST({ cancelable: false }));
    const env = { MODULE_KEYFRAME: fetcher } as unknown as Env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cancelInFlightKeyframe(env, filmJob({ keyframe_job_id: "job-xyz-e1" }));
    expect(warn.mock.calls.flat().join(" ")).toContain("job-xyz-e1");
    warn.mockRestore();
  });
});

describe("cancelFilmJob (DELETE /api/storyboard/render/:id) propagates cancel to RunPod (#328)", () => {
  it("issues a module cancel for the in-flight keyframe job and marks the film cancelled", async () => {
    const { fetcher, calls } = fakeModule(KF_MANIFEST());
    const job = filmJob({ keyframe_poll: "tok-del" });
    const store = new Map<string, string>([[filmJobDocKey(job.film_id), JSON.stringify(job)]]);
    const env = {
      MODULE_KEYFRAME: fetcher,
      R2_RENDERS: {
        get: async (k: string) => { const v = store.get(k); return v === undefined ? null : { text: async () => v }; },
        put: async (k: string, v: string) => { store.set(k, v); },
      },
    } as unknown as Env;

    const out = await cancelFilmJob(env, job.film_id);
    expect(calls.cancel).toEqual(["tok-del"]); // the GPU was actually told to stop, not just the studio state
    expect(out?.cancelled).toBe(true);
    expect(out?.phase).toBe("failed");
    // and it was persisted cancelled
    expect(JSON.parse(store.get(filmJobDocKey(job.film_id))!).cancelled).toBe(true);
  });

  it("an already-terminal film is a no-op (no cancel call)", async () => {
    const { fetcher, calls } = fakeModule(KF_MANIFEST());
    const job = filmJob({ phase: "done" });
    const store = new Map<string, string>([[filmJobDocKey(job.film_id), JSON.stringify(job)]]);
    const env = {
      MODULE_KEYFRAME: fetcher,
      R2_RENDERS: { get: async (k: string) => { const v = store.get(k); return v === undefined ? null : { text: async () => v }; }, put: async () => {} },
    } as unknown as Env;
    await cancelFilmJob(env, job.film_id);
    expect(calls.cancel).toEqual([]);
  });
});
