import { describe, it, expect } from "vitest";
import { clampTier, buildPreviewBody, parseKeyframes, parseTrainedLoras, encodePoll, decodePoll, runpodJobGone, classifyGoneState, RUNPOD_NOTFOUND_GRACE_MS } from "../modules/keyframe/src/keyframe";

describe("keyframe pure logic", () => {
  it("clampTier accepts the known tiers and defaults to final", () => {
    expect(clampTier("draft")).toBe("draft");
    expect(clampTier("standard")).toBe("standard");
    expect(clampTier("final")).toBe("final");
    expect(clampTier("ultra")).toBe("final"); // unknown -> default
    expect(clampTier(undefined)).toBe("final");
  });

  it("buildPreviewBody submits the keyframes-only preview action with project + bundle", () => {
    const { input } = buildPreviewBody(
      { project: "neon_film", bundle_key: "bundles/neon_film.tar.gz" },
      { quality_tier: "standard" },
    );
    expect(input).toMatchObject({
      action: "preview",
      project: "neon_film",
      bundle_key: "bundles/neon_film.tar.gz",
      quality_tier: "standard",
    });
  });

  it("buildPreviewBody folds set config knobs into render_overrides.keyframe, omits unset", () => {
    const { input } = buildPreviewBody(
      { project: "p", bundle_key: "b" },
      { width: 1024, height: 768, steps: 30, guidance_scale: 6.5, seed: 42 },
    );
    expect(input.render_overrides).toEqual({
      keyframe: { width: 1024, height: 768, steps: 30, guidance_scale: 6.5, seed: 42 },
    });
  });

  it("buildPreviewBody drops a -1 (random) seed and omits render_overrides when nothing is set", () => {
    const a = buildPreviewBody({ project: "p", bundle_key: "b" }, { seed: -1 });
    expect(a.input.render_overrides).toBeUndefined();
    const b = buildPreviewBody({ project: "p", bundle_key: "b" }, {});
    expect(b.input.render_overrides).toBeUndefined();
  });

  it("buildPreviewBody passes process_shot_ids only when a subset is given", () => {
    const sub = buildPreviewBody({ project: "p", bundle_key: "b", shot_ids: ["shot_02"] }, {});
    expect(sub.input.process_shot_ids).toEqual(["shot_02"]);
    const all = buildPreviewBody({ project: "p", bundle_key: "b", shot_ids: [] }, {});
    expect(all.input.process_shot_ids).toBeUndefined();
    const none = buildPreviewBody({ project: "p", bundle_key: "b" }, {});
    expect(none.input.process_shot_ids).toBeUndefined();
  });

  it("buildPreviewBody passes pretrained_loras when provided", () => {
    const { input } = buildPreviewBody(
      { project: "p", bundle_key: "b", pretrained_loras: { A: "loras/a.safetensors" } },
      {},
    );
    expect(input.pretrained_loras).toEqual({ A: "loras/a.safetensors" });
  });

  it("parseKeyframes reads the backend result shape (keyframes[].key) into KeyframeShot", () => {
    const result = {
      project: "neon_film",
      output_key: null,
      keyframes: [
        { shot_id: "shot_01", key: "renders/neon_film/keyframes/shot_01.png" },
        { shot_id: "shot_02", key: "renders/neon_film/keyframes/shot_02.png" },
      ],
    };
    expect(parseKeyframes(result)).toEqual([
      { shot_id: "shot_01", keyframe_key: "renders/neon_film/keyframes/shot_01.png" },
      { shot_id: "shot_02", keyframe_key: "renders/neon_film/keyframes/shot_02.png" },
    ]);
  });

  it("parseKeyframes unwraps a RunPod {output:...} envelope and accepts keyframe_key alias", () => {
    const wrapped = { output: { keyframes: [{ shot_id: "shot_01", keyframe_key: "k.png" }] } };
    expect(parseKeyframes(wrapped)).toEqual([{ shot_id: "shot_01", keyframe_key: "k.png" }]);
  });

  it("parseKeyframes skips malformed entries and returns [] for junk", () => {
    const messy = { keyframes: [{ shot_id: "ok", key: "k.png" }, { shot_id: "nokey" }, null, 7] };
    expect(parseKeyframes(messy)).toEqual([{ shot_id: "ok", keyframe_key: "k.png" }]);
    expect(parseKeyframes(undefined)).toEqual([]);
    expect(parseKeyframes({})).toEqual([]);
  });

  it("parseTrainedLoras reads backend result.lora ({slot:{lora_id}}) into slot -> R2 key", () => {
    const result = {
      keyframes: [{ shot_id: "shot_01", key: "k.png" }],
      lora: { A: { lora_id: "loras/wren/A/pytorch_lora_weights.safetensors" }, B: { lora_id: "loras/x/B/w.safetensors" } },
    };
    expect(parseTrainedLoras(result)).toEqual({
      A: "loras/wren/A/pytorch_lora_weights.safetensors",
      B: "loras/x/B/w.safetensors",
    });
  });

  it("parseTrainedLoras unwraps the RunPod {output:...} envelope", () => {
    const wrapped = { output: { keyframes: [], lora: { A: { lora_id: "loras/a.safetensors" } } } };
    expect(parseTrainedLoras(wrapped)).toEqual({ A: "loras/a.safetensors" });
  });

  it("parseTrainedLoras drops malformed entries and returns {} when absent", () => {
    const messy = { keyframes: [], lora: { A: { lora_id: "ok.safetensors" }, B: { nope: 1 }, C: 7, D: null } };
    expect(parseTrainedLoras(messy)).toEqual({ A: "ok.safetensors" });
    expect(parseTrainedLoras({ keyframes: [] })).toEqual({});
    expect(parseTrainedLoras(undefined)).toEqual({});
  });

  it("encodePoll / decodePoll round-trips the job state", () => {
    const tok = encodePoll({ jobId: "abc-123", project: "neon_film" });
    expect(decodePoll(tok)).toEqual({ jobId: "abc-123", project: "neon_film" });
  });

  it("decodePoll rejects garbage and incomplete tokens", () => {
    expect(decodePoll("not-base64-$$")).toBeNull();
    expect(decodePoll(encodePoll({ jobId: "x" } as never))).toBeNull();
  });

  it("round-trips submittedAt; legacy token decodes undefined (#141)", () => {
    const s = { jobId: "abc-123", project: "neon_film", submittedAt: 1_700_000_000_000 };
    expect(decodePoll(encodePoll(s))).toEqual(s);
    expect(decodePoll(encodePoll({ jobId: "j", project: "p" }))?.submittedAt).toBeUndefined();
  });

  it("runpodJobGone detects 404 / numeric-404 / not-found, not a real run state (#141)", () => {
    expect(runpodJobGone(404, { status: 404 })).toBe(true);
    expect(runpodJobGone(200, { status: 404, title: "Not Found" } as never)).toBe(true);
    expect(runpodJobGone(200, { title: "Not Found" })).toBe(true);
    expect(runpodJobGone(200, { status: "COMPLETED" })).toBe(false);
    expect(runpodJobGone(200, { status: "IN_QUEUE" })).toBe(false);
  });

  it("classifyGoneState: grace window vs fail vs legacy (#141)", () => {
    const now = 3_000_000;
    expect(classifyGoneState(now - (RUNPOD_NOTFOUND_GRACE_MS - 1), now)).toBe("gone-grace");
    expect(classifyGoneState(now - (RUNPOD_NOTFOUND_GRACE_MS + 1), now)).toBe("gone-failed");
    expect(classifyGoneState(undefined, now)).toBe("gone-failed");
  });
});
