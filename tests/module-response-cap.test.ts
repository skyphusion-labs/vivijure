import { describe, it, expect } from "vitest";
import { invokeModule, pollModule, cancelModule } from "../src/modules/registry";

const ctx = { project: "p", job_id: "j" } as never;

// A module is untrusted (community territory). These cover the F5 response-size cap: the core must
// never buffer an unbounded body from a hostile/buggy module (OOM/DoS), and a cap hit degrades to
// ok:false (the honest-degrade path the callers already handle), never a crash.
function oversizedFetcher() {
  return {
    async fetch() {
      return new Response("x".repeat(1_100_000), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

describe("module response size cap (F5)", () => {
  it("invokeModule degrades to ok:false on an oversized response body (no OOM)", async () => {
    const r = await invokeModule(oversizedFetcher() as never, { hook: "finish", input: {}, config: {}, context: ctx });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeded|rejected/);
  });

  it("pollModule degrades to ok:false on an oversized response body", async () => {
    const r = await pollModule(oversizedFetcher() as never, { poll: "tok" });
    expect(r.ok).toBe(false);
  });

  it("cancelModule degrades to ok:false on an oversized response body", async () => {
    const r = await cancelModule(oversizedFetcher() as never, { poll: "tok" });
    expect(r.ok).toBe(false);
  });

  it("a normal-sized response still parses through the capped reader", async () => {
    const f = {
      async fetch() {
        return new Response(JSON.stringify({ ok: true, output: { shot_id: "s" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const r = await invokeModule(f as never, { hook: "finish", input: {}, config: {}, context: ctx });
    expect(r.ok).toBe(true);
  });
});
