// Pure Wan 2.2 (LoRA) mapping/parsing: build the RunPod request body, parse custom LoRA config, parse
// the result video URL + cost, and encode/decode the async poll token. No I/O here, so it unit-tests
// without the runtime or spend. The video-URL parse, poll token, and RunPod-GC helpers are shared,
// vendored per-module so the module stays independent (matches the alibaba-wan / seedance reference).
//
// This is the alibaba-wan pattern (Wan I2V on RunPod) plus the distinctive trait of the
// `wan-2-2-t2v-720-lora` managed endpoint: the operator can bring CUSTOM LoRAs (high-noise + low-noise
// passes), each an { path, scale } where `path` is a URL / path to the LoRA file (HuggingFace URLs
// supported). Empty LoRA lists = plain Wan 2.2 i2v.

import type { MotionBackendInput } from "./contract";

// One LoRA the operator brings: `path` is a URL/path to the adapter file (HF URLs supported), `scale`
// its strength. This is the shape the endpoint expects inside high_noise_loras / low_noise_loras.
export interface LoraRef {
  path: string;
  scale: number;
}

// Duration snap. The wan-2-2-t2v-720-lora endpoint accepts ONLY a discrete set of durations (seconds):
// it 400s on anything else ("invalid request body: field \"duration\" must be one of [5, 8]"). The
// contract hands a per-shot `seconds`; we SNAP it to the nearest allowed value (<=6 -> 5, else 8) so the
// endpoint never rejects the job. The snap is RECORDED at the call site (submit), never a silent change
// to the user's timing (#279). Pricing scales with duration (~$0.35 for 5s, ~$0.56 for 8s).
export const ALLOWED_DURATIONS = [5, 8] as const;
export function clampDuration(seconds: number): number {
  const n = Math.round(Number(seconds) || 5);
  return n <= 6 ? 5 : 8; // snap to the endpoint's allowed set {5, 8}
}

// Default LoRA strength when an entry omits `scale`. 1.0 = the adapter's trained strength.
const DEFAULT_LORA_SCALE = 1;
// Cap how many LoRAs we forward per pass: a sane guard against a runaway config; the endpoint is the
// real authority, this just keeps an obviously-malformed list from being shipped wholesale.
const MAX_LORAS_PER_PASS = 8;

/** Pure: parse an operator LoRA list into validated { path, scale } entries.
 *
 *  The module config carries each LoRA list as a JSON STRING (the contract's ConfigField has no array
 *  type -- int/float/bool/enum/string only -- so a structured list rides as a string the module
 *  parses). Be liberal: accept a JSON string OR an already-parsed array. Drop any entry without a
 *  non-empty string `path`; coerce `scale` to a finite number, defaulting to 1.0. Anything unparseable
 *  yields [] (plain Wan i2v), never a throw -- a bad LoRA field must not crash the shot. */
export function parseLoras(raw: unknown): LoraRef[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "" || s === "[]") return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: LoraRef[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path.trim() : "";
    if (!path) continue;
    const scaleRaw = Number(o.scale);
    const scale = Number.isFinite(scaleRaw) ? scaleRaw : DEFAULT_LORA_SCALE;
    out.push({ path, scale });
    if (out.length >= MAX_LORAS_PER_PASS) break;
  }
  return out;
}

/** The RunPod /run body for `wan-2-2-t2v-720-lora`, mapped from the hook input + the clamped module
 *  config. Only documented fields are sent. LoRA arrays are included ONLY when non-empty (empty =
 *  plain Wan i2v); seed defaults to -1 (random); the safety checker defaults on. */
export function buildWanLoraBody(input: MotionBackendInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  const high = parseLoras(cfg.high_noise_loras);
  const low = parseLoras(cfg.low_noise_loras);
  const seedRaw = Number(cfg.seed);
  const seed = Number.isFinite(seedRaw) ? Math.round(seedRaw) : -1;
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    image: input.keyframe_url, // THE KEYFRAME: the presigned start-image URL the core hands us
    duration: clampDuration(input.seconds),
    seed,
    enable_safety_checker: cfg.enable_safety_checker !== false, // default true; only an explicit false disables
  };
  if (high.length) body.high_noise_loras = high;
  if (low.length) body.low_noise_loras = low;
  return { input: body };
}

