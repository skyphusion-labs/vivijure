// RunPod serverless submit / poll helpers (v0.32.0).
//
// Pure URL + payload builders + response normalizer plus a thin dispatcher
// that calls fetch. The dispatcher is not unit-tested (it would require
// mocking the fetch global); the pure helpers are tested in their own file
// and the dispatcher mirrors them. Reuses the project's "no zod / ajv at
// runtime, hand-authored types" convention from src/env.ts.
//
// The vivijure-serverless GPU worker is a RunPod queue-based endpoint. The
// job input shape is fixed in rp_handler.py:
//
//   { "project": "<name>", "bundle_key": "bundles/<name>.tar.gz",
//     "quality_tier": "draft|standard|final",
//     "render_overrides": { "keyframe": {...}, "i2v": {...}, "lora": {...} } }
//
// RunPod wraps this in `{ "input": {...} }` on submit. Polling returns an
// envelope { id, status, output?, error?, executionTime?, delayTime? }.

import type { Env } from "./env";

// Quality tier normalizer / validator (v0.156.3). The render tiers are keyframe (a
// separate keyframesOnly flag) plus three real generation tiers the pod's `for_tier`
// genuinely distinguishes: draft (4-step distilled), standard (8-step keyframe + 20-step
// EasyCache i2v, the middle), and final (30-step keyframe + 40-step MixCache i2v). v0.156.1
// wrongly dropped standard on the belief for_tier only branched draft/final; it does not
// (config.py KeyframeConfig.for_tier and I2VConfig.for_tier each branch all three), so
// standard is restored here. Returns undefined for an invalid tier the caller should hear about.
export function coerceQualityTier(t: unknown): "draft" | "standard" | "final" | undefined {
  if (t === "draft") return "draft";
  if (t === "standard") return "standard";
  if (t === "final") return "final";
  return undefined;
}

// What the planner / UI sends to /api/storyboard/render.
export interface RenderSubmitArgs {
  // Project slug; if omitted, derived from bundleKey by stripping prefix.
  project?: string;
  bundleKey: string;
  qualityTier?: "draft" | "standard" | "final";
  // The namespaced generation-override contract the clean-room backend reads
  // (config.py RenderConfig.from_request): { keyframe, i2v, lora } layered over
  // the quality-tier baseline, plus the one routing flag it reads off the raw
  // dict (finish_offloaded; keyframes-only is the `preview` action now, not a
  // flag). normalizeRenderOverrides drops anything else; the pod re-clamps. See
  // docs/render-api.md.
  renderOverrides?: Record<string, unknown>;
  // v0.40.0: skip Wan I2V + silent-MP4 assembly; produce only SDXL
  // keyframes so the user can preview shots before committing to the
  // full render. v0.160.0: this now selects the first-class
  // action="preview" on the wire (vivijure-backend Action.PREVIEW), not
  // a render_overrides.keyframes_only flag. The retired vivijure-
  // serverless read that flag and short-circuited after the SDXL pass;
  // the clean-room backend dispatches on `action` only, so the flag was
  // silently ignored and every "preview" ran a full render.
  keyframesOnly?: boolean;
  // v0.52.0: optional R2 key for an audio bed to mux onto the final
  // video. Vivijure-serverless 0.4.11+ downloads from R2_BUCKET and
  // muxes via export_film(with_audio=True). Caller (handleRenderSubmit)
  // is responsible for ensuring the key lives in R2_RENDERS (audio/
  // prefix); MiniMax-generated artifacts (out/<uuid>.<ext> in env.R2)
  // get cross-bucket-copied before this builder sees them.
  audioKey?: string;
  // v0.58.0: pretrained-LoRA passthrough. Resolved by the route from a
  // body-side {slot: cast_id} map; keys are R2 paths under loras/...
  pretrainedLoras?: Record<string, string>;
  // v0.161.0: restrict a fresh render to a subset of shots (scatter shards).
  // The backend orchestrator.plan() scopes scenes to process_shot_ids for ANY
  // action (not finalize-only); a scatter shard is a finish-offloaded render
  // over its slice. Empty / undefined => the full storyboard.
  processShotIds?: string[];
}

