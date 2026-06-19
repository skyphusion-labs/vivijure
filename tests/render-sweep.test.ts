import { describe, it, expect } from "vitest";
import { sweepUnresolvedJobs } from "../src/render-sweep";
import { filmJobDocKey } from "../src/film-orchestrator";
import type { Env } from "../src/env";

// The cron sweep must self-heal a film job that rendered all its clips but stalled
// before "done" and then aged past SWEEP_MAX_AGE_SECONDS -- the remaining work is the
// CPU-only concat, which never expires, so abandoning it would strand a finished film
// over its last step. But it must NOT chase a stranded job whose R2 doc was swept (the
// clips are gone with it). These fakes return canned D1 rows + an R2 with a controllable
// doc set; the swept jobs are persisted phase "done" so advanceFilmJob resolves them with
// zero network (no RunPod / container call) and the sweep is the only thing under test.

type Rows = Array<{ job_id: string }>;

function makeEnv(opts: {
  inWindow?: Rows; // listUnresolvedNotifiableJobs results (submitted_at >= cutoff)
  stranded?: Rows; // listStrandedPostClipsFilmJobs results (post-clips, aged out)
  docsInR2?: string[]; // film_ids whose film-job.json exists in R2 (phase "done")
}) {
  const inWindow = opts.inWindow ?? [];
  const stranded = opts.stranded ?? [];
  const docs = new Set(opts.docsInR2 ?? []);
  const advanced: string[] = []; // film ids whose doc advanceFilmJob actually read

  // The two list queries are distinguished by their SQL text; updateRenderFromView's
  // own queries (first/run) are harmless no-ops here.
  const prepare = (sql: string) => {
    const isStrandedQuery = sql.includes('"phase":"assemble"');
    const isInWindowQuery = sql.includes("submitted_at >= ?") && !isStrandedQuery;
    return {
      bind: () => prepare(sql),
      all: async () => ({ results: isStrandedQuery ? stranded : isInWindowQuery ? inWindow : [] }),
      first: async () => null,
      run: async () => ({ success: true }),
    };
  };

  const env = {
    DB: { prepare: (sql: string) => prepare(sql) },
    R2_RENDERS: {
      head: async (key: string) => (docs.has(filmIdFromDocKey(key)) ? {} : null),
      get: async (key: string) => {
        const id = filmIdFromDocKey(key);
        if (!docs.has(id)) return null;
        advanced.push(id);
        // phase "done" -> advanceFilmJob returns immediately, no external calls.
        return { text: async () => JSON.stringify({ film_id: id, project: "p", scenes: [], phase: "done" }) };
      },
      put: async () => {},
    },
  } as unknown as Env;
  return { env, advanced };
}

function filmIdFromDocKey(key: string): string {
  // filmJobDocKey(id) === `renders/${id}/film-job.json`
  return key.replace(/^renders\//, "").replace(/\/film-job\.json$/, "");
}

describe("sweepUnresolvedJobs (stranded post-clips self-heal)", () => {
  it("re-drives a stranded post-clips film job whose R2 doc still exists", async () => {
    const id = "film-stranded-1";
    const { env, advanced } = makeEnv({ stranded: [{ job_id: id }], docsInR2: [id] });
    const n = await sweepUnresolvedJobs(env);
    expect(advanced).toContain(id); // the sweep loaded + advanced it
    expect(n).toBe(1);
  });

  it("skips a stranded film job whose R2 doc was swept (clips gone -- nothing to assemble)", async () => {
    const id = "film-stranded-2";
    const { env, advanced } = makeEnv({ stranded: [{ job_id: id }], docsInR2: [] });
    const n = await sweepUnresolvedJobs(env);
    expect(advanced).not.toContain(id);
    expect(n).toBe(0);
  });

  it("does not double-drive a job that is in both passes", async () => {
    const id = "film-both";
    const { env, advanced } = makeEnv({
      inWindow: [{ job_id: id }],
      stranded: [{ job_id: id }],
      docsInR2: [id],
    });
    await sweepUnresolvedJobs(env);
    expect(advanced.filter((x) => x === id)).toHaveLength(1); // pass-1 wins; pass-2 de-dups
  });

  it("verifies the doc key the sweep checks matches filmJobDocKey", () => {
    expect(filmJobDocKey("film-x")).toBe("renders/film-x/film-job.json");
    expect(filmIdFromDocKey(filmJobDocKey("film-x"))).toBe("film-x");
  });
});
