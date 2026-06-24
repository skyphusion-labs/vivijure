import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

// Regression test for #143: POST /api/storyboard/plan with no `characters` field in the request
// body must not throw "TypeError: characters is not iterable". Before the fix, hPlan passed the
// raw body to planStoryboard() which handed it to buildPlanningUserMessage(), which spread
// `undefined` and crashed with a 500. After the fix, hPlan defaults characters to [] before the
// call, so the handler returns a structured error rather than throwing.

function makeEnv() {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: {
      fetch: async () => new Response("ASSET", { status: 200 }),
    },
  } as unknown as Env;
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const planReq = (body: Record<string, unknown>) =>
  new Request("https://studio.example/api/storyboard/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("hPlan (#143 regression)", () => {
  it("omitting characters entirely does not throw (returns structured error, not 500)", async () => {
    const env = makeEnv();
    // Use a model id that is not in the planning catalog so planStoryboard
    // returns { ok: false } immediately without any network call.
    const res = await worker.fetch(
      planReq({ brief: "a short film", model: "nonexistent/model" }),
      env,
      ctx,
    );
    // Was 500 (uncaught throw) before the fix; must be 422 (structured planning error) after.
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors?: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors).toBeDefined();
  });

  it("sending characters: null also does not throw", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      planReq({ brief: "a short film", model: "nonexistent/model", characters: null }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("sending an empty characters array is also valid", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      planReq({ brief: "a short film", model: "nonexistent/model", characters: [] }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("missing brief still gets a 400 bad request, not a 500", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      planReq({ model: "nonexistent/model" }), // no brief, no characters
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