// What the vivijure-serverless rp_handler.py reads off the job input. Field
// names mirror the Python side (snake_case) so any change there propagates
// here without a layer of remapping.
export interface RenderJobInput {
  // v0.160.0: "preview" selects the keyframes-only render (train + SDXL
  // keyframes, no Wan i2v, no MP4) via vivijure-backend Action.PREVIEW.
  // Absent = full render (the backend's default "render"). A first-class
  // action like finalize/train_lora, not a render_overrides flag.
  action?: "preview";
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  render_overrides?: Record<string, unknown>;
  audio_key?: string;
  // v0.58.0: {slot: r2_key} of pretrained LoRAs the worker should
  // stage to skip Stage 1 training. Resolved server-side from cast
  // bindings against cast_members rows the user owns.
  pretrained_loras?: Record<string, string>;
  // v0.161.0: subset of shots for a scatter shard (mirrors finalize's field).
  // The backend plan() scopes scenes to it for the render action too.
  process_shot_ids?: string[];
}

// Per-shot SDXL keyframe regeneration. The backend scopes to the shot via
// process_shot_ids (the field its orchestrator actually reads) and writes the
// keyframe to its stable convention key keys.keyframe_key(project, shot_id) --
// the SAME key as before, so a cache-bust on the <img> src picks up the new
// pixels with no parent-job tracking needed.
export interface RegenShotArgs {
  project: string;
  bundleKey: string;
  shotId: string;
}

export interface RegenShotJobInput {
  action: "regen_shot";
  project: string;
  bundle_key: string;
  process_shot_ids: string[];
}

// v0.42.0: finalize. Runs Wan I2V over the keyframes already on the
// volume from a prior keyframes-only preview, then assembles the
// silent MP4. Same wire shape as RenderSubmitArgs (qualityTier +
// renderOverrides pass through to the GPU); only the action field
// distinguishes it from a fresh render at the dispatcher.
export interface FinalizeArgs {
  project: string;
  bundleKey: string;
  qualityTier?: "draft" | "standard" | "final";
  renderOverrides?: Record<string, unknown>;
  // v0.45.0: optional shot_id list to restrict the I2V pass + final
  // assembly to. When non-empty the GPU (vivijure-serverless 0.4.5+)
  // processes ONLY these shots and assembles the silent MP4 from a
  // temp manifest filtered to them. When undefined / empty, the GPU
  // runs the full all-scenes flow (v0.4.4 behavior). Sourced from
  // the originating row's locked_shots column in the handler.
  processShotIds?: string[];
  // v0.52.0: same audio-mux opt-in as RenderSubmitArgs.audioKey.
  audioKey?: string;
  // v0.58.0: same pretrained-LoRA passthrough as RenderSubmitArgs.
  pretrainedLoras?: Record<string, string>;
}

export interface FinalizeJobInput {
  action: "finalize";
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  render_overrides?: Record<string, unknown>;
  process_shot_ids?: string[];
  audio_key?: string;
  pretrained_loras?: Record<string, string>;
}

// Standalone LoRA training. The cast manager UI submits this; the backend
// dispatches on action=="train_lora", pulls the synthesized single-slot bundle,
// trains, and uploads the .safetensors to its OWN convention key
// (vivijure-backend keys.lora_key(project, slot)) -- the caller does not pick
// the destination.
export interface TrainLoraArgs {
  project: string;
  bundleKey: string;
  // The namespaced override contract (same as the render path). Training
  // hyperparams ride render_overrides.lora (rank / max_steps / learning_rate /
  // ...), parsed by config.py RenderConfig.from_request on the pod. Lets the
  // cast manager's "train LoRA" button iterate without an image rebuild.
  renderOverrides?: Record<string, unknown>;
}

export interface TrainLoraJobInput {
  action: "train_lora";
  project: string;
  bundle_key: string;
  render_overrides?: Record<string, unknown>;
}

// RunPod queue-based job status. The platform uses these literal strings
// across submit / poll / cancel responses. Anything else surfaces as the
// raw string in `statusRaw` so the UI can show it without us silently
// dropping a new RunPod-side state.
export type RunpodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

