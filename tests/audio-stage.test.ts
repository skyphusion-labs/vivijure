// Regression for the scored-render 500: an `out/<uuid>.mp3` key from the score-bed MODULE workers
// (music-gen/narration-gen, #158) lands in R2_RENDERS (vivijure), NOT env.R2 (skyphusion-llm). The
// staging must check R2_RENDERS first and use it as-is; only the legacy chat-side out/ key (in env.R2)
// gets cross-copied. Before the fix, a score-bed key threw "audio source not found" -> film kick 500.
import { describe, it, expect } from "vitest";
import { stageAudioKeyForRenders, resolveStagedAudioKey } from "../src/audio-stage";
import type { Env } from "../src/env";

function fakeEnv(opts: { rendersHas?: string[]; r2Has?: Record<string, string> }) {
  const rendersHas = new Set(opts.rendersHas ?? []);
  const r2Has = opts.r2Has ?? {};
  const puts: string[] = [];
  let r2Gets = 0;
  const env = {
    R2_RENDERS: {
      head: async (k: string) => (rendersHas.has(k) ? {} : null),
      put: async (k: string) => { puts.push(k); },
    },
    R2: {
      get: async (k: string) => {
        r2Gets += 1;
        return k in r2Has
          ? { httpMetadata: { contentType: r2Has[k] }, arrayBuffer: async () => new ArrayBuffer(8) }
          : null;
      },
    },
  } as unknown as Env;
  return { env, puts, r2Gets: () => r2Gets };
}

describe("stageAudioKeyForRenders bucket routing", () => {
  it("returns an audio/ key as-is (BYO upload already in R2_RENDERS, no copy)", async () => {
    const { env, puts, r2Gets } = fakeEnv({});
    const out = await stageAudioKeyForRenders(env, "audio/abc.mp3");
    expect(out).toBe("audio/abc.mp3");
    expect(puts).toEqual([]);
    expect(r2Gets()).toBe(0); // never touched env.R2
  });

  it("returns a score-bed out/ key as-is when it is already in R2_RENDERS (no env.R2 read, no copy)", async () => {
    const { env, puts, r2Gets } = fakeEnv({ rendersHas: ["out/bed.mp3"] });
    const out = await stageAudioKeyForRenders(env, "out/bed.mp3");
    expect(out).toBe("out/bed.mp3");
    expect(puts).toEqual([]);
    expect(r2Gets()).toBe(0); // the bug was reading env.R2 here and throwing
  });

  it("cross-copies a legacy chat-side out/ key from env.R2 into R2_RENDERS under audio/", async () => {
    const { env, puts } = fakeEnv({ r2Has: { "out/chat.mp3": "audio/mpeg" } });
    const out = await stageAudioKeyForRenders(env, "out/chat.mp3");
    expect(out).toMatch(/^audio\/[0-9a-f-]+\.mp3$/);
    expect(puts.length).toBe(1);
    expect(puts[0]).toBe(out);
  });

  it("throws only when an out/ key is in neither bucket", async () => {
    const { env } = fakeEnv({});
    await expect(stageAudioKeyForRenders(env, "out/missing.mp3")).rejects.toThrow(/audio source not found/);
  });

  it("resolveStagedAudioKey returns undefined for no key, stages otherwise", async () => {
    const { env } = fakeEnv({ rendersHas: ["out/bed.mp3"] });
    expect(await resolveStagedAudioKey(env, undefined)).toBeUndefined();
    expect(await resolveStagedAudioKey(env, "  ")).toBeUndefined();
    expect(await resolveStagedAudioKey(env, "out/bed.mp3")).toBe("out/bed.mp3");
  });
});
