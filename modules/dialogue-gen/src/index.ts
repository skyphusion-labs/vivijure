// dialogue-gen: a `dialogue` module worker (vivijure-module/2). Voices each speaking shot's line with
// Deepgram Aura-1 on Workers AI, in the cast member's assigned voice, and writes one WAV per shot to
// R2. The core attaches each audio_key to that shot's FinishInput so finish-lipsync can drive the
// mouth from it -- the "talking characters" pipeline's audio stage.
//
// ASYNC: an Aura-1 synth is a SINGLE BLOCKING env.AI.run (Workers AI is synchronous-only). A whole
// film's worth of lines, done one per shot, far exceeds any request-path / waitUntil window (the
// runtime cancels waitUntil ~30s after the response, #155). So the batch runs inside a Cloudflare
// WORKFLOW, ONE step.do per shot: unlimited wall, per-shot retry + checkpoint, survives a recycle.
// R2 presence of the done state is authoritative for completion, like the render pipeline.
//   GET  /module.json -> manifest
//   POST /invoke      -> validate DialogueInput, persist `running`, START the workflow, return poll
//   POST /poll        -> R2 state authoritative: pending until the workflow writes done -> DialogueOutput
//
// Failures are DATA (ok:false), never thrown across the wire.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type DialogueInput,
  type DialogueOutput,
  type DialogueShotAudio,
} from "./contract";
import {
  MODEL,
  AUDIO_MIME,
  buildTtsParams,
  encodePoll,
  decodePoll,
  stateKey,
  audioKey,
  appliedTags,
  readOutput,
  normalizeInput,
  type RunState,
  type NormalizedLine,
} from "./dialogue-gen";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";

interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

interface AiRun {
  run(model: string, params: unknown, opts?: { gateway?: { id: string } }): Promise<unknown>;
}

// Minimal hand-authored shapes for the Workflow binding (mirrors the wrangler [[workflows]] entry).
interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string }>;
}
interface WorkflowBinding {
  create(options?: { id?: string; params?: WorkflowParams }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

interface Env {
  AI: AiRun;
  GATEWAY_ID: SecretsStoreSecret;
  R2_RENDERS: R2Bucket;
  DIALOGUE_WORKFLOW: WorkflowBinding;
}

/** Params passed to the workflow instance: everything the synth steps need, no bindings. */
export interface WorkflowParams {
  job_id: string;
  project: string;
  lines: NormalizedLine[];
}

const MANIFEST: ModuleManifest = {
  name: "dialogue-gen",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["dialogue"],
  provides: [{ id: "aura1", label: "Dialogue voices (Deepgram Aura-1)" }],
  // No user-facing knobs: the voice is the speaking cast member's assigned voice_id (resolved by the
  // core), and the line is the shot's dialogue. Both are authored upstream, not module config.
  ui: { section: "dialogue", icon: "mic", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value.
 *  Returns "" if unset/unreadable so the existing "not configured" guards still fire. */
async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  if (typeof s === "string") return s;
  if (!s) return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + (e as Error).message);
    return "";
  }
}

async function writeState(env: Env, jobId: string, state: RunState): Promise<void> {
  await env.R2_RENDERS.put(stateKey(jobId), JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function readState(env: Env, jobId: string): Promise<RunState | null> {
  const obj = await env.R2_RENDERS.get(stateKey(jobId));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as RunState;
  } catch {
    return null;
  }
}

/** Synthesize ONE line: blocking env.AI.run -> WAV bytes -> R2. Returns the shot's audio descriptor.
 *  THROWS on failure so the step retries; Aura-1 returns the audio as a binary stream (not a URL like
 *  the music model), so we read the body to bytes directly. */
async function synthLine(env: Env, project: string, line: NormalizedLine): Promise<DialogueShotAudio> {
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) throw new Error("GATEWAY_ID not configured");
  const result = await env.AI.run(MODEL, buildTtsParams(line.text, line.voice), { gateway: { id: gatewayId } });
  // Aura-1 returns a ReadableStream of audio; Response accepts it (or a raw ArrayBuffer/bytes) as a body.
  const bytes = await new Response(result as BodyInit).arrayBuffer();
  if (bytes.byteLength === 0) throw new Error(`empty audio for ${line.shot_id}`);
  const key = audioKey(project, line.shot_id);
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: AUDIO_MIME } });
  return { shot_id: line.shot_id, audio_key: key, voice_id: line.voice };
}