// Normalized response shape returned by both submit and poll. `output` /
// `error` populate per RunPod's envelope; `executionTime` and `delayTime`
// are pass-throughs (milliseconds, integers) when RunPod returns them.
export interface RunpodJobView {
  jobId: string;
  status: RunpodStatus;
  statusRaw: string;
  output?: unknown;
  error?: string;
  executionTimeMs?: number;
  delayTimeMs?: number;
}

const RUNPOD_BASE = "https://api.runpod.ai";

// Bundle key shape (mirrors bundle-assembler.assembleBundle's output):
//   bundles/<projectName>.tar.gz
// Extracts <projectName> for the rp_handler `project` field when the caller
// did not provide one explicitly. Falls back to the full bundleKey when the
// shape does not match, which lets a caller stage a custom-keyed bundle
// outside the assembler and still submit it.
export function deriveProjectFromBundleKey(bundleKey: string): string {
  const m = bundleKey.match(/^bundles\/(.+)\.tar\.gz$/);
  if (m) return m[1];
  return bundleKey;
}

export function buildSubmitPayload(args: RenderSubmitArgs): { input: RenderJobInput } {
  const project =
    args.project && args.project.trim().length > 0
      ? args.project.trim()
      : deriveProjectFromBundleKey(args.bundleKey);
  const input: RenderJobInput = {
    project,
    bundle_key: args.bundleKey,
    quality_tier: args.qualityTier ?? "final",
  };
  // v0.160.0: keyframes-only is a first-class action (Action.PREVIEW), not a
  // render_overrides.keyframes_only flag the backend has to remember to read.
  // The retired vivijure-serverless honored the flag; the clean-room backend
  // dispatches on `action` only, so the flag was a dead passenger and every
  // preview ran the full train -> keyframes -> i2v -> MP4 path.
  if (args.keyframesOnly) input.action = "preview";
  const ro = normalizeRenderOverrides(args.renderOverrides);
  if (ro) input.render_overrides = ro;
  // v0.52.0: pass through the audio bed key. Already-empty values stay
  // off the wire so 0.4.10 and earlier workers (which ignore unknown
  // fields anyway) see no diff.
  if (typeof args.audioKey === "string" && args.audioKey.length > 0) {
    input.audio_key = args.audioKey;
  }
  // v0.68.0 hot-fix: buildSubmitPayload was missing the pretrained_loras
  // pass-through that buildFinalizePayload already had. That meant the
  // v0.58.0 castLoras feature populated the route's response envelope
  // (pretrainedSlots) but the wire body never carried the actual
  // {slot: r2_key} map, so the GPU never staged the LoRAs and Stage 1
  // re-trained from scratch every time. Identified during the post-
  // 0.4.16 smoke-test investigation - we were chasing
  // _stage_pretrained_loras silently failing on the GPU when the bug
  // was that the field never reached it.
  if (args.pretrainedLoras && Object.keys(args.pretrainedLoras).length > 0) {
    input.pretrained_loras = { ...args.pretrainedLoras };
  }
  // v0.161.0: subset render for a scatter shard. Same empty-array-is-undefined
  // semantic as finalize: an empty list means "the full storyboard".
  if (Array.isArray(args.processShotIds) && args.processShotIds.length > 0) {
    input.process_shot_ids = [...args.processShotIds];
  }
  return { input };
}

