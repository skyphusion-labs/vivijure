import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { checkCastBindingsReady, checkDurationGrid, checkStoryboardShape, resolveCastBindings, summarize } from "../src/preflight";
import { MODULE_API } from "../src/modules/types";
import { _resetModuleDiscoveryCache } from "../src/modules/registry";

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

// #707: a fixed-grid motion backend (pinned fps + per-tier frame caps) clamps a shot's requested
// duration at render time; preflight must warn at storyboard time instead of the clamp staying
// silent until the clip lands short. Warning, never an error: clamping is legitimate, silence is the bug.
describe("checkDurationGrid pure check (#707)", () => {
  const GRID = { fps: 8, tiers: { draft: { max_frames: 25 }, standard: { max_frames: 49 }, final: { max_frames: 49 } } };
  const board = (seconds: number) => ({
    title: "t",
    scenes: [{ id: "shot_01", prompt: "a long enough prompt here", target_seconds: seconds }],
  });

  it("warns when the planned seconds exceed the named tier's grid (5s vs draft 25f@8fps=3.125s)", () => {
    const issues = checkDurationGrid(board(5), GRID, "draft", "local-gpu");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: "warning", scope: "scene[shot_01]" });
    expect(issues[0].message).toContain("5s");
    expect(issues[0].message).toContain("3.125s");
    expect(issues[0].message).toContain("draft");
    expect(issues[0].message).toContain("local-gpu");
    expect(issues[0].message).toContain("clamped");
  });

  it("stays quiet when the plan fits the tier (5s vs standard 49f@8fps=6.125s)", () => {
    expect(checkDurationGrid(board(5), GRID, "standard", "local-gpu")).toEqual([]);
  });

  // #751: with the duration-floor fraction passed, a clamp that would breach the #697 gate must
  // escalate from a "clip will be clamped" warning to an `error` (guaranteed hard-fail), so preflight
  // blocks a submit that cannot succeed instead of saying "unblocked".
  it("ESCALATES to error when the clamp breaches the duration floor (7s vs draft 3.125s, floor 0.5 -> 3.5s)", () => {
    const issues = checkDurationGrid(board(7), GRID, "draft", "local-gpu", 0.5);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: "error", scope: "scene[shot_01]" });
    expect(issues[0].message).toContain("duration floor");
    expect(issues[0].message).toContain("would fail the duration gate");
    expect(issues[0].message).toContain("3.125s"); // the actionable target
  });

  it("stays a WARNING when the clamp is within the floor (5s vs draft 3.125s, floor 0.5 -> 2.5s: 3.125 >= 2.5)", () => {
    const issues = checkDurationGrid(board(5), GRID, "draft", "local-gpu", 0.5);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
    expect(issues[0].message).toContain("clamped");
  });

  it("floor 0 (gate disabled) never escalates -- every clamp stays a warning", () => {
    const issues = checkDurationGrid(board(7), GRID, "draft", "local-gpu", 0);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });

  it("omitting the floor (pure-function / older callers) keeps the pre-#751 warning-only behavior", () => {
    const issues = checkDurationGrid(board(7), GRID, "draft", "local-gpu");
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });

  it("with NO named tier, warns only past the LOOSEST cap (no false alarms on an unknown tier)", () => {
    expect(checkDurationGrid(board(5), GRID, null, "local-gpu")).toEqual([]); // fits the 6.125s loosest cap
    const issues = checkDurationGrid(board(8), GRID, null, "local-gpu");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("even at its largest tier");
  });

  it("an UNDECLARED named tier falls back to the loosest cap, not a fabricated per-tier claim", () => {
    expect(checkDurationGrid(board(5), GRID, "turbo", "local-gpu")).toEqual([]);
    expect(checkDurationGrid(board(8), GRID, "turbo", "local-gpu")).toHaveLength(1);
  });

  it("falls back to the storyboard clip_seconds default when a scene has no target_seconds", () => {
    const sb = { title: "t", clip_seconds: 5, scenes: [{ id: "shot_01", prompt: "a long enough prompt here" }] };
    expect(checkDurationGrid(sb, GRID, "draft", "local-gpu")).toHaveLength(1);
  });

  it("no grid / malformed grid -> no issues (absence is honest, nothing fabricated)", () => {
    expect(checkDurationGrid(board(60), null, "draft")).toEqual([]);
    expect(checkDurationGrid(board(60), undefined, "draft")).toEqual([]);
    expect(checkDurationGrid(board(60), { fps: 0, tiers: GRID.tiers }, "draft")).toEqual([]);
    expect(checkDurationGrid(board(60), { fps: 8, tiers: {} }, "draft")).toEqual([]);
  });
});

