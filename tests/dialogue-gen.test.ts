// dialogue-gen module: per-shot Aura-1 TTS in a Workflow for the `dialogue` hook. Covers the pure
// helpers, the fetch submit/poll lifecycle (#155: gen runs in a Workflow, not request-path waitUntil),
// and the batch workflow loop (one WAV per shot to R2 + a done state carrying the audio map).
import { describe, it, expect } from "vitest";
import worker, { DialogueGenWorkflow } from "../modules/dialogue-gen/src/index";
import {
  resolveVoice,
  normalizeInput,
  audioKey,
  DEFAULT_VOICE_ID,
  AUDIO_MIME,
} from "../modules/dialogue-gen/src/dialogue-gen";

// ---- pure helpers ----------------------------------------------------------

describe("dialogue-gen helpers", () => {
  it("resolveVoice keeps a known speaker, falls back to default otherwise", () => {
    expect(resolveVoice("asteria")).toBe("asteria");
    expect(resolveVoice("nope")).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoice(undefined)).toBe(DEFAULT_VOICE_ID);
  });

  it("audioKey lands the WAV beside the shot's render artifacts", () => {
    expect(audioKey("my_film", "shot_03")).toBe("renders/my_film/dialogue/shot_03.wav");
  });

  it("normalizeInput requires a project and an array of lines", () => {
    expect(normalizeInput(undefined as never).ok).toBe(false);
    expect(normalizeInput({ project: "", lines: [] } as never).ok).toBe(false);
    const bad = normalizeInput({ project: "p", lines: {} } as never);
    expect(bad.ok).toBe(false);
  });

  it("normalizeInput skips empty/textless lines and resolves voices", () => {
    const r = normalizeInput({
      project: "p",
      lines: [
        { shot_id: "shot_01", text: "Hello.", voice_id: "orion" },
        { shot_id: "shot_02", text: "   " },          // no words -> skipped
        { shot_id: "", text: "orphan" },              // no shot -> skipped
        { shot_id: "shot_03", text: "Bye.", voice_id: "bogus" }, // unknown voice -> default
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines.map((l) => l.shot_id)).toEqual(["shot_01", "shot_03"]);
      expect(r.lines[0].voice).toBe("orion");
      expect(r.lines[1].voice).toBe(DEFAULT_VOICE_ID);
    }
  });

  it("normalizeInput rejects an over-cap line (no silent truncation of a character's words)", () => {
    const r = normalizeInput({ project: "p", lines: [{ shot_id: "shot_01", text: "x".repeat(301) }] });
    expect(r.ok).toBe(false);
  });
});

// ---- fetch submit/poll lifecycle ------------------------------------------

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
    DIALOGUE_WORKFLOW: {
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
const speaking = { project: "f", lines: [{ shot_id: "shot_01", text: "We should not be here.", voice_id: "orion" }] };

describe("dialogue-gen #155: batch synth runs in a Workflow, not waitUntil", () => {
  it("invoke with lines starts the workflow with the normalized lines and returns a poll token", async () => {
    const { env, created } = fakeEnv();
    const resp = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const j = await resp.json() as { ok: boolean; pending?: boolean; poll?: string };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
    expect(typeof j.poll).toBe("string");
    expect(created.length).toBe(1);
    const params = created[0].params as { project: string; lines: Array<{ shot_id: string; voice: string }> };
    expect(params.project).toBe("f");
    expect(params.lines[0].voice).toBe("orion");
  });

  it("invoke with NO speaking lines returns an empty result immediately (no workflow)", async () => {
    const { env, created } = fakeEnv();
    const resp = await worker.fetch(req("/invoke", { hook: "dialogue", input: { project: "f", lines: [] }, config: {} }), env as never);
    const j = await resp.json() as { ok: boolean; pending?: boolean; output?: { audio: unknown[] } };
    expect(j.ok).toBe(true);
    expect(j.pending).toBeUndefined();
    expect(j.output?.audio).toEqual([]);
    expect(created.length).toBe(0);
  });

  it("poll returns pending while the workflow runs (no done state in R2 yet)", async () => {
    const { env } = fakeEnv({ workflowStatus: "running" });
    const inv = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await worker.fetch(req("/poll", { poll }), env as never);
    const j = await out.json() as { ok: boolean; pending?: boolean };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
  });

  it("poll returns the audio map once the workflow writes the done R2 state", async () => {
    const { env } = fakeEnv();
    const inv = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const jobId = JSON.parse(atob(poll)).job_id;
    await env.R2_RENDERS.put(`dialogue-gen/${jobId}.state.json`, JSON.stringify({
      status: "done", project: "f",
      audio: [{ shot_id: "shot_01", audio_key: "renders/f/dialogue/shot_01.wav", voice_id: "orion" }],
      applied: ["dialogue:@cf/deepgram/aura-1", "lines:1"],
    }));
    const out = await worker.fetch(req("/poll", { poll }), env as never);
    const j = await out.json() as { ok: boolean; output?: { audio: Array<{ audio_key: string }> } };
    expect(j.ok).toBe(true);
    expect(j.output?.audio[0].audio_key).toBe("renders/f/dialogue/shot_01.wav");
  });

  it("poll surfaces an errored workflow as ok:false instead of pending-forever", async () => {
    const { env } = fakeEnv({ workflowStatus: "errored" });
    const inv = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await worker.fetch(req("/poll", { poll }), env as never);
    const j = await out.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/errored/);
  });

  it("invoke surfaces a workflow-create failure as ok:false (failure is data)", async () => {
    const { env } = fakeEnv({ createThrows: true });
    const resp = await worker.fetch(req("/invoke", { hook: "dialogue", input: speaking, config: {} }), env as never);
    const j = await resp.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/workflow/i);
  });
});

