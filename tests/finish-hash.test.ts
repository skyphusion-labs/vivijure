import { describe, it, expect } from "vitest";
import { finishStepInputHash, canonicalJson } from "../src/finish-hash";

// The golden vectors pinned in docs/CONTRACT.md 3.3.1. finishStepInputHash is the SINGLE function used
// by BOTH the invoke-time stamp and the future adoption gate, so this one test protects both call sites
// against drift (#583 Design 2).
describe("finishStepInputHash golden vectors (docs/CONTRACT.md 3.3.1)", () => {
  it("vector 1 (audio present; quoted etags exercise the quote-strip pin)", async () => {
    const h = await finishStepInputHash(
      '"d41d8cd98f00b204e9800998ecf8427e"',       // quoted -> normalized
      '"9e107d9d372bb6826bd81d3542a419d6"',
      { mode: "v15", scale: 2, ratio: 0.5, enabled: true },
    );
    expect(h).toBe("67c6c7a13b3db646ab1923332efca36e9add3ba9c1ba9903e38c7988f1391ece");
  });

  it("vector 2 (no audio -> null; integral float 4.0 -> \"4\")", async () => {
    const h = await finishStepInputHash(
      "d41d8cd98f00b204e9800998ecf8427e",
      null,
      { mode: "x2", scale: 4.0, ratio: 0.25, enabled: false },
    );
    expect(h).toBe("e9e5119cf006958b598a90c27dea5a1d6268bc2d8db8f42cc260c1f6b4f93c9a");
  });

  it("canonical JSON: sorted keys, compact, integral floats without a decimal point", () => {
    expect(canonicalJson({ b: 2.0, a: "x", c: 0.5, d: true })).toBe('{"a":"x","b":2,"c":0.5,"d":true}');
  });

  it("audio_etag null and undefined hash identically (a silent shot)", async () => {
    const a = await finishStepInputHash("etag", null, { k: 1 });
    const b = await finishStepInputHash("etag", undefined, { k: 1 });
    expect(a).toBe(b);
  });

  it("a changed config knob changes the hash (the whole point: re-run on changed input)", async () => {
    const a = await finishStepInputHash("etag", null, { scale: 2 });
    const b = await finishStepInputHash("etag", null, { scale: 4 });
    expect(a).not.toBe(b);
  });
});
