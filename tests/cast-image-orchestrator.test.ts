import { describe, it, expect } from "vitest";
import { selectSeedKeys, summarizeCastRefs, castRefsJobKey, type CastRefsJob } from "../src/cast-image-orchestrator";

describe("cast-image orchestrator pure logic", () => {
  it("selectSeedKeys: portrait first, then requested valid sources, de-duped + capped", () => {
    const sources = [{ key: "s1" }, { key: "s2" }, { key: "s3" }];
    expect(selectSeedKeys("p", sources, ["s2", "s1"])).toEqual(["p", "s2", "s1"]);
    expect(selectSeedKeys("p", sources, [])).toEqual(["p"]);
    expect(selectSeedKeys("p", sources, undefined)).toEqual(["p"]);
  });

  it("selectSeedKeys: drops source keys that are not the member's own", () => {
    const sources = [{ key: "s1" }];
    expect(selectSeedKeys("p", sources, ["s1", "not-mine"])).toEqual(["p", "s1"]);
  });

  it("selectSeedKeys: no portrait -> first valid source becomes the seed (sources-only members)", () => {
    const sources = [{ key: "s1" }, { key: "s2" }];
    expect(selectSeedKeys(null, sources, ["s2"])).toEqual(["s2"]);
    expect(selectSeedKeys(null, sources, undefined)).toEqual([]); // nothing to generate from
    expect(selectSeedKeys(null, [], undefined)).toEqual([]);
  });

  it("selectSeedKeys: caps the seed set (FLUX 2 takes <=4 reference inputs)", () => {
    const sources = [{ key: "s1" }, { key: "s2" }, { key: "s3" }, { key: "s4" }, { key: "s5" }];
    expect(selectSeedKeys("p", sources, ["s1", "s2", "s3", "s4", "s5"])).toEqual(["p", "s1", "s2", "s3"]);
  });

  it("selectSeedKeys: de-dupes a requested key that equals the portrait", () => {
    expect(selectSeedKeys("p", [{ key: "p" }], ["p"])).toEqual(["p"]);
  });

  it("summarizeCastRefs maps the job to the caller-facing view", () => {
    const job: CastRefsJob = {
      job_id: "refs-1", cast_id: 7, cast_public_id: "a7000000-0000-4000-8000-000000000007",
      module_name: "cast-image", binding: "MODULE_CAST_IMAGE", phase: "done",
      images: [{ key: "cast-gen/7/ref_01.png", mime: "image/png" }],
      applied: ["model:flux-2-klein-9b", "generated:1"], registered: 1, created_at: 0,
    };
    expect(summarizeCastRefs(job)).toEqual({
      job_id: "refs-1", cast_id: "a7000000-0000-4000-8000-000000000007", phase: "done", module: "cast-image",
      registered: 1, images: [{ key: "cast-gen/7/ref_01.png", mime: "image/png" }], error: undefined,
    });
  });

  it("summarizeCastRefs carries an error + omits an unset module", () => {
    const job: CastRefsJob = {
      job_id: "refs-2", cast_id: 9, cast_public_id: "a9000000-0000-4000-8000-000000000009",
      module_name: null, binding: null, phase: "failed",
      images: [], applied: [], registered: 0, error: "no cast.image module installed", created_at: 0,
    };
    const s = summarizeCastRefs(job);
    expect(s.module).toBeUndefined();
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("no cast.image module installed");
  });

  it("castRefsJobKey is per cast + job", () => {
    expect(castRefsJobKey(7, "refs-abc")).toBe("cast-gen/7/refs-abc.refs-job.json");
  });
});
