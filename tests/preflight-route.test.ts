import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { checkCastBindingsReady, checkStoryboardShape, summarize } from "../src/preflight";

// Regression coverage for #242: /api/storyboard/preflight used to validate the
// whole request body (so it read `.title`/`.scenes` off the { storyboard,
// castBindings } envelope = undefined) and returned HTTP 400 on every valid
// storyboard, which made the client throw and show only "HTTP 400". The route
// now unwraps `.storyboard`, runs the real preflight (shape + cast readiness),
// and returns a PreflightResult { ok, counts, issues } at HTTP 200 -- errors are
// data, not an HTTP failure.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(castRows: unknown[] = []): Env {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: castRows }) }),
      }),
    },
  } as unknown as Env;
}

const post = (body: unknown) =>
  new Request("https://studio.example/api/storyboard/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const validStoryboard = {
  title: "neon_handoff",
  scenes: [
    { id: "shot_01", prompt: "a wide shot of a rain-soaked neon alley at night" },
    { id: "shot_02", prompt: "a close-up of the data handoff between two robots" },
  ],
};

interface PreflightResp {
  ok: boolean;
  counts: { error: number; warning: number; info: number };
  issues: Array<{ level: string; scope: string; message: string }>;
}

describe("POST /api/storyboard/preflight route (#242)", () => {
  it("unwraps the { storyboard, castBindings } envelope and returns ok:true at 200", async () => {
    const res = await worker.fetch(post({ storyboard: validStoryboard, castBindings: {} }), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    expect(body.ok).toBe(true);
    expect(body.counts.error).toBe(0);
  });

  it("regression: the exact old-bug payload no longer 400s (envelope is unwrapped, not validated whole)", async () => {
    // Before #242 this returned 400 {ok:false, errors:["title is required...","scenes ... undefined"]}.
    const res = await worker.fetch(post({ storyboard: validStoryboard, castBindings: { A: 1 } }), makeEnv(), ctx);
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    // castBindings A:1 -> no such cast member in an empty catalog -> that's the only error.
    expect(body.issues.every((i) => i.scope !== "storyboard")).toBe(true);
  });

  it("surfaces a missing title as a structured error at 200 (not a thrown 400)", async () => {
    const res = await worker.fetch(post({ storyboard: { scenes: validStoryboard.scenes } }), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    expect(body.ok).toBe(false);
    expect(body.counts.error).toBeGreaterThan(0);
    const titleIssue = body.issues.find((i) => /title/i.test(i.message));
    expect(titleIssue).toBeTruthy();
    expect(titleIssue!.level).toBe("error");
    expect(titleIssue!.scope).toBe("storyboard");
  });

  it("surfaces missing scenes as a structured error at 200", async () => {
    const res = await worker.fetch(post({ storyboard: { title: "x" } }), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    expect(body.ok).toBe(false);
    expect(body.issues.some((i) => /scenes/i.test(i.message))).toBe(true);
  });

  it("folds castBindings into cast-readiness: a bound member with no portrait/refs errors", async () => {
    const castRow = {
      id: 7, user_email: "u@x", slug: "vex", name: "Detective Vex", bible: "",
      portrait_key: null, portrait_mime: null,
      ref_keys_json: "[]", source_keys_json: "[]",
      created_at: "", updated_at: "",
      lora_key: null, lora_status: "idle", lora_job_id: null, lora_error: null,
      lora_trained_at: null, voice_id: null,
    };
    const res = await worker.fetch(
      post({ storyboard: validStoryboard, castBindings: { A: 7 } }),
      makeEnv([castRow]),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    expect(body.ok).toBe(false);
    expect(body.issues.some((i) => i.scope === "cast[A]" && /portrait/i.test(i.message))).toBe(true);
    expect(body.issues.some((i) => i.scope === "cast[A]" && /refs/i.test(i.message))).toBe(true);
  });
});

describe("preflight.ts pure checks", () => {
  it("checkCastBindingsReady: null bindings produce no issues", () => {
    expect(checkCastBindingsReady(null, [])).toEqual([]);
  });

  it("checkCastBindingsReady: missing member is an error; sparse refs is a warning", () => {
    const missing = checkCastBindingsReady({ A: 99 }, []);
    expect(missing[0].level).toBe("error");

    const sparse = checkCastBindingsReady(
      { A: 1 },
      [{ id: 1, name: "Kit", portrait_key: "p.png", ref_keys: [{ key: "r1.png" }] }],
    );
    expect(sparse.some((i) => i.level === "warning" && /refs/i.test(i.message))).toBe(true);
  });

  it("summarize: ok only when there are zero errors", () => {
    expect(summarize([]).ok).toBe(true);
    expect(summarize([{ level: "warning", scope: "s", message: "m" }]).ok).toBe(true);
    expect(summarize([{ level: "error", scope: "s", message: "m" }]).ok).toBe(false);
    expect(checkStoryboardShape({ scenes: [] })[0]).toMatchObject({ level: "error", scope: "scenes" });
  });
});
