import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

// Regression coverage for #731: the authoring helpers turned contract-valid
// (or merely wrong) input into 500s.
// - POST /api/storyboard/yaml cast the RAW client storyboard to the validator's
//   normalized shape; quote()/emitSlotList() then threw on absent optional
//   fields (full_prompt, style_prefix, use_characters, ...), so a schema-valid
//   minimal storyboard was answered "500 internal error".
// - POST /api/storyboard/markers had no format-enum check; an out-of-enum
//   format fell through emitMarkers' switch to undefined and the handler's
//   out.body dereference threw.
// Both are user-input problems and per CONTRACT 2.0 must be 400s, never 500s.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
} as unknown as Env;

const post = (path: string, body: unknown) =>
  new Request(`https://studio.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// Schema-valid but non-normalized: every optional top-level field absent.
const minimalStoryboard = {
  title: "s40_minimal",
  scenes: [{ id: "shot_01", prompt: "a red kite over dunes at golden hour" }],
};

describe("POST /api/storyboard/yaml (#731)", () => {
  it("serializes a schema-valid minimal storyboard at 200 (was 500)", async () => {
    const res = await worker.fetch(post("/api/storyboard/yaml", { storyboard: minimalStoryboard }), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; yaml: string };
    expect(body.ok).toBe(true);
    expect(body.yaml).toContain('title: "s40_minimal"');
    expect(body.yaml).toContain("scenes:");
  });

  it("400s with the shape errors on an invalid storyboard (was 500)", async () => {
    const res = await worker.fetch(post("/api/storyboard/yaml", { storyboard: { nope: true } }), env, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("storyboard invalid");
    expect(body.error).toContain("title is required");
  });

  it("keeps the missing-storyboard 400", async () => {
    const res = await worker.fetch(post("/api/storyboard/yaml", {}), env, ctx);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/storyboard/markers (#731)", () => {
  it("400s naming the enum on an unknown format (was 500)", async () => {
    const res = await worker.fetch(
      post("/api/storyboard/markers", { storyboard: minimalStoryboard, format: "nope" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("format must be one of: premiere_csv, resolve_csv");
  });

  it("still serves a premiere_csv attachment for a valid format", async () => {
    const res = await worker.fetch(
      post("/api/storyboard/markers", { storyboard: minimalStoryboard, format: "premiere_csv" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });
});
