// Workers-for-Platforms dynamic-dispatch (Phase 3): the host-side transport that installs a module
// WITHOUT a core redeploy (docs/module-dispatch.md). These cover the resolution primitive
// (resolveFetcher), the D1-backed dispatch discovery + merge, the install-gate conformance runner, the
// installed_modules store, and the host capability flag -- all with fakes (no live WfP / D1).

import { describe, expect, it } from "vitest";

import {
  DISPATCH_BINDING,
  DISPATCH_REF_PREFIX,
  dispatchRef,
  resolveFetcher,
  moduleBindingNames,
  discoverDispatchModules,
  mergeRegistries,
  discoverModules,
  modulesResponse,
  dispatchPickOne,
  _resetModuleDiscoveryCache,
} from "../src/modules/registry";
import { runLiveConformance, allPass, failures } from "../src/modules/conformance";
import {
  installModuleRow,
  uninstallModuleRow,
  setModuleEnabled,
  listInstalledModules,
} from "../src/installed-modules";
import { MODULE_API, type ModuleManifest, type RegisteredModule } from "../src/modules/types";
import type { Env } from "../src/env";

// --------------------------------------------------------------------------- fakes

/** A minimal Fetcher stub that answers /module.json + /invoke like a real module worker. `opts.invoke`
 *  overrides the first-hook response; `opts.badHook` overrides the bad-hook (degrade) response. */
function fakeModule(
  manifest: unknown,
  opts: { invoke?: (hook: string) => Response; badHook?: () => Response; manifestStatus?: number } = {},
) {
  return {
    async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/module.json")) {
        return new Response(JSON.stringify(manifest), { status: opts.manifestStatus ?? 200 });
      }
      if (url.endsWith("/invoke")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { hook: string };
        if (body.hook === "not.a.real.hook") {
          return opts.badHook ? opts.badHook() : new Response(JSON.stringify({ ok: false, error: "unknown hook" }), { status: 200 });
        }
        if (opts.invoke) return opts.invoke(body.hook);
        // default: a conformant plan.enhance output
        return new Response(JSON.stringify({ ok: true, output: { storyboard: { scenes: [{ prompt: "x" }] } } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

/** A dispatch-namespace stub: `.get(script)` returns the mapped fetcher, or THROWS for an absent script
 *  (as the real DispatchNamespace.get does), so the resolveFetcher guard is exercised. */
function fakeNamespace(scripts: Record<string, ReturnType<typeof fakeModule>>) {
  return {
    get(script: string) {
      const f = scripts[script];
      if (!f) throw new Error(`script ${script} not found in namespace`);
      return f;
    },
  };
}

/** A fake D1 that returns `rows` from any SELECT .all(), and records writes with a configurable
 *  `changes` count so uninstall/setEnabled can report matched/not-matched. */
function fakeDb(rows: unknown[] = [], changes = 1) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() { writes.push({ sql, args }); return { meta: { changes } }; },
            async all() { return { results: rows }; },
          };
        },
        async all() { return { results: rows }; },
        async run() { writes.push({ sql, args: [] }); return { meta: { changes } }; },
      };
    },
  };
  return { DB, writes };
}

const planEnhanceManifest: ModuleManifest = {
  name: "pe-cloud",
  version: "1.0.0",
  api: MODULE_API,
  hooks: ["plan.enhance"],
};

// --------------------------------------------------------------------------- resolveFetcher

describe("resolveFetcher (transport-encoded binding refs)", () => {
  it("resolves a service ref via the env binding", () => {
    const stub = fakeModule(planEnhanceManifest);
    expect(resolveFetcher({ MODULE_FOO: stub }, "MODULE_FOO")).toBe(stub);
  });
  it("returns null for an unbound service ref", () => {
    expect(resolveFetcher({}, "MODULE_MISSING")).toBeNull();
  });
  it("resolves a dispatch ref through the namespace", () => {
    const stub = fakeModule(planEnhanceManifest);
    const env = { [DISPATCH_BINDING]: fakeNamespace({ "pe-script": stub }) };
    expect(resolveFetcher(env, dispatchRef("pe-script"))).toBe(stub);
  });
  it("returns null for a dispatch ref when no namespace is bound", () => {
    expect(resolveFetcher({}, dispatchRef("pe-script"))).toBeNull();
  });
  it("returns null (never throws) when the dispatch script is absent from the namespace", () => {
    const env = { [DISPATCH_BINDING]: fakeNamespace({}) }; // get() throws
    expect(resolveFetcher(env, dispatchRef("gone"))).toBeNull();
  });
  it("dispatchRef uses the reserved prefix", () => {
    expect(dispatchRef("x")).toBe(DISPATCH_REF_PREFIX + "x");
  });
});