// v0.42.0: pure builder for the finalize RunPod payload. Action gates
// the GPU dispatcher into the Wan-I2V-only + assemble branch (no
// fresh SDXL). Identical wire fields to buildSubmitPayload otherwise.
export function buildFinalizePayload(args: FinalizeArgs): { input: FinalizeJobInput } {
  const input: FinalizeJobInput = {
    action: "finalize",
    project: args.project,
    bundle_key: args.bundleKey,
    quality_tier: args.qualityTier ?? "final",
  };
  const ro = normalizeRenderOverrides(args.renderOverrides);
  if (ro) input.render_overrides = ro;
  // v0.45.0: only include the shot list when there is at least one
  // shot to process. An empty array stripped to undefined means "run
  // the full all-scenes flow" on the GPU side; that matches the
  // semantic the Worker route surfaces ("if nothing is locked, run
  // everything").
  if (Array.isArray(args.processShotIds) && args.processShotIds.length > 0) {
    input.process_shot_ids = [...args.processShotIds];
  }
  // v0.52.0: same audio_key passthrough as buildSubmitPayload.
  if (typeof args.audioKey === "string" && args.audioKey.length > 0) {
    input.audio_key = args.audioKey;
  }
  if (args.pretrainedLoras && Object.keys(args.pretrainedLoras).length > 0) {
    input.pretrained_loras = { ...args.pretrainedLoras };
  }
  return { input };
}

// v0.57.0: pure builder for the standalone LoRA training payload.
// Same wire shape as the render/finalize/regen actions; the GPU
// dispatcher routes on the `action` field.
export function buildTrainLoraPayload(args: TrainLoraArgs): { input: TrainLoraJobInput } {
  const input: TrainLoraJobInput = {
    action: "train_lora",
    project: args.project,
    bundle_key: args.bundleKey,
  };
  const ro = normalizeRenderOverrides(args.renderOverrides);
  if (ro) input.render_overrides = ro;
  return { input };
}

// The namespaced render-override contract the clean-room vivijure-backend reads
// (config.py RenderConfig.from_request): a { keyframe, i2v, lora } object layered
// over the quality-tier baseline, plus the one routing flag the backend reads off
// the raw overrides dict (finish_offloaded; keyframes-only is the `preview` action
// now). Anything outside these
// known sections / flags is DROPPED here -- the planner historically sent ~24
// vivijure-serverless *_overrides blocks (multi_character, wan_diffusion, ...) that
// the clean-room backend never reads, so every advanced knob was silently lost
// (the contract-completeness audit, ~/vivijure-audit-F-contract.md). Sections pass
// through verbatim (keyframe nests multi_char); the pod re-clamps every value, so a
// stray key wastes no GPU. Advanced users now send the namespaced shape directly
// (docs/render-api.md).
const _OVERRIDE_SECTIONS = ["keyframe", "i2v", "lora"] as const;
// v0.160.0: keyframes_only is no longer a wire flag -- it is the `preview` action
// now (buildSubmitPayload sets input.action). finish_offloaded stays the one
// routing flag the backend reads off the raw overrides dict.
const _OVERRIDE_FLAGS = ["finish_offloaded"] as const;

