import { describe, expect, it } from "vitest";

import {
  discoverModules,
  cloudMotionModules,
  defaultGpuDoorModule,
  dispatchChain,
  dispatchPickOne,
  gpuDoorMotionModules,
  indexByHook,
  invokeModule,
  moduleBindingNames,
  modulesResponse,
  readManifest,
  resolvePickOne,
  validateConfig,
  validateManifest,
} from "../src/modules/registry";
import { MODULE_API, type ConfigSchema, type RegisteredModule } from "../src/modules/types";

// ----------------------------------------------------------------- helpers

const manifest = (over = {}) => ({
  name: "finish-rife",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["finish"],
  ...over,
});

/** A fake service binding that serves a given manifest (or a status) from GET /module.json. */
function fakeModule(body: unknown, status = 200) {
  return {
    fetch: async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  };
}

// ----------------------------------------------------------------- manifest validation

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(manifest())).toMatchObject({ name: "finish-rife", hooks: ["finish"] });
  });
  it("rejects a wrong api version", () => {
    expect(validateManifest(manifest({ api: "vivijure-module/99" }))).toContain("unsupported api");
  });
  it("rejects the retired /1 epoch (window closed by #294; /2 only)", () => {
    expect(validateManifest(manifest({ api: "vivijure-module/1" }))).toContain("unsupported api");
    expect(validateManifest(manifest({ api: "vivijure-module/2" }))).toMatchObject({ name: "finish-rife" });
  });
  it("rejects unknown hooks", () => {
    expect(validateManifest(manifest({ hooks: ["finish", "teleport"] }))).toContain("unknown hooks");
  });
  it("rejects a manifest with no name", () => {
    expect(validateManifest(manifest({ name: "" }))).toContain("missing name");
  });
  it("rejects a manifest with no hooks", () => {
    expect(validateManifest(manifest({ hooks: [] }))).toContain("no hooks");
  });
  it("rejects non-objects", () => {
    expect(typeof validateManifest(null)).toBe("string");
    expect(typeof validateManifest(42)).toBe("string");
  });
});

// ----------------------------------------------------------------- config validation (clamping)

const SCHEMA: ConfigSchema = {
  interpolation_factor: { type: "int", min: 1, max: 8, default: 2 },
  fidelity: { type: "float", min: 0, max: 1, default: 0.7 },
  face_restore: { type: "enum", values: ["none", "gfpgan"], default: "none" },
  only_faces: { type: "bool", default: true },
  note: { type: "string", default: "" },
};

describe("validateConfig", () => {
  it("returns defaults when nothing is supplied", () => {
    expect(validateConfig(SCHEMA, undefined)).toEqual({
      interpolation_factor: 2,
      fidelity: 0.7,
      face_restore: "none",
      only_faces: true,
      note: "",
    });
  });
  it("clamps ints to range and rounds", () => {
    expect(validateConfig(SCHEMA, { interpolation_factor: 99 }).interpolation_factor).toBe(8);
    expect(validateConfig(SCHEMA, { interpolation_factor: 0 }).interpolation_factor).toBe(1);
    expect(validateConfig(SCHEMA, { interpolation_factor: 3.7 }).interpolation_factor).toBe(4);
  });
  it("clamps floats without rounding", () => {
    expect(validateConfig(SCHEMA, { fidelity: 2.5 }).fidelity).toBe(1);
    expect(validateConfig(SCHEMA, { fidelity: 0.33 }).fidelity).toBe(0.33);
  });
  it("falls back on an out-of-set enum and junk numbers", () => {
    expect(validateConfig(SCHEMA, { face_restore: "wat" }).face_restore).toBe("none");
    expect(validateConfig(SCHEMA, { interpolation_factor: "abc" }).interpolation_factor).toBe(2);
  });
  it("drops unknown keys", () => {
    expect(validateConfig(SCHEMA, { evil: 1 })).not.toHaveProperty("evil");
  });
});

// ----------------------------------------------------------------- binding discovery + indexing

describe("moduleBindingNames", () => {
  it("picks MODULE_* fetchers and ignores everything else", () => {
    const env = {
      MODULE_FINISH_RIFE: fakeModule(manifest()),
      MODULE_BROKEN: { not: "a fetcher" },
      ASSETS: fakeModule(manifest()),
      GATEWAY_ID: "abc",
    };
    expect(moduleBindingNames(env)).toEqual(["MODULE_FINISH_RIFE"]);
  });
});

