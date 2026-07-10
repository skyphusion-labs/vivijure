import { describe, it, expect } from "vitest";
import {
  buildClipUrl, honestWaitSeconds, utcDay,
  submitDemoRender, pollDemoRender, getJob, queuePosition,
  DEFAULT_DEMO_RENDER_CAPS,
  type D1Like, type D1StmtLike, type DemoBackend, type DemoRenderable, type DemoQueueRow, type DemoRenderDeps,
} from "../src/demo-render";

// --- an in-memory D1 fake honoring exactly the statements demo-render.ts issues ------------------
interface FakeState {
  renderables: Map<string, DemoRenderable & { ordr: number }>;
  queue: DemoQueueRow[];
  counters: Map<string, { count: number; day: string }>;
}

function fakeDb(state: FakeState): D1Like {
  const stmt = (sql: string): D1StmtLike => {
    let args: unknown[] = [];
    const s: D1StmtLike = {
      bind(...vals: unknown[]) { args = vals; return s; },
      async first<T = unknown>(): Promise<T | null> {
        if (sql.includes("FROM demo_renderable WHERE id = ?")) {
          const r = state.renderables.get(args[0] as string);
          return (r ?? null) as T | null;
        }
        if (sql.includes("COUNT(*) AS n FROM demo_render_queue WHERE status IN ('queued','running')")) {
          return { n: state.queue.filter((r) => r.status === "queued" || r.status === "running").length } as T;
        }
        if (sql.startsWith("SELECT * FROM demo_render_queue WHERE id = ?")) {
          return (state.queue.find((r) => r.id === args[0]) ?? null) as T | null;
        }
        if (sql.includes("SET status = 'running'")) {
          // atomic concurrency-1 claim
          if (state.queue.some((r) => r.status === "running")) return null;
          const head = state.queue.filter((r) => r.status === "queued").sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))[0];
          if (!head) return null;
          head.status = "running"; head.claimed_at = args[0] as number; head.updated_at = args[1] as number;
          return { ...head } as T;
        }
        if (sql.includes("status = 'queued' AND (created_at <")) {
          const [createdAt, , id] = args as [number, number, string];
          return { n: state.queue.filter((r) => r.status === "queued" && (r.created_at < createdAt || (r.created_at === createdAt && r.id < id))).length } as T;
        }
        if (sql.includes("COUNT(*) AS n FROM demo_render_queue WHERE status = 'running'")) {
          return { n: state.queue.filter((r) => r.status === "running").length } as T;
        }
        if (sql.includes("INSERT INTO demo_counter")) {
          const [bucket, day] = args as [string, string];
          const cur = state.counters.get(bucket) ?? { count: 0, day };
          cur.count += 1; state.counters.set(bucket, cur);
          return { count: cur.count } as T;
        }
        return null;
      },
      async run() {
        const now = () => Date.now();
        if (sql.startsWith("INSERT INTO demo_render_queue")) {
          const [id, renderable_id, ip, created_at, updated_at] = args as [string, string, string, number, number];
          state.queue.push({ id, renderable_id, ip, status: "queued", poll_token: null, clip_url: null, error: null, created_at, claimed_at: null, updated_at });
          return {};
        }
        if (sql.includes("went silent")) {
          const staleCutoff = args[1] as number;
          for (const r of state.queue) if (r.status === "running" && r.claimed_at !== null && r.claimed_at < staleCutoff) { r.status = "failed"; r.error = "render backend went silent (box restarted); please try again"; r.updated_at = args[0] as number; }
          return {};
        }
        if (sql.includes("SET poll_token = ?")) {
          const [poll, updated_at, id] = args as [string, number, string];
          const r = state.queue.find((x) => x.id === id); if (r) { r.poll_token = poll; r.updated_at = updated_at; }
          return {};
        }
        if (sql.includes("SET status = 'done'")) {
          const [clip_url, updated_at, id] = args as [string, number, string];
          const r = state.queue.find((x) => x.id === id); if (r) { r.status = "done"; r.clip_url = clip_url; r.updated_at = updated_at; }
          return {};
        }
        if (sql.includes("SET status = 'failed', error = ?")) {
          const [error, updated_at, id] = args as [string, number, string];
          const r = state.queue.find((x) => x.id === id); if (r) { r.status = "failed"; r.error = error; r.updated_at = updated_at; }
          return {};
        }
        void now;
        return {};
      },
      async all<T = unknown>() {
        if (sql.includes("FROM demo_renderable WHERE enabled = 1")) {
          const rows = [...state.renderables.values()].sort((a, b) => a.ordr - b.ordr).map((r) => ({ id: r.id, title: r.title, description: r.description, seconds: r.seconds }));
          return { results: rows as T[] };
        }
        return { results: [] as T[] };
      },
    };
    return s;
  };
  return { prepare: stmt };
}