export function normalizeRenderOverrides(
  raw: unknown,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    for (const sec of _OVERRIDE_SECTIONS) {
      const v = r[sec];
      if (v && typeof v === "object" && !Array.isArray(v)) out[sec] = v;
    }
    for (const f of _OVERRIDE_FLAGS) {
      if (typeof r[f] === "boolean") out[f] = r[f];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.41.0: pure builder for the per-shot regen RunPod payload. Mirrors
// buildSubmitPayload's shape so the dispatcher can use the same fetch
// surface. The GPU side dispatches by `action` and ignores fields
// irrelevant to its branch.
export function buildRegenShotPayload(args: RegenShotArgs): { input: RegenShotJobInput } {
  const input: RegenShotJobInput = {
    action: "regen_shot",
    project: args.project,
    bundle_key: args.bundleKey,
    process_shot_ids: [args.shotId],
  };
  return { input };
}

export function buildSubmitUrl(endpointId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/run`;
}

export function buildStatusUrl(endpointId: string, jobId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/status/${jobId}`;
}

export function buildCancelUrl(endpointId: string, jobId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/cancel/${jobId}`;
}

// Validate a job id at the route boundary so a malformed id does not
// produce a RunPod 404 we have to translate back. RunPod ids are
// alphanumeric with hyphens / underscores; the cap is generous since the
// platform has not published an exact format.
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId);
}

// Map RunPod's envelope to RunpodJobView. Tolerates missing fields and
// surfaces unknown status strings via `statusRaw`. Does not throw; the
// dispatcher decides how to translate transport errors to HTTP semantics.
export function normalizeRunpodResponse(raw: unknown): RunpodJobView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const jobId = typeof r.id === "string" ? r.id : "";
  const statusRaw = typeof r.status === "string" ? r.status : "";
  if (!jobId || !statusRaw) return null;
  const knownStatuses: RunpodStatus[] = [
    "IN_QUEUE",
    "IN_PROGRESS",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
  ];
  const status: RunpodStatus = knownStatuses.includes(statusRaw as RunpodStatus)
    ? (statusRaw as RunpodStatus)
    : "IN_PROGRESS"; // best-effort: keep the UI polling on unknown states
  const view: RunpodJobView = { jobId, status, statusRaw };
  if (r.output !== undefined) view.output = r.output;
  if (typeof r.error === "string" && r.error.length > 0) view.error = r.error;
  if (typeof r.executionTime === "number") view.executionTimeMs = r.executionTime;
  if (typeof r.delayTime === "number") view.delayTimeMs = r.delayTime;
  return view;
}

// ---------- Shared RunPod transport (retry + timeout) ----------
//
// All six RunPod call-sites (the four submitters + cancel + poll) used to be
// byte-identical fetch dispatchers differing only in method/payload and an
// error prefix -- exactly the copy-paste surface the v0.68.0 pretrained_loras
// divergence slipped through (issue #13). They share ONE transport now, so a
// reliability fix lands in a single place instead of six.
//
// Reliability: a transient failure (network error, per-attempt timeout, 429,
// or 5xx) is retried with bounded, jittered exponential backoff; a terminal
// 4xx is never retried (a malformed request will not get better). Each attempt
// is bounded by AbortSignal.timeout so a hung call cannot burn the Worker
// subrequest budget. Otherwise behavior is identical to the old per-call
// dispatchers: never throws, returns the normalized view or { ok:false, ... }.

// Default tunables. Three attempts total (two retries); 250ms base backoff
// doubling per attempt with full jitter; 30s per-attempt timeout.
const RUNPOD_MAX_ATTEMPTS = 3;
const RUNPOD_BACKOFF_BASE_MS = 250;
const RUNPOD_TIMEOUT_MS = 30_000;

// Injection seam for tests: the defaults bind the Worker globals. Tests pass a
// mock fetch + a no-op sleep (and a deterministic random) so the retry/backoff
// logic runs without real network or wall-clock delay. Also lets a caller tune
// attempts/timeout per call if it ever needs to.
export interface RunpodTransportOpts {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  timeoutMs?: number;
}

export type RunpodResult =
  | { ok: true; view: RunpodJobView }
  | { ok: false; error: string; status?: number };

interface RunpodRequestSpec {
  method: "GET" | "POST";
  url: string;
  // JSON body for the POST submitters; omitted for cancel (POST, no body) and
  // poll (GET). Its presence also gates the content-type header.
  body?: string;
  // Error-message prefix, e.g. "submit", "finalize submit", "poll" -- preserves
  // the exact strings the old per-call dispatchers produced.
  label: string;
}

// 429 (rate limited) and 5xx (server error) are worth retrying; everything
// else (4xx) is the caller's fault and will not improve on retry.
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with full jitter: a random point in [0, base * 2^(n-1)]
// for 1-based attempt n. Full jitter de-synchronizes a herd of retrying
// Workers better than a fixed delay.
function backoffDelayMs(attempt: number, baseMs: number, random: () => number): number {
  const ceil = baseMs * 2 ** (attempt - 1);
  return Math.floor(random() * ceil);
}

// The one transport every RunPod call goes through. Never throws: an env-config
// miss, a network/timeout error, a non-JSON body, or an HTTP error all come
// back as { ok:false, error, status? } for the route to translate. Retries a
// transient failure up to maxAttempts with jittered backoff; returns a terminal
// 4xx immediately.
export async function runpodRequest(
  env: Env,
  spec: RunpodRequestSpec,
  opts: RunpodTransportOpts = {},
): Promise<RunpodResult> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxAttempts = opts.maxAttempts ?? RUNPOD_MAX_ATTEMPTS;
  const backoffBaseMs = opts.backoffBaseMs ?? RUNPOD_BACKOFF_BASE_MS;
  const timeoutMs = opts.timeoutMs ?? RUNPOD_TIMEOUT_MS;

  const headers: Record<string, string> = {
    authorization: `Bearer ${env.RUNPOD_API_KEY}`,
  };
  if (spec.body !== undefined) headers["content-type"] = "application/json";

  // Carried across attempts so a final transient HTTP failure surfaces the
  // status the route maps to an HTTP code (not just a bare message).
  let lastTransientError = `RunPod ${spec.label} failed`;
  let lastTransientStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp: Response;
    try {
      resp = await fetchImpl(spec.url, {
        method: spec.method,
        headers,
        body: spec.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error or a per-attempt timeout (AbortSignal fires a
      // TimeoutError) -- both transient.
      const m = err instanceof Error ? err.message : String(err);
      lastTransientError = `RunPod ${spec.label} network error: ${m}`;
      lastTransientStatus = undefined;
      if (attempt < maxAttempts) {
        await sleep(backoffDelayMs(attempt, backoffBaseMs, random));
        continue;
      }
      return { ok: false, error: lastTransientError };
    }

    // Retry a transient HTTP status (when attempts remain) without reading the
    // body. On the final attempt fall through so the real error envelope is
    // parsed and returned.
    if (!resp.ok && isTransientStatus(resp.status) && attempt < maxAttempts) {
      lastTransientError = `RunPod ${spec.label} failed: HTTP ${resp.status}`;
      lastTransientStatus = resp.status;
      await sleep(backoffDelayMs(attempt, backoffBaseMs, random));
      continue;
    }

    let raw: unknown;
    try {
      raw = await resp.json();
    } catch {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `RunPod ${spec.label} returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
        status: resp.status,
      };
    }
    if (!resp.ok) {
      const errStr =
        raw && typeof raw === "object" && "error" in raw
          ? String((raw as Record<string, unknown>).error)
          : `HTTP ${resp.status}`;
      return { ok: false, error: `RunPod ${spec.label} failed: ${errStr}`, status: resp.status };
    }
    const view = normalizeRunpodResponse(raw);
    if (!view) {
      return { ok: false, error: `RunPod ${spec.label} returned an unrecognized envelope` };
    }
    return { ok: true, view };
  }

  // Unreachable in practice (the loop always returns on its last iteration);
  // present to satisfy the compiler and as a defensive fallback.
  return { ok: false, error: lastTransientError, status: lastTransientStatus };
}

