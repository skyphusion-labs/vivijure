// Module conformance harness (vivijure-module/2; /1 accepted transitionally).
//
// The "does this module honor the contract?" checker. Anyone writing a module (in this repo or
// another) runs these checks against their worker to know it will plug into the core cleanly:
//   - its GET /module.json is a valid manifest (api version, name, version, known hooks, sane
//     config_schema + provides),
//   - its POST /invoke returns a well-formed InvokeResponse,
//   - and it degrades (a bad request is DATA -- HTTP 200 with { ok:false }, never a crash).
//
// The pure checks here are dependency-free + unit-tested; the live runner (tests/conformance.live
// .test.ts) drives them against a deployed module URL. This is the conformance half of the module
// SDK: the contract is the law, and this is how a contributor proves they obey it.

import { SUPPORTED_MODULE_APIS, type HookName } from "./types";
import { validateManifest } from "./registry";

export interface ConformanceCheck {
  name: string;
  pass: boolean;
  detail: string;
}

const ok = (name: string, detail = "ok"): ConformanceCheck => ({ name, pass: true, detail });
const bad = (name: string, detail: string): ConformanceCheck => ({ name, pass: false, detail });

const FIELD_TYPES = ["int", "float", "bool", "enum", "string"];
const FIELD_SCOPES = ["render", "install"];

/** One config_schema field has a valid type and a default consistent with that type. */
function checkConfigField(key: string, f: unknown): ConformanceCheck {
  const label = "config." + key;
  if (!f || typeof f !== "object") return bad(label, "field is not an object");
  const ff = f as Record<string, unknown>;
  const t = ff.type;
  if (typeof t !== "string" || !FIELD_TYPES.includes(t)) return bad(label, "bad field type " + String(t));
  // scope is optional (omitted => "render", a per-render knob); when present it must be a known scope.
  if (ff.scope !== undefined && (typeof ff.scope !== "string" || !FIELD_SCOPES.includes(ff.scope))) {
    return bad(label, "bad field scope " + String(ff.scope));
  }
  if (t === "enum") {
    if (!Array.isArray(ff.values) || ff.values.length === 0) return bad(label, "enum needs a non-empty values[]");
    if (typeof ff.default !== "string" || !(ff.values as unknown[]).includes(ff.default)) {
      return bad(label, "enum default must be one of values");
    }
  } else if (t === "bool") {
    if (typeof ff.default !== "boolean") return bad(label, "bool default must be a boolean");
  } else if (t === "string") {
    if (typeof ff.default !== "string") return bad(label, "string default must be a string");
  } else {
    if (typeof ff.default !== "number") return bad(label, t + " default must be a number");
  }
  return ok(label, String(t));
}

/** Validate a module's manifest (the GET /module.json body) against the contract. */
export function checkManifest(raw: unknown): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  const m = validateManifest(raw);
  if (typeof m === "string") {
    checks.push(bad("manifest", m));
    return checks;
  }
  checks.push(ok("manifest", m.name + " v" + m.version));
  checks.push((SUPPORTED_MODULE_APIS as ReadonlySet<string>).has(String(m.api))
    ? ok("api-version", String(m.api))
    : bad("api-version", String(m.api) + " not in " + [...SUPPORTED_MODULE_APIS].join("/")));
  checks.push(ok("hooks", m.hooks.join(", ")));
  if (m.config_schema) {
    for (const [k, f] of Object.entries(m.config_schema)) checks.push(checkConfigField(k, f));
  }
  if (m.provides) {
    const good = m.provides.every((p) => p && typeof p.id === "string" && typeof p.label === "string");
    checks.push(good ? ok("provides", String(m.provides.length)) : bad("provides", "each provides[] needs id + label"));
  }
  return checks;
}

/** Validate that a body is a well-formed InvokeResponse: { ok:true, output } or { ok:false, error:string }. */
export function checkInvokeResponse(raw: unknown): ConformanceCheck {
  if (!raw || typeof raw !== "object") return bad("invoke-response", "not an object");
  const r = raw as Record<string, unknown>;
  if (r.ok === true) {
    if ("output" in r) return ok("invoke-response", "ok:true + output");
    if (r.pending === true && typeof r.poll === "string") return ok("invoke-response", "ok:true + pending + poll");
    return bad("invoke-response", "ok:true but neither output nor pending+poll");
  }
  if (r.ok === false) return typeof r.error === "string" ? ok("invoke-response", "ok:false + error") : bad("invoke-response", "ok:false but error is not a string");
  return bad("invoke-response", "missing boolean `ok`");
}

