// Module conformance harness (vivijure-module/1).
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

import { MODULE_API } from "./types";
import { validateManifest } from "./registry";

export interface ConformanceCheck {
  name: string;
  pass: boolean;
  detail: string;
}

const ok = (name: string, detail = "ok"): ConformanceCheck => ({ name, pass: true, detail });
const bad = (name: string, detail: string): ConformanceCheck => ({ name, pass: false, detail });

const FIELD_TYPES = ["int", "float", "bool", "enum", "string"];

/** One config_schema field has a valid type and a default consistent with that type. */
function checkConfigField(key: string, f: unknown): ConformanceCheck {
  const label = "config." + key;
  if (!f || typeof f !== "object") return bad(label, "field is not an object");
  const ff = f as Record<string, unknown>;
  const t = ff.type;
  if (typeof t !== "string" || !FIELD_TYPES.includes(t)) return bad(label, "bad field type " + String(t));
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
  checks.push(m.api === MODULE_API ? ok("api-version", m.api) : bad("api-version", m.api + " != " + MODULE_API));
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

/** True iff every check passed. */
export function allPass(checks: ConformanceCheck[]): boolean {
  return checks.every((c) => c.pass);
}

/** The failed checks, for a concise report. */
export function failures(checks: ConformanceCheck[]): ConformanceCheck[] {
  return checks.filter((c) => !c.pass);
}