// Submit a job to the vivijure-serverless RunPod endpoint. Returns the
// normalized view or a transport error. Does not throw on HTTP 4xx / 5xx; the
// caller decides how to translate to a Worker response. Optional opts inject a
// mock transport in tests.
export function submitRenderJob(
  env: Env,
  args: RenderSubmitArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  return runpodRequest(
    env,
    {
      method: "POST",
      url: buildSubmitUrl(env.RUNPOD_ENDPOINT_ID),
      body: JSON.stringify(buildSubmitPayload(args)),
      label: "submit",
    },
    opts,
  );
}

// v0.42.0: submit a finalize job. Same transport contract as submitRenderJob.
export function submitFinalizeJob(
  env: Env,
  args: FinalizeArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  return runpodRequest(
    env,
    {
      method: "POST",
      url: buildSubmitUrl(env.RUNPOD_ENDPOINT_ID),
      body: JSON.stringify(buildFinalizePayload(args)),
      label: "finalize submit",
    },
    opts,
  );
}

// v0.41.0: submit a per-shot regen job. Hits the same /v2/<endpointId>/run;
// the GPU side dispatches by action.
export function submitRegenShotJob(
  env: Env,
  args: RegenShotArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  return runpodRequest(
    env,
    {
      method: "POST",
      url: buildSubmitUrl(env.RUNPOD_ENDPOINT_ID),
      body: JSON.stringify(buildRegenShotPayload(args)),
      label: "regen submit",
    },
    opts,
  );
}