describe("indexByHook", () => {
  it("indexes by hook in ui.order then name", () => {
    const mods = [
      { name: "b", hooks: ["finish"], ui: { order: 20 } },
      { name: "a", hooks: ["finish", "score"], ui: { order: 10 } },
    ] as unknown as RegisteredModule[];
    const idx = indexByHook(mods);
    expect(idx.finish).toEqual(["a", "b"]);
    expect(idx.score).toEqual(["a"]);
  });
});

describe("modulesResponse", () => {
  const render = { quality_tiers: [{ value: "final", label: "final", blurb: "x" }], default_tier: "final" };
  it("wraps the registry with the api version and hook index", () => {
    const mods = [{ name: "x", hooks: ["finish"] }] as unknown as RegisteredModule[];
    const r = modulesResponse(mods, render);
    expect(r.api).toBe(MODULE_API);
    expect(r.modules).toHaveLength(1);
    expect(r.hooks.finish).toEqual(["x"]);
  });
  it("is a clean, lean studio when nothing is installed", () => {
    const r = modulesResponse([], render);
    expect(r.modules).toEqual([]);
    expect(r.hooks).toEqual({});
  });
  it("carries the core-owned render projection (tiers) for the planner to render from", () => {
    const r = modulesResponse([], render);
    expect(r.render).toEqual(render);
  });
  it("strips the internal binding from the public module view (#18 info disclosure)", () => {
    const mods = [
      { name: "finish-rife", version: "0.1.0", api: MODULE_API, hooks: ["finish"], binding: "MODULE_FINISH_RIFE" },
    ] as unknown as RegisteredModule[];
    const r = modulesResponse(mods, render);
    expect(r.modules[0]).not.toHaveProperty("binding");
    expect(r.modules[0]).toMatchObject({ name: "finish-rife", hooks: ["finish"] });
    // the hook index still maps the hook to the module NAME (no topology leaked)
    expect(r.hooks.finish).toEqual(["finish-rife"]);
  });
  it("serves the static hook catalog (name + blurb + cardinality), independent of installs", () => {
    const r = modulesResponse([], render);
    expect(r.catalog.map((h) => h.name)).toEqual([
      "keyframe", "motion.backend", "finish", "score", "dialogue", "speech", "plan.enhance", "cast.image", "notify", "master", "film.finish",
    ]);
    expect(r.catalog.find((h) => h.name === "dialogue")?.cardinality).toBe("pick_one");
    expect(r.catalog.find((h) => h.name === "speech")?.cardinality).toBe("chain");
    expect(r.catalog.find((h) => h.name === "cast.image")?.cardinality).toBe("pick_one");
    expect(r.catalog.find((h) => h.name === "notify")?.cardinality).toBe("chain");
    expect(r.catalog.find((h) => h.name === "master")?.cardinality).toBe("chain");
    expect(r.catalog.find((h) => h.name === "keyframe")?.cardinality).toBe("pick_one");
    expect(r.catalog.find((h) => h.name === "motion.backend")?.cardinality).toBe("pick_one");
    expect(r.catalog.find((h) => h.name === "finish")?.cardinality).toBe("chain");
    expect(r.catalog.every((h) => h.blurb.length > 0)).toBe(true);
  });
  it("omits host when not passed, carries it verbatim when passed (additive, #625)", () => {
    expect(modulesResponse([], render)).not.toHaveProperty("host");
    expect(modulesResponse([], render, { dispatch: true }).host).toEqual({ dispatch: true });
    // the demo studio projection: readonly rides the same optional host object
    expect(modulesResponse([], render, { dispatch: false, readonly: true }).host).toEqual({
      dispatch: false,
      readonly: true,
    });
  });

  it("#631 Phase B: render + assistant capabilities ride the same host object (additive)", () => {
    const host = modulesResponse([], render, {
      dispatch: false, readonly: true,
      render: { available: true },
      assistant: { model: "oss", note: "free model here" },
    }).host;
    expect(host).toEqual({
      dispatch: false, readonly: true,
      render: { available: true },
      assistant: { model: "oss", note: "free model here" },
    });
  });
});

describe("resolvePickOne", () => {
  const mods = [
    { name: "motion-runpod", hooks: ["motion.backend"] },
    { name: "motion-cloud", hooks: ["motion.backend"] },
  ] as unknown as RegisteredModule[];
  it("returns the named choice", () => {
    expect(resolvePickOne(mods, "motion.backend", "motion-cloud")?.name).toBe("motion-cloud");
  });
  it("returns the first when no choice is given", () => {
    expect(resolvePickOne(mods, "motion.backend")?.name).toBe("motion-runpod");
  });
  it("returns null when no module serves the hook", () => {
    expect(resolvePickOne(mods, "finish")).toBeNull();
  });
});

