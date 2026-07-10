import { describe, it, expect } from "vitest";
import { retimeSrt, parseTimestamp, formatTimestamp } from "../src/srt";

// #663: the subtitle module writes its .srt against the pre-card 0-based timeline; film-titles then
// prepends a title card, so the core re-times the sidecar by the prepend to match the FINAL film.

describe("srt timestamp helpers", () => {
  it("parseTimestamp -> whole ms, formatTimestamp -> SubRip HH:MM:SS,mmm (roundtrip)", () => {
    expect(parseTimestamp("00:00:05,000")).toBe(5000);
    expect(parseTimestamp("01:02:03,004")).toBe(3723004);
    expect(formatTimestamp(5000)).toBe("00:00:05,000");
    expect(formatTimestamp(3723004)).toBe("01:02:03,004");
    // roundtrip
    expect(formatTimestamp(parseTimestamp("00:59:59,900"))).toBe("00:59:59,900");
  });

  it("formatTimestamp clamps a negative input to zero and rounds sub-ms", () => {
    expect(formatTimestamp(-1)).toBe("00:00:00,000");
    expect(formatTimestamp(-99999)).toBe("00:00:00,000");
    expect(formatTimestamp(1500.6)).toBe("00:00:01,501");
  });
});

describe("retimeSrt cue-shift math (#663)", () => {
  const doc = [
    "1",
    "00:00:00,000 --> 00:00:05,000",
    "Hello there",
    "",
    "2",
    "00:00:05,000 --> 00:00:10,000",
    "Goodbye",
    "",
  ].join("\n");

  it("shifts every cue by a 3s offset, leaving indices and text intact", () => {
    const out = retimeSrt(doc, 3);
    expect(out).toBe(
      [
        "1",
        "00:00:03,000 --> 00:00:08,000",
        "Hello there",
        "",
        "2",
        "00:00:08,000 --> 00:00:13,000",
        "Goodbye",
        "",
      ].join("\n"),
    );
  });

  it("rolls seconds into minutes and minutes into hours on the shift", () => {
    const minute = retimeSrt("1\n00:00:58,000 --> 00:00:59,000\nlate\n", 3);
    expect(minute).toContain("00:01:01,000 --> 00:01:02,000"); // 58s+3 -> 1:01, 59s+3 -> 1:02

    const hour = retimeSrt("1\n00:59:58,500 --> 00:59:59,900\nedge\n", 3);
    expect(hour).toContain("01:00:01,500 --> 01:00:02,900"); // 59:58 -> 1:00:01, 59:59.9 -> 1:00:02.9
  });

  it("supports a fractional offset (ms precision)", () => {
    expect(retimeSrt("1\n00:00:01,250 --> 00:00:02,750\nx\n", 0.5)).toContain("00:00:01,750 --> 00:00:03,250");
  });

  it("zero offset is a verbatim no-op (same reference-equal string back)", () => {
    expect(retimeSrt(doc, 0)).toBe(doc);
  });

  it("a non-finite offset is a no-op (defensive)", () => {
    expect(retimeSrt(doc, NaN)).toBe(doc);
    expect(retimeSrt(doc, Infinity)).toBe(doc);
  });

  it("only rewrites cue (-->) lines, never index or caption-text lines", () => {
    // A caption whose TEXT happens to look like a timestamp must not be shifted.
    const tricky = "1\n00:00:01,000 --> 00:00:02,000\n00:00:01,000 is the time\n";
    const out = retimeSrt(tricky, 5);
    expect(out).toBe("1\n00:00:06,000 --> 00:00:07,000\n00:00:01,000 is the time\n");
  });

  it("clamps a cue that would go negative to zero (defensive; offsets are >= 0 in use)", () => {
    expect(retimeSrt("1\n00:00:01,000 --> 00:00:04,000\nx\n", -2)).toContain("00:00:00,000 --> 00:00:02,000");
  });
});
