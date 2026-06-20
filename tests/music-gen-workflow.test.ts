// Regression test for #155 (music side): the blocking gen runs in a WORKFLOW, never a request-path
// ctx.waitUntil. /invoke creates the workflow and returns fast (no waitUntil, no AI.run); /poll is R2-
// presence authoritative and reports the workflow status for an errored run. Drives the worker fetch
// handler with a fake R2 + fake Workflow binding.
import { describe, it, expect } from "vitest";
import worker from "../modules/music-gen/src/index";

interface StoredObj { body: string | ArrayBuffer; }

function fakeEnv(opts: { workflowStatus?: string; createThrows?: boolean } = {}) {
  const store = new Map<string, StoredObj>();
  const created: Array<{ id?: string; params?: unknown }> = [];
  const env = {
    GATEWAY_ID: "gw",
    AI: { async run() { throw new Error("AI.run must NOT be called from the request path"); } },
    R2_RENDERS: {
      async put(key: string, value: string | ArrayBuffer) { store.set(key, { body: value }); },
      async get(key: string) {
        const o = store.get(key);
        if (!o) return null;
        return { async text() { return typeof o.body === "string" ? o.body : ""; } };
      },
    },
    SCORE_WORKFLOW: {
      async create(options?: { id?: string; params?: unknown }) {
        if (opts.createThrows) throw new Error("workflow create failed");
        created.push(options ?? {});
        return { id: "wf-1", async status() { return { status: opts.workflowStatus ?? "running" }; } };
      },
      async get(_id: string) {
        return { id: "wf-1", async status() { return { status: opts.workflowStatus ?? "running" }; } };
      },
    },
  };
  return { env, store, created };
}

function req(path: string, body: unknown): Request {
  return new Request("https://module" + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}
const ctx = { waitUntil() { throw new Error("waitUntil must NOT be used (#155)"); }, passThroughOnException() {} };

describe("music-gen #155: gen runs in a Workflow, not waitUntil", () => {
  it("invoke starts the workflow with the params and returns a poll token (no waitUntil, no AI.run)", async () => {
    const { env, created } = fakeEnv();
    const resp = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score" } }), env as never, ctx as never);
    const j = await resp.json() as { ok: boolean; pending?: boolean; poll?: string };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
    expect(typeof j.poll).toBe("string");
    expect(created.length).toBe(1);
    expect((created[0].params as { input: { film_key: string } }).input.film_key).toBe("renders/f/film.mp4");
  });

  it("poll returns pending while the workflow runs (R2 has no audio yet)", async () => {
    const { env } = fakeEnv({ workflowStatus: "running" });
    const inv = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score" } }), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await worker.fetch(req("/poll", { poll }), env as never, ctx as never);
    const j = await out.json() as { ok: boolean; pending?: boolean };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
  });

  it("poll returns the output once the workflow has written the done R2 state (R2-presence authoritative)", async () => {
    const { env } = fakeEnv();
    const inv = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score" } }), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const jobId = JSON.parse(atob(poll)).job_id;
    // Simulate the workflow step having completed: write the done state to R2.
    await env.R2_RENDERS.put(`music-gen/${jobId}.state.json`, JSON.stringify({
      status: "done", film_key: "renders/f/film.mp4", audio_key: "out/" + jobId + ".mp3",
      mime: "audio/mpeg", applied: ["music:minimax/music-2.6", "audio:out/" + jobId + ".mp3"],
    }));
    const out = await worker.fetch(req("/poll", { poll }), env as never, ctx as never);
    const j = await out.json() as { ok: boolean; output?: { applied?: string[] } };
    expect(j.ok).toBe(true);
    expect(j.output?.applied?.some((t) => t.startsWith("audio:"))).toBe(true);
  });

  it("poll surfaces an errored workflow as ok:false instead of pending-forever", async () => {
    const { env } = fakeEnv({ workflowStatus: "errored" });
    const inv = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score" } }), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await worker.fetch(req("/poll", { poll }), env as never, ctx as never);
    const j = await out.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/errored/);
  });

  it("invoke surfaces a workflow-create failure as ok:false (failure is data)", async () => {
    const { env } = fakeEnv({ createThrows: true });
    const resp = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score" } }), env as never, ctx as never);
    const j = await resp.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/workflow/i);
  });
});
