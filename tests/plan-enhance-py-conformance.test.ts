// Static conformance for the Python plan-enhance-py module (vivijure-module/1).
//
// The Python Worker can't run under vitest (it needs the Pyodide runtime), so this validates the
// module's CONTRACT artifacts -- its manifest and the InvokeResponse shapes its pure logic produces --
// against the SAME conformance harness the live runner uses. The Python pure logic is exercised
// separately in CPython (see the module's local round-trip); here we prove it honors vivijure-module/1.
//
// The manifest + sample outputs below are copied verbatim from modules/plan-enhance-py (MANIFEST in
// src/entry.py; run_enhance in src/enhance.py). A drift between these and the Python source would be a
// real contract break, which is exactly what this guards on the TS/CI side.
import { describe, it, expect } from "vitest";
import { checkManifest, checkInvokeResponse, checkHookOutput, allPass, failures } from "../src/modules/conformance";

// --- mirrors modules/plan-enhance-py/src/entry.py MANIFEST ---
const MANIFEST = {
  name: "plan-enhance-py",
  version: "0.1.0",
  api: "vivijure-module/1",
  hooks: ["plan.enhance"],
  provides: [{ id: "auto-direction-py", label: "Rule-based auto-direction (Python)" }],
  config_schema: {
    intensity: { type: "enum", values: ["light", "medium", "bold"], default: "medium", label: "direction intensity" },
  },
  ui: { section: "plan", order: 11 },
};

// --- mirrors run_enhance() output shapes (modules/plan-enhance-py/src/enhance.py) ---
const INVOKE_OK = {
  ok: true,
  output: {
    storyboard: { scenes: [{ prompt: "a quiet street at night, cinematic lighting, shallow depth of field, deliberate camera move" }] },
    notes: ["enhanced 1 shot(s) at medium intensity (python module)"],
  },
};
const INVOKE_BAD = { ok: false, error: "plan.enhance: input.storyboard has no scenes" };

describe("plan-enhance-py conformance (vivijure-module/1)", () => {
  it("serves a conformant manifest", () => {
    const checks = checkManifest(MANIFEST);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });

  it("its success InvokeResponse is a well-formed envelope", () => {
    expect(checkInvokeResponse(INVOKE_OK).pass).toBe(true);
  });

  it("its plan.enhance output payload honors the hook contract", () => {
    const c = checkHookOutput("plan.enhance", INVOKE_OK.output);
    expect(c.pass, c.detail).toBe(true);
  });

  it("degrades on a bad request as DATA (ok:false + string error)", () => {
    expect(checkInvokeResponse(INVOKE_BAD).pass).toBe(true);
    expect(INVOKE_BAD.ok).toBe(false);
  });
});
