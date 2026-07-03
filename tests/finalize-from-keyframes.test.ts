import { describe, it, expect } from "vitest";
import { parseStoryboardScenes } from "../src/planner-yaml";
import {
  selectPreviewKeyframes,
  validatePreviewParent,
  clipAnimateProgress,
} from "../src/finalize-from-keyframes";
import type { RenderRow } from "../src/renders-db";
import type { ClipJob } from "../src/render-orchestrator";

const yaml = `title: "demo"
scenes:
  - prompt: "a city at dawn"
    id: "shot_01"
    target_seconds: 5
  - prompt: "a chase"
    target_seconds: 7
`;

describe("parseStoryboardScenes", () => {
  it("reads prompt, id, and target_seconds", () => {
    expect(parseStoryboardScenes(yaml)).toEqual([
      { shot_id: "shot_01", prompt: "a city at dawn", seconds: 5 },
      { shot_id: "shot_02", prompt: "a chase", seconds: 7 },
    ]);
  });
});

const previewRow = (over: Partial<RenderRow> = {}): RenderRow => ({
  id: 1,
  public_id: "prev0000-0000-4000-8000-000000000001",
  job_id: "film-prev",
  project: "demo",
  bundle_key: "bundles/demo.tar.gz",
  quality_tier: "final",
  render_overrides: null,
  status: "COMPLETED",
  output_key: null,
  output: null,
  error: null,
  execution_time_ms: null,
  delay_time_ms: null,
  submitted_at: 1,
  updated_at: 1,
  completed_at: 2,
  label: null,
  keyframes: [{ shot_id: "shot_01", key: "k/1.png" }, { shot_id: "shot_02", key: "k/2.png" }],
  mode: "keyframes-only",
  locked_shots: null,
  project_id: null,
  folder_path: null,
  tags: [],
  parent_id: null,
  project_public_id: null,
  parent_public_id: null,
  ...over,
});

describe("validatePreviewParent", () => {
  it("accepts a completed keyframes-only row", () => {
    expect(validatePreviewParent(previewRow())).toBeNull();
  });
  it("rejects non-preview rows", () => {
    expect(validatePreviewParent(previewRow({ mode: "full" }))).toMatch(/not a keyframes-only/);
  });
});

describe("selectPreviewKeyframes", () => {
  it("filters to locked shots when any are set", () => {
    const picked = selectPreviewKeyframes(previewRow({ locked_shots: ["shot_02"] }));
    expect(picked).toEqual([{ shot_id: "shot_02", keyframe_key: "k/2.png" }]);
  });
});

describe("clipAnimateProgress", () => {
  const GPU_DOORS = new Set(["own-gpu", "local-gpu"]);
  const baseJob = (shots: ClipJob["shots"]): ClipJob => ({
    job_id: "clips-1",
    project: "demo",
    motion_backend: "own-gpu",
    binding: "MODULE_OWN_GPU",
    shots,
    created_at: Date.now(),
  });

  it("splits gpu and cloud lane counts", () => {
    const job = baseJob([
      { shot_id: "shot_01", keyframe_url: "u1", prompt: "a", seconds: 4, status: "done", motion_backend: "own-gpu", binding: "MODULE_OWN_GPU" },
      { shot_id: "shot_02", keyframe_url: "u2", prompt: "b", seconds: 4, status: "pending", motion_backend: "seedance", binding: "MODULE_SEEDANCE" },
    ]);
    const p = clipAnimateProgress(job, GPU_DOORS);
    expect(p.gpu).toEqual({ done: 1, total: 1, status: "done" });
    expect(p.cloud).toEqual({ done: 0, total: 1 });
    expect(p.done).toBe(1);
    expect(p.total).toBe(2);
  });

  it("classifies by LOCALITY, not name: a local door's shots count gpu, not cloud", () => {
    const job = baseJob([
      { shot_id: "shot_01", keyframe_url: "u1", prompt: "a", seconds: 4, status: "done", motion_backend: "local-gpu", binding: "MODULE_LOCAL_GPU" },
      { shot_id: "shot_02", keyframe_url: "u2", prompt: "b", seconds: 4, status: "pending", motion_backend: "kling", binding: "MODULE_KLING" },
    ]);
    const p = clipAnimateProgress(job, GPU_DOORS);
    expect(p.gpu).toEqual({ done: 1, total: 1, status: "done" });
    expect(p.cloud).toEqual({ done: 0, total: 1 });
  });

  it("a shot with no resolvable backend counts gpu (the default lane)", () => {
    const job = { ...baseJob([
      { shot_id: "shot_01", keyframe_url: "u1", prompt: "a", seconds: 4, status: "pending", binding: "MODULE_OWN_GPU" } as ClipJob["shots"][number],
    ]), motion_backend: undefined } as unknown as ClipJob;
    const p = clipAnimateProgress(job, GPU_DOORS);
    expect(p.gpu.total).toBe(1);
    expect(p.cloud.total).toBe(0);
  });
});