// ----------------------------------------------------------------- discovery (I/O, faked)

describe("readManifest / discoverModules", () => {
  it("reads a healthy module", async () => {
    const m = await readManifest("MODULE_FINISH_RIFE", fakeModule(manifest()) as never);
    expect(m).toMatchObject({ name: "finish-rife", binding: "MODULE_FINISH_RIFE" });
  });
  it("drops a module that 404s its manifest", async () => {
    expect(await readManifest("MODULE_X", fakeModule("nope", 404) as never)).toBeNull();
  });
  it("drops a module with a malformed manifest", async () => {
    expect(await readManifest("MODULE_X", fakeModule({ api: "wrong" }) as never)).toBeNull();
  });
  it("drops an unreachable module without throwing", async () => {
    const dead = { fetch: async () => { throw new Error("connection refused"); } };
    expect(await readManifest("MODULE_DEAD", dead as never)).toBeNull();
  });
  it("discovers only the healthy modules from a mixed env", async () => {
    const env = {
      MODULE_GOOD: fakeModule(manifest({ name: "good" })),
      MODULE_BAD: fakeModule({ api: "wrong" }),
      MODULE_DOWN: { fetch: async () => { throw new Error("down"); } },
      ASSETS: fakeModule(manifest()),
    };
    const found = await discoverModules(env);
    expect(found.map((m) => m.name)).toEqual(["good"]);
  });
});

// ----------------------------------------------------------------- dispatch (I/O, faked)

const ctx = { project: "p", job_id: "j" };