// v0.57.0: submit a standalone LoRA training job. Differs only in the payload
// builder.
export function submitTrainLoraJob(
  env: Env,
  args: TrainLoraArgs,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  return runpodRequest(
    env,
    {
      method: "POST",
      url: buildSubmitUrl(env.RUNPOD_ENDPOINT_ID),
      body: JSON.stringify(buildTrainLoraPayload(args)),
      label: "train-lora submit",
    },
    opts,
  );
}

// Cancel one job. RunPod's cancel endpoint is POST /v2/<id>/cancel/<job>; we
// expose it under our DELETE /api/storyboard/render/<jobId> route. Calling
// cancel on a job that is already terminal (or never existed) returns RunPod's
// error envelope, which we surface verbatim.
export function cancelRenderJob(
  env: Env,
  jobId: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  return runpodRequest(
    env,
    {
      method: "POST",
      url: buildCancelUrl(env.RUNPOD_ENDPOINT_ID, jobId),
      label: "cancel",
    },
    opts,
  );
}

// Poll one job's status.
export function pollRenderJob(
  env: Env,
  jobId: string,
  opts?: RunpodTransportOpts,
): Promise<RunpodResult> {
  return runpodRequest(
    env,
    {
      method: "GET",
      url: buildStatusUrl(env.RUNPOD_ENDPOINT_ID, jobId),
      label: "poll",
    },
    opts,
  );
}

// ---------- Audio beat-sync (CPU Cloudflare Container) ----------
//
// Beat analysis runs on the AUDIO_BEAT_SYNC container (librosa), called
// synchronously from src/index.ts handleAudioAnalyze; the GPU pod
// `analyze_audio` action was reverted in vivijure-serverless 0.4.60. These
// types + parseAudioBeatPlan are shared: the request shape the route validates,
// and the snake_case plan the container emits (normalized to camelCase here).
// See docs/containers.md.

// Worker-facing request (camelCase); the route handler builds the container
// body from this. Defaults below are applied at the call site / in the
// container, not here.
export interface AudioAnalyzeRequest {
  audioKey: string;                    // required; R2 key
  clipSeconds?: number;                // default 8.0
  mode?: "beat" | "duration";          // default "beat"
  minSceneS?: number;                  // default 2.5 (beat mode)
  maxSceneS?: number;                  // default 12.0 (beat mode)
  forceShots?: number;                 // duration mode only; override slice count
}

export interface TimedScene {
  index: number;
  start: number;
  end: number;
  targetSeconds: number;
}

export interface AudioBeatPlan {
  mode: "beat" | "duration";
  audioKey: string;
  durationSeconds: number;
  bpm?: number;                        // beat mode only
  beatCount?: number;                  // beat mode only
  suggestedShots: number;
  clipSeconds: number;
  filmSeconds: number;
  remainderSeconds: number;
  timedScenes: TimedScene[];
  note: string;
}

// Pod returns snake_case; normalize to the camelCase Worker shape. Returns
// null on a shape that is not a recognizable beat plan (no valid `mode`).
export function parseAudioBeatPlan(raw: unknown): AudioBeatPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "beat" || r.mode === "duration" ? r.mode : null;
  if (!mode) return null;
  return {
    mode,
    audioKey: String(r.audio_key ?? ""),
    durationSeconds: Number(r.duration_seconds ?? 0),
    bpm: typeof r.bpm === "number" ? r.bpm : undefined,
    beatCount: typeof r.beat_count === "number" ? r.beat_count : undefined,
    suggestedShots: Number(r.suggested_shots ?? 0),
    clipSeconds: Number(r.clip_seconds ?? 0),
    filmSeconds: Number(r.film_seconds ?? 0),
    remainderSeconds: Number(r.remainder_seconds ?? 0),
    timedScenes: Array.isArray(r.timed_scenes)
      ? r.timed_scenes
          .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
          .map((s) => ({
            index: Number(s.index ?? 0),
            start: Number(s.start ?? 0),
            end: Number(s.end ?? 0),
            targetSeconds: Number(s.target_seconds ?? 0),
          }))
      : [],
    note: String(r.note ?? ""),
  };
}
