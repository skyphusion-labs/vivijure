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
  HOOK_NAMES,
  type ConfigSchema,
  type HookName,
  type ModuleManifest,
  type ModulesResponse,
  type RegisteredModule,
} from "./types";

/** A service-binding-shaped value: anything we can `.fetch()` like a Worker. */
interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

function isFetcher(v: unknown): v is FetcherLike {
  return !!v && typeof (v as { fetch?: unknown }).fetch === "function";
}

/** The env keys that name module bindings. Convention: `MODULE_<NAME>` service bindings. */
export function moduleBindingNames(env: Record<string, unknown>): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith("MODULE_") && isFetcher(env[k]))
    .sort();
}

// --------------------------------------------------------------------------- manifest validation

/** Validate a parsed manifest enough to trust it in the registry. Returns the typed manifest or a
 *  reason string. We check the contract version, a name, and that every declared hook is known. */
export function validateManifest(raw: unknown): ModuleManifest | string {
  if (!raw || typeof raw !== "object") return "manifest is not an object";
  const m = raw as Record<string, unknown>;
  if (m.api !== MODULE_API) return `unsupported api ${String(m.api)} (core speaks ${MODULE_API})`;
  if (typeof m.name !== "string" || !m.name) return "manifest missing name";
  if (typeof m.version !== "string" || !m.version) return "manifest missing version";
  if (!Array.isArray(m.hooks) || m.hooks.length === 0) return "manifest declares no hooks";
  const known = new Set<string>(HOOK_NAMES);
  const bad = (m.hooks as unknown[]).filter((h) => !known.has(h as string));
  if (bad.length) return `manifest declares unknown hooks: ${bad.join(", ")}`;
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

/** The GET /api/modules payload the frontend renders itself from. */
export function modulesResponse(modules: RegisteredModule[]): ModulesResponse {
  return { api: MODULE_API, modules, hooks: indexByHook(modules) };
}

// --------------------------------------------------------------------------- discovery (I/O)

/** Fetch + validate the manifest from one bound module worker. Returns the registered module or
 *  null (logged) on any failure, so one bad module never poisons the registry. */
export async function readManifest(
  binding: string,
  fetcher: FetcherLike,
): Promise<RegisteredModule | null> {
  try {
    const res = await fetcher.fetch("https://module/module.json");
    if (!res.ok) {
      console.warn(`module ${binding}: GET /module.json -> ${res.status}; skipping`);
      return null;
    }
    const parsed = validateManifest(await res.json());
    if (typeof parsed === "string") {
      console.warn(`module ${binding}: invalid manifest (${parsed}); skipping`);
      return null;
    }
    return { ...parsed, binding };
  } catch (e) {
    console.warn(`module ${binding}: unreachable (${(e as Error).message}); skipping`);
    return null;
  }
}

/** Discover every installed module from the env: read each `MODULE_*` binding's manifest in
 *  parallel, drop the ones that fail, and return the live registry. */
export async function discoverModules(env: Record<string, unknown>): Promise<RegisteredModule[]> {
  const names = moduleBindingNames(env);
  const read = await Promise.all(
    names.map((n) => readManifest(n, env[n] as FetcherLike)),
  );
  return read.filter((m): m is RegisteredModule => m !== null);
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
