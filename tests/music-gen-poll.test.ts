// Regression test for #155: generation must run during /poll (within the request budget), NOT in a
// background ctx.waitUntil (the runtime cancels waitUntil ~30s after the response, hanging the job).
// Drives the worker's fetch handler with a fake AI + R2 and asserts /poll produces the audio with no
// waitUntil ever scheduled.
import { describe, it, expect } from "vitest";
import worker from "../modules/music-gen/src/index";

interface StoredObj { body: string | ArrayBuffer; }

function fakeEnv(aiResult: unknown) {
  const store = new Map<string, StoredObj>();
  let aiRuns = 0;
  const env = {
    GATEWAY_ID: "gw",
    AI: {
      async run(_model: string, _params: unknown) {
        aiRuns += 1;
        return aiResult;
      },
    },
    R2_RENDERS: {
      async put(key: string, value: string | ArrayBuffer) {
        store.set(key, { body: value });
        return undefined;
      },
      async get(key: string) {
        const o = store.get(key);
        if (!o) return null;
        return { async text() { return typeof o.body === "string" ? o.body : ""; } };
      },
    },
  };
  return { env, store, aiRuns: () => aiRuns };
}

// A ctx that records waitUntil calls so we can assert none are used for generation.
function recordingCtx() {
  const tasks: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => { tasks.push(p); }, passThroughOnException() {} }, tasks };
}

function req(path: string, body: unknown): Request {
  return new Request("https://module" + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

// Patch global fetch for the audio download step (the module fetches the model's audio URL).
const realFetch = globalThis.fetch;
function withAudioFetch<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async () => new Response("FAKEAUDIO", { headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
  return fn().finally(() => { globalThis.fetch = realFetch; });
}

describe("music-gen #155: /poll does the work, no background waitUntil", () => {
  it("invoke returns a poll token without scheduling generation in waitUntil", async () => {
    const { env, aiRuns } = fakeEnv({ audio: "https://r2/audio.mp3" });
    const { ctx, tasks } = recordingCtx();
    const resp = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score", format: "mp3" } }), env as never, ctx as never);
    const j = await resp.json() as { ok: boolean; pending?: boolean; poll?: string };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
    expect(typeof j.poll).toBe("string");
    expect(tasks.length).toBe(0); // generation is NOT deferred to waitUntil (the #155 bug)
    expect(aiRuns()).toBe(0); // invoke does no generation
  });

  it("first poll runs generation inline and returns the output with the audio applied tag", async () => {
    const { env, store, aiRuns } = fakeEnv({ audio: "https://r2/audio.mp3" });
    const { ctx } = recordingCtx();
    const inv = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score", format: "mp3" } }), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;

    const out = await withAudioFetch(() => worker.fetch(req("/poll", { poll }), env as never, ctx as never));
    const j = await out.json() as { ok: boolean; output?: { applied?: string[] }; pending?: boolean };
    expect(j.ok).toBe(true);
    expect(j.pending).toBeUndefined();
    expect(aiRuns()).toBe(1); // generation ran during the poll
    expect(j.output?.applied?.some((t) => t.startsWith("audio:"))).toBe(true);
    // the audio object landed in R2
    expect([...store.keys()].some((k) => k.startsWith("out/"))).toBe(true);
  });

  it("a poll while generation is in-flight reports pending, never double-runs the model", async () => {
    const { env } = fakeEnv({ audio: "https://r2/audio.mp3" });
    const { ctx } = recordingCtx();
    const inv = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score" } }), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    // Manually set state to `generating` (claimed by a prior poll mid-flight) and confirm a poll reports pending.
    await env.R2_RENDERS.put("music-gen/" + JSON.parse(atob(poll)).job_id + ".state.json", JSON.stringify({ status: "generating", started_at: 1, film_key: "renders/f/film.mp4", applied: [] }));
    const out = await worker.fetch(req("/poll", { poll }), env as never, ctx as never);
    const j = await out.json() as { ok: boolean; pending?: boolean };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
  });

  it("surfaces a model error as ok:false on the poll (failure is data)", async () => {
    const { env } = fakeEnv({ /* no audio url */ });
    const { ctx } = recordingCtx();
    const inv = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { prompt: "warm score" } }), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await withAudioFetch(() => worker.fetch(req("/poll", { poll }), env as never, ctx as never));
    const j = await out.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/no audio URL/i);
  });
});
