import { describe, it, expect } from "vitest";
import { awaitInvoke, pollModule } from "../src/modules/registry";

// A fake module fetcher: /invoke returns `invoke`; /poll returns the next item from `pollSeq`.
function fakeFetcher(invoke: unknown, pollSeq: unknown[]) {
  let i = 0;
  return {
    async fetch(input: Request | string): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      const body = url.endsWith("/poll") ? pollSeq[Math.min(i++, pollSeq.length - 1)] : invoke;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

const req = { hook: "motion.backend" as const, input: {}, config: {}, context: { project: "p", job_id: "j" } };

describe("awaitInvoke (sync + async resolution)", () => {
  it("returns a synchronous output directly, no poll", async () => {
    const r = await awaitInvoke(fakeFetcher({ ok: true, output: { x: 1 } }, []), req);
    expect(r).toEqual({ ok: true, output: { x: 1 } });
  });

  it("polls a pending job until it finishes", async () => {
    const f = fakeFetcher({ ok: true, pending: true, poll: "tok" }, [
      { ok: true, pending: true },
      { ok: true, pending: true },
      { ok: true, output: { done: true } },
    ]);
    const r = await awaitInvoke(f, req, { pollMs: 1, pollMax: 10 });
    expect(r).toEqual({ ok: true, output: { done: true } });
  });

  it("surfaces a poll failure as data", async () => {
    const f = fakeFetcher({ ok: true, pending: true, poll: "tok" }, [{ ok: false, error: "boom" }]);
    const r = await awaitInvoke(f, req, { pollMs: 1, pollMax: 5 });
    expect(r).toEqual({ ok: false, error: "boom" });
  });

  it("times out a job that never finishes", async () => {
    const f = fakeFetcher({ ok: true, pending: true, poll: "tok" }, [{ ok: true, pending: true }]);
    const r = await awaitInvoke(f, req, { pollMs: 1, pollMax: 3 });
    expect(r.ok).toBe(false);
  });

  it("passes a synchronous failure straight through", async () => {
    const r = await awaitInvoke(fakeFetcher({ ok: false, error: "nope" }, []), req);
    expect(r).toEqual({ ok: false, error: "nope" });
  });
});

describe("pollModule", () => {
  it("degrades to data on a non-200", async () => {
    const f = { async fetch(): Promise<Response> { return new Response("x", { status: 500 }); } };
    expect((await pollModule(f, { poll: "t" })).ok).toBe(false);
  });
});