// --------------------------------------------------------------------------- moduleBindingNames

describe("moduleBindingNames excludes the dispatch namespace binding", () => {
  it("skips MODULE_DISPATCH even though it matches the MODULE_ prefix", () => {
    const env = {
      MODULE_FOO: fakeModule(planEnhanceManifest),
      [DISPATCH_BINDING]: fakeNamespace({}), // has .get(), not .fetch()
    };
    expect(moduleBindingNames(env)).toEqual(["MODULE_FOO"]);
  });
});

// --------------------------------------------------------------------------- discoverDispatchModules

describe("discoverDispatchModules", () => {
  const row = { name: "pe-cloud", script_name: "pe-script", manifest_json: JSON.stringify(planEnhanceManifest), api: MODULE_API };

  it("returns [] (no D1 read) when no dispatch namespace is bound", async () => {
    const { DB } = fakeDb([row]);
    expect(await discoverDispatchModules({ DB })).toEqual([]);
  });
  it("reconstructs modules from installed rows, tagged with the dispatch ref", async () => {
    const { DB } = fakeDb([row]);
    const mods = await discoverDispatchModules({ DB, [DISPATCH_BINDING]: fakeNamespace({}) });
    expect(mods).toHaveLength(1);
    expect(mods[0].name).toBe("pe-cloud");
    expect(mods[0].binding).toBe(dispatchRef("pe-script"));
  });
  it("drops a row whose manifest_json is not valid JSON", async () => {
    const { DB } = fakeDb([{ ...row, manifest_json: "{not json" }]);
    expect(await discoverDispatchModules({ DB, [DISPATCH_BINDING]: fakeNamespace({}) })).toEqual([]);
  });
  it("drops a row whose stored manifest is invalid", async () => {
    const bad = JSON.stringify({ name: "x", api: "vivijure-module/2", hooks: ["nope.not.a.hook"], version: "1" });
    const { DB } = fakeDb([{ ...row, manifest_json: bad }]);
    expect(await discoverDispatchModules({ DB, [DISPATCH_BINDING]: fakeNamespace({}) })).toEqual([]);
  });

  // #625: the demo studio's display-only catalog -- seeded rows surface WITHOUT a namespace.
  it("AUTH_MODE=demo reads seeded rows with NO namespace bound (the demo catalog path)", async () => {
    const { DB } = fakeDb([row]);
    const mods = await discoverDispatchModules({ DB, AUTH_MODE: "demo" });
    expect(mods).toHaveLength(1);
    expect(mods[0].name).toBe("pe-cloud");
    // the ref still encodes as dispatch:<script>; with no namespace bound resolveFetcher
    // returns null for it, so nothing discovered this way is invocable even if reached.
    expect(mods[0].binding).toBe(dispatchRef("pe-script"));
    expect(resolveFetcher({ DB, AUTH_MODE: "demo" }, mods[0].binding)).toBeNull();
  });
  it("a NON-demo AUTH_MODE still short-circuits without a namespace (zero D1 overhead preserved)", async () => {
    const { DB } = fakeDb([row]);
    expect(await discoverDispatchModules({ DB, AUTH_MODE: "token" })).toEqual([]);
    expect(await discoverDispatchModules({ DB, AUTH_MODE: "" })).toEqual([]);
  });
});

// --------------------------------------------------------------------------- mergeRegistries

describe("mergeRegistries", () => {
  const svc: RegisteredModule = { ...planEnhanceManifest, name: "dup", binding: "MODULE_DUP" };
  const disp: RegisteredModule = { ...planEnhanceManifest, name: "dup", binding: dispatchRef("dup-script") };
  it("service binding wins on a name collision (migration overlap)", () => {
    const merged = mergeRegistries([svc], [disp]);
    expect(merged).toHaveLength(1);
    expect(merged[0].binding).toBe("MODULE_DUP");
  });
  it("keeps dispatch-only modules", () => {
    const only: RegisteredModule = { ...planEnhanceManifest, name: "only", binding: dispatchRef("only-script") };
    const merged = mergeRegistries([], [only]);
    expect(merged.map((m) => m.name)).toEqual(["only"]);
  });
});

// --------------------------------------------------------------------------- discoverModules merge