/** Validate that a body is a well-formed CancelResponse: { ok:true } or { ok:false, error:string }. A
 *  module whose manifest advertises `cancelable` must answer POST /cancel with this shape (a bad/unknown
 *  token is DATA -> ok:false with a reason, never a crash), so the core can trust ok:true as "the job is
 *  not running on our account" and degrade-log on ok:false (#327 / #328). */
export function checkCancelResponse(raw: unknown): ConformanceCheck {
  if (!raw || typeof raw !== "object") return bad("cancel-response", "not an object");
  const r = raw as Record<string, unknown>;
  if (r.ok === true) return ok("cancel-response", "ok:true");
  if (r.ok === false) return typeof r.error === "string" ? ok("cancel-response", "ok:false + error") : bad("cancel-response", "ok:false but error is not a string");
  return bad("cancel-response", "missing boolean `ok`");
}

// --------------------------------------------------------------------------- hook output payloads

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Per-hook output validators: the typed payload each hook must return inside `{ ok:true, output }`.
 *  Validating the envelope (checkInvokeResponse) is not enough -- a `finish` module that returns
 *  `{ ok:true, output:{} }` is well-formed at the envelope but breaks the contract. Each returns a
 *  reason string on a shape violation, or null when the payload honors the hook's contract. Only the
 *  REQUIRED fields are enforced; optional contract fields are not demanded (mirrors the runtime,
 *  which treats hint fields as optional). */
const HOOK_OUTPUT_CHECKS: Record<HookName, (o: Record<string, unknown>) => string | null> = {
  keyframe: (o) => {
    if (!isStr(o.project)) return "keyframe output needs a string project";
    if (!Array.isArray(o.keyframes)) return "keyframe output needs a keyframes[]";
    const bad = (o.keyframes as unknown[]).find(
      (k) => !isRec(k) || !isStr(k.shot_id) || !isStr(k.keyframe_key),
    );
    if (bad) return "each keyframe needs shot_id + keyframe_key";
    // Optional: trained_loras maps slot -> R2 key (string -> string).
    if (o.trained_loras !== undefined) {
      if (!isRec(o.trained_loras)) return "keyframe output trained_loras must be an object";
      if (Object.values(o.trained_loras).some((v) => !isStr(v))) {
        return "keyframe output trained_loras values must be R2 key strings";
      }
    }
    return null;
  },
  "motion.backend": (o) => {
    if (!isStr(o.shot_id)) return "motion output needs a string shot_id";
    if (!isStr(o.clip_key)) return "motion output needs a string clip_key";
    if (!isNum(o.fps)) return "motion output needs a numeric fps";
    if (!isNum(o.frames)) return "motion output needs a numeric frames";
    return null;
  },
  finish: (o) => {
    if (!isStr(o.shot_id)) return "finish output needs a string shot_id";
    if (!isStr(o.clip_key)) return "finish output needs a string clip_key";
    if (!isNum(o.out_fps)) return "finish output needs a numeric out_fps";
    if (!isNum(o.frames)) return "finish output needs a numeric frames";
    if (!isStrArr(o.applied)) return "finish output needs an applied string[]";
    return null;
  },
  score: (o) => {
    if (!isStr(o.film_key)) return "score output needs a string film_key";
    if (!isStrArr(o.applied)) return "score output needs an applied string[]";
    return null;
  },
  dialogue: (o) => {
    if (!isStr(o.project)) return "dialogue output needs a string project";
    if (!Array.isArray(o.audio)) return "dialogue output needs an audio[]";
    const badEntry = (o.audio as unknown[]).find(
      (a) => !isRec(a) || !isStr(a.shot_id) || !isStr(a.audio_key) || !isStr(a.voice_id),
    );
    if (badEntry) return "each dialogue audio needs shot_id + audio_key + voice_id";
    if (!isStrArr(o.applied)) return "dialogue output needs an applied string[]";
    return null;
  },
  speech: (o) => {
    if (!isStr(o.shot_id)) return "speech output needs a string shot_id";
    if (!isStr(o.audio_key)) return "speech output needs a string audio_key";
    if (!isStrArr(o.applied)) return "speech output needs an applied string[]";
    return null;
  },
  "plan.enhance": (o) => {
    if (!isRec(o.storyboard)) return "plan.enhance output needs a storyboard object";
    if (!Array.isArray((o.storyboard as Record<string, unknown>).scenes)) {
      return "plan.enhance storyboard needs a scenes[]";
    }
    return null;
  },
  "cast.image": (o) => {
    if (!isNum(o.cast_id)) return "cast.image output needs a numeric cast_id";
    if (!Array.isArray(o.images)) return "cast.image output needs an images[]";
    const bad = (o.images as unknown[]).find((i) => !isRec(i) || !isStr(i.key) || !isStr(i.mime));
    if (bad) return "each cast.image needs key + mime";
    if (!isStrArr(o.applied)) return "cast.image output needs an applied string[]";
    return null;
  },
  notify: (o) => {
    if (!isStrArr(o.delivered)) return "notify output needs a delivered string[]";
    return null;
  },
  master: (o) => {
    if (!isStr(o.audio_key)) return "master output needs a string audio_key";
    if (!isStrArr(o.applied)) return "master output needs an applied string[]";
    return null;
  },
  "film.finish": (o) => {
    if (!isStr(o.film_key)) return "film.finish output needs a string film_key";
    return null;
  },
};

