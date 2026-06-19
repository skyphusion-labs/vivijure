// Regression test for #155 (narration side): synthesis must run during /poll, not in background
// ctx.waitUntil. Mirrors tests/music-gen-poll.test.ts.
import { describe, it, expect } from "vitest";
import worker from "../modules/narration-gen/src/index";

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

function recordingCtx() {
  const tasks: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => { tasks.push(p); }, passThroughOnException() {} }, tasks };
}

function req(path: string, body: unknown): Request {
  return new Request("https://module" + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
function withAudioFetch<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async () => new Response("FAKEAUDIO", { headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
  return fn().finally(() => { globalThis.fetch = realFetch; });
}

describe("narration-gen #155: /poll does the work, no background waitUntil", () => {
  it("invoke returns a poll token without scheduling synthesis in waitUntil", async () => {
    const { env, aiRuns } = fakeEnv({ audio: "https://r2/voice.mp3" });
    const { ctx, tasks } = recordingCtx();
    const resp = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { text: "a quiet voiceover" } }), env as never, ctx as never);
    const j = await resp.json() as { ok: boolean; pending?: boolean; poll?: string };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
    expect(typeof j.poll).toBe("string");
    expect(tasks.length).toBe(0);
    expect(aiRuns()).toBe(0);
  });

  it("first poll runs synthesis inline and returns the output with the audio applied tag", async () => {
    const { env, store, aiRuns } = fakeEnv({ audio: "https://r2/voice.mp3" });
    const { ctx } = recordingCtx();
    const inv = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { text: "a quiet voiceover" } }), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await withAudioFetch(() => worker.fetch(req("/poll", { poll }), env as never, ctx as never));
    const j = await out.json() as { ok: boolean; output?: { applied?: string[] }; pending?: boolean };
    expect(j.ok).toBe(true);
    expect(j.pending).toBeUndefined();
    expect(aiRuns()).toBe(1);
    expect(j.output?.applied?.some((t) => t.startsWith("audio:"))).toBe(true);
    expect([...store.keys()].some((k) => k.startsWith("out/"))).toBe(true);
  });

  it("surfaces a model error as ok:false on the poll (failure is data)", async () => {
    const { env } = fakeEnv({ /* no audio url */ });
    const { ctx } = recordingCtx();
    const inv = await worker.fetch(req("/invoke", { hook: "score", input: { film_key: "renders/f/film.mp4" }, config: { text: "a quiet voiceover" } }), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await withAudioFetch(() => worker.fetch(req("/poll", { poll }), env as never, ctx as never));
    const j = await out.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/no audio URL/i);
  });
});
