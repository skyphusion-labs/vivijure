import { describe, it, expect, vi } from "vitest";
import { callVideoFinishInspect, contentValidateDoneClips, type ContentVerdict } from "../src/clip-content-validate";
import type { ClipJob, ClipShot } from "../src/render-orchestrator";
import type { Env } from "../src/env";

function jr(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function doneShot(id: string, over: Partial<ClipShot> = {}): ClipShot {
  return { shot_id: id, keyframe_url: "u", keyframe_key: `renders/p/keyframes/${id}.png`, prompt: "x", seconds: 4, status: "done", clip_key: `renders/p/clips/${id}_i2v.mp4`, ...over };
}
function job(shots: ClipShot[]): ClipJob {
  return { job_id: "clips-x", project: "p", motion_backend: "own-gpu", binding: "MODULE_OWN_GPU", created_at: 0, shots };
}
const withVpc = (fetch: (url: string, init: RequestInit) => Promise<Response>): Env =>
  ({ VIDEO_FINISH_VPC: { fetch: (u: string, i: RequestInit) => fetch(u, i) } } as unknown as Env);
const noVpc = (): Env => ({} as unknown as Env);

describe("callVideoFinishInspect (container round-trip)", () => {
  it("returns null when the tier is not installed (self-host): never fails a render", async () => {
    const r = await callVideoFinishInspect(noVpc(), { clipUrl: "https://r2/clip" });
    expect(r).toBeNull();
  });
  it("parses a verdict from the container", async () => {
    const r = await callVideoFinishInspect(withVpc(async () => jr({ ok: true, verdict: "corrupt", reason: "no keyframe match" })), { clipUrl: "https://r2/clip" });
    expect(r).toMatchObject({ ok: true, verdict: "corrupt" });
  });
  it("returns null on an unreachable container (fetch throws)", async () => {
    const r = await callVideoFinishInspect(withVpc(async () => { throw new Error("down"); }), { clipUrl: "u" }, { retries: 2, backoffMs: 0 });
    expect(r).toBeNull();
  });
  it("retries the transient 503 then succeeds", async () => {
    let n = 0;
    const r = await callVideoFinishInspect(withVpc(async () => (++n < 2 ? jr({}, 503) : jr({ ok: true, verdict: "ok" }))), { clipUrl: "u" }, { retries: 3, backoffMs: 0 });
    expect(n).toBe(2);
    expect(r).toMatchObject({ verdict: "ok" });
  });
});

describe("contentValidateDoneClips (Layer 2 verdict application at the finish gate)", () => {
  const env = withVpc(async () => jr({ ok: true, verdict: "ok" })); // binding present; inspect is injected below

  it("no-op (false) when the video-finish tier is not installed", async () => {
    const j = job([doneShot("s1")]);
    const changed = await contentValidateDoneClips(noVpc(), j);
    expect(changed).toBe(false);
    expect(j.shots[0].status).toBe("done");
  });

  it("CORRUPT (keyframe mismatch) FAILS the shot before finish spend, with the real reason + cleared poll", async () => {
    const j = job([doneShot("s1", { poll: "tok" })]);
    const inspect = async (): Promise<ContentVerdict> => ({ verdict: "corrupt", reason: "first frame does not resemble its keyframe (similarity 0.020 < 0.2)", keyframe_similarity: 0.02 });
    const changed = await contentValidateDoneClips(env, j, inspect);
    expect(changed).toBe(true);
    expect(j.shots[0].status).toBe("failed");
    expect(j.shots[0].content_validated).toBe("corrupt");
    expect(j.shots[0].error).toContain("content validation");
    expect(j.shots[0].poll).toBeUndefined();
  });

  it("SUSPECT (chroma heuristic) DEGRADES (warn) but the shot stays done -- film still completes", async () => {
    const j = job([doneShot("s1")]);
    const inspect = async (): Promise<ContentVerdict> => ({ verdict: "suspect", reason: "chromatic-noise signature (chroma/structure ratio 5.6 > 4.0)" });
    const changed = await contentValidateDoneClips(env, j, inspect);
    expect(changed).toBe(true);
    expect(j.shots[0].status).toBe("done");
    expect(j.shots[0].content_validated).toBe("suspect");
    expect(j.shots[0].content_degraded).toContain("chromatic-noise");
  });

  it("OK passes; SKIP (inspector down) leaves the shot untouched -- a down inspector never fails a render", async () => {
    const j = job([doneShot("ok1"), doneShot("skip1")]);
    const inspect = async (_e: Env, k: string): Promise<ContentVerdict> => (k.includes("ok1") ? { verdict: "ok" } : { verdict: "skip", reason: "unreachable" });
    const changed = await contentValidateDoneClips(env, j, inspect);
    expect(changed).toBe(false);
    expect(j.shots.every((s) => s.status === "done")).toBe(true);
    expect(j.shots[0].content_validated).toBe("ok");
    expect(j.shots[1].content_validated).toBe("skip");
  });

  it("is idempotent + emits one clip.content_validate event per shot", async () => {
    const j = job([doneShot("s1")]);
    const inspect = vi.fn(async (): Promise<ContentVerdict> => ({ verdict: "ok" }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await contentValidateDoneClips(env, j, inspect);
    await contentValidateDoneClips(env, j, inspect); // content_validated set -> skipped
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("clip.content_validate"));
    const emits = spy.mock.calls.filter((c) => String(c[0]).includes("clip.content_validate")).length;
    spy.mockRestore();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(emits).toBe(1);
    expect(JSON.parse(line as string)).toMatchObject({ ev: "clip.content_validate", job_id: "clips-x", shot_id: "s1", verdict: "ok" });
  });
});
