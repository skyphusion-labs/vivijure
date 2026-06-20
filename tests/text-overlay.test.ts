import { describe, it, expect } from "vitest";
import {
  defaultConfig,
  coerceConfig,
  coerceOverlays,
  resolvePositionExprs,
  escapeDrawtext,
  overlayToDrawtext,
  buildDrawtextFilter,
  outputClipKey,
  passthroughOutput,
} from "../modules/text-overlay/src/overlay";
import type { FinishInput } from "../modules/text-overlay/src/contract";
import worker from "../modules/text-overlay/src/index";

const SAMPLE_INPUT: FinishInput = {
  shot_id: "shot_01",
  clip_key: "renders/neon/clips/shot_01_seedance.mp4",
  src_fps: 24,
  frames: 120,
  width: 1920,
  height: 1080,
};

// ---------------------------------------------------------------------------
describe("coerceConfig", () => {
  it("returns sane defaults for an empty config", () => {
    const c = defaultConfig();
    expect(c.font).toBe("DejaVu Sans");
    expect(c.size).toBe(48);
    expect(c.color).toBe("white");
    expect(c.safe_margin).toBe(50);
  });

  it("accepts valid overrides", () => {
    const c = coerceConfig({ font: "Helvetica", size: 64, color: "yellow", safe_margin: 100 });
    expect(c.font).toBe("Helvetica");
    expect(c.size).toBe(64);
    expect(c.color).toBe("yellow");
    expect(c.safe_margin).toBe(100);
  });

  it("clamps size to [8, 400] (0 is treated as provided-but-below-min, clamped up to 8)", () => {
    expect(coerceConfig({ size: 0 }).size).toBe(8);
    expect(coerceConfig({ size: 999 }).size).toBe(400);
    expect(coerceConfig({ size: 48 }).size).toBe(48);
  });

  it("rejects unsafe color values and falls back to default", () => {
    // Color with spaces or injection chars is rejected
    expect(coerceConfig({ color: "white; rm -rf /" }).color).toBe("white");
    expect(coerceConfig({ color: "#ff0000" }).color).toBe("#ff0000");
  });

  it("clamps safe_margin to [0, 500]", () => {
    expect(coerceConfig({ safe_margin: -10 }).safe_margin).toBe(0);
    expect(coerceConfig({ safe_margin: 9999 }).safe_margin).toBe(500);
  });
});

