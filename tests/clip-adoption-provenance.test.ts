// #767 regression: cross-render clip-adoption contamination (same project namespace).
//
// Three films off the SAME bundle derive the SAME project namespace + SAME shot_ids. A second render that
// switched motion backend (seedance -> kling) used to ADOPT the first render's already-rendered clip via
// the R2-presence reclaim -- which matched by shot-id boundary alone -- and ship byte-identical, wrong
// content. The provenance sidecar (<clip_key>.prov) makes the reclaim refuse any clip it cannot prove was
// produced by THIS render config; a mismatched-backend clip is never adopted, the shot re-renders.

import { describe, it, expect } from "vitest";
import { reclaimClipsFromR2 } from "../src/render-orchestrator";
import type { ClipJob } from "../src/render-orchestrator";
import { clipProvenanceHash, provKey } from "../src/clip-provenance";
import type { Env } from "../src/env";

const NOW = 5_000_000;
const KF_KEY = "renders/proj/keyframes/shot_01.png";
const KF_ETAG = "kf-etag-stable";
const PROMPT = "a knight on a balloon at dawn";

/** Tiny in-memory R2 with the four methods the reclaim + provenance path touch. */
function memR2() {
  const store = new Map<string, { body: string; uploaded: number; etag: string }>();
  const seed = (key: string, o: { body?: string; uploaded?: number; etag?: string }) =>
    store.set(key, { body: o.body ?? "", uploaded: o.uploaded ?? NOW, etag: o.etag ?? "et-" + key });
  const env = {
    R2_RENDERS: {
      list: async ({ prefix }: { prefix: string; cursor?: string; limit?: number }) => ({
        objects: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, v]) => ({ key, uploaded: new Date(v.uploaded) })),
        truncated: false,
      }),
      get: async (key: string) => {
        const o = store.get(key);
        return o ? { text: async () => o.body } : null;
      },
      head: async (key: string) => {
        const o = store.get(key);
        return o ? { etag: o.etag } : null;
      },
      put: async (key: string, value: unknown) => {
        seed(key, { body: typeof value === "string" ? value : "", uploaded: NOW, etag: "et-" + key });
      },
    },
  } as unknown as Env;
  return { store, env, seed };
}

/** A single-shot clip job pending on shot_01, keyed to the shared project keyframe. */
function pendingJob(motion_backend: string, config: Record<string, unknown>): ClipJob {
  return {
    job_id: "j-" + motion_backend,
    project: "proj",
    motion_backend,
    binding: "MODULE_" + motion_backend.toUpperCase(),
    created_at: NOW,
    shots: [{
      shot_id: "shot_01",
      keyframe_url: "https://presigned/kf",
      keyframe_key: KF_KEY,
      prompt: PROMPT,
      seconds: 5,
      status: "pending",
      motion_backend,
      config,
    }],
  };
}

async function stampFor(env: Env, seed: ReturnType<typeof memR2>["seed"], clipKey: string, motion_backend: string, config: Record<string, unknown>) {
  seed(clipKey, { uploaded: NOW + 1_000, etag: "et-" + clipKey });
  const hash = await clipProvenanceHash({ motion_backend, config, keyframe_etag: KF_ETAG, prompt: PROMPT, seconds: 5 });
  seed(provKey(clipKey), { body: hash, uploaded: NOW + 1_000 });
}

describe("#767 clip-adoption provenance: a different-backend render never adopts a mismatched clip", () => {
  it("does NOT adopt a seedance clip for a kling re-render of the same project+shot (the contamination)", async () => {
    const { env, seed } = memR2();
    seed(KF_KEY, { etag: KF_ETAG });
    await stampFor(env, seed, "renders/proj/clips/shot_01_seedance.mp4", "seedance", { steps: 30 });

    const cj = pendingJob("kling", { steps: 40 }); // switched backend + config
    const adopted = await reclaimClipsFromR2(env, cj);

    expect(adopted).toBe(0);
    expect(cj.shots[0].status).toBe("pending"); // must re-render its own clip, never adopt seedance's
    expect(cj.shots[0].clip_key).toBeUndefined();
  });

  it("adopts ONLY this render's own clip when both a sibling's and its own are present (disambiguation)", async () => {
    const { env, seed } = memR2();
    seed(KF_KEY, { etag: KF_ETAG });
    await stampFor(env, seed, "renders/proj/clips/shot_01_seedance.mp4", "seedance", { steps: 30 });
    await stampFor(env, seed, "renders/proj/clips/shot_01_kling.mp4", "kling", { steps: 40 });

    const cj = pendingJob("kling", { steps: 40 });
    const adopted = await reclaimClipsFromR2(env, cj);

    expect(adopted).toBe(1);
    expect(cj.shots[0].status).toBe("done");
    expect(cj.shots[0].clip_key).toBe("renders/proj/clips/shot_01_kling.mp4"); // NOT the seedance clip
  });

  it("adopts an identical-config clip (legit same-config reuse is preserved)", async () => {
    const { env, seed } = memR2();
    seed(KF_KEY, { etag: KF_ETAG });
    await stampFor(env, seed, "renders/proj/clips/shot_01_kling.mp4", "kling", { steps: 40 });

    const cj = pendingJob("kling", { steps: 40 }); // same backend + config as the stamped clip
    const adopted = await reclaimClipsFromR2(env, cj);

    expect(adopted).toBe(1);
    expect(cj.shots[0].clip_key).toBe("renders/proj/clips/shot_01_kling.mp4");
  });

  it("recovers a legacy UNSTAMPED single candidate (#141 survives) and heals it with this render's fingerprint", async () => {
    const { env, seed, store } = memR2();
    seed(KF_KEY, { etag: KF_ETAG });
    // A lost-poll clip THIS render produced, no sidecar (pre-#767 artifact), uploaded after the job started.
    seed("renders/proj/clips/shot_01_kling.mp4", { uploaded: NOW + 1_000, etag: "et-own" });

    const cj = pendingJob("kling", { steps: 40 });
    const adopted = await reclaimClipsFromR2(env, cj);

    expect(adopted).toBe(1);
    expect(cj.shots[0].clip_key).toBe("renders/proj/clips/shot_01_kling.mp4");
    // healed: the reclaim stamped a sidecar so the next reclaim / any sibling relies on provenance
    expect(store.has(provKey("renders/proj/clips/shot_01_kling.mp4"))).toBe(true);
  });

  it("refuses an ambiguous set of TWO unstamped candidates (rival lost-poll renders) -> re-render", async () => {
    const { env, seed } = memR2();
    seed(KF_KEY, { etag: KF_ETAG });
    seed("renders/proj/clips/shot_01_seedance.mp4", { uploaded: NOW + 1_000, etag: "et-a" });
    seed("renders/proj/clips/shot_01_kling.mp4", { uploaded: NOW + 1_000, etag: "et-b" });

    const cj = pendingJob("kling", { steps: 40 });
    const adopted = await reclaimClipsFromR2(env, cj);

    expect(adopted).toBe(0);
    expect(cj.shots[0].status).toBe("pending"); // cannot prove which is ours -> re-render, never guess
  });
});