/** Per-shot step config. A single short line synth is fast; a generous timeout + a couple of retries
 *  absorbs a transient gateway blip without much double-spend (TTS is cheap vs the music model). */
const SYNTH_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

export class DialogueGenWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    const { job_id, project, lines } = event.payload;
    try {
      const audio: DialogueShotAudio[] = [];
      for (const line of lines) {
        // One step per shot: each is independently retried + checkpointed, so a recycle or a single
        // shot's transient failure never re-bills the lines already synthesized.
        const shot = await step.do(`synth:${line.shot_id}`, SYNTH_STEP_CONFIG, async () => {
          return await synthLine(this.env, project, line);
        });
        audio.push(shot);
      }
      await writeState(this.env, job_id, { status: "done", project, audio, applied: appliedTags(audio) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeState(this.env, job_id, { status: "failed", error: msg.slice(0, 500) });
    }
  }
}

async function submit(env: Env, req: InvokeRequest<DialogueInput>): Promise<InvokeResponse<DialogueOutput>> {
  const norm = normalizeInput(req.input);
  if (!norm.ok) return { ok: false, error: "dialogue: " + norm.error };
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) return { ok: false, error: "dialogue: GATEWAY_ID not configured" };

  // No lines with anything to say: a film with no dialogue. Return an empty result immediately rather
  // than spinning up a workflow that does nothing.
  if (norm.lines.length === 0) {
    return { ok: true, output: { project: norm.project, audio: [], applied: appliedTags([]) } };
  }

  const jobId = req.context?.job_id || crypto.randomUUID();
  let workflowId: string | undefined;
  try {
    const instance = await env.DIALOGUE_WORKFLOW.create({
      params: { job_id: jobId, project: norm.project, lines: norm.lines },
    });
    workflowId = instance.id;
  } catch (e) {
    return { ok: false, error: "dialogue: could not start generation workflow: " + (e as Error).message };
  }

  try {
    await writeState(env, jobId, {
      status: "running",
      started_at: Math.floor(Date.now() / 1000),
      project: norm.project,
      workflow_id: workflowId,
    });
  } catch (e) {
    return { ok: false, error: "dialogue: could not persist run state: " + (e as Error).message };
  }

  return { ok: true, pending: true, poll: encodePoll({ job_id: jobId }) };
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<DialogueOutput>> {
  const token = decodePoll(body.poll);
  if (!token) return { ok: false, error: "dialogue: bad poll token" };
  const state = await readState(env, token.job_id);
  if (!state) return { ok: false, error: "dialogue: run state not found (expired or bad token)" };
  if (state.status === "done") return { ok: true, output: readOutput(state) };
  if (state.status === "failed") return { ok: false, error: state.error || "dialogue generation failed" };

  // running: R2 presence is the authoritative done-signal, but if the workflow errored/terminated
  // without writing a terminal state, surface that instead of pending-forever (#155).
  if (state.workflow_id) {
    try {
      const instance = await env.DIALOGUE_WORKFLOW.get(state.workflow_id);
      const ws = (await instance.status()).status;
      if (ws === "errored" || ws === "terminated") {
        return { ok: false, error: `dialogue generation workflow ${ws}` };
      }
    } catch { /* instance not found yet / transient: keep polling */ }
  }
  return { ok: true, pending: true };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<DialogueInput>;
      try {
        req = (await request.json()) as InvokeRequest<DialogueInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "dialogue") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await submit(env, req));
    }

    if (request.method === "POST" && url.pathname === "/poll") {
      let body: PollRequest;
      try {
        body = (await request.json()) as PollRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as PollResponse);
      }
      if (!body || typeof body.poll !== "string") {
        return json({ ok: false, error: "poll token required" } as PollResponse);
      }
      return json(await poll(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
