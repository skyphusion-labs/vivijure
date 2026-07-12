import { describe, it, expect } from "vitest";
import {
  isFilmJobId,
  mapRenderOverridesToModuleConfigs,
  normalizeFilmScenes,
  filterScenesByShotIds,
  orderScenesByShotIds,
  filmJobToPollView,
  filmRowFromJob,
  stallSignal,
} from "../src/film-render-bridge";
import type { FilmJob } from "../src/film-orchestrator";
import { KEYFRAME_STALL_SECONDS, orderFinalClips } from "../src/film-orchestrator";
import { buildCaptionCues } from "../src/captions";
import type { RegisteredModule } from "../src/modules/types";

describe("isFilmJobId", () => {
  it("recognizes film orchestrator job ids", () => {
    expect(isFilmJobId("film-abc")).toBe(true);
    expect(isFilmJobId("runpod-xyz")).toBe(false);
  });
});

describe("mapRenderOverridesToModuleConfigs", () => {
  const modules = [
    {
      name: "keyframe",
      version: "0.1.0",
      api: "vivijure-module/2" as const,
      binding: "MODULE_KEYFRAME",
      hooks: ["keyframe" as const],
      config_schema: {
        quality_tier: { type: "enum" as const, values: ["draft", "standard", "final"], default: "final" },
        steps: { type: "int" as const, default: 30, min: 1, max: 60 },
        guidance_scale: { type: "float" as const, default: 6.5, min: 0, max: 20 },
        seed: { type: "int" as const, default: -1, min: -1 },
        width: { type: "int" as const, default: 1024, min: 512, max: 1536 },
        height: { type: "int" as const, default: 1024, min: 512, max: 1536 },
      },
    },
    {
      name: "own-gpu",
      version: "0.1.0",
      api: "vivijure-module/2" as const,
      binding: "MODULE_OWN_GPU",
      hooks: ["motion.backend" as const],
      config_schema: {
        quality: { type: "enum" as const, values: ["draft", "standard", "final"], default: "standard" },
        fps: { type: "int" as const, default: 16, min: 8, max: 30 },
        flow_shift: { type: "float" as const, default: 5, min: 1, max: 12 },
        seed: { type: "int" as const, default: -1, min: -1 },
      },
      ui: { order: 5 },
    },
  ] as RegisteredModule[];

  it("maps module wire overrides into module config fields", () => {
    const mapped = mapRenderOverridesToModuleConfigs(
      {
        config: {
          keyframe: { steps: 25, guidance_scale: 7, seed: 42, width: 1024, height: 768 },
          "own-gpu": { fps: 24, flow_shift: 4.5 },
        },
      },
      "standard",
      modules,
    );
    expect(mapped.keyframe_config).toEqual({
      quality_tier: "standard",
      steps: 25,
      guidance_scale: 7,
      seed: 42,
      width: 1024,
      height: 768,
    });
    expect(mapped.motion_config).toEqual({ quality: "standard", fps: 24, flow_shift: 4.5, seed: -1 });
    expect(mapped.motion_backend).toBe("own-gpu");
  });
});

describe("normalizeFilmScenes", () => {
  it("drops scenes without prompt or shot_id", () => {
    expect(
      normalizeFilmScenes([
        { shot_id: "shot_01", prompt: "a dawn", seconds: 5 },
        { shot_id: "shot_02", prompt: "  " },
        { prompt: "orphan" },
      ]),
    ).toEqual([{ shot_id: "shot_01", prompt: "a dawn", seconds: 5 }]);
  });
});

describe("filterScenesByShotIds", () => {
  const scenes = [
    { shot_id: "shot_01", prompt: "a", seconds: 4 },
    { shot_id: "shot_02", prompt: "b", seconds: 4 },
  ];
  it("returns all scenes when no filter", () => {
    expect(filterScenesByShotIds(scenes, undefined)).toEqual(scenes);
  });
  it("restricts to listed shot ids", () => {
    expect(filterScenesByShotIds(scenes, ["shot_02"])).toEqual([scenes[1]]);
  });
});