/** RunPod video workers vary in output shape; find the first plausible video URL (prefers an .mp4). */
export function extractVideoUrl(output: unknown): string | null {
  let firstHttp: string | null = null;
  const visit = (v: unknown): string | null => {
    if (typeof v === "string") {
      if (/^https?:\/\/\S+\.mp4(\?|$)/i.test(v)) return v;
      if (firstHttp === null && /^https?:\/\//i.test(v)) firstHttp = v;
      return null;
    }
    if (Array.isArray(v)) {
      for (const x of v) { const hit = visit(x); if (hit) return hit; }
      return null;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["video_url", "videoUrl", "url", "video", "output", "result", "assets"]) {
        if (k in o) { const hit = visit(o[k]); if (hit) return hit; }
      }
      for (const x of Object.values(o)) { const hit = visit(x); if (hit) return hit; }
    }
    return null;
  };
  return visit(output) ?? firstHttp;
}

/** Pure: pull the reported USD cost from the endpoint output, if present (for observability logging).
 *  The contract's MotionBackendOutput carries no cost field, so this is logged, not returned. */
export function extractCost(output: unknown): number | null {
  if (output && typeof output === "object") {
    const c = Number((output as Record<string, unknown>).cost);
    if (Number.isFinite(c)) return c;
  }
  return null;
}

/** The R2 key the rendered clip is stored under, per shot. */
export function clipKey(project: string, shotId: string): string {
  const safe = (s: string) => (s || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `renders/${safe(project)}/clips/${safe(shotId)}_wanlora.mp4`;
}

// --- async poll token --------------------------------------------------------------------------

// Everything /poll needs to finalize a job: the RunPod job id + where the clip belongs + its length.
// The token is opaque (base64 JSON) so the caller just round-trips it from /invoke to /poll.
// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141).
export interface PollState {
  jobId: string;
  project: string;
  shotId: string;
  seconds: number;
  submittedAt?: number;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.project === "string" && typeof o.shotId === "string") {
      return {
        jobId: o.jobId, project: o.project, shotId: o.shotId, seconds: Number(o.seconds) || 5,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// How long after submit a RunPod "job not found" is treated as a propagation race vs a real GC. Mirrors
// the control plane's PHANTOM_GRACE_SECONDS (150s) so a momentary post-submit 404 never false-fails.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did RunPod report this job as gone? A GC'd job returns HTTP 404 with a body like
 *  {"status":404,"title":"Not Found",...} where `status` is the NUMBER 404, not a run state. (#141)
 *  This module DOWNLOADS the provider video then writes R2 itself only on COMPLETED, so a never-
 *  completed job has no recoverable artifact -- the only correct behavior past grace is to FAIL. */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: "gone-failed" past the grace window (or a legacy token); "gone-grace" inside it. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

// Cold-start cap: on a VIRGIN host the image pull (10-20GB) can outlive the normal #141 grace window
// while /status 404s, so the first-ever job on a fresh endpoint false-failed ("GC'd or never ran")
// and only the warm retry succeeded. When the endpoint's /health shows no worker has EVER come up,
// the 404 means "still initializing", not "dropped" -- keep polling up to this cap instead.
export const RUNPOD_COLD_GRACE_MS = 900_000; // 15 min; the film pipeline's 90-min deadline still bounds it

/** Pure: has NO worker ever come up on this endpoint (ready/idle/running all 0) while one is still
 *  coming (initializing/throttled > 0)? That is the virgin-host image pull. A dead endpoint (nothing
 *  up, nothing coming) returns false so a gone job still fails instead of pending forever. */
export function workersStillCold(health: unknown): boolean {
  if (!health || typeof health !== "object") return false;
  const w = (health as Record<string, unknown>).workers;
  if (!w || typeof w !== "object") return false;
  const n = (k: string): number => {
    const v = (w as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const up = n("ready") + n("idle") + n("running");
  const coming = n("initializing") + n("throttled");
  return up === 0 && coming > 0;
}

/** Pure: did the backend report a TERMINAL error inside `output` while the RunPod envelope status
 *  never advanced? (F17: a handler error path that returns instead of raising leaves the job
 *  IN_PROGRESS forever -- billing the worker -- while output already carries
 *  {status:"error", error:{stage, message}}.) Returns the human error string, or null when the
 *  output is a normal progress snapshot. */
export function terminalErrorInOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" && e.message.length > 0
      ? e.message
      : JSON.stringify(e).slice(0, 200);
    const stage = typeof e.stage === "string" && e.stage.length > 0 ? " (stage: " + e.stage + ")" : "";
    return msg + stage;
  }
  if (typeof err === "string" && err.length > 0) return err;
  if (o.status === "error") return "backend reported status=error with no error detail";
  return null;
}