describe("discoverModules merges service + dispatch", () => {
  it("includes a dispatch module and its ref never leaks to the public projection", async () => {
    _resetModuleDiscoveryCache();
    const row = { name: "pe-cloud", script_name: "pe-script", manifest_json: JSON.stringify(planEnhanceManifest), api: MODULE_API };
    const { DB } = fakeDb([row]);
    const env = { DB, [DISPATCH_BINDING]: fakeNamespace({ "pe-script": fakeModule(planEnhanceManifest) }) };
    const mods = await discoverModules(env);
    expect(mods.map((m) => m.name)).toContain("pe-cloud");
    // the public projection strips the binding ref (no dispatch:<script> on the wire)
    const wire = modulesResponse(mods, { quality_tiers: [], default_tier: "" }, { dispatch: true });
    expect(JSON.stringify(wire)).not.toContain("dispatch:pe-script");
    expect(wire.host).toEqual({ dispatch: true });
  });
});

// --------------------------------------------------------------------------- dispatch end-to-end

describe("dispatchPickOne over the dispatch transport", () => {
  it("invokes a namespace-resident module and returns its output", async () => {
    const mod: RegisteredModule = { ...planEnhanceManifest, hooks: ["plan.enhance"], binding: dispatchRef("pe-script") };
    const env = { [DISPATCH_BINDING]: fakeNamespace({ "pe-script": fakeModule(planEnhanceManifest) }) };
    const r = await dispatchPickOne(env, [mod], "plan.enhance", { storyboard: { scenes: [{ prompt: "a" }] } }, { project: "p", job_id: "j" });
    expect(r.ok).toBe(true);
  });
  it("degrades (ok:false) when the namespace script is gone", async () => {
    const mod: RegisteredModule = { ...planEnhanceManifest, hooks: ["plan.enhance"], binding: dispatchRef("gone") };
    const env = { [DISPATCH_BINDING]: fakeNamespace({}) };
    const r = await dispatchPickOne(env, [mod], "plan.enhance", {}, { project: "p", job_id: "j" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/dispatch:gone/);
  });
});

// --------------------------------------------------------------------------- runLiveConformance (install gate)

describe("runLiveConformance", () => {
  it("passes a conformant module", async () => {
    const checks = await runLiveConformance(fakeModule(planEnhanceManifest));
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });
  it("fails on an invalid manifest", async () => {
    const checks = await runLiveConformance(fakeModule({ api: MODULE_API, hooks: ["plan.enhance"], version: "1" })); // no name
    expect(allPass(checks)).toBe(false);
  });
  it("fails when a bad hook does NOT degrade (crashes / non-200)", async () => {
    const m = fakeModule(planEnhanceManifest, { badHook: () => new Response("boom", { status: 500 }) });
    const checks = await runLiveConformance(m);
    expect(allPass(checks)).toBe(false);
    expect(failures(checks).some((c) => c.name === "degrade")).toBe(true);
  });
  it("fails when a bad hook returns ok:true instead of ok:false", async () => {
    const m = fakeModule(planEnhanceManifest, { badHook: () => new Response(JSON.stringify({ ok: true, output: {} }), { status: 200 }) });
    const checks = await runLiveConformance(m);
    expect(failures(checks).some((c) => c.name === "degrade")).toBe(true);
  });
});

// --------------------------------------------------------------------------- installed_modules store

describe("installed-modules D1 store", () => {
  it("installModuleRow upserts (INSERT ... ON CONFLICT) with the manifest + enabled=1", async () => {
    const { DB, writes } = fakeDb();
    await installModuleRow({ DB } as unknown as Env, {
      name: "pe-cloud", script_name: "pe-script", manifest_json: "{}", api: MODULE_API, installed_at: 123,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toMatch(/INSERT INTO installed_modules/);
    expect(writes[0].sql).toMatch(/ON CONFLICT/);
    expect(writes[0].args).toEqual(["pe-cloud", "pe-script", "{}", MODULE_API, 123]);
  });
  it("uninstallModuleRow reports whether a row was removed", async () => {
    expect(await uninstallModuleRow({ DB: fakeDb([], 1).DB } as unknown as Env, "pe-cloud")).toBe(true);
    expect(await uninstallModuleRow({ DB: fakeDb([], 0).DB } as unknown as Env, "missing")).toBe(false);
  });
  it("setModuleEnabled binds 1/0 and reports matched", async () => {
    const { DB, writes } = fakeDb([], 1);
    expect(await setModuleEnabled({ DB } as unknown as Env, "pe-cloud", false)).toBe(true);
    expect(writes[0].args).toEqual(["pe-cloud", 0]);
  });
  it("listInstalledModules maps rows to the admin view (enabled as bool)", async () => {
    const rows = [{ name: "pe-cloud", script_name: "pe-script", manifest_json: "{}", api: MODULE_API, installed_at: 5, enabled: 1 }];
    const list = await listInstalledModules({ DB: fakeDb(rows).DB } as unknown as Env);
    expect(list).toEqual([{ name: "pe-cloud", script_name: "pe-script", api: MODULE_API, installed_at: 5, enabled: true }]);
  });
});