// ---- the batch workflow loop ----------------------------------------------

describe("DialogueGenWorkflow.run synthesizes one WAV per shot", () => {
  it("writes a WAV per line via env.AI.run and a done state carrying the audio map", async () => {
    const puts: Array<{ key: string; mime?: string }> = [];
    let aiCalls = 0;
    const env = {
      GATEWAY_ID: "gw",
      AI: {
        async run(_model: string, params: { speaker: string }) {
          aiCalls++;
          return `WAV-for-${params.speaker}`;  // BodyInit string -> non-empty bytes
        },
      },
      R2_RENDERS: {
        store: new Map<string, string>(),
        async put(key: string, v: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
          puts.push({ key, mime: opts?.httpMetadata?.contentType });
          (this.store as Map<string, string>).set(key, typeof v === "string" ? v : "bytes");
        },
        async get(key: string) {
          const s = (this.store as Map<string, string>).get(key);
          return s ? { async text() { return s; } } : null;
        },
      },
      DIALOGUE_WORKFLOW: {} as never,
    };
    const step = { do: async (_n: string, _c: unknown, fn: () => Promise<unknown>) => fn() };
    const wf = new DialogueGenWorkflow(null as never, env as never);
    await wf.run(
      { payload: { job_id: "job-1", project: "f", lines: [
        { shot_id: "shot_01", text: "Hi.", voice: "orion" },
        { shot_id: "shot_02", text: "Bye.", voice: "hera" },
      ] } } as never,
      step as never,
    );

    // Two synths, two WAVs (audio/wav), each at the per-shot key.
    expect(aiCalls).toBe(2);
    const wavPuts = puts.filter((p) => p.key.endsWith(".wav"));
    expect(wavPuts.map((p) => p.key)).toEqual([
      "renders/f/dialogue/shot_01.wav",
      "renders/f/dialogue/shot_02.wav",
    ]);
    expect(wavPuts.every((p) => p.mime === AUDIO_MIME)).toBe(true);

    // Done state written with the audio map + applied tags.
    const stateRaw = await env.R2_RENDERS.get("dialogue-gen/job-1.state.json");
    const state = JSON.parse(await stateRaw!.text()) as { status: string; audio: Array<{ shot_id: string; voice_id: string }>; applied: string[] };
    expect(state.status).toBe("done");
    expect(state.audio.map((a) => a.shot_id)).toEqual(["shot_01", "shot_02"]);
    expect(state.audio[1].voice_id).toBe("hera");
    expect(state.applied).toContain("lines:2");
  });

  it("writes a terminal failed state when a synth throws (failure is recorded, not swallowed)", async () => {
    const env = {
      GATEWAY_ID: "gw",
      AI: { async run() { throw new Error("model down"); } },
      R2_RENDERS: {
        store: new Map<string, string>(),
        async put(key: string, v: string) { (this.store as Map<string, string>).set(key, typeof v === "string" ? v : "x"); },
        async get(key: string) {
          const s = (this.store as Map<string, string>).get(key);
          return s ? { async text() { return s; } } : null;
        },
      },
      DIALOGUE_WORKFLOW: {} as never,
    };
    const step = { do: async (_n: string, _c: unknown, fn: () => Promise<unknown>) => fn() };
    const wf = new DialogueGenWorkflow(null as never, env as never);
    await wf.run({ payload: { job_id: "job-2", project: "f", lines: [{ shot_id: "shot_01", text: "Hi.", voice: "orion" }] } } as never, step as never);
    const stateRaw = await env.R2_RENDERS.get("dialogue-gen/job-2.state.json");
    const state = JSON.parse(await stateRaw!.text()) as { status: string; error: string };
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/model down/);
  });
});