describe("POST /api/storyboard/preflight duration-grid wiring (#707)", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  const LOCAL_GPU_MANIFEST = {
    name: "local-gpu", version: "0.1.1", api: MODULE_API, hooks: ["motion.backend"],
    duration_grid: { fps: 8, tiers: { draft: { max_frames: 25 }, standard: { max_frames: 49 }, final: { max_frames: 49 } } },
  };
  const NO_GRID_MANIFEST = { name: "own-gpu", version: "1.0.0", api: MODULE_API, hooks: ["motion.backend"] };

  function moduleEnv(): Env {
    const respond = (m: unknown) => async () =>
      new Response(JSON.stringify(m), { status: 200, headers: { "content-type": "application/json" } });
    return {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
      MODULE_LOCAL_GPU: { fetch: respond(LOCAL_GPU_MANIFEST) },
      MODULE_OWN_GPU: { fetch: respond(NO_GRID_MANIFEST) },
    } as unknown as Env;
  }

  const fiveSecondBoard = {
    title: "grid_check",
    scenes: [{ id: "shot_01", prompt: "a wide neon alley in the rain at night", target_seconds: 5 }],
  };

  it("warns per shot when the named backend declares a grid the plan exceeds", async () => {
    const res = await worker.fetch(
      post({ storyboard: fiveSecondBoard, motionBackend: "local-gpu", quality: "draft" }),
      moduleEnv(), ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    expect(body.ok).toBe(true); // a clamp is a WARNING, never a submit-blocking error
    const w = body.issues.find((i) => i.scope === "scene[shot_01]" && /clamped/.test(i.message));
    expect(w).toBeTruthy();
    expect(w!.level).toBe("warning");
  });

  it("no warning when the backend declares no grid, or when no backend is named (older client)", async () => {
    const noGrid = await worker.fetch(
      post({ storyboard: fiveSecondBoard, motionBackend: "own-gpu", quality: "draft" }),
      moduleEnv(), ctx,
    );
    expect(((await noGrid.json()) as PreflightResp).issues.filter((i) => /clamped/.test(i.message))).toEqual([]);

    const legacy = await worker.fetch(post({ storyboard: fiveSecondBoard }), moduleEnv(), ctx);
    expect(((await legacy.json()) as PreflightResp).issues.filter((i) => /clamped/.test(i.message))).toEqual([]);
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


// #576: castBindings values arrive as the cast PUBLIC id (the UUID the API returns
// as `id`), the internal numeric row id, or a numeric string. The route resolves all
// three to the numeric row id before the numeric-keyed cast-readiness check, and an
// unresolved value gets an error that names WHY (unknown id vs wrong kind) instead of
// the misleading old "cast id <uuid> which no longer exists".
describe("POST /api/storyboard/preflight castBindings id resolution (#576)", () => {
  const readyRow = {
    id: 7, public_id: "cast-7-uuid", slug: "vex", name: "Detective Vex", bible: "",
    portrait_key: "vex/portrait.png", portrait_mime: "image/png",
    ref_keys_json: JSON.stringify([
      { key: "vex/r1.png", mime: "image/png" },
      { key: "vex/r2.png", mime: "image/png" },
      { key: "vex/r3.png", mime: "image/png" },
      { key: "vex/r4.png", mime: "image/png" },
    ]),
    source_keys_json: "[]",
    created_at: "", updated_at: "",
    lora_key: null, lora_status: "idle", lora_job_id: null, lora_error: null,
    lora_trained_at: null, voice_id: null,
  };

  it("binds a slot by the cast PUBLIC id (UUID) the API handed out", async () => {
    const res = await worker.fetch(
      post({ storyboard: validStoryboard, castBindings: { A: "cast-7-uuid" } }),
      makeEnv([readyRow]),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    // A ready member (portrait + 4 refs) resolved from its UUID -> zero cast errors.
    expect(body.issues.some((i) => i.scope === "cast[A]")).toBe(false);
    expect(body.ok).toBe(true);
  });

  it("binds a slot by the numeric row id (backward compatible)", async () => {
    const res = await worker.fetch(
      post({ storyboard: validStoryboard, castBindings: { A: 7 } }),
      makeEnv([readyRow]),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    expect(body.issues.some((i) => i.scope === "cast[A]")).toBe(false);
    expect(body.ok).toBe(true);
  });

  it("an unknown UUID errors as an unknown public id, not 'no longer exists'", async () => {
    const res = await worker.fetch(
      post({ storyboard: validStoryboard, castBindings: { A: "cast-nope-uuid" } }),
      makeEnv([readyRow]),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    const issue = body.issues.find((i) => i.scope === "cast[A]");
    expect(issue).toBeTruthy();
    expect(issue!.level).toBe("error");
    expect(issue!.message).toMatch(/unknown cast id/i);
    expect(issue!.message).toMatch(/public id/i);
    expect(issue!.message).not.toMatch(/no longer exists/i);
  });

  it("an unknown numeric id errors as an unknown numeric id", async () => {
    const res = await worker.fetch(
      post({ storyboard: validStoryboard, castBindings: { A: 999 } }),
      makeEnv([readyRow]),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreflightResp;
    const issue = body.issues.find((i) => i.scope === "cast[A]");
    expect(issue).toBeTruthy();
    expect(issue!.level).toBe("error");
    expect(issue!.message).toMatch(/unknown cast id 999/i);
    expect(issue!.message).toMatch(/numeric id/i);
    expect(issue!.message).not.toMatch(/no longer exists/i);
  });
});

describe("resolveCastBindings pure resolver (#576)", () => {
  const catalog = [
    { id: 5, public_id: "u-five" },
    { id: 6, public_id: "u-six" },
  ];

  it("null/undefined bindings resolve to empty", () => {
    expect(resolveCastBindings(null, catalog)).toEqual({ resolved: {}, unresolved: [] });
    expect(resolveCastBindings(undefined, catalog)).toEqual({ resolved: {}, unresolved: [] });
  });

  it("resolves a public UUID to its numeric row id", () => {
    const r = resolveCastBindings({ A: "u-five" }, catalog);
    expect(r.resolved).toEqual({ A: 5 });
    expect(r.unresolved).toEqual([]);
  });

  it("passes a numeric row id through, and a numeric string form of one", () => {
    expect(resolveCastBindings({ A: 6 }, catalog).resolved).toEqual({ A: 6 });
    expect(resolveCastBindings({ A: "6" }, catalog).resolved).toEqual({ A: 6 });
  });

  it("an unknown UUID is an unresolved error naming the public id", () => {
    const r = resolveCastBindings({ A: "u-missing" }, catalog);
    expect(r.resolved).toEqual({});
    expect(r.unresolved[0].level).toBe("error");
    expect(r.unresolved[0].scope).toBe("cast[A]");
    expect(r.unresolved[0].message).toMatch(/public id/i);
  });

  it("an unknown numeric id is an unresolved error naming the numeric id", () => {
    const r = resolveCastBindings({ A: 42 }, catalog);
    expect(r.resolved).toEqual({});
    expect(r.unresolved[0].message).toMatch(/unknown cast id 42/i);
    expect(r.unresolved[0].message).toMatch(/numeric id/i);
  });

  it("a non-number, non-string value is a wrong-kind error", () => {
    const r = resolveCastBindings({ A: true as unknown } as Record<string, unknown>, catalog);
    expect(r.resolved).toEqual({});
    expect(r.unresolved[0].message).toMatch(/invalid cast id/i);
    expect(r.unresolved[0].message).toMatch(/boolean/i);
  });
});