/** A fake module that answers POST /invoke from the posted InvokeRequest. */
function invoker(respond: (req: any) => unknown) {
  return {
    fetch: async (_url: string, init?: { body?: string }) => {
      const req = init?.body ? JSON.parse(init.body) : {};
      return new Response(JSON.stringify(respond(req)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

describe("invokeModule", () => {
  it("returns the module's InvokeResponse on 200", async () => {
    const f = invoker((req) => ({ ok: true, output: { gotHook: req.hook } }));
    const r = await invokeModule<unknown, { gotHook: string }>(f as never, {
      hook: "finish", input: {}, config: {}, context: ctx,
    });
    expect(r.ok).toBe(true);
    if (r.ok && "output" in r) expect(r.output.gotHook).toBe("finish");
  });
  it("degrades to ok:false on a non-200, never throws", async () => {
    const f = { fetch: async () => new Response("nope", { status: 500 }) };
    const r = await invokeModule(f as never, { hook: "finish", input: {}, config: {}, context: ctx });
    expect(r.ok).toBe(false);
  });
  it("degrades to ok:false when the module is unreachable", async () => {
    const f = { fetch: async () => { throw new Error("down"); } };
    const r = await invokeModule(f as never, { hook: "finish", input: {}, config: {}, context: ctx });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unreachable/);
  });
});

describe("dispatchPickOne", () => {
  const mod = {
    name: "motion-cloud", binding: "MODULE_MOTION", hooks: ["motion.backend"],
    config_schema: { steps: { type: "int", min: 1, max: 10, default: 4 } },
  } as unknown as RegisteredModule;

  it("invokes the resolved module with config clamped to its schema", async () => {
    const env = { MODULE_MOTION: invoker((req) => ({ ok: true, output: { steps: req.config.steps } })) };
    const r = await dispatchPickOne<unknown, { steps: number }>(
      env, [mod], "motion.backend", { keyframe: "k" }, ctx, { config: { steps: 999 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.steps).toBe(10); // 999 clamped to max
  });
  it("returns ok:false when no module serves the hook", async () => {
    expect((await dispatchPickOne({}, [], "motion.backend", {}, ctx)).ok).toBe(false);
  });
  it("returns ok:false when the serving module's binding is missing", async () => {
    const r = await dispatchPickOne({}, [mod], "motion.backend", {}, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not reachable/);
  });
});

describe("dispatchChain", () => {
  it("folds modules in ui.order, threads output->input, and skips a failed one", async () => {
    const a = { name: "a", binding: "MODULE_A", hooks: ["finish"], ui: { order: 10 } } as unknown as RegisteredModule;
    const b = { name: "b", binding: "MODULE_B", hooks: ["finish"], ui: { order: 20 } } as unknown as RegisteredModule;
    const c = { name: "c", binding: "MODULE_C", hooks: ["finish"], ui: { order: 30 } } as unknown as RegisteredModule;
    const env = {
      MODULE_A: invoker((req) => ({ ok: true, output: { n: req.input.n + 1 } })),
      MODULE_B: { fetch: async () => new Response("err", { status: 500 }) },
      MODULE_C: invoker((req) => ({ ok: true, output: { n: req.input.n + 100 } })),
    };
    // pass out of declaration order to prove the ui.order sort drives the fold
    const res = await dispatchChain<{ n: number }, { n: number }>(
      env, [c, a, b], "finish", { n: 0 }, ctx, { nextInput: (prev) => ({ n: prev.n }) });
    expect(res.applied).toEqual(["a", "c"]); // b skipped (500)
    expect(res.output).toEqual({ n: 101 });  // a: 0 -> 1, c: 1 -> 101
    expect(res.errors).toHaveLength(1);
    expect(res.degraded).toEqual([]); // no soft-degrade reported
  });

  it("records a soft-degrade (ok:true with output.degraded) without treating it as a failure", async () => {
    // A module that returns ok:true but reports `degraded` passed its input through (e.g. its container
    // was unreachable). It counts as `applied` (it ran) AND `degraded` (it did nothing useful); it must
    // NOT be binned in `errors`. This is the generalized version of the film.finish-ships-uncarded fix.
    const a = { name: "a", binding: "MODULE_A", hooks: ["finish"], ui: { order: 10 } } as unknown as RegisteredModule;
    const b = { name: "b", binding: "MODULE_B", hooks: ["finish"], ui: { order: 20 } } as unknown as RegisteredModule;
    const env = {
      MODULE_A: invoker((req) => ({ ok: true, output: { n: req.input.n + 1, degraded: "passthrough:container-unreachable" } })),
      MODULE_B: invoker((req) => ({ ok: true, output: { n: req.input.n + 100 } })),
    };
    const res = await dispatchChain<{ n: number }, { n: number; degraded?: string }>(
      env, [a, b], "finish", { n: 0 }, ctx, { nextInput: (prev) => ({ n: prev.n }) });
    expect(res.applied).toEqual(["a", "b"]); // both ran
    expect(res.errors).toEqual([]);          // a degrade is NOT an error
    expect(res.degraded).toEqual(["a: passthrough:container-unreachable"]); // surfaced, module-prefixed
    expect(res.output).toEqual({ n: 101 });  // chain still threaded through
  });
});

// ----------------------------------------------------------------- readManifest transient retry
// A module dropped on a TRANSIENT manifest blip silently shortens a chain hook (e.g. the finish
// chain), changing the render output with no error -- the silent-showcase-render root cause. So a
// 5xx / network throw is retried; a 4xx or invalid manifest is a real error and is dropped at once.

/** A fetcher that yields `outcomes` in order. Each outcome is a status number (-> Response) or the
 *  string "throw" (-> rejected fetch, like a network/timeout). Counts the calls. */
function sequencedModule(outcomes: Array<number | "throw">, body: unknown = manifest()) {
  let i = 0;
  const calls = { n: 0 };
  const fetcher = {
    fetch: async () => {
      const outcome = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      calls.n += 1;
      if (outcome === "throw") throw new Error("network timeout");
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: outcome,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { fetcher, calls };
}

describe("readManifest transient retry", () => {
  it("retries a transient 503 then succeeds (module not dropped)", async () => {
    const { fetcher, calls } = sequencedModule([503, 200]);
    const m = await readManifest("MODULE_FINISH_LIPSYNC", fetcher);
    expect(m).toMatchObject({ name: "finish-rife", binding: "MODULE_FINISH_LIPSYNC" });
    expect(calls.n).toBe(2); // one retry
  });

  it("retries a thrown fetch (network/timeout) then succeeds", async () => {
    const { fetcher, calls } = sequencedModule(["throw", 200]);
    const m = await readManifest("MODULE_X", fetcher);
    expect(m).not.toBeNull();
    expect(calls.n).toBe(2);
  });

  it("gives up (null) after bounded attempts on a persistent transient error", async () => {
    const { fetcher, calls } = sequencedModule([503, 503, 503, 503]);
    const m = await readManifest("MODULE_X", fetcher);
    expect(m).toBeNull();
    expect(calls.n).toBe(3); // MANIFEST_READ_ATTEMPTS, no infinite loop
  });

  it("does NOT retry a 4xx (real, stable error) -- drops at once", async () => {
    const { fetcher, calls } = sequencedModule([404, 200]);
    const m = await readManifest("MODULE_X", fetcher);
    expect(m).toBeNull();
    expect(calls.n).toBe(1); // no retry on a 4xx
  });

  it("does NOT retry an invalid manifest (real error) -- drops at once", async () => {
    const { fetcher, calls } = sequencedModule([200], manifest({ hooks: ["teleport"] }));
    const m = await readManifest("MODULE_X", fetcher);
    expect(m).toBeNull();
    expect(calls.n).toBe(1);
  });
});

// ---- locality classification (S6 debt sprint: locality-driven, never name-matched) -----------

describe("locality classification helpers", () => {
  const motion = (name: string, order: number, locality?: "local" | "byo" | "cloud") =>
    ({ name, binding: `MODULE_${name.toUpperCase()}`, hooks: ["motion.backend"], config_schema: {},
       ui: { order, ...(locality ? { locality } : {}) } }) as unknown as RegisteredModule;
  const fleet = [
    motion("local-gpu", 4, "local"),
    motion("own-gpu", 5, "byo"),
    motion("seedance", 10, "cloud"),
    motion("kling", 20, "cloud"),
    motion("mystery", 30), // no declared locality
  ];

  it("cloudMotionModules: locality cloud only; undeclared counts cloud; NEVER the doors", () => {
    expect(cloudMotionModules(fleet).map((m) => m.name)).toEqual(["seedance", "kling", "mystery"]);
  });

  it("gpuDoorMotionModules: byo + local, order-sorted", () => {
    expect(gpuDoorMotionModules(fleet).map((m) => m.name)).toEqual(["local-gpu", "own-gpu"]);
  });

  it("defaultGpuDoorModule: byo preferred over an order-earlier local door", () => {
    expect(defaultGpuDoorModule(fleet)?.name).toBe("own-gpu");
  });

  it("defaultGpuDoorModule: falls back to the local door when it is the only door", () => {
    expect(defaultGpuDoorModule([motion("local-gpu", 4, "local"), motion("seedance", 10, "cloud")])?.name).toBe("local-gpu");
  });

  it("defaultGpuDoorModule: undefined when no gpu door is installed (callers fail honestly)", () => {
    expect(defaultGpuDoorModule([motion("seedance", 10, "cloud")])).toBeUndefined();
  });
});

describe("validateManifest: finish_artifacts shape (optional, but malformed rejects)", () => {
  const base = { name: "m", version: "1", api: "vivijure-module/2", hooks: ["finish"] };
  const v = (finish_artifacts: unknown) => validateManifest({ ...base, finish_artifacts });

  it("absent is fine; both valid output_key kinds pass; applied rules pass", () => {
    expect(typeof validateManifest(base)).not.toBe("string");
    expect(typeof v({ output_key: { kind: "shot_named", filename: "_f.mp4" } })).not.toBe("string");
    expect(typeof v({
      output_key: { kind: "append_suffix", suffix: "_ls" },
      applied: [{ when: { knob: "interpolate", equals: false }, tag: "noop" }, { tag: "x:{y|2}" }],
    })).not.toBe("string");
  });

  it("malformed shapes reject with a reason", () => {
    expect(v({})).toMatch(/output_key missing/);
    expect(v({ output_key: { kind: "banana" } })).toMatch(/kind/);
    expect(v({ output_key: { kind: "shot_named" } })).toMatch(/filename/);
    expect(v({ output_key: { kind: "append_suffix", suffix: "" } })).toMatch(/suffix/);
    expect(v({ output_key: { kind: "shot_named", filename: "_f" }, applied: "nope" })).toMatch(/not an array/);
    expect(v({ output_key: { kind: "shot_named", filename: "_f" }, applied: [{ tag: "" }] })).toMatch(/missing tag/);
    expect(v({ output_key: { kind: "shot_named", filename: "_f" }, applied: [{ tag: "t", when: { knob: "" } }] })).toMatch(/when/);
  });
});

describe("validateManifest: keyframe_label (optional, but malformed rejects)", () => {
  const base = { name: "m", version: "1", api: "vivijure-module/2", hooks: ["keyframe"] };
  const v = (keyframe_label: unknown) => validateManifest({ ...base, keyframe_label });

  it("absent is fine; a non-empty string passes and survives to the typed manifest", () => {
    expect(typeof validateManifest(base)).not.toBe("string");
    expect(v("SDXL")).toMatchObject({ name: "m", keyframe_label: "SDXL" });
  });

  it("present-but-malformed rejects with a reason", () => {
    expect(v("")).toMatch(/keyframe_label must be a non-empty string/);
    expect(v("   ")).toMatch(/keyframe_label must be a non-empty string/);
    expect(v(42)).toMatch(/keyframe_label must be a non-empty string/);
    expect(v({ text: "SDXL" })).toMatch(/keyframe_label must be a non-empty string/);
    expect(v(null)).toMatch(/keyframe_label must be a non-empty string/);
  });
});
