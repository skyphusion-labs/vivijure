// The module registry: the core's index of what is plugged in.
//
// On demand, the core scans its env for module service bindings (named `MODULE_*`), reads each
// module's manifest (GET /module.json), and indexes them by hook. That index drives two things: the
// pipeline (which module answers a hook) and the frontend (GET /api/modules, so the studio UI renders
// only what is installed). A bare deploy with no modules bound is a valid, lean studio.
//
// Everything here is best-effort and total: a module that fails to respond, or serves a malformed or
// wrong-version manifest, is dropped from the registry with a console warning, never crashing the
// core. The pure helpers (validation, indexing, the response shape) are unit-tested without bindings.

import {
  MODULE_API,
  SUPPORTED_MODULE_APIS,
  HOOK_NAMES,
  HOOK_BLURBS,
  HOOK_CARDINALITY,
  type ConfigSchema,
  type HookCatalogEntry,
  type HookName,
  type InvokeContext,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type CancelRequest,
  type CancelResponse,
  type ModuleManifest,
  type ModulesResponse,
  type PublicModule,
  type RegisteredModule,
  type RenderConfigProjection,
} from "./types";

/** A service-binding-shaped value: anything we can `.fetch()` like a Worker. */
interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

function isFetcher(v: unknown): v is FetcherLike {
  return !!v && typeof (v as { fetch?: unknown }).fetch === "function";
}

/** A Workers-for-Platforms dispatch namespace, shaped minimally so the registry stays dependency-free
 *  (no import of Env / @cloudflare/workers-types). `.get(script)` returns a Fetcher for one resident
 *  user Worker. Distinct from a service binding: a namespace has `.get()`, a binding has `.fetch()`. */
interface DispatchLike {
  get(scriptName: string): FetcherLike;
}

function isDispatch(v: unknown): v is DispatchLike {
  return !!v && typeof (v as { get?: unknown }).get === "function";
}

/** The env key naming the WfP dispatch-namespace binding. Excluded from the `MODULE_*` service scan
 *  (it is a DispatchNamespace, NOT a module Fetcher): the `isFetcher` guard already rejects it by shape
 *  (a namespace has `.get()`, not `.fetch()`), but the exclusion is made EXPLICIT so a future
 *  workers-types change can never accidentally enroll the namespace as a module (docs/module-dispatch
 *  section 6.3). */
export const DISPATCH_BINDING = "MODULE_DISPATCH";

/** The reserved prefix marking a `RegisteredModule.binding` ref as a WfP dispatch script rather than a
 *  service binding: `dispatch:<script-name>`. It cannot collide with a real `MODULE_*` env key, so the
 *  one `binding` string carries the module's transport through job state and resolveFetcher parses it. */
export const DISPATCH_REF_PREFIX = "dispatch:";

/** Build a dispatch binding ref from a namespace script name. */
export function dispatchRef(scriptName: string): string {
  return DISPATCH_REF_PREFIX + scriptName;
}

/** Resolve a module `binding` ref to a Fetcher, transport-aware. A `dispatch:<script>` ref resolves
 *  through the namespace binding (`MODULE_DISPATCH.get(script)`, which THROWS if the script is absent --
 *  guarded so a missing script becomes an honest null / ok:false degrade, never a core crash); any other
 *  ref is a service-binding env key. Returns null when the transport is unavailable (no namespace bound,
 *  script absent, or binding unbound), which every caller already treats as "module not reachable". This
 *  is the SINGLE resolution primitive: everything after "got a Fetcher" (the invoke/poll/cancel envelope)
 *  is identical for both transports (docs/module-dispatch.md 3.2). */
export function resolveFetcher(env: Record<string, unknown>, binding: string): FetcherLike | null {
  if (binding.startsWith(DISPATCH_REF_PREFIX)) {
    const ns = env[DISPATCH_BINDING];
    if (!isDispatch(ns)) return null;
    try {
      return ns.get(binding.slice(DISPATCH_REF_PREFIX.length));
    } catch {
      return null;
    }
  }
  const v = env[binding];
  return isFetcher(v) ? v : null;
}

