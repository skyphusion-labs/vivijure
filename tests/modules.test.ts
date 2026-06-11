import { describe, expect, it } from "vitest";

import {
  discoverModules,
  indexByHook,
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
  it("wraps the registry with the api version and hook index", () => {
    const mods = [{ name: "x", hooks: ["finish"] }] as unknown as RegisteredModule[];
    const r = modulesResponse(mods);
    expect(r.api).toBe(MODULE_API);
    expect(r.modules).toHaveLength(1);
    expect(r.hooks.finish).toEqual(["x"]);
  });
  it("is a clean, lean studio when nothing is installed", () => {
    const r = modulesResponse([]);
    expect(r.modules).toEqual([]);
    expect(r.hooks).toEqual({});
  });
  it("serves the static hook catalog (name + blurb + cardinality), independent of installs", () => {
    const r = modulesResponse([]);
    expect(r.catalog.map((h) => h.name)).toEqual([
      "motion.backend", "finish", "score", "plan.enhance",
    ]);
    expect(r.catalog.find((h) => h.name === "motion.backend")?.cardinality).toBe("pick_one");
    expect(r.catalog.find((h) => h.name === "finish")?.cardinality).toBe("chain");
    expect(r.catalog.every((h) => h.blurb.length > 0)).toBe(true);
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