describe("orderScenesByShotIds (#284/#285: caption scenes must follow the assembled cut order)", () => {
  const scenes = [
    { shot_id: "shot_01", prompt: "a", seconds: 4 },
    { shot_id: "shot_02", prompt: "b", seconds: 4 },
    { shot_id: "shot_03", prompt: "c", seconds: 4 },
  ];
  it("reorders scenes to match the shot-id sequence (not the scenes' own order)", () => {
    // bundle gives 01,02,03 but the cut is requested as 03,01,02 -> follow the request
    const out = orderScenesByShotIds(scenes, ["shot_03", "shot_01", "shot_02"]);
    expect(out.map((s) => s.shot_id)).toEqual(["shot_03", "shot_01", "shot_02"]);
  });
  it("drops scenes whose id is not in the sequence (partial-shot scatter)", () => {
    const out = orderScenesByShotIds(scenes, ["shot_03", "shot_01"]);
    expect(out.map((s) => s.shot_id)).toEqual(["shot_03", "shot_01"]);
  });
  it("skips unknown ids in the sequence", () => {
    const out = orderScenesByShotIds(scenes, ["shot_99", "shot_02"]);
    expect(out.map((s) => s.shot_id)).toEqual(["shot_02"]);
  });
  it("returns empty for an empty sequence", () => {
    expect(orderScenesByShotIds(scenes, [])).toEqual([]);
  });
});

// THE CRUX (Mackaye review note #1): on the scatter gather the clips assemble in expected_shot_ids
// order regardless of shard COMPLETION order, and the caption timeline must be computed against that
// same order or the subtitles drift. This proves the end-to-end chain the gather runs:
//   out-of-order shard completion -> orderFinalClips(expected order) -> assembled cut
//   bundle-order scenes          -> orderScenesByShotIds(expected order) -> caption scenes
//   buildCaptionCues(caption scenes, dialogue) -> windows that line up with the cut.
describe("scatter caption/clip order alignment (#284/#285 crux)", () => {
  // expected cut order (what the planner requested); deliberately NOT ascending and NOT the order
  // the shards finish in, to catch any reliance on completion or bundle order.
  const expected = ["shot_02", "shot_03", "shot_01"];
  // bundle stores scenes in a DIFFERENT (ascending) order, with distinct durations so a misordering
  // would produce visibly wrong cumulative caption windows.
  const bundleScenes = [
    { shot_id: "shot_01", prompt: "a", seconds: 5 },
    { shot_id: "shot_02", prompt: "b", seconds: 2 },
    { shot_id: "shot_03", prompt: "c", seconds: 3 },
  ];
  const dialogue = [
    { shot_id: "shot_01", text: "third in the cut" },
    { shot_id: "shot_02", text: "first in the cut" },
    { shot_id: "shot_03", text: "second in the cut" },
  ];

  it("assembles in expected order from out-of-order shard completion", () => {
    // shards report done in completion order 03, 01, 02 (none matches the cut order)
    const completedClips = [
      { shot_id: "shot_03", clip_key: "c/shot_03.mp4" },
      { shot_id: "shot_01", clip_key: "c/shot_01.mp4" },
      { shot_id: "shot_02", clip_key: "c/shot_02.mp4" },
    ];
    const cutScenes = expected.map((shot_id) => ({ shot_id, prompt: "", seconds: 4 }));
    const cut = orderFinalClips(cutScenes, completedClips);
    expect(cut.map((c) => c.shot_id)).toEqual(expected);
  });

  it("captions line up with the assembled cut even when bundle order differs", () => {
    const captionScenes = orderScenesByShotIds(bundleScenes, expected);
    // sanity: caption scenes follow the cut, not the bundle
    expect(captionScenes.map((s) => s.shot_id)).toEqual(expected);

    const cues = buildCaptionCues(captionScenes, dialogue);
    // cut is 02(2s) -> 03(3s) -> 01(5s). Cumulative windows:
    //   shot_02 "first":  [0, 2)
    //   shot_03 "second": [2, 5)
    //   shot_01 "third":  [5, 10)
    expect(cues).toEqual([
      { start: 0, end: 2, text: "first in the cut" },
      { start: 2, end: 5, text: "second in the cut" },
      { start: 5, end: 10, text: "third in the cut" },
    ]);
  });

  it("REGRESSION guard: bundle-order scenes would misalign (proves the fix is load-bearing)", () => {
    // Feeding raw bundle order (the pre-fix behavior) yields windows that do NOT match the cut:
    // bundle is 01(5)->02(2)->03(3), so "first in the cut" (shot_02) would land at [5,7) not [0,2).
    const wrong = buildCaptionCues(bundleScenes, dialogue);
    const firstCue = wrong.find((c) => c.text === "first in the cut");
    expect(firstCue).toEqual({ start: 5, end: 7, text: "first in the cut" });
    // i.e. without orderScenesByShotIds the first spoken line drifts 5s late -- the bug we closed.
  });
});