/** The env keys that name module SERVICE bindings. Convention: `MODULE_<NAME>` service bindings;
 *  the dispatch-namespace binding is explicitly skipped (it is not a module, it is the transport to N). */
export function moduleBindingNames(env: Record<string, unknown>): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith("MODULE_") && k !== DISPATCH_BINDING && isFetcher(env[k]))
    .sort();
}

// --------------------------------------------------------------------------- manifest validation

/** Validate a parsed manifest enough to trust it in the registry. Returns the typed manifest or a
 *  reason string. We check the contract version, a name, and that every declared hook is known. */
export function validateManifest(raw: unknown): ModuleManifest | string {
  if (!raw || typeof raw !== "object") return "manifest is not an object";
  const m = raw as Record<string, unknown>;
  if (!(SUPPORTED_MODULE_APIS as ReadonlySet<string>).has(String(m.api)))
    return `unsupported api ${String(m.api)} (core speaks ${MODULE_API}, accepts ${[...SUPPORTED_MODULE_APIS].join(", ")})`;
  if (typeof m.name !== "string" || !m.name) return "manifest missing name";
  if (typeof m.version !== "string" || !m.version) return "manifest missing version";
  if (!Array.isArray(m.hooks) || m.hooks.length === 0) return "manifest declares no hooks";
  const known = new Set<string>(HOOK_NAMES);
  const bad = (m.hooks as unknown[]).filter((h) => !known.has(h as string));
  if (bad.length) return `manifest declares unknown hooks: ${bad.join(", ")}`;
  // finish_artifacts is OPTIONAL, but present-and-malformed is a rejected manifest (a wrong shape
  // here would silently disable -- or worse, misdirect -- the R2-authoritative finish recovery).
  if (m.finish_artifacts !== undefined) {
    const fa = m.finish_artifacts as Record<string, unknown>;
    if (!fa || typeof fa !== "object") return "finish_artifacts is not an object";
    const ok = fa.output_key as Record<string, unknown> | undefined;
    if (!ok || typeof ok !== "object") return "finish_artifacts.output_key missing";
    if (ok.kind === "shot_named") {
      if (typeof ok.filename !== "string" || !ok.filename) return "finish_artifacts.output_key.filename missing";
    } else if (ok.kind === "append_suffix") {
      if (typeof ok.suffix !== "string" || !ok.suffix) return "finish_artifacts.output_key.suffix missing";
    } else {
      return `finish_artifacts.output_key.kind ${JSON.stringify(ok.kind)} unknown (shot_named | append_suffix)`;
    }
    if (fa.applied !== undefined) {
      if (!Array.isArray(fa.applied)) return "finish_artifacts.applied is not an array";
      for (const r of fa.applied as unknown[]) {
        const rule = r as Record<string, unknown>;
        if (!rule || typeof rule !== "object" || typeof rule.tag !== "string" || !rule.tag)
          return "finish_artifacts.applied rule missing tag";
        if (rule.when !== undefined) {
          const w = rule.when as Record<string, unknown>;
          if (!w || typeof w !== "object" || typeof w.knob !== "string" || !w.knob || w.equals === undefined)
            return "finish_artifacts.applied rule has a malformed when clause";
        }
      }
    }
  }
  // keyframe_label is OPTIONAL, but present-and-malformed is a rejected manifest (same doctrine as
  // finish_artifacts: a wrong shape would ship a blank/garbage token into the UI projection).
  if (m.keyframe_label !== undefined) {
    if (typeof m.keyframe_label !== "string" || !m.keyframe_label.trim())
      return "keyframe_label must be a non-empty string";
  }
  return m as unknown as ModuleManifest;
}

// --------------------------------------------------------------------------- config validation

/** Clamp + coerce a user's config values against a module's declared schema. Unknown keys are
 *  dropped; missing keys fall back to the field default; numbers are clamped to [min, max]; an
 *  out-of-set enum falls back to its default. The result is exactly what the core sends a module as
 *  `config`, so a module never has to defend against junk. (Mirrors the backend's forgiving
 *  config parsing: clamp, do not throw.) */