// ---------------------------------------------------------------------------
describe("coerceOverlays", () => {
  it("returns empty array for non-array or null input", () => {
    expect(coerceOverlays(null)).toEqual([]);
    expect(coerceOverlays(undefined)).toEqual([]);
    expect(coerceOverlays("string")).toEqual([]);
    expect(coerceOverlays({})).toEqual([]);
  });

  it("skips entries with empty or missing text", () => {
    expect(coerceOverlays([{ text: "" }, { text: "  " }, {}])).toHaveLength(0);
  });

  it("defaults kind to subtitle when unspecified or invalid", () => {
    const [o] = coerceOverlays([{ text: "Hello" }]);
    expect(o.kind).toBe("subtitle");
    const [o2] = coerceOverlays([{ text: "Hi", kind: "invalid" }]);
    expect(o2.kind).toBe("subtitle");
  });

  it("accepts valid kinds", () => {
    for (const kind of ["title", "credit", "lower-third", "subtitle"] as const) {
      const [o] = coerceOverlays([{ text: "x", kind }]);
      expect(o.kind).toBe(kind);
    }
  });

  it("drops end that is not greater than start", () => {
    const [o] = coerceOverlays([{ text: "x", start: 5, end: 3 }]);
    expect(o.end).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("escapeDrawtext", () => {
  it("escapes backslashes, colons, and single quotes", () => {
    expect(escapeDrawtext("hello")).toBe("hello");
    // colon -> \:
    expect(escapeDrawtext("a:b")).toBe("a\\:b");
    // single quote -> \'
    expect(escapeDrawtext("it's")).toBe("it\\'s");
    // "C:\path" (C, colon, backslash, path): backslash -> \\, colon -> \:
    // Result: C\:\\path  (JS literal: "C\\:\\\\path")
    expect(escapeDrawtext("C:\\path")).toBe("C\\:\\\\path");
  });

  it("handles combined special characters", () => {
    const out = escapeDrawtext("Say: 'it\\'s fine'");
    // backslash -> \\, colon -> \:, quote -> \'
    // Original: Say: 'it\'s fine'
    // After \\ escape: Say: 'it\\'s fine'  -- but original only has one \
    // Let's check the actual output
    expect(out).not.toContain("'s fine'"); // raw quote should be escaped
    expect(out).toContain("\\:"); // colon escaped
  });
});

// ---------------------------------------------------------------------------
describe("resolvePositionExprs", () => {
  it("top-center places text horizontally centered at top margin", () => {
    const { x, y } = resolvePositionExprs("top-center", 50);
    expect(x).toBe("(w-text_w)/2");
    expect(y).toBe("50");
  });

  it("bottom-center places text at the bottom safe margin", () => {
    const { y } = resolvePositionExprs("bottom-center", 50);
    expect(y).toBe("h-text_h-50");
  });

  it("lower-left uses 75% height (lower-third standard)", () => {
    const { x, y } = resolvePositionExprs("lower-left", 50);
    expect(x).toBe("50");
    expect(y).toContain("3/4");
  });

  it("lower-right is mirror of lower-left", () => {
    const { x } = resolvePositionExprs("lower-right", 50);
    expect(x).toContain("w-text_w");
  });
});

// ---------------------------------------------------------------------------
describe("overlayToDrawtext", () => {
  const cfg = defaultConfig();

  it("produces a drawtext= filter string for a basic title overlay", () => {
    const f = overlayToDrawtext({ text: "ACT ONE", kind: "title" }, cfg);
    expect(f).toMatch(/^drawtext=/);
    expect(f).toContain("text='ACT ONE'");
    expect(f).toContain("fontsize=48");
    expect(f).toContain("fontcolor=white");
    expect(f).toContain("(w-text_w)/2"); // top-center x
  });

  it("adds enable= for start/end timing", () => {
    const f = overlayToDrawtext({ text: "hello", start: 1, end: 4 }, cfg);
    expect(f).toContain("enable='between(t,1.000,4.000)'");
  });

  it("adds gte enable for start-only", () => {
    const f = overlayToDrawtext({ text: "hi", start: 2 }, cfg);
    expect(f).toContain("enable='gte(t,2.000)'");
  });

  it("no enable clause when start is 0 and end is absent", () => {
    const f = overlayToDrawtext({ text: "hi", start: 0 }, cfg);
    // start=0 with no end -> no enable needed (always visible)
    expect(f).not.toContain("enable=");
  });

  it("per-overlay font/size/color override wins over config", () => {
    const f = overlayToDrawtext({ text: "X", font: "Impact", size: 96, color: "red" }, cfg);
    expect(f).toContain("font=Impact");
    expect(f).toContain("fontsize=96");
    expect(f).toContain("fontcolor=red");
  });
});

// ---------------------------------------------------------------------------
describe("buildDrawtextFilter", () => {
  const cfg = defaultConfig();

  it("returns null for an empty overlay list", () => {
    expect(buildDrawtextFilter([], cfg)).toBeNull();
  });

  it("returns a single drawtext segment for one overlay", () => {
    const f = buildDrawtextFilter([{ text: "Title" }], cfg);
    expect(f).not.toBeNull();
    expect(f!.split(",").filter((s) => s.startsWith("drawtext="))).toHaveLength(1);
  });

  it("chains multiple overlays with commas", () => {
    const f = buildDrawtextFilter([{ text: "Title" }, { text: "Credit", kind: "credit" }], cfg);
    expect(f).not.toBeNull();
    const segments = f!.split(",drawtext=");
    expect(segments).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe("outputClipKey", () => {
  it("inserts -overlay before the extension", () => {
    expect(outputClipKey("renders/neon/clips/shot_01_veo.mp4"))
      .toBe("renders/neon/clips/shot_01_veo-overlay.mp4");
  });

  it("handles keys without an extension gracefully", () => {
    const k = outputClipKey("renders/neon/shot_01");
    // no extension: -overlay appended
    expect(k).toContain("-overlay");
  });
});

// ---------------------------------------------------------------------------
describe("passthroughOutput", () => {
  it("sets degraded on a real degrade and uses passthrough: tag in applied", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "container-failed", { detail: "HTTP 502" });
    expect(o.degraded).toMatch(/container-failed/);
    expect(o.applied[0]).toMatch(/^passthrough:/);
    expect(o.clip_key).toBe(SAMPLE_INPUT.clip_key);
  });

  it("does NOT set degraded for an intentional noop (degraded:false)", () => {
    const o = passthroughOutput(SAMPLE_INPUT, "no-overlays", { degraded: false });
    expect(o.degraded).toBeUndefined();
    expect(o.applied[0]).toMatch(/^noop:/);
  });
});


// #212: text-overlay's soft-degrade convention must hold so the central dispatchChain detection catches
// it -- a genuine degrade (container unreachable) returns ok:true WITH output.degraded set; only the
// intentional no-overlays no-op opts out. Also guards the bare-path URL bug (must be absolute).
describe("text-overlay module invoke degrade + absolute url (#212)", () => {
  function env(over: { throws?: boolean } = {}) {
    const calls: string[] = [];
    const e = {
      VIDEO_FINISH_VPC: {
        async fetch(input: Request | string) {
          calls.push(typeof input === "string" ? input : input.url);
          if (over.throws) throw new TypeError("Invalid URL");
          return new Response(new ArrayBuffer(64), { status: 200 });
        },
      },
      R2_RENDERS: {
        get: async () => ({ arrayBuffer: async () => new ArrayBuffer(32) }),
        put: async () => {},
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    return { e, calls };
  }
  const invoke = (config: Record<string, unknown>) =>
    new Request("https://module/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook: "finish", input: SAMPLE_INPUT, config, context: {} }),
    });

  it("degrades (ok:true + output.degraded) on a container throw, AND uses an absolute url", async () => {
    const { e, calls } = env({ throws: true });
    const res = await worker.fetch(invoke({ overlays: [{ text: "HELLO" }] }), e);
    const json = (await res.json()) as { ok: boolean; output: { degraded?: string } };
    expect(calls).toHaveLength(1);
    expect(() => new URL(calls[0])).not.toThrow();   // bare "/overlay" would throw here
    expect(new URL(calls[0]).pathname).toBe("/overlay");
    expect(json.ok).toBe(true);                       // never drops the clip
    expect(json.output.degraded).toContain("container-failed"); // dispatchChain will surface this
  });

  it("a no-overlays no-op is NOT flagged as degraded", async () => {
    const { e, calls } = env();
    const res = await worker.fetch(invoke({}), e); // no overlays
    const json = (await res.json()) as { ok: boolean; output: { degraded?: string } };
    expect(calls).toHaveLength(0);
    expect(json.ok).toBe(true);
    expect(json.output.degraded).toBeUndefined();
  });
});
