import { describe, it, expect } from "vitest";
import { claimFilmAdvance, releaseFilmAdvance, FILM_ADVANCE_LEASE_TTL_SECONDS } from "../src/renders-db";
import { advanceFilmJob, filmJobDocKey, type FilmJob, type FinishShot } from "../src/film-orchestrator";
import type { Env } from "../src/env";

// S4: the film-advance lease. advanceFilmJob is driven concurrently by the 1-minute cron sweep
// and every client status poll; both do an unlocked read-modify-write on the R2 film-job doc, so
// two racers could each observe phase N incomplete and BOTH submit the underlying external work
// (clip start / dialogue / per-shot finish steps / mux) -- duplicated GPU spend. The lease
// (claimFilmAdvance, the claimFinish conditional-UPDATE pattern) makes exactly ONE driver advance
// a film per tick; the loser reads the doc read-only.

// A fake D1 implementing the lease SQL semantics atomically (each run() has no internal await, so
// it is atomic under JS concurrency exactly as a single D1 UPDATE is under SQLite's writer lock).
function leaseDb(jobIds: string[]) {
  const rows = new Map<string, { advance_lease: number | null }>(
    jobIds.map((id) => [id, { advance_lease: null }]),
  );
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => {
              if (sql.includes("advance_lease = NULL")) {
                const [jobId, lease] = args as [string, number];
                const r = rows.get(jobId);
                if (r && r.advance_lease === lease) {
                  r.advance_lease = null;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes("SET advance_lease")) {
                const [lease, jobId, now] = args as [number, string, number];
                const r = rows.get(jobId);
                if (r && (r.advance_lease === null || r.advance_lease < now)) {
                  r.advance_lease = lease;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 0 } };
            },
            first: async () => (rows.has(args[0] as string) ? { one: 1 } : null),
          };
        },
      };
    },
  };
  return { DB, rows };
}

describe("claimFilmAdvance / releaseFilmAdvance (win / lose / reset)", () => {
  const id = "film-lease-unit";

  it("first claim wins with a lease token; a concurrent second claim loses", async () => {
    const { DB } = leaseDb([id]);
    const env = { DB } as unknown as Env;
    const a = await claimFilmAdvance(env, id, 1000);
    expect(a.won).toBe(true);
    expect(a.lease).toBe(1000 + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000);
    const b = await claimFilmAdvance(env, id, 1001);
    expect(b.won).toBe(false);
    expect(b.lease).toBeUndefined();
  });

  it("release (by token) makes the lease re-grantable; a stale token releases nothing", async () => {
    const { DB, rows } = leaseDb([id]);
    const env = { DB } as unknown as Env;
    const a = await claimFilmAdvance(env, id, 1000);
    await releaseFilmAdvance(env, id, (a.lease as number) - 1); // stale token: no-op
    expect(rows.get(id)?.advance_lease).toBe(a.lease);
    await releaseFilmAdvance(env, id, a.lease as number);
    expect(rows.get(id)?.advance_lease).toBeNull();
    const b = await claimFilmAdvance(env, id, 2000);
    expect(b.won).toBe(true); // genuine retry after a released tick is never deadlocked
  });

  it("an EXPIRED lease is re-grantable (a crashed winner never wedges the job)", async () => {
    const { DB } = leaseDb([id]);
    const env = { DB } as unknown as Env;
    const t0 = 1000;
    const a = await claimFilmAdvance(env, id, t0);
    expect(a.won).toBe(true);
    // ... the winner crashes; no release. Before expiry: still held.
    const before = await claimFilmAdvance(env, id, t0 + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000 - 1);
    expect(before.won).toBe(false);
    // Past expiry: the next driver wins it fresh.
    const after = await claimFilmAdvance(env, id, t0 + FILM_ADVANCE_LEASE_TTL_SECONDS * 1000 + 1);
    expect(after.won).toBe(true);
  });

  it("no renders row at all: wins UNGUARDED (no token) -- a legacy/untracked film must not deadlock", async () => {
    const { DB } = leaseDb([]); // no row for this film
    const env = { DB } as unknown as Env;
    const a = await claimFilmAdvance(env, "film-no-row", 1000);
    expect(a.won).toBe(true);
    expect(a.lease).toBeUndefined(); // nothing to release
  });
});