export function validateConfig(
  schema: ConfigSchema | undefined,
  user: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!schema) return out;
  const u = user ?? {};
  for (const [key, field] of Object.entries(schema)) {
    const v = u[key];
    switch (field.type) {
      case "int":
      case "float": {
        let n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) n = field.default;
        if (typeof field.min === "number") n = Math.max(field.min, n);
        if (typeof field.max === "number") n = Math.min(field.max, n);
        out[key] = field.type === "int" ? Math.round(n) : n;
        break;
      }
      case "bool":
        out[key] = typeof v === "boolean" ? v : field.default;
        break;
      case "enum":
        out[key] = field.values.includes(v as string) ? v : field.default;
        break;
      case "string":
        out[key] = typeof v === "string" ? v : field.default;
        break;
    }
  }
  return out;
}

// --------------------------------------------------------------------------- indexing + response

/** Index modules by the hook they serve, preserving `ui.order` (then name) within each hook so a
 *  chain hook folds in a stable, declared order. */
export function indexByHook(modules: RegisteredModule[]): Partial<Record<HookName, string[]>> {
  const byHook: Partial<Record<HookName, string[]>> = {};
  const ordered = [...modules].sort(
    (a, b) => (a.ui?.order ?? 100) - (b.ui?.order ?? 100) || a.name.localeCompare(b.name),
  );
  for (const m of ordered) {
    for (const hook of m.hooks) {
      (byHook[hook] ??= []).push(m.name);
    }
  }
  return byHook;
}

/** The static hook catalog (every hook + its blurb + cardinality), independent of what is
 *  installed, so the frontend renders the pipeline panel as a projection of the contract. */
export function hookCatalog(): HookCatalogEntry[] {
  return HOOK_NAMES.map((name) => ({
    name,
    blurb: HOOK_BLURBS[name],
    cardinality: HOOK_CARDINALITY[name],
  }));
}

/** Strip a registered module down to its PUBLIC view: the manifest, minus the internal `binding` ref.
 *  The /api/modules route is unauthenticated, so what serves a hook (a service binding OR a namespace
 *  script -- internal module-host topology) must not cross the wire; the frontend renders from the
 *  manifest alone (#18). */
function toPublic({ binding: _binding, ...manifest }: RegisteredModule): PublicModule {
  return manifest;
}

/** The GET /api/modules payload the frontend renders itself from. Modules are exposed as the PUBLIC
 *  view (no `binding`); the hook index keeps using names, so dispatch (which needs the binding) stays
 *  core-side off the registered modules, never the wire payload. */
/** Build the GET /api/modules projection. `render` (core-owned render config, e.g. quality tiers) is
 *  passed in by the route rather than imported here: it lives in render-module-config, which imports
 *  the registry, so taking it as a param keeps this module free of that back-edge. */
export function modulesResponse(
  modules: RegisteredModule[],
  render: RenderConfigProjection,
  host?: { dispatch: boolean },
): ModulesResponse {
  return {
    api: MODULE_API,
    modules: modules.map(toPublic),
    hooks: indexByHook(modules),
    catalog: hookCatalog(),
    render,
    ...(host ? { host } : {}),
  };
}

// --------------------------------------------------------------------------- discovery (I/O)

/** Fetch + validate the manifest from one bound module worker. Returns the registered module or
 *  null (logged) on any failure, so one bad module never poisons the registry. */
// One slow/hung module must not stall discovery for all the others (they are read together under
// Promise.all). Bound the manifest read with a per-call timeout; on timeout the fetch aborts, the
// catch below logs it, and the module is simply skipped (issue #17).
const MANIFEST_READ_TIMEOUT_MS = 3000;
// A dropped module silently SHORTENS a chain hook (e.g. the finish chain), changing the output with
// no error -- a talking film's shot lost its lip-sync because a transient manifest blip dropped the
// module at enterFinishPhase time. So retry a TRANSIENT failure (5xx / timeout / network throw) a few
// times before giving up; a real error (4xx, invalid manifest) is NOT retried -- that module is
// genuinely broken and is dropped as before (issue #17). Mirrors the D1 self-heal philosophy.
const MANIFEST_READ_ATTEMPTS = 3;
const MANIFEST_RETRY_BASE_MS = 120;

