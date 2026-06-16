import { describe, it, expect, vi } from "vitest";
import { buildRenderEmail, type RenderNotifyInfo } from "../src/render-email";
import { buildRenderLogText } from "../src/render-log";
import { readManifest } from "../src/modules/registry";
import type { RunpodJobView } from "../src/runpod-submit";

// Issue #17 cleanup batch: render-email escaping/encoding/clamping, render-log truncation, and the
// readManifest discovery timeout. All exercised through the exported pure surface.

const info = (over: Partial<RenderNotifyInfo> = {}): RenderNotifyInfo => ({
  userEmail: "u@e.com",
  project: "RUST",
  status: "COMPLETED",
  outputKey: "renders/out.mp4",
  error: null,
  executionTimeMs: 12000,
  mode: "full",
  ...over,
});

describe("render-email esc() lock (issue #17)", () => {
  it("escapes & < > and double-quote, but NOT single-quote (safe in double-quoted attrs)", () => {
    const { html } = buildRenderEmail(info({ project: `a & b < c > d " e ' f` }), "https://skyphusion.org");
    expect(html).toContain("a &amp; b &lt; c &gt; d &quot; e ' f");
    expect(html).not.toContain("&#39;");
    expect(html).not.toContain("&apos;");
  });
});

describe("render-email artifact URL encoding (issue #17)", () => {
  it("per-segment-encodes the output key so '/ # ? & space' survive as a usable link", () => {
    const { text } = buildRenderEmail(info({ outputKey: "renders/a b#c?d&e.mp4" }), "https://skyphusion.org");
    // slashes stay literal (route splits on them); the in-segment specials are percent-encoded.
    expect(text).toContain("https://skyphusion.org/api/artifact/renders/a%20b%23c%3Fd%26e.mp4");
  });
});

describe("render-email field clamp (issue #17)", () => {
  it("truncates a runaway project name", () => {
    const { subject } = buildRenderEmail(info({ project: "P".repeat(500) }), "https://skyphusion.org");
    expect(subject).toContain("P".repeat(200) + "...");
    expect(subject).not.toContain("P".repeat(201));
  });
  it("truncates a runaway failure reason", () => {
    const { text } = buildRenderEmail(info({ status: "FAILED", error: "E".repeat(500) }), "https://skyphusion.org");
    expect(text).toContain("E".repeat(200) + "...");
    expect(text).not.toContain("E".repeat(201));
  });
});

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
