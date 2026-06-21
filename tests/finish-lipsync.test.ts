import { describe, it, expect } from "vitest";
import {
  runpodInnerComplete,
  parseBackendOutput,
  lipsyncedKey,
  coerceConfig,
  buildRunPodBody,
} from "../modules/finish-lipsync/src/lipsync";

// RunPod envelope-freeze: the musetalk handler returns its terminal result while RunPod's outer
// envelope is stuck IN_PROGRESS. The poll must trust the backend's own signal, not the frozen status.
describe("finish-lipsync envelope-freeze (inner complete trusted over the envelope)", () => {
  it("runpodInnerComplete trusts the handler's terminal result (boolean ok)", () => {
    expect(runpodInnerComplete({ ok: true, clip_key: "renders/p/clips/shot_01_ls.mp4" })).toBe(true);
    expect(runpodInnerComplete({ ok: false, error: "no face" })).toBe(true); // a soft-degrade is terminal too
    expect(runpodInnerComplete({ status: "complete" })).toBe(true);
    expect(runpodInnerComplete({ last_event: { event: "complete" } })).toBe(true);
  });
  it("runpodInnerComplete is false mid-flight (no terminal signal yet)", () => {
    expect(runpodInnerComplete({})).toBe(false);
    expect(runpodInnerComplete({ last_event: { event: "progress" } })).toBe(false);
    expect(runpodInnerComplete(null)).toBe(false);
    expect(runpodInnerComplete("running")).toBe(false);
  });
  it("parseBackendOutput reads clip_key from the clean result, or last_event under a freeze", () => {
    expect(parseBackendOutput({ ok: true, clip_key: "a_ls.mp4", applied: ["lipsync:v15"] })?.clip_key).toBe("a_ls.mp4");
    expect(parseBackendOutput({ last_event: { event: "complete", output_key: "b_ls.mp4" } })?.clip_key).toBe("b_ls.mp4");
    expect(parseBackendOutput({})?.clip_key).toBeUndefined();
  });
});

describe("finish-lipsync helpers", () => {
  it("lipsyncedKey adds the _ls suffix before the extension", () => {
    expect(lipsyncedKey("renders/p/clips/shot_01.mp4")).toBe("renders/p/clips/shot_01_ls.mp4");
  });
  it("buildRunPodBody passes clip_key + audio_key + output_key", () => {
    const body = buildRunPodBody(
      { shot_id: "shot_01", clip_key: "renders/p/clips/shot_01.mp4", audio_key: "renders/p/dialogue/shot_01.wav", src_fps: 16, frames: 48, width: 0, height: 0 },
      coerceConfig({}),
    );
    expect(body.input.clip_key).toBe("renders/p/clips/shot_01.mp4");
    expect(body.input.audio_key).toBe("renders/p/dialogue/shot_01.wav");
    expect(body.input.output_key).toBe("renders/p/clips/shot_01_ls.mp4");
  });
});