/** A non-2xx manifest status worth retrying (the module is up but momentarily unhappy / warming). A
 *  4xx is a real, stable error (bad route / auth) -- do not retry. */
function isRetryableManifestStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export async function readManifest(
  binding: string,
  fetcher: FetcherLike,
): Promise<RegisteredModule | null> {
  let lastReason = "";
  for (let attempt = 0; attempt < MANIFEST_READ_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === MANIFEST_READ_ATTEMPTS - 1;
    try {
      const res = await fetcher.fetch("https://module/module.json", {
        signal: AbortSignal.timeout(MANIFEST_READ_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Transient (5xx/timeout-class) -> retry so a blip never silently drops the module from a
        // chain. A 4xx is stable -> skip now.
        if (isRetryableManifestStatus(res.status) && !lastAttempt) {
          lastReason = `GET /module.json -> ${res.status}`;
          await new Promise((r) => setTimeout(r, MANIFEST_RETRY_BASE_MS * (attempt + 1)));
          continue;
        }
        console.warn(`module ${binding}: GET /module.json -> ${res.status}; skipping`);
        return null;
      }
      const parsed = validateManifest(await readModuleJson(res));
      if (typeof parsed === "string") {
        console.warn(`module ${binding}: invalid manifest (${parsed}); skipping`); // real error: don't retry
        return null;
      }
      return { ...parsed, binding };
    } catch (e) {
      // fetch threw (timeout / network) -> transient: retry unless this was the last attempt.
      lastReason = (e as Error).message;
      if (!lastAttempt) {
        await new Promise((r) => setTimeout(r, MANIFEST_RETRY_BASE_MS * (attempt + 1)));
        continue;
      }
    }
  }
  console.warn(`module ${binding}: unreachable after ${MANIFEST_READ_ATTEMPTS} attempts (${lastReason}); skipping`);
  return null;
}

// Per-isolate discovery cache for the /api/modules route (issue #17 follow-up). That route re-ran N
// service-binding manifest fetches on EVERY request; with a short TTL it serves a cached registry
// instead. Module bindings are static per deploy and a module only changes its manifest on its own
// redeploy, so 60s of staleness is fine. This holds only module metadata (identical for every user),
// so the module-scoped cache leaks nothing cross-request. OPT-IN: only the route passes a TTL; every
// dispatch-path caller passes nothing and keeps the old always-fresh behavior.
let discoveryCache: { modules: RegisteredModule[]; expiresAt: number } | null = null;

/** Test-only: drop the per-isolate discovery cache so a suite starts clean. */
export function _resetModuleDiscoveryCache(): void {
  discoveryCache = null;
}

/** A D1 database, shaped minimally so the registry stays dependency-free (no import of Env). Only the
 *  read the dispatch-discovery needs is declared. */
interface D1Like {
  prepare(query: string): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> };
}

interface InstalledModuleRow {
  name: string;
  script_name: string;
  manifest_json: string;
  api: string;
}

/** Discover the modules installed via Workers-for-Platforms dynamic dispatch: read the
 *  `installed_modules` D1 table (enabled rows), reconstruct each `RegisteredModule` from its stored,
 *  conformance-checked manifest, and tag it with its `dispatch` descriptor (the namespace analogue of
 *  `binding`). Gated on `env.MODULE_DISPATCH` (the namespace binding) being present: a deploy WITHOUT
 *  WfP short-circuits here and never touches D1, so non-WfP / self-host deploys pay ZERO overhead and
 *  behave exactly as before. Best-effort + total, like the service-binding scan: a D1 error or a
 *  drifted manifest row is logged and dropped, never crashes discovery. (docs/module-dispatch.md 3.1/3.4) */
export async function discoverDispatchModules(env: Record<string, unknown>): Promise<RegisteredModule[]> {
  const ns = env[DISPATCH_BINDING];
  if (!isDispatch(ns)) return []; // no WfP namespace bound -> nothing to discover, no D1 read
  const db = env.DB;
  if (!db || typeof (db as D1Like).prepare !== "function") return [];
  let rows: InstalledModuleRow[];
  try {
    const res = await (db as D1Like)
      .prepare("SELECT name, script_name, manifest_json, api FROM installed_modules WHERE enabled = 1")
      .all<InstalledModuleRow>();
    rows = res.results ?? [];
  } catch (e) {
    console.warn(`dispatch discovery: installed_modules read failed (${(e as Error).message}); skipping`);
    return [];
  }
  const out: RegisteredModule[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.manifest_json);
    } catch {
      console.warn(`dispatch module ${row.name}: manifest_json is not valid JSON; skipping`);
      continue;
    }
    const parsed = validateManifest(raw);
    if (typeof parsed === "string") {
      console.warn(`dispatch module ${row.name}: stored manifest invalid (${parsed}); skipping`);
      continue;
    }
    out.push({ ...parsed, binding: dispatchRef(row.script_name) });
  }
  return out;
}