describe("filmJobToPollView", () => {
  const base: FilmJob = {
    film_id: "film-1",
    project: "demo",
    bundle_key: "bundles/demo.tar.gz",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 5 }],
    motion_backend: "own-gpu",
    motion_config: {},
    finish_config: {},
    keyframe_binding: "MODULE_KEYFRAME",
    phase: "clips",
    created_at: Date.now() - 60_000,
  };

  it("maps in-progress clip phase with progress", () => {
    const view = filmJobToPollView(base, {
      job_id: "clip-1",
      project: "demo",
      motion_backend: "own-gpu",
      binding: "MODULE_OWN_GPU",
      shots: [{ shot_id: "shot_01", keyframe_url: "u", prompt: "x", seconds: 5, status: "done", clip_key: "c" }],
      created_at: Date.now(),
    });
    expect(view.status).toBe("IN_PROGRESS");
    expect(view.output).toMatchObject({ phase: "i2v", scene_total: 1, progress: 1 });
  });

  it("maps keyframes-only completion with thumbnail keys", () => {
    const view = filmJobToPollView(
      {
        ...base,
        phase: "done",
        keyframes_only: true,
        keyframes: [{ shot_id: "shot_01", keyframe_key: "k/shot_01.png" }],
      },
      null,
    );
    expect(view.status).toBe("COMPLETED");
    expect(view.output).toMatchObject({
      mode: "keyframes-only",
      keyframes: [{ shot_id: "shot_01", key: "k/shot_01.png" }],
    });
  });

  it("maps cancelled jobs", () => {
    const view = filmJobToPollView({ ...base, phase: "failed", cancelled: true, error: "cancelled" }, null);
    expect(view.status).toBe("CANCELLED");
  });

  it("surfaces the stall signal on an in-progress render (#129 / Joan's UX)", () => {
    const stale: FilmJob = {
      ...base,
      phase: "keyframe",
      created_at: Date.now() - (KEYFRAME_STALL_SECONDS + 120) * 1000,
      phase_started_at: Date.now() - (KEYFRAME_STALL_SECONDS + 120) * 1000,
    };
    const view = filmJobToPollView(stale, null);
    expect(view.status).toBe("IN_PROGRESS");
    const out = view.output as Record<string, unknown>;
    expect(out.stalled).toBe(true);
    expect(out.stall_seconds as number).toBeGreaterThanOrEqual(KEYFRAME_STALL_SECONDS);
    expect(typeof out.last_progress_at).toBe("number");
  });

  it("does not flag a healthy in-progress render as stalled", () => {
    const fresh: FilmJob = { ...base, phase: "clips", phase_started_at: Date.now() };
    const view = filmJobToPollView(fresh, null);
    const out = view.output as Record<string, unknown>;
    expect(out.stalled).toBeUndefined();
    expect(out.last_progress_at).toBe(fresh.phase_started_at);
  });

  // #707: the film-status route (FilmSummary) carries clip_deliveries, but the planner polls THIS
  // view -- without the relay the panel's delivered-vs-planned surfacing stays dark (Joan's wire-gap).
  it("relays clip_deliveries (+ distilled) on the poll view, in progress AND at done (#707/#705)", () => {
    const clipJob = {
      job_id: "clip-1", project: "demo", motion_backend: "local-gpu", binding: "MODULE_LOCAL_GPU",
      shots: [{
        shot_id: "shot_01", keyframe_url: "u", prompt: "x", seconds: 5,
        status: "done" as const, clip_key: "c", delivered_fps: 8, delivered_frames: 25, distilled: false,
      }],
      created_at: Date.now(),
    };
    const inflight = filmJobToPollView(base, clipJob);
    expect((inflight.output as Record<string, unknown>).clip_deliveries).toEqual([
      { shot_id: "shot_01", planned_seconds: 5, delivered_seconds: 3.125, fps: 8, frames: 25, distilled: false },
    ]);
    const done = filmJobToPollView({ ...base, phase: "done", film_key: "f.mp4" }, clipJob);
    expect((done.output as Record<string, unknown>).clip_deliveries).toEqual([
      { shot_id: "shot_01", planned_seconds: 5, delivered_seconds: 3.125, fps: 8, frames: 25, distilled: false },
    ]);
  });

  it("omits clip_deliveries when no shot reported durations (absence stays absent)", () => {
    const view = filmJobToPollView(base, {
      job_id: "clip-1", project: "demo", motion_backend: "own-gpu", binding: "MODULE_OWN_GPU",
      shots: [{ shot_id: "shot_01", keyframe_url: "u", prompt: "x", seconds: 5, status: "done" as const, clip_key: "c" }],
      created_at: Date.now(),
    });
    expect((view.output as Record<string, unknown>).clip_deliveries).toBeUndefined();
  });
});

