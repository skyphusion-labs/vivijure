import { describe, it, expect } from "vitest";
import { writeCloudAnimateLog, type CloudAnimateLogInput } from "../src/render-log";
import type { Env } from "../src/env";

// Issue #15: writeCloudAnimateLog must enrich a LOCAL copy (never mutate the caller's
// shots) and fetch the per-shot AI Gateway logs concurrently + resiliently. A fake
// AI.gateway().getLog + a fake R2 put exercise it with no network.

function makeEnv(getLog: (logId: string) => Promise<unknown>) {
  const putCalls: Array<{ key: string; body: string }> = [];
  const getLogCalls: string[] = [];
  const env = {
    GATEWAY_ID: "gw-1",
    AI: {
      gateway: (_id: string) => ({
        getLog: (logId: string) => {
          getLogCalls.push(logId);
          return getLog(logId);
        },
      }),
    },
    R2_RENDERS: {
      put: async (key: string, body: string) => {
        putCalls.push({ key, body });
      },
    },
  } as unknown as Env;
  return { env, putCalls, getLogCalls };
}

const baseInput = (): CloudAnimateLogInput => ({
  jobId: "job-1",
  model: "wan-i2v",
  status: "COMPLETED",
  shots: [
    { shot_id: "shot_01", model: "wan-i2v", status: "ok", log_id: "L1" },
    { shot_id: "shot_02", model: "wan-i2v", status: "ok", log_id: "L2" },
  ],
});

describe("writeCloudAnimateLog (issue #15: copy, not mutate; parallel + resilient)", () => {
  it("does NOT mutate the caller's input shots", async () => {
    const { env } = makeEnv(async (id) => ({ cost: 0.01, id }));
    const input = baseInput();
    await writeCloudAnimateLog(env, input);
    expect(input.shots[0].gateway_log).toBeUndefined();
    expect(input.shots[1].gateway_log).toBeUndefined();
  });

  it("writes an enriched copy (the gateway log lands in the file)", async () => {
    const { env, putCalls } = makeEnv(async (id) => ({ marker: `LOG_FOR_${id}` }));
    const key = await writeCloudAnimateLog(env, baseInput());
    expect(key).toBe("renders/logs/job-1.txt");
    expect(putCalls.length).toBe(1);
    expect(putCalls[0].body).toContain("LOG_FOR_L1");
    expect(putCalls[0].body).toContain("LOG_FOR_L2");
  });

  it("fetches one getLog per shot that has a log_id", async () => {
    const { env, getLogCalls } = makeEnv(async () => ({}));
    const input = baseInput();
    input.shots.push({ shot_id: "shot_03", model: "wan-i2v", status: "failed", log_id: null });
    await writeCloudAnimateLog(env, input);
    expect(getLogCalls.sort()).toEqual(["L1", "L2"]); // shot_03 (no log_id) skipped
  });

  it("survives a failing getLog on one shot -- still writes, other shots enriched", async () => {
    const { env, putCalls } = makeEnv(async (id) => {
      if (id === "L1") throw new Error("log expired");
      return { marker: `LOG_FOR_${id}` };
    });
    const input = baseInput();
    const key = await writeCloudAnimateLog(env, input);
    expect(key).toBe("renders/logs/job-1.txt");
    expect(putCalls.length).toBe(1); // a single failed lookup did not drop the file
    expect(putCalls[0].body).toContain("LOG_FOR_L2"); // the healthy shot still enriched
    expect(input.shots[0].gateway_log).toBeUndefined(); // caller object still untouched
  });

  it("returns null when the R2 write fails (best-effort, never throws)", async () => {
    const { env } = makeEnv(async () => ({}));
    (env as unknown as { R2_RENDERS: { put: () => Promise<void> } }).R2_RENDERS.put = async () => {
      throw new Error("R2 down");
    };
    const key = await writeCloudAnimateLog(env, baseInput());
    expect(key).toBeNull();
  });
});