/** Merge the service-binding registry with the dispatch registry into one list the pipeline +
 *  /api/modules consume. On a NAME collision (a module mid-migration that is both service-bound AND
 *  installed as a namespace upload -- allowed transiently, section 6.3), the service binding WINS (it
 *  is the deliberate, in-tree, deploy-tested one) and the dispatch duplicate is dropped with a warning.
 *  Deterministic + order-preserving: service entries first, then any dispatch-only entries. */
export function mergeRegistries(
  service: RegisteredModule[],
  dispatch: RegisteredModule[],
): RegisteredModule[] {
  const byName = new Map<string, RegisteredModule>();
  for (const m of service) byName.set(m.name, m);
  for (const m of dispatch) {
    if (byName.has(m.name)) {
      console.warn(`module ${m.name}: installed via dispatch AND service-bound; service binding wins (migration overlap)`);
      continue;
    }
    byName.set(m.name, m);
  }
  return [...byName.values()];
}

/** Discover every installed module: the `MODULE_*` service-binding scan (read each binding's manifest
 *  in parallel) MERGED with the WfP dispatch modules from D1 (discoverDispatchModules, a no-op unless
 *  MODULE_DISPATCH is bound). Both kinds land in ONE registry, agnostic to how each later resolves to a
 *  Fetcher. With `opts.cacheTtlMs > 0` the result is cached per-isolate for that many ms (the
 *  /api/modules route uses this); without it discovery runs fresh (the pipeline paths). `opts.nowMs` is
 *  injectable for tests. */
export async function discoverModules(
  env: Record<string, unknown>,
  opts: { cacheTtlMs?: number; nowMs?: number } = {},
): Promise<RegisteredModule[]> {
  const ttl = opts.cacheTtlMs ?? 0;
  const now = opts.nowMs ?? Date.now();
  if (ttl > 0 && discoveryCache && now < discoveryCache.expiresAt) {
    return discoveryCache.modules;
  }
  const names = moduleBindingNames(env);
  const [read, dispatch] = await Promise.all([
    Promise.all(names.map((n) => readManifest(n, env[n] as FetcherLike))),
    discoverDispatchModules(env),
  ]);
  const service = read.filter((m): m is RegisteredModule => m !== null);
  const modules = mergeRegistries(service, dispatch);
  if (ttl > 0) discoveryCache = { modules, expiresAt: now + ttl };
  return modules;
}

/** Look up the module binding that should answer a `pick_one` hook for a given choice (by module
 *  name), or the first registered for that hook when no choice is given. Returns null if none. */
export function resolvePickOne(
  modules: RegisteredModule[],
  hook: HookName,
  choice?: string,
): RegisteredModule | null {
  const serving = modules.filter((m) => m.hooks.includes(hook));
  if (serving.length === 0) return null;
  if (choice) return serving.find((m) => m.name === choice) ?? null;
  return serving[0];
}

// --------------------------------------------------------------------------- dispatch (I/O)

/** The modules serving a hook, in the same `ui.order` then name order `indexByHook` uses, so a
 *  chain folds in the declared order and a pick_one default is the first. */
