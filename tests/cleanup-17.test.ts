import { describe, it, expect, vi } from "vitest";
import { buildRenderLogText } from "../src/render-log";
import { readManifest } from "../src/modules/registry";
import type { RunpodJobView } from "../src/runpod-submit";

// Issue #17 cleanup batch: render-log truncation + the readManifest discovery timeout, exercised
// through the exported pure surface. (The render-email esc/encode/clamp locks moved out with the
// legacy core render-email builder when email logic became the notify-email module's sole concern;
// the live notify path's composer is covered by tests/notify-email.test.ts.)

describe("buildRenderLogText truncation (issue #17)", () => {
  const view = (over: Partial<RunpodJobView> = {}): RunpodJobView => ({
    jobId: "job-1", status: "FAILED", statusRaw: "FAILED", ...over,
  });

  it("clamps an oversized error and marks how much was dropped", () => {
    const txt = buildRenderLogText(view({ error: "x".repeat(5000) }), "2026-06-16T00:00:00Z");
    expect(txt).toContain("x".repeat(4000));
    expect(txt).not.toContain("x".repeat(4001));
    expect(txt).toContain("[truncated 1000 chars]");
  });

  it("clamps an oversized string output too", () => {
    const txt = buildRenderLogText(view({ status: "COMPLETED", statusRaw: "COMPLETED", output: "y".repeat(6000) }), "ts");
    expect(txt).toContain("[truncated 2000 chars]");
  });

  it("leaves a small error untouched", () => {
    const txt = buildRenderLogText(view({ error: "boom" }), "ts");
    expect(txt).toContain("boom");
    expect(txt).not.toContain("truncated");
  });
});

describe("readManifest discovery timeout (issue #17)", () => {
  it("passes an AbortSignal (the per-read timeout) on the manifest fetch", async () => {
    let captured: RequestInit | undefined;
    const fetcher = {
      async fetch(_input: Request | string, init?: RequestInit): Promise<Response> {
        captured = init;
        return new Response("nope", { status: 503 });
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await readManifest("MODULE_X", fetcher);
    expect(out).toBeNull(); // 503 -> skipped, never throws
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    warn.mockRestore();
  });
});
