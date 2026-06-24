import { describe, it, expect } from "vitest";
import { shapeEventsToLoki, deriveFields } from "../tail/src/index";

describe("vivijure-tail event -> Loki shaping", () => {
  it("maps a film.finish soft-degrade warn to the right labels + job_id in the line", () => {
    const events = [{
      scriptName: "vivijure-studio",
      outcome: "ok",
      eventTimestamp: 1_700_000_000_000,
      logs: [{ timestamp: 1_700_000_000_001, level: "warn",
        message: ["film.finish degraded for film-abc123: noop:no-cards -- film shipped WITHOUT cards"] }],
      exceptions: [],
    }];
    const streams = shapeEventsToLoki(events);
    const w = streams.find((s) => s.stream.level === "warn" && s.stream.module === "film.finish");
    expect(w).toBeTruthy();
    expect(w!.stream).toMatchObject({ worker: "vivijure-studio", level: "warn", module: "film.finish" });
    const line = JSON.parse(w!.values[0][1]);
    expect(line.job_id).toBe("film-abc123");
    // ns timestamp is ms * 1e6
    expect(w!.values[0][0]).toBe("1700000000001000000");
  });

  it("routes an uncaught exception to level=error", () => {
    const events = [{ scriptName: "vivijure-studio", outcome: "exception", eventTimestamp: 1_700_000_000_000,
      logs: [], exceptions: [{ timestamp: 1_700_000_000_002, name: "TypeError", message: "x is not a function" }] }];
    const streams = shapeEventsToLoki(events);
    const err = streams.find((s) => s.stream.level === "error");
    expect(err).toBeTruthy();
    const names = err!.values.map((v) => JSON.parse(v[1]).name);
    expect(names).toContain("TypeError");
  });

  it("derives a phase and module from the console convention", () => {
    const f = deriveFields("film film-xyz: master degraded -- audio-master: stalled");
    expect(f.job_id).toBe("film-xyz");
    expect(f.phase).toBe("master");
  });

  it("prefers a structured logEvent JSON line when present (fast-follow)", () => {
    const f = deriveFields(JSON.stringify({ _v: 1, job_id: "film-q", phase: "speech", module: "speech-upscale", reason: "not configured" }));
    expect(f).toMatchObject({ job_id: "film-q", phase: "speech", module: "speech-upscale", reason: "not configured" });
  });

  it("emits an invocation summary line even when logs[] is empty (routine traffic visible)", () => {
    const events = [{ scriptName: "vivijure-studio", outcome: "ok", eventTimestamp: 1_700_000_000_000,
      event: { request: { method: "GET", path: "/api/modules" }, response: { status: 200 } }, logs: [], exceptions: [] }];
    const streams = shapeEventsToLoki(events);
    expect(streams).toHaveLength(1);
    expect(streams[0].stream).toMatchObject({ worker: "vivijure-studio", level: "info" });
    const line = JSON.parse(streams[0].values[0][1]);
    expect(line.kind).toBe("invocation");
    expect(line.msg).toBe("GET /api/modules 200");
    expect(line.status).toBe(200);
  });

  it("marks a failed-outcome invocation as level=error", () => {
    const events = [{ scriptName: "vivijure-studio", outcome: "exception", eventTimestamp: 1,
      event: { request: { method: "POST", path: "/api/render" }, response: { status: 500 } }, logs: [], exceptions: [] }];
    const streams = shapeEventsToLoki(events);
    expect(streams.find((s) => s.stream.level === "error")).toBeTruthy();
  });

  it("groups same-label logs into one stream, splits different levels", () => {
    const events = [{ scriptName: "vivijure-studio", eventTimestamp: 1, logs: [
      { timestamp: 2, level: "log", message: ["film film-a: clips phase start"] },
      { timestamp: 3, level: "warn", message: ["film film-a: clips degraded"] },
    ], exceptions: [] }];
    const streams = shapeEventsToLoki(events);
    const levels = [...new Set(streams.map((s) => s.stream.level))].sort();
    expect(levels).toEqual(["info", "warn"]);
  });
});