export function servingForHook(modules: RegisteredModule[], hook: HookName): RegisteredModule[] {
  return [...modules]
    .filter((m) => m.hooks.includes(hook))
    .sort((a, b) => (a.ui?.order ?? 100) - (b.ui?.order ?? 100) || a.name.localeCompare(b.name));
}

// ---- locality classification (#379 ui.locality, wired by the S6 debt sprint) -------------------
// The core classifies motion.backend modules by their DECLARED ui.locality, never by module name.
// "cloud" = pay-per-render provider; "byo" = the operator's own RunPod endpoint + keys; "local" =
// a homelab card. An UNDECLARED locality counts as cloud: that preserves the pre-locality behavior
// (anything that was not the gpu door was offered as a cloud model), and it is the safe default
// for a third-party module that never heard of the field.

/** Motion modules the cloud selectors may offer: declared (or defaulted) locality "cloud". */
export function cloudMotionModules(modules: RegisteredModule[]): RegisteredModule[] {
  return servingForHook(modules, "motion.backend").filter((m) => (m.ui?.locality ?? "cloud") === "cloud");
}

/** Motion modules that render on hardware the operator controls (byo or local): the "gpu" lane of
 *  hybrid renders and the gpu bucket of progress counters. */
export function gpuDoorMotionModules(modules: RegisteredModule[]): RegisteredModule[] {
  const l = (m: RegisteredModule) => m.ui?.locality;
  return servingForHook(modules, "motion.backend").filter((m) => l(m) === "byo" || l(m) === "local");
}

/** The default gpu door when a render does not name one: the order-first byo module (the studio's
 *  canonical own-GPU render path), else the order-first local module (a local door is normally an
 *  explicit pick, so it only becomes the default when it is the ONLY gpu door). Undefined when no
 *  gpu door is installed -- callers fail honestly instead of submitting to a hardcoded name. */
export function defaultGpuDoorModule(modules: RegisteredModule[]): RegisteredModule | undefined {
  const doors = gpuDoorMotionModules(modules);
  return doors.find((m) => m.ui?.locality === "byo") ?? doors[0];
}

/** A short label for a module's transport, for error/log messages that must name it without leaking to
 *  the wire (these strings stay core-side, in the pipeline's degrade log). */
function transportLabel(module: RegisteredModule): string {
  return module.binding.startsWith(DISPATCH_REF_PREFIX)
    ? module.binding // already "dispatch:<script>"
    : `binding ${module.binding}`;
}

/** Resolve a registered module to a Fetcher by its transport-encoded `binding` ref. Thin wrapper over
 *  resolveFetcher (the single primitive); everything AFTER "got a Fetcher" is identical for both
 *  transports. */
function fetcherFor(env: Record<string, unknown>, module: RegisteredModule): FetcherLike | null {
  return resolveFetcher(env, module.binding);
}

// F5: a module is untrusted (community territory). Read its response through a size cap so a
// malicious/buggy module cannot OOM the core with a giant body -- envelopes are small JSON
// metadata (heavy artifacts live in R2, referenced by key). Oversized/unreadable -> throw, which
// the callers turn into an honest ok:false degrade.
const MAX_MODULE_RESPONSE_BYTES = 1024 * 1024; // 1MB
async function readModuleJson(res: Response): Promise<unknown> {
  const body = res.body;
  if (!body) return res.json(); // no stream (e.g. a test stub) -> fall back
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_MODULE_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`response exceeded ${MAX_MODULE_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  if (total === 0) throw new Error("empty response body");
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

/** POST one module's `/invoke` and return its typed `InvokeResponse`. A module failure is DATA, never
 *  an exception: a non-200, a malformed body, or an unreachable binding all become `{ ok: false }`,
 *  so the core degrades instead of crashing (the contract's whole point). */
export async function invokeModule<I = unknown, O = unknown>(
  fetcher: FetcherLike,
  request: InvokeRequest<I>,
): Promise<InvokeResponse<O>> {
  let res: Response;
  try {
    res = await fetcher.fetch("https://module/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (e) {
    return { ok: false, error: `module unreachable: ${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: `module /invoke -> ${res.status}` };
  let data: InvokeResponse<O>;
  try {
    data = (await readModuleJson(res)) as InvokeResponse<O>;
  } catch (e) {
    return { ok: false, error: `module /invoke body rejected: ${(e as Error).message}` };
  }
  if (!(data && typeof data === "object" && typeof (data as { ok?: unknown }).ok === "boolean")) {
    return { ok: false, error: "module returned a malformed InvokeResponse" };
  }
  return data;
}