// The concurrency proof: two advanceFilmJob invocations racing on the SAME finish-phase job.
// The finish leg SUBMITS the shot's current module (invokeModule) whenever the shot has no poll
// token -- both racers read the doc pre-submit, so without the lease BOTH would invoke (double
// GPU lip-sync spend). With the lease, exactly one submission happens; the loser reports the doc
// read-only and writes nothing.
describe("advanceFilmJob under the lease: two concurrent drivers, ONE submission", () => {
  const filmId = "film-lease-race";

  const finishFilm = (): FilmJob => ({
    film_id: filmId, project: "neon", bundle_key: "b",
    scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
    motion_backend: "own-gpu", motion_config: {}, finish_config: {},
    keyframe_binding: null, phase: "finish", clips_only: true,
    finish_shots: [
      { shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4", chain: ["MODULE_FINISH_LIPSYNC"], configs: [{}], idx: 0, status: "pending", applied: [] },
    ] as FinishShot[],
    created_at: Date.now(),
  });

  function raceEnv(job: FilmJob) {
    const docKey = filmJobDocKey(job.film_id);
    let stored = JSON.stringify(job);
    let puts = 0;
    const calls = { invoke: 0, poll: 0 };
    const { DB, rows } = leaseDb([job.film_id]);
    const env = {
      DB,
      R2_RENDERS: {
        get: async (k: string) => (k === docKey ? { text: async () => stored } : null),
        put: async (k: string, b: string) => { if (k === docKey) { stored = b; puts += 1; } },
        list: async () => ({ objects: [], truncated: false }),
        head: async () => null,
      },
      MODULE_FINISH_LIPSYNC: {
        fetch: async (url: string) => {
          if (String(url).includes("/module.json")) {
            // Manifest discovery (adoptFinishStepFromR2 reads finish_artifacts): NOT a poll; answer
            // like a real module and keep it out of the counters.
            return new Response(JSON.stringify({ name: "finish-lipsync", version: "0.1.0", api: "vivijure-module/2", hooks: ["finish"] }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (String(url).includes("/invoke")) {
            calls.invoke += 1;
            // Async-accept: the module parks the GPU job and hands back a poll token.
            return new Response(JSON.stringify({ ok: true, pending: true, poll: "tok-1" }), { status: 200, headers: { "content-type": "application/json" } });
          }
          calls.poll += 1;
          return new Response(JSON.stringify({ ok: true, pending: true, poll: "tok-1" }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    } as unknown as Env;
    return { env, calls, rows, read: () => JSON.parse(stored) as FilmJob, putCount: () => puts };
  }

  it("two CONCURRENT advances submit the lip-sync job exactly once; the loser still reports the job", async () => {
    const { env, calls, rows, read } = raceEnv(finishFilm());
    const [a, b] = await Promise.all([advanceFilmJob(env, filmId), advanceFilmJob(env, filmId)]);
    expect(calls.invoke).toBe(1); // THE assertion: one racer submits, the other skips quietly
    expect(a).not.toBeNull();
    expect(b).not.toBeNull(); // the loser returns the doc read-only (a poll response, not a 500)
    expect(read().finish_shots?.[0].poll).toBe("tok-1"); // the winner's poll token survives (no lost update)
    expect(rows.get(filmId)?.advance_lease).toBeNull(); // the winner released its lease after the tick
  });

  it("the released lease lets the NEXT tick advance (poll the parked job) -- no deadlock after a win", async () => {
    const { env, calls } = raceEnv(finishFilm());
    await Promise.all([advanceFilmJob(env, filmId), advanceFilmJob(env, filmId)]);
    await advanceFilmJob(env, filmId); // a later poll tick
    expect(calls.invoke).toBe(1); // still exactly one submission
    expect(calls.poll).toBe(1);   // the next tick polled the in-flight job (progress continues)
  });

  it("the LOSER writes nothing (its stale doc state can never clobber the winner's)", async () => {
    const { env, putCount } = raceEnv(finishFilm());
    const before = putCount();
    const results = await Promise.all([advanceFilmJob(env, filmId), advanceFilmJob(env, filmId)]);
    expect(results.every((r) => r !== null)).toBe(true);
    // Only the winner's tick persisted (submit-park + progress stamps); a lost-update from the
    // loser would show as extra writes carrying pre-submit state.
    const winnerWrites = putCount() - before;
    const { env: soloEnv, putCount: soloPuts } = raceEnv(finishFilm());
    await advanceFilmJob(soloEnv, filmId);
    expect(winnerWrites).toBe(soloPuts()); // racing writers wrote exactly what one writer writes
  });
});