describe("stallSignal (#129 render-status contract)", () => {
  const job = (over: Partial<FilmJob>): FilmJob => ({
    film_id: "f", project: "p", bundle_key: "b", scenes: [], motion_backend: null,
    motion_config: {}, finish_config: {}, keyframe_binding: null, phase: "keyframe",
    created_at: 0, ...over,
  });

  it("reports last_progress_at = phase_started_at and no stall flag when fresh", () => {
    const s = stallSignal(job({ phase_started_at: 1_000 }), 1_000 + 60_000);
    expect(s).toEqual({ last_progress_at: 1_000 });
  });

  it("flags stalled + stall_seconds once past the threshold", () => {
    const now = 1_000 + (KEYFRAME_STALL_SECONDS + 30) * 1000;
    const s = stallSignal(job({ phase_started_at: 1_000 }), now);
    expect(s.last_progress_at).toBe(1_000);
    expect(s.stalled).toBe(true);
    expect(s.stall_seconds as number).toBe(KEYFRAME_STALL_SECONDS + 30);
  });

  it("falls back to created_at on a pre-#129 job (no phase_started_at)", () => {
    const s = stallSignal(job({ created_at: 5_000 }), 5_000 + 60_000);
    expect(s.last_progress_at).toBe(5_000);
  });
});