const SCENE: DemoRenderable & { ordr: number } = {
  id: "demo-scene-x", title: "Scene X", description: "d", keyframe_key: "kf/x.png",
  keyframe_url: "https://assets.example/kf/x.png", prompt: "a shot", seconds: 5, quality: "standard", ordr: 10,
};

function freshState(): FakeState {
  return { renderables: new Map([[SCENE.id, { ...SCENE }]]), queue: [], counters: new Map() };
}

// a backend that completes on the Nth poll (default: 1st), reachable by default
function fakeBackend(opts: { reachable?: boolean; completeAfter?: number; submitFails?: boolean; pollFails?: boolean } = {}): DemoBackend & { submits: number } {
  const state = { submits: 0, polls: 0 };
  const completeAfter = opts.completeAfter ?? 1;
  return {
    submits: 0,
    async reachable() { return opts.reachable ?? true; },
    async submit() { state.submits += 1; (this as { submits: number }).submits = state.submits; return opts.submitFails ? { ok: false, error: "boom" } : { ok: true, poll: "tok-" + state.submits }; },
    async poll() {
      state.polls += 1;
      if (opts.pollFails) return { ok: false, error: "gpu oom" };
      return state.polls >= completeAfter ? { ok: true, clipKey: "clips/out.mp4" } : { ok: true, pending: true };
    },
  };
}

function deps(state: FakeState, backend: DemoBackend, now = 1_000_000): DemoRenderDeps {
  return { db: fakeDb(state), backend, artifactOrigin: "https://assets.example", caps: { ...DEFAULT_DEMO_RENDER_CAPS }, now };
}

describe("demo-render pure helpers", () => {
  it("buildClipUrl joins origin + key without doubled slashes", () => {
    expect(buildClipUrl("https://a.example/", "/clips/x.mp4")).toBe("https://a.example/clips/x.mp4");
    expect(buildClipUrl("https://a.example", "clips/x.mp4")).toBe("https://a.example/clips/x.mp4");
  });
  it("honestWaitSeconds scales with position", () => {
    expect(honestWaitSeconds(0, 120)).toBe(0);
    expect(honestWaitSeconds(3, 120)).toBe(360);
  });
  it("utcDay is the ISO date", () => { expect(utcDay(Date.UTC(2026, 6, 10, 5))).toBe("2026-07-10"); });
});