/** Validate that a hook's success output honors its typed contract shape (the payload inside
 *  `{ ok:true, output }`). Use this AFTER checkInvokeResponse confirms the envelope: a module can be
 *  envelope-correct yet return a payload that breaks the hook contract, which the core would then
 *  hand downstream as garbage. An unknown hook name is itself a failure. */
export function checkHookOutput(hook: string, output: unknown): ConformanceCheck {
  const label = "output." + hook;
  const validator = HOOK_OUTPUT_CHECKS[hook as HookName];
  if (!validator) return bad(label, "unknown hook " + hook);
  if (!isRec(output)) return bad(label, "output is not an object");
  const reason = validator(output);
  return reason ? bad(label, reason) : ok(label);
}

/** Terminal-seam guard for a module's RESOLVED hook output. The generic transport (invokeModule /
 *  pollModule) is payload-agnostic -- it also backs dispatchChain's output->input fold and dispatchPickOne
 *  and cannot enforce a specific hook's contract without rejecting those legitimate toy payloads. The
 *  ORCHESTRATOR that consumes a hook enforces it instead: after awaitInvoke / pollModule resolves, the
 *  payload IS the real contract type. Returns a concise, traceable degrade reason (module id + hook + what
 *  broke, so it reads cleanly on the event channel) when the output violates the hook contract, or null
 *  when it honors it, so the core never threads an envelope-correct but malformed payload downstream
 *  (#345 / F5b). A legitimate soft-degrade (ok:true + passthrough + `degraded`) still carries its required
 *  contract fields, so it passes this guard untouched -- only a genuinely malformed payload is caught. */
export function hookOutputViolation(moduleId: string, hook: string, output: unknown): string | null {
  const check = checkHookOutput(hook, output);
  return check.pass ? null : `module ${moduleId} violated ${hook} contract: ${check.detail}`;
}

/** True iff every check passed. */
export function allPass(checks: ConformanceCheck[]): boolean {
  return checks.every((c) => c.pass);
}

/** The failed checks, for a concise report. */
export function failures(checks: ConformanceCheck[]): ConformanceCheck[] {
  return checks.filter((c) => !c.pass);
}

// --------------------------------------------------------------------------- live runner (install gate)

/** A Fetcher-shaped module handle: the SAME thing `MODULE_DISPATCH.get(script)` and a service binding
 *  both return. The live runner is transport-agnostic -- it drives whatever Fetcher it is handed. */
export interface ConformanceFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

// The bad-hook the degrade check submits; deliberately not a real HookName so a conformant module must
// answer HTTP 200 + { ok:false } (data, never a crash / 4xx / 5xx).
const DEGRADE_PROBE_HOOK = "not.a.real.hook";