describe("stallSignal measures from last_progress_at, not phase_started_at (#136)", () => {
  const job = (over: Partial<FilmJob>): FilmJob => ({
    film_id: "f", project: "p", bundle_key: "b", scenes: [], motion_backend: null,
    motion_config: {}, finish_config: {}, keyframe_binding: null, phase: "clips",
    created_at: 0, ...over,
  });

  it("a long clips phase that recently advanced a shot is NOT stalled (the #136 false-positive)", () => {
    // phase began well past the threshold (10 i2v shots, ~3min each), but a shot finished 60s ago.
    const now = 1_000_000;
    const s = stallSignal(
      job({
        phase_started_at: now - (KEYFRAME_STALL_SECONDS + 600) * 1000, // 30+ min in this one phase
        last_progress_at: now - 60 * 1000, // ...but a shot completed a minute ago
      }),
      now,
    );
    expect(s.stalled).toBeUndefined();
    expect(s.last_progress_at).toBe(now - 60 * 1000); // reported from real progress, not phase start
  });

  it("flags stalled from last_progress_at once NO shot has progressed within the window", () => {
    const now = 1_000_000;
    const lastProgress = now - (KEYFRAME_STALL_SECONDS + 30) * 1000;
    const s = stallSignal(
      job({ phase_started_at: now - 10 * 1000, last_progress_at: lastProgress }),
      now,
    );
    expect(s.stalled).toBe(true);
    expect(s.stall_seconds as number).toBe(KEYFRAME_STALL_SECONDS + 30); // measured from last progress
    expect(s.last_progress_at).toBe(lastProgress);
  });

  it("last_progress_at takes precedence over phase_started_at when both are present", () => {
    const s = stallSignal(job({ phase_started_at: 1_000, last_progress_at: 50_000 }), 50_000 + 60_000);
    expect(s.last_progress_at).toBe(50_000);
    expect(s.stalled).toBeUndefined();
  });
});

describe("filmJobToPollView keyframe sub-progress (#318)", () => {
  const kfJob = (over: Partial<FilmJob> = {}): FilmJob => ({
    film_id: "f", project: "p", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }, { shot_id: "shot_02", prompt: "b", seconds: 4 }, { shot_id: "shot_03", prompt: "c", seconds: 4 }],
    motion_backend: null, motion_config: {}, finish_config: {}, keyframe_binding: null,
    phase: "keyframe", phase_started_at: Date.now(), created_at: Date.now(), ...over,
  });

  it("subdivides the keyframe band from the snapshot's keyframe_done count", () => {
    const view = filmJobToPollView(kfJob(), null, 2); // 2 of 3 keyframes done
    const out = view.output as Record<string, unknown>;
    expect(out.phase).toBe("keyframe");
    expect(out.scene_index).toBe(3);       // min(total, done+1)
    expect(out.progress).toBeCloseTo(2 / 3);
  });

  it("holds scene_index=1 with no snapshot (cloud-keyframe / pre-job-id) -- no regression", () => {
    const view = filmJobToPollView(kfJob(), null); // keyframeDone undefined
    const out = view.output as Record<string, unknown>;
    expect(out.phase).toBe("keyframe");
    expect(out.scene_index).toBe(1);
    expect(out.progress).toBeUndefined();
  });
});

describe("filmRowFromJob (#164 -- film jobs in render history)", () => {
  const base: FilmJob = {
    film_id: "film-abc",
    project: "demo",
    bundle_key: "bundles/demo.tar.gz",
    scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 5 }],
    motion_backend: "own-gpu",
    motion_config: {},
    finish_config: {},
    keyframe_binding: "MODULE_KEYFRAME",
    phase: "clips",
    created_at: Date.now() - 60_000,
  };

  it("maps a full render job to a renders row (tier defaults to final)", () => {
    const row = filmRowFromJob(base);
    expect(row).toEqual({
      jobId: "film-abc",
      project: "demo",
      bundleKey: "bundles/demo.tar.gz",
      qualityTier: "final",
      status: "IN_PROGRESS",
      mode: "full",
      parentId: null,
    });
  });

  it("derives mode keyframes-only for a preview job", () => {
    const row = filmRowFromJob({ ...base, keyframes_only: true });
    expect(row.mode).toBe("keyframes-only");
  });

  it("carries derive_mode + parent_render_id for a cloud-finalized child", () => {
    const row = filmRowFromJob({ ...base, derive_mode: "cloud-finalized", parent_render_id: 42 });
    expect(row.mode).toBe("cloud-finalized");
    expect(row.parentId).toBe(42);
  });

  it("reflects the job phase in the row status (terminal + cancelled)", () => {
    expect(filmRowFromJob({ ...base, phase: "done" }).status).toBe("COMPLETED");
    expect(filmRowFromJob({ ...base, phase: "failed" }).status).toBe("FAILED");
    expect(filmRowFromJob({ ...base, phase: "failed", cancelled: true }).status).toBe("CANCELLED");
  });

  // #762: the row LABEL was hardcoded "final", so a draft film mislabeled as final in render history.
  // filmRowFromJob now reads job.quality_tier (set from the request's top-level qualityTier), defaulting
  // "final" only when the job carries none. Fails on pre-#762 code (draft asserted against the hardcode).
  it("#762: records the job quality_tier on the row (draft stays draft), defaulting final when absent", () => {
    expect(filmRowFromJob({ ...base, quality_tier: "draft" }).qualityTier).toBe("draft");
    expect(filmRowFromJob({ ...base, quality_tier: "standard" }).qualityTier).toBe("standard");
    expect(filmRowFromJob(base).qualityTier).toBe("final");
  });

});