describe("demo-render submit + queue", () => {
  it("submits the head immediately to the box (running), concurrency 1 for a second job", async () => {
    const st = freshState();
    const be = fakeBackend({ completeAfter: 99 });
    const r1 = await submitDemoRender(deps(st, be, 1000), { renderableId: SCENE.id, ip: "1.1.1.1", jobId: "j1" });
    const r2 = await submitDemoRender(deps(st, be, 2000), { renderableId: SCENE.id, ip: "2.2.2.2", jobId: "j2" });
    expect(r1.ok && r1.status).toBe("running");
    expect(r1.ok && r1.position).toBe(0);                // the running job is AT the front, not waiting
    expect(r2.ok && r2.status).toBe("queued");         // box busy -> queued, not a 2nd box submit
    expect(be.submits).toBe(1);                          // only ONE job on the box
    expect(r2.ok && r2.position).toBe(1);                // one ahead (the running job)
  });

  it("refuses when the backend is paused (box offline)", async () => {
    const st = freshState();
    const r = await submitDemoRender(deps(st, fakeBackend({ reachable: false })), { renderableId: SCENE.id, ip: "1.1.1.1", jobId: "j1" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("paused");
  });

  it("refuses an unknown (non-seeded) scene id -- menu-only", async () => {
    const st = freshState();
    const r = await submitDemoRender(deps(st, fakeBackend()), { renderableId: "not-a-scene", ip: "1.1.1.1", jobId: "j1" });
    expect(!r.ok && r.reason).toBe("unknown-scene");
  });

  it("enforces the per-IP daily cap", async () => {
    const st = freshState();
    const be = fakeBackend({ completeAfter: 99 });
    const caps = { ...DEFAULT_DEMO_RENDER_CAPS, perIpDaily: 2 };
    const mk = (n: number) => ({ db: fakeDb(st), backend: be, artifactOrigin: "https://assets.example", caps, now: 1000 + n });
    expect((await submitDemoRender(mk(1), { renderableId: SCENE.id, ip: "9.9.9.9", jobId: "a" })).ok).toBe(true);
    // free the slot so depth/concurrency does not mask the cap
    st.queue[0].status = "done";
    expect((await submitDemoRender(mk(2), { renderableId: SCENE.id, ip: "9.9.9.9", jobId: "b" })).ok).toBe(true);
    st.queue[1].status = "done";
    const third = await submitDemoRender(mk(3), { renderableId: SCENE.id, ip: "9.9.9.9", jobId: "c" });
    expect(!third.ok && third.reason).toBe("ip-cap");
  });

  it("refuses when the queue is full at the depth cap", async () => {
    const st = freshState();
    const caps = { ...DEFAULT_DEMO_RENDER_CAPS, queueDepth: 2, perIpDaily: 999 };
    const be = fakeBackend({ completeAfter: 99 });
    const mk = (n: number, ip: string) => ({ db: fakeDb(st), backend: be, artifactOrigin: "https://assets.example", caps, now: 1000 + n });
    await submitDemoRender(mk(1, "a"), { renderableId: SCENE.id, ip: "a", jobId: "j1" }); // running
    await submitDemoRender(mk(2, "b"), { renderableId: SCENE.id, ip: "b", jobId: "j2" }); // queued (depth 2)
    const full = await submitDemoRender(mk(3, "c"), { renderableId: SCENE.id, ip: "c", jobId: "j3" });
    expect(!full.ok && full.reason).toBe("queue-full");
  });
});

describe("demo-render poll lifecycle", () => {
  it("running -> done folds the public clip URL and promotes the next queued job", async () => {
    const st = freshState();
    const be = fakeBackend({ completeAfter: 1 });
    await submitDemoRender(deps(st, be, 1000), { renderableId: SCENE.id, ip: "a", jobId: "j1" }); // running
    await submitDemoRender(deps(st, be, 1001), { renderableId: SCENE.id, ip: "b", jobId: "j2" }); // queued
    const p = await pollDemoRender(deps(st, be, 2000), "j1");
    expect(p.status).toBe("done");
    expect(p.status === "done" && p.clipUrl).toBe("https://assets.example/clips/out.mp4");
    // j1 done freed the slot -> j2 promoted to running on the same pump
    const j2 = await getJob(fakeDb(st), "j2");
    expect(j2?.status).toBe("running");
    expect(be.submits).toBe(2);
  });

  it("a box failure fails the job honestly (never a silent success)", async () => {
    const st = freshState();
    const be = fakeBackend({ pollFails: true });
    await submitDemoRender(deps(st, be, 1000), { renderableId: SCENE.id, ip: "a", jobId: "j1" });
    const p = await pollDemoRender(deps(st, be, 2000), "j1");
    expect(p.status).toBe("failed");
    expect(p.status === "failed" && p.error).toContain("gpu oom");
  });

  it("releases a stale (crashed-box) running job and reports failed", async () => {
    const st = freshState();
    const be = fakeBackend({ completeAfter: 99 });
    await submitDemoRender(deps(st, be, 1000), { renderableId: SCENE.id, ip: "a", jobId: "j1" }); // running, claimed_at=1000
    // poll far past the stale window
    const later = 1000 + DEFAULT_DEMO_RENDER_CAPS.staleMs + 60_000;
    const p = await pollDemoRender(deps(st, be, later), "j1");
    expect(p.status).toBe("failed");
  });

  it("a submit rejection frees the slot and advances to the next queued job", async () => {
    const st = freshState();
    const be = fakeBackend({ submitFails: true });
    const r = await submitDemoRender(deps(st, be, 1000), { renderableId: SCENE.id, ip: "a", jobId: "j1" });
    // submit failed inside pump -> j1 marked failed, slot free
    expect(r.ok).toBe(true); // enqueue itself succeeded; the failure surfaces on the row
    const j1 = await getJob(fakeDb(st), "j1");
    expect(j1?.status).toBe("failed");
  });

  it("unknown job id -> not_found", async () => {
    const st = freshState();
    const p = await pollDemoRender(deps(st, fakeBackend()), "nope");
    expect(p.status).toBe("not_found");
  });
});
