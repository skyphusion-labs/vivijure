import { describe, it, expect } from "vitest";
import { checkManifest, checkInvokeResponse, allPass, failures } from "../src/modules/conformance";

const goodManifest = {
  name: "demo",
  version: "1.0.0",
  api: "vivijure-module/1",
  hooks: ["finish"],
  provides: [{ id: "x", label: "X" }],
  config_schema: {
    n: { type: "int", default: 2, min: 1, max: 4 },
    flag: { type: "bool", default: true },
    mode: { type: "enum", values: ["a", "b"], default: "a" },
  },
};

describe("conformance: manifest", () => {
  it("passes a well-formed manifest", () => {
    const checks = checkManifest(goodManifest);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });

  it("fails an unknown api version", () => {
    const checks = checkManifest({ ...goodManifest, api: "vivijure-module/9" });
    expect(allPass(checks)).toBe(false);
  });

  it("fails an unknown hook", () => {
    const checks = checkManifest({ ...goodManifest, hooks: ["finish", "bogus"] });
    expect(allPass(checks)).toBe(false);
  });

  it("fails a config field whose default does not match its type", () => {
    const checks = checkManifest({ ...goodManifest, config_schema: { n: { type: "int", default: "two" } } });
    expect(allPass(checks)).toBe(false);
  });

  it("fails an enum default outside its values", () => {
    const checks = checkManifest({ ...goodManifest, config_schema: { mode: { type: "enum", values: ["a", "b"], default: "c" } } });
    expect(allPass(checks)).toBe(false);
  });

  it("fails a provides entry missing a label", () => {
    const checks = checkManifest({ ...goodManifest, provides: [{ id: "x" }] });
    expect(allPass(checks)).toBe(false);
  });
});

describe("conformance: invoke response", () => {
  it("accepts ok:true with output", () => {
    expect(checkInvokeResponse({ ok: true, output: { storyboard: {} } }).pass).toBe(true);
  });
  it("accepts ok:false with an error string", () => {
    expect(checkInvokeResponse({ ok: false, error: "nope" }).pass).toBe(true);
  });
  it("rejects ok:true with no output", () => {
    expect(checkInvokeResponse({ ok: true }).pass).toBe(false);
  });
  it("rejects ok:false with no error string", () => {
    expect(checkInvokeResponse({ ok: false }).pass).toBe(false);
  });
  it("rejects a body with no boolean ok", () => {
    expect(checkInvokeResponse({ output: {} }).pass).toBe(false);
    expect(checkInvokeResponse(null).pass).toBe(false);
  });
});