/** True for the async-accepted shape of an InvokeResponse. */
function isPending<O>(r: InvokeResponse<O>): r is { ok: true; pending: true; poll: string } {
  return r.ok === true && (r as { pending?: unknown }).pending === true;
}

/** POST a module's `/poll` to check an async job. A failure is DATA, like invoke. */
export async function pollModule<O = unknown>(
  fetcher: FetcherLike,
  request: PollRequest,
): Promise<PollResponse<O>> {
  let res: Response;
  try {
    res = await fetcher.fetch("https://module/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (e) {
    return { ok: false, error: `module unreachable: ${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: `module /poll -> ${res.status}` };
  let data: PollResponse<O>;
  try {
    data = (await readModuleJson(res)) as PollResponse<O>;
  } catch (e) {
    return { ok: false, error: `module /poll body rejected: ${(e as Error).message}` };
  }
  if (!(data && typeof data === "object" && typeof (data as { ok?: unknown }).ok === "boolean")) {
    return { ok: false, error: "module returned a malformed PollResponse" };
  }
  return data;
}

/** POST a module's `/cancel` to STOP an in-flight async job, identified by the same poll token `/invoke`
 *  returned. A failure is DATA, like invoke/poll: a non-200, a malformed body, or an unreachable binding
 *  all become `{ ok: false }`, so the caller degrade-logs the orphan instead of crashing. Only call this
 *  on a module whose manifest advertises `cancelable` -- a module without /cancel would 404 here, which
 *  this surfaces honestly as `ok: false` (the caller then logs the orphan, never hides it). */
export async function cancelModule(
  fetcher: FetcherLike,
  request: CancelRequest,
): Promise<CancelResponse> {
  try {
    const res = await fetcher.fetch("https://module/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) return { ok: false, error: `module /cancel -> ${res.status}` };
    const data = (await readModuleJson(res)) as CancelResponse;
    if (data && typeof data === "object" && typeof (data as { ok?: unknown }).ok === "boolean") return data;
    return { ok: false, error: "module returned a malformed CancelResponse" };
  } catch (e) {
    return { ok: false, error: `module unreachable: ${(e as Error).message}` };
  }
}

/** Invoke a module and resolve to a terminal result: a synchronous module returns its output; an
 *  async module returns `pending` and we poll its `/poll` until done (or the cap). NOTE: the polling
 *  runs in the caller's request, so this fits synchronous + SHORT async hooks. A long-running hook
 *  (cloud i2v that takes minutes) should be driven OUT of a request -- an orchestrator (Durable
 *  Object / cron) calling invokeModule + pollModule across requests -- so no Worker holds a long
 *  request open. */
export async function awaitInvoke<I = unknown, O = unknown>(
  fetcher: FetcherLike,
  request: InvokeRequest<I>,
  opts: { pollMs?: number; pollMax?: number } = {},
): Promise<{ ok: true; output: O } | { ok: false; error: string }> {
  const r = await invokeModule<I, O>(fetcher, request);
  if (!r.ok) return r;
  if (!isPending(r)) return { ok: true, output: (r as { output: O }).output };
  const pollMs = opts.pollMs ?? 3000;
  const pollMax = opts.pollMax ?? 40;
  for (let i = 0; i < pollMax; i++) {
    await new Promise((res) => setTimeout(res, pollMs));
    const p = await pollModule<O>(fetcher, { poll: r.poll });
    if (!p.ok) return p;
    if (!(p as { pending?: unknown }).pending) return { ok: true, output: (p as { output: O }).output };
  }
  return { ok: false, error: "module async job did not finish within the poll window" };
}

/** Dispatch a `pick_one` hook: resolve the single serving module (honoring an optional `choice`),
 *  clamp the user's config against that module's schema, and invoke it. Returns `{ ok: false }` when
 *  no module serves the hook or its binding is missing -- the caller decides whether that is fatal. */
export async function dispatchPickOne<I = unknown, O = unknown>(
  env: Record<string, unknown>,
  modules: RegisteredModule[],
  hook: HookName,
  input: I,
  context: InvokeContext,
  opts: { config?: Record<string, unknown>; choice?: string } = {},
): Promise<{ ok: true; output: O } | { ok: false; error: string }> {
  const module = resolvePickOne(modules, hook, opts.choice);
  if (!module) return { ok: false, error: `no module serves pick_one hook "${hook}"` };
  const fetcher = fetcherFor(env, module);
  if (!fetcher) {
    return { ok: false, error: `module ${module.name} (${transportLabel(module)}) is not reachable` };
  }
  const config = validateConfig(module.config_schema, opts.config);
  return awaitInvoke<I, O>(fetcher, { hook, input, config, context });
}

/** The result of folding a `chain` hook over its serving modules. `output` is the last module's
 *  output (null if none ran), `applied` names the modules that succeeded in order, and `errors`
 *  records the ones that were skipped (a chain degrades past a failed module, it does not abort). */
export interface ChainResult<O> {
  output: O | null;
  applied: string[];
  errors: string[];
  // Modules that returned ok:true but reported a SOFT-DEGRADE (passed their input through because they
  // could not do the work, e.g. a container was unreachable). Format "<module>: <reason>". A module
  // reporting ok must not hide a no-op: `applied` says it ran, `degraded` says it did nothing useful.
  degraded: string[];
}

/** Dispatch a `chain` hook: fold every serving module in `ui.order`, each consuming the previous
 *  module's output as its next input (mapped by `nextInput`, since a hook's output and input shapes
 *  differ), clamping each module's config against its own schema. A failed module is skipped
 *  (recorded in `errors`), not fatal -- the chain continues from the last good output. */
export async function dispatchChain<I = unknown, O = unknown>(
  env: Record<string, unknown>,
  modules: RegisteredModule[],
  hook: HookName,
  seed: I,
  context: InvokeContext,
  opts: {
    // Map a module's output to the next module's input. May be async: a chain whose steps thread
    // through R2 (film.finish reading the PRIOR step's output) presigns a fresh GET/PUT pair per step
    // here, so step N+1 reads what step N wrote instead of re-reading the seed (#14). A sync mapper
    // (plan.enhance) just returns I; `await` on a non-promise is a no-op.
    nextInput: (prevOutput: O, seed: I) => I | Promise<I>;
    configFor?: (moduleName: string) => Record<string, unknown> | undefined;
  },
): Promise<ChainResult<O>> {
  const applied: string[] = [];
  const errors: string[] = [];
  const degraded: string[] = [];
  let current: I = seed;
  let last: O | null = null;
  for (const module of servingForHook(modules, hook)) {
    const fetcher = fetcherFor(env, module);
    if (!fetcher) {
      errors.push(`${module.name}: ${transportLabel(module)} is not reachable`);
      continue;
    }
    const config = validateConfig(module.config_schema, opts.configFor?.(module.name));
    const r = await awaitInvoke<I, O>(fetcher, { hook, input: current, config, context });
    if (r.ok) {
      last = r.output;
      current = await opts.nextInput(r.output, seed);
      applied.push(module.name);
      // A module can return ok:true yet report a SOFT-DEGRADE via the `output.degraded` convention (a
      // reason string) -- it passed its input through because it could not do its work. Without this, a
      // degrade is binned in `applied` and only surfaces if the caller happens to inspect the output (the
      // film.finish-ships-uncarded bug). Record + log it centrally so EVERY chain hook gets the signal.
      const deg = (r.output as { degraded?: unknown } | null)?.degraded;
      if (typeof deg === "string" && deg.length > 0) {
        degraded.push(`${module.name}: ${deg}`);
        console.warn(`chain ${hook}: ${module.name} degraded (${deg})`);
      }
    } else {
      errors.push(`${module.name}: ${r.error}`);
    }
  }
  return { output: last, applied, errors, degraded };
}