async function fetchJson(
  fetcher: ConformanceFetcher,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown } | { status: number; body: null; err: string }> {
  try {
    const res = await fetcher.fetch("https://module" + path, init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (e) {
      return { status: res.status, body: null, err: `body not JSON: ${(e as Error).message}` };
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, err: `unreachable: ${(e as Error).message}` };
  }
}

/** Run the conformance suite against a LIVE module Fetcher at install time (docs/module-dispatch.md 4.3).
 *  Drives the module over the SAME transport it will run on (a dispatched user Worker, or a service
 *  binding), asserting: a valid manifest at GET /module.json; a well-formed InvokeResponse ENVELOPE for
 *  its first hook; and that a bad-hook request DEGRADES (HTTP 200 + { ok:false }, never a crash). The
 *  install route INSERTs the registry row ONLY when every check passes; a resident-but-failing module is
 *  never installed and never dispatched. Total: a network failure becomes a failed check, never a throw.
 *
 *  SCOPE (be honest about what this gate proves): it validates the CONTRACT WIRING -- manifest shape,
 *  the invoke/degrade envelope, and, for a SYNCHRONOUS hook (a module that answers `ok:true + output`
 *  right away, e.g. plan.enhance), the typed hook OUTPUT via checkHookOutput. It deliberately does NOT
 *  validate the typed output of an ASYNC hook (motion.backend / keyframe / finish / speech / master),
 *  which answers `ok:true + pending + poll`: proving that output shape would require POLLING THE JOB TO
 *  COMPLETION, i.e. triggering the module's real (often GPU) work just to install it -- an unacceptable
 *  cost + side effect for an install gate. Typed-output conformance for async hooks is therefore the
 *  MODULE'S OWN responsibility, proven by its conformance CI (checkHookOutput over a controlled
 *  completion in tests/conformance.live.test.ts / `npm run conformance`), not by this install-time gate.
 *  The gate blocks a mis-wired or non-degrading module; it does not (and cannot cheaply) re-run an async
 *  module's per-shot output contract. */
export async function runLiveConformance(fetcher: ConformanceFetcher): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];

  // 1) manifest
  const man = await fetchJson(fetcher, "/module.json");
  if ("err" in man || man.status !== 200) {
    const why = "err" in man ? man.err : `GET /module.json -> ${man.status}`;
    checks.push(bad("manifest", why));
    return checks; // no manifest -> nothing else can be meaningfully checked
  }
  const manifestChecks = checkManifest(man.body);
  checks.push(...manifestChecks);
  const manifest = validateManifest(man.body);
  if (typeof manifest === "string") return checks; // checkManifest already recorded the failure

  // 2) first-hook invoke: well-formed envelope (+ typed payload when synchronous)
  const hook = manifest.hooks[0];
  const probe = await fetchJson(fetcher, "/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook,
      // A plan.enhance-shaped input; for other hooks the module simply degrades (ok:false), which is
      // still a conformant envelope. The gate validates the CONTRACT WIRING, not a real render.
      input: { storyboard: { scenes: [{ prompt: "a quiet street at night" }] } },
      config: {},
      context: { project: "conformance", job_id: "install-gate" },
    }),
  });
  if ("err" in probe || probe.status !== 200) {
    const why = "err" in probe ? probe.err : `POST /invoke -> ${probe.status}`;
    checks.push(bad("invoke", why));
  } else {
    const env = checkInvokeResponse(probe.body);
    checks.push(env);
    const b = probe.body as { ok?: boolean; pending?: boolean; output?: unknown };
    // Typed output is validated ONLY for a synchronous answer. An async module returns pending here, and
    // proving its output shape would mean polling its real (GPU) job to completion at install time --
    // see the SCOPE note above; async output conformance is the module's own CI, not this gate.
    if (env.pass && b.ok === true && b.pending !== true) {
      checks.push(checkHookOutput(hook, b.output));
    }
  }

  // 3) degrade: a bad hook is DATA (HTTP 200 + ok:false), never a crash
  const deg = await fetchJson(fetcher, "/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook: DEGRADE_PROBE_HOOK, input: {}, config: {}, context: { project: "conformance", job_id: "install-gate-degrade" } }),
  });
  if ("err" in deg || deg.status !== 200) {
    const why = "err" in deg ? deg.err : `POST /invoke (bad hook) -> ${deg.status}`;
    checks.push(bad("degrade", why));
  } else {
    const shape = checkInvokeResponse(deg.body);
    const okFalse = !!deg.body && typeof deg.body === "object" && (deg.body as { ok?: unknown }).ok === false;
    checks.push(shape.pass && okFalse ? ok("degrade", "bad hook -> 200 + ok:false") : bad("degrade", "bad hook must return 200 + ok:false"));
  }

  return checks;
}
