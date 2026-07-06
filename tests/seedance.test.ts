import { describe, it, expect } from "vitest";
import { clampDuration, buildSeedanceBody, extractVideoUrl, clipKey, encodePoll, decodePoll, runpodJobGone, classifyGoneState, RUNPOD_NOTFOUND_GRACE_MS, RESOLUTIONS, DEFAULT_RESOLUTION } from "../modules/seedance/src/seedance";
import seedanceWorker from "../modules/seedance/src/index";

describe("seedance pure logic", () => {
  it("clampDuration bounds the shot length into Seedance's [4,12] range (min 4: the endpoint 400s on 3, #279)", () => {
    expect(clampDuration(5)).toBe(5);
    expect(clampDuration(0)).toBe(5); // 0 -> default 5
    expect(clampDuration(99)).toBe(12);
    expect(clampDuration(1)).toBe(4); // below-range snaps UP to 4 (was 3, which the endpoint rejects)
    expect(clampDuration(3)).toBe(4); // 3 was the #279-shaped break
    expect(clampDuration(7.6)).toBe(8);
  });

  it("buildSeedanceBody maps the hook input + config onto the RunPod body", () => {
    const body = buildSeedanceBody(
      { shot_id: "shot_01", keyframe_url: "https://r2/x.png", prompt: "a city at dawn", seconds: 5 },
      { resolution: "480p", aspect_ratio: "9:16", camera_fixed: true, generate_audio: true, seed: 42 },
    );
    expect(body.input).toMatchObject({
      prompt: "a city at dawn",
      image: "https://r2/x.png",
      duration: 5,
      resolution: "480p",
      aspect_ratio: "9:16",
      camera_fixed: true,
      generate_audio: true,
      seed: 42,
    });
  });

  it("buildSeedanceBody falls back to sane defaults for missing config", () => {
    const body = buildSeedanceBody(
      { shot_id: "s", keyframe_url: "u", prompt: "p", seconds: 8 },
      {},
    );
    expect(body.input).toMatchObject({ resolution: "720p", aspect_ratio: "16:9", camera_fixed: false, generate_audio: false, seed: -1, duration: 8 });
  });

  it("#577: the manifest's resolution enum IS the provider-accepted set (no 1080p over-promise)", async () => {
    // The provider 400s anything but 480p/720p ("Invalid resolution: '1080p'. Must be '480p' or
    // '720p'"); an enum value the provider rejects passes the core clamp and fails every shot AFTER
    // the keyframe spend. The manifest builds its enum from RESOLUTIONS, pinned here.
    expect(RESOLUTIONS).toEqual(["480p", "720p"]);
    expect(RESOLUTIONS).toContain(DEFAULT_RESOLUTION);
    const res = await seedanceWorker.fetch(
      new Request("https://module/module.json"),
      {} as unknown as Parameters<typeof seedanceWorker.fetch>[1],
    );
    const manifest = (await res.json()) as { config_schema: { resolution: { values: string[]; default: string } } };
    expect(manifest.config_schema.resolution.values).toEqual(RESOLUTIONS);
    expect(manifest.config_schema.resolution.default).toBe(DEFAULT_RESOLUTION);
  });

  it("extractVideoUrl finds the video url across output shapes", () => {
    expect(extractVideoUrl("https://cdn/x.mp4")).toBe("https://cdn/x.mp4");
    expect(extractVideoUrl({ video_url: "https://cdn/y.mp4" })).toBe("https://cdn/y.mp4");
    expect(extractVideoUrl({ output: { url: "https://cdn/z.mp4" } })).toBe("https://cdn/z.mp4");
    expect(extractVideoUrl([{ foo: 1 }, { video: "https://cdn/a.mp4" }])).toBe("https://cdn/a.mp4");
    expect(extractVideoUrl({ nope: 1 })).toBeNull();
  });

  it("extractVideoUrl prefers an mp4 but falls back to the first http url", () => {
    expect(extractVideoUrl({ thumb: "https://cdn/t.jpg", clip: "https://cdn/v.mp4" })).toBe("https://cdn/v.mp4");
    expect(extractVideoUrl({ only: "https://cdn/asset" })).toBe("https://cdn/asset");
  });

  it("clipKey sanitizes project + shot into an R2 path", () => {
    expect(clipKey("My Project!", "shot 01")).toBe("renders/My_Project_/clips/shot_01_seedance.mp4");
  });

  it("encodePoll/decodePoll round-trip the async job state", () => {
    const st = { jobId: "abc123", project: "My Proj", shotId: "shot_01", seconds: 5 };
    expect(decodePoll(encodePoll(st))).toEqual(st);
    expect(decodePoll("not-valid-token")).toBeNull();
  });
});

describe("seedance RunPod gone-detection + grace (#141)", () => {
  it("round-trips submittedAt; legacy token decodes undefined", () => {
    const s = { jobId: "j", project: "p", shotId: "shot_04", seconds: 5, submittedAt: 1_700_000_000_000 };
    expect(decodePoll(encodePoll(s))).toEqual(s);
    expect(decodePoll(encodePoll({ jobId: "j", project: "p", shotId: "s", seconds: 5 }))?.submittedAt).toBeUndefined();
  });
  it("runpodJobGone detects 404 / numeric-404 / not-found, not a real run state", () => {
    expect(runpodJobGone(404, { status: 404 })).toBe(true);
    expect(runpodJobGone(200, { status: 404, title: "Not Found" } as never)).toBe(true);
    expect(runpodJobGone(200, { title: "Not Found" })).toBe(true);
    expect(runpodJobGone(200, { status: "COMPLETED" })).toBe(false);
    expect(runpodJobGone(200, { status: "IN_PROGRESS" })).toBe(false);
  });
  it("classifyGoneState: grace vs fail vs legacy", () => {
    const now = 4_000_000;
    expect(classifyGoneState(now - (RUNPOD_NOTFOUND_GRACE_MS - 1), now)).toBe("gone-grace");
    expect(classifyGoneState(now - (RUNPOD_NOTFOUND_GRACE_MS + 1), now)).toBe("gone-failed");
    expect(classifyGoneState(undefined, now)).toBe("gone-failed");
  });
});