describe("filmJobToPollView surfaces the #619 keyframes_incomplete degrade", () => {
  const base = (over: Partial<FilmJob>): FilmJob => ({
    film_id: "film-619",
    project: "neon",
    bundle_key: "bundles/neon.json",
    scenes: [
      { shot_id: "shot_01", prompt: "a", seconds: 7 },
      { shot_id: "shot_02", prompt: "b", seconds: 7 },
    ],
    motion_backend: null,
    motion_config: {},
    finish_config: {},
    keyframe_binding: null,
    phase: "clips",
    keyframes_incomplete: { adopted: 2, expected: 4, dropped: ["shot_03", "shot_04"] },
    created_at: Date.now(),
    ...over,
  });

  it("attaches keyframes_incomplete to the poll output while still in flight (not just at done)", () => {
    const view = filmJobToPollView(base({ phase: "clips" }), null);
    expect(view.status).toBe("IN_PROGRESS");
    expect((view.output as Record<string, unknown>).keyframes_incomplete).toEqual({ adopted: 2, expected: 4, dropped: ["shot_03", "shot_04"] });
  });

  it("attaches keyframes_incomplete to the poll output at done, alongside the delivered film", () => {
    const view = filmJobToPollView(base({ phase: "done", film_key: "renders/film-619/film.mp4" }), null);
    expect(view.status).toBe("COMPLETED");
    expect((view.output as Record<string, unknown>).keyframes_incomplete).toEqual({ adopted: 2, expected: 4, dropped: ["shot_03", "shot_04"] });
  });

  it("is absent on a normal render (no degrade)", () => {
    const view = filmJobToPollView(base({ phase: "clips", keyframes_incomplete: undefined }), null);
    expect((view.output as Record<string, unknown>).keyframes_incomplete).toBeUndefined();
  });

  it("surfaces film_finish.sidecar_key on the done output when a subtitle sidecar was produced (#663/#669)", () => {
    const view = filmJobToPollView(base({ phase: "done", film_key: "renders/film-619/film.mp4", film_finish: { applied: ["subtitle"], errors: [], sidecar_key: "renders/film-619/film.srt" } }), null);
    expect(view.status).toBe("COMPLETED");
    expect((view.output as Record<string, unknown>).sidecar_key).toBe("renders/film-619/film.srt");
  });

  it("omits sidecar_key on the done output when no sidecar was produced (burn-only / silent / pre-#663)", () => {
    const view = filmJobToPollView(base({ phase: "done", film_key: "renders/film-619/film.mp4", film_finish: { applied: ["film-titles"], errors: [] } }), null);
    expect(view.status).toBe("COMPLETED");
    expect((view.output as Record<string, unknown>).sidecar_key).toBeUndefined();
  });
});
