import { describe, it, expect } from "vitest";
import { resolveRenderPipeline } from "../src/modules/render-pipeline";
import type { RegisteredModule } from "../src/modules/types";

const mod = (over: Partial<RegisteredModule>): RegisteredModule => ({
  name: "m",
  version: "1.0.0",
  api: "vivijure-module/2",
  hooks: [],
  binding: "MODULE_M",
  ...over,
});

const seedance = mod({
  name: "cloud-seedance", binding: "MODULE_SEEDANCE", hooks: ["motion.backend"], ui: { order: 10 },
  config_schema: { steps: { type: "int", default: 20, min: 4, max: 50 } },
});
const wan = mod({ name: "gpu-wan", binding: "MODULE_WAN", hooks: ["motion.backend"], ui: { order: 20 } });
const rife = mod({
  name: "rife", binding: "MODULE_RIFE", hooks: ["finish"], ui: { order: 10 },
  config_schema: { factor: { type: "enum", values: ["2x", "4x"], default: "2x" } },
});
const gfpgan = mod({ name: "gfpgan", binding: "MODULE_GFPGAN", hooks: ["finish"], ui: { order: 20 } });

describe("resolveRenderPipeline", () => {
  it("returns an empty plan when nothing is installed", () => {
    const p = resolveRenderPipeline([]);
    expect(p.motion_backend).toBeNull();
    expect(p.finish).toEqual([]);
    expect(p.score).toEqual([]);
  });

  it("picks the first motion.backend by default and folds the finish chain in ui.order", () => {
    const p = resolveRenderPipeline([gfpgan, wan, rife, seedance]);
    expect(p.motion_backend?.name).toBe("cloud-seedance"); // order 10 before gpu-wan order 20
    expect(p.finish.map((m) => m.name)).toEqual(["rife", "gfpgan"]); // ui.order
    expect(p.score).toEqual([]);
  });

  it("honors an explicit motion.backend choice", () => {
    const p = resolveRenderPipeline([seedance, wan], { motion_backend_choice: "gpu-wan" });
    expect(p.motion_backend?.name).toBe("gpu-wan");
  });

  it("clamps each module config against its schema", () => {
    const p = resolveRenderPipeline([seedance, rife], {
      config: { "cloud-seedance": { steps: 999 }, rife: { factor: "8x" } },
    });
    expect(p.motion_backend?.config.steps).toBe(50); // clamped to max
    expect(p.finish[0].config.factor).toBe("2x"); // bad enum -> default
  });

  it("carries the binding through so a downstream invoker can reach the module", () => {
    const p = resolveRenderPipeline([seedance]);
    expect(p.motion_backend?.binding).toBe("MODULE_SEEDANCE");
  });
});
