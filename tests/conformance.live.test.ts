// Live module conformance: opt-in (runs only when MODULE_URL is set), so it stays out of CI but
// lets anyone point the harness at a deployed module worker:
//   MODULE_URL=https://my-module.example.workers.dev npx vitest run tests/conformance.live.test.ts
import { describe, it, expect } from "vitest";
import { checkManifest, checkInvokeResponse, allPass, failures } from "../src/modules/conformance";

const BASE = process.env.MODULE_URL;

describe.skipIf(!BASE)("live module conformance (" + (BASE || "set MODULE_URL") + ")", () => {
  it("serves a conformant manifest at GET /module.json", async () => {
    const manifest = await (await fetch(BASE + "/module.json")).json();
    const checks = checkManifest(manifest);
    expect(allPass(checks), JSON.stringify(failures(checks))).toBe(true);
  });

  it("returns a well-formed InvokeResponse for its first hook", async () => {
    const manifest = (await (await fetch(BASE + "/module.json")).json()) as { hooks: string[] };
    const body = {
      hook: manifest.hooks[0],
      input: { storyboard: { scenes: [{ prompt: "a quiet street at night" }] } },
      config: {},
      context: { project: "conformance", job_id: "c1" },
    };
    const res = await fetch(BASE + "/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(checkInvokeResponse(await res.json()).pass).toBe(true);
  });

  it("degrades on a bad request (HTTP 200 + ok:false, never a crash)", async () => {
    const res = await fetch(BASE + "/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook: "not.a.real.hook", input: {}, config: {}, context: { project: "c", job_id: "c2" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(checkInvokeResponse(body).pass).toBe(true);
    expect((body as { ok: boolean }).ok).toBe(false);
  });
});
