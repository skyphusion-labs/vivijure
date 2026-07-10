// Public demo studio -- Phase B click-to-render (#631). A SINGLE seeded shot renders to ONE LTX i2v clip
// on the standing Vultr vGPU box (the `local-gpu` motion.backend door), bounded by construction:
//
//  * MENU-ONLY (constraint 2): the only input is a SEEDED `demo_renderable` id. No free text, no uploads,
//    so every prompt + keyframe is curator-vetted and the CSAM bright line is satisfied BY CONSTRUCTION.
//  * SERIAL, honest queue (constraint 3): one box => global concurrency 1 (an atomic conditional claim),
//    honest FIFO position + wait, a depth cap ("queue is full"), and a stale-TTL release for a box crash.
//  * OWNED-silicon spend only (constraints 1, 4): per-IP + global DAILY caps in D1; the demo worker holds
//    NO R2 / presign / CPU-container bindings -- the box owns the bytes and writes to an isolated public
//    demo prefix, and the finished clip is served as an absolute URL (storage stays absent from the demo).
//  * SWAPPABLE backend (the GPU ruling's HORIZON): when the box is unreachable the demo reports an honest
//    "renders paused" state; browse keeps working, submit is refused plainly. Post-credits we repoint the
//    backend or leave it paused -- no demo outage.
//
// Everything here is Env-free and I/O is behind two injected seams (a D1 slice + a backend), so the queue
// logic + cap math unit-test without a database, a Worker runtime, or the GPU box.

// --- injected seams -----------------------------------------------------------------------------

/** The minimal D1 surface this module uses (real `env.DB` satisfies it; a fake backs the tests). */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...vals: unknown[]): D1StmtLike;
  first<T = unknown>(col?: string): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** The render backend (the demo-scoped `local-gpu` door). Injected so the queue tests never touch the
 *  box. `reachable` drives the "paused" state; submit/poll mirror the motion.backend async contract. */
export interface DemoBackend {
  reachable(): Promise<boolean>;
  submit(r: DemoRenderable, jobId: string): Promise<{ ok: true; poll: string } | { ok: false; error: string }>;
  poll(token: string): Promise<{ ok: true; pending: true } | { ok: true; clipKey: string } | { ok: false; error: string }>;
}

// --- data shapes --------------------------------------------------------------------------------

export interface DemoRenderable {
  id: string;
  title: string;
  description: string;
  keyframe_key: string;
  keyframe_url: string;
  prompt: string;
  seconds: number;
  quality: string;
}

export type DemoRenderState = "queued" | "running" | "done" | "failed";

export interface DemoQueueRow {
  id: string;
  renderable_id: string;
  ip: string;
  status: DemoRenderState;
  poll_token: string | null;
  clip_url: string | null;
  error: string | null;
  created_at: number;
  claimed_at: number | null;
  updated_at: number;
}

/** Tunable caps (constraint 4, 6-7). Defaults match the lead's D4 targets; overridable from env vars. */
export interface DemoRenderCaps {
  queueDepth: number;   // refuse enqueue past this many active (queued+running) -> honest "queue is full"
  perIpDaily: number;   // per-IP renders per UTC day
  globalDaily: number;  // global renders per UTC day
  staleMs: number;      // a running job older than this (box crash) is released
  etaSeconds: number;   // per-render wait estimate for honest queue math
}

export const DEFAULT_DEMO_RENDER_CAPS: DemoRenderCaps = {
  queueDepth: 10,       // D3 ruling
  perIpDaily: 3,        // D4 ruling
  globalDaily: 2000,    // D4 ruling
  staleMs: 10 * 60_000, // 10 min; a single LTX clip is ~1-3 min, so this only trips on a crash
  etaSeconds: 120,      // honest-enough single-clip estimate
};

// --- pure helpers -------------------------------------------------------------------------------

/** Build the public artifact URL from the box-reported clip key + the isolated demo origin. String-only:
 *  the demo worker never binds R2 -- it serves the box's public URL (D2 ruling). */
export function buildClipUrl(artifactOrigin: string, clipKey: string): string {
  return artifactOrigin.replace(/\/+$/, "") + "/" + clipKey.replace(/^\/+/, "");
}

/** Honest wait estimate (seconds) for a job `position` places back in line. */
export function honestWaitSeconds(position: number, etaSeconds: number): number {
  return Math.max(0, position) * etaSeconds;
}

// --- UTC day (mirrors rate-limit.ts) ------------------------------------------------------------

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// --- D1 ops -------------------------------------------------------------------------------------

export async function getRenderable(db: D1Like, id: string): Promise<DemoRenderable | null> {
  const row = await db
    .prepare("SELECT id, title, description, keyframe_key, keyframe_url, prompt, seconds, quality FROM demo_renderable WHERE id = ? AND enabled = 1")
    .bind(id)
    .first<DemoRenderable>();
  return row ?? null;
}

export async function listRenderables(db: D1Like): Promise<Array<Pick<DemoRenderable, "id" | "title" | "description" | "seconds">>> {
  const { results } = await db
    .prepare("SELECT id, title, description, seconds FROM demo_renderable WHERE enabled = 1 ORDER BY ordr, id")
    .all<Pick<DemoRenderable, "id" | "title" | "description" | "seconds">>();
  return results ?? [];
}

export async function countActive(db: D1Like): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM demo_render_queue WHERE status IN ('queued','running')")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getJob(db: D1Like, id: string): Promise<DemoQueueRow | null> {
  const row = await db.prepare("SELECT * FROM demo_render_queue WHERE id = ?").bind(id).first<DemoQueueRow>();
  return row ?? null;
}

async function enqueueJob(db: D1Like, job: { id: string; renderableId: string; ip: string; now: number }): Promise<void> {
  await db
    .prepare("INSERT INTO demo_render_queue (id, renderable_id, ip, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)")
    .bind(job.id, job.renderableId, job.ip, job.now, job.now)
    .run();
}

/** Release a running job whose box went silent past the stale window (a crash): mark it failed so the
 *  slot frees and the queue never wedges. Returns the count released (0 or more). */
async function releaseStale(db: D1Like, now: number, staleMs: number): Promise<void> {
  await db
    .prepare("UPDATE demo_render_queue SET status = 'failed', error = 'render backend went silent (box restarted); please try again', updated_at = ? WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?")
    .bind(now, now - staleMs)
    .run();
}

/** ATOMIC concurrency-1 claim: promote the oldest queued job to running ONLY when no job is running.
 *  The conditional subquery makes the "no other running" check part of the single UPDATE, so two
 *  concurrent pumps cannot both claim. Returns the claimed row, or null when nothing was claimed. */
async function claimHead(db: D1Like, now: number): Promise<DemoQueueRow | null> {
  const row = await db
    .prepare(
      "UPDATE demo_render_queue SET status = 'running', claimed_at = ?, updated_at = ? " +
        "WHERE id = (SELECT id FROM demo_render_queue WHERE status = 'queued' ORDER BY created_at, id LIMIT 1) " +
        "AND (SELECT COUNT(*) FROM demo_render_queue WHERE status = 'running') = 0 " +
        "RETURNING *",
    )
    .bind(now, now)
    .first<DemoQueueRow>();
  return row ?? null;
}

async function setRunningToken(db: D1Like, id: string, poll: string, now: number): Promise<void> {
  await db.prepare("UPDATE demo_render_queue SET poll_token = ?, updated_at = ? WHERE id = ?").bind(poll, now, id).run();
}

async function markDone(db: D1Like, id: string, clipUrl: string, now: number): Promise<void> {
  await db.prepare("UPDATE demo_render_queue SET status = 'done', clip_url = ?, updated_at = ? WHERE id = ?").bind(clipUrl, now, id).run();
}

async function markFailed(db: D1Like, id: string, error: string, now: number): Promise<void> {
  await db.prepare("UPDATE demo_render_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(error.slice(0, 300), now, id).run();
}

/** Honest position: 0 for the running job (it is AT the front, not waiting); for a queued job, the
 *  jobs strictly ahead in line (queued before it) + (1 if a job is running). */
export async function queuePosition(db: D1Like, row: DemoQueueRow): Promise<number> {
  if (row.status === "running") return 0;
  const ahead = await db
    .prepare("SELECT COUNT(*) AS n FROM demo_render_queue WHERE status = 'queued' AND (created_at < ? OR (created_at = ? AND id < ?))")
    .bind(row.created_at, row.created_at, row.id)
    .first<{ n: number }>();
  const running = await db.prepare("SELECT COUNT(*) AS n FROM demo_render_queue WHERE status = 'running'").first<{ n: number }>();
  return (ahead?.n ?? 0) + (running?.n ?? 0);
}

/** Atomic per-bucket daily bump; returns the post-increment count. bucket = '<kind>:<scope>:<day>'. */
export async function bumpCounter(db: D1Like, bucket: string, day: string): Promise<number> {
  const row = await db
    .prepare("INSERT INTO demo_counter (bucket, count, day) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(bucket, day)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

// --- orchestration ------------------------------------------------------------------------------

export interface DemoRenderDeps {
  db: D1Like;
  backend: DemoBackend;
  artifactOrigin: string;
  caps: DemoRenderCaps;
  now: number;
}

export type SubmitResult =
  | { ok: true; jobId: string; status: DemoRenderState; position: number; waitSeconds: number }
  | { ok: false; reason: "paused" | "unknown-scene" | "queue-full" | "ip-cap" | "global-cap"; message: string };

/** The pump: release a stale (crashed) job, then -- if the slot is free -- claim the head and submit it to
 *  the box. A submit failure frees the slot and tries the next queued job (bounded by the queue length).
 *  Concurrency 1 is guaranteed by claimHead; the pump only ever has one job "running" at a time. */
async function pump(deps: DemoRenderDeps): Promise<void> {
  await releaseStale(deps.db, deps.now, deps.caps.staleMs);
  // At most `queueDepth` iterations: each iteration either submits one job (and stops, slot taken) or
  // fails one un-submittable job and continues. Bounded, no infinite loop.
  for (let i = 0; i <= deps.caps.queueDepth; i++) {
    const claimed = await claimHead(deps.db, deps.now);
    if (!claimed) return; // a job is already running, or nothing is queued
    const renderable = await getRenderable(deps.db, claimed.renderable_id);
    if (!renderable) {
      await markFailed(deps.db, claimed.id, "scene no longer available", deps.now);
      continue; // slot freed; try the next queued job
    }
    const sub = await deps.backend.submit(renderable, claimed.id);
    if (sub.ok) {
      await setRunningToken(deps.db, claimed.id, sub.poll, deps.now);
      return; // one job running; stop
    }
    await markFailed(deps.db, claimed.id, "render backend rejected the job: " + sub.error, deps.now);
    // slot freed; continue to the next queued job
  }
}

/** Submit a menu render: refuse when paused / unknown scene / queue full / over a daily cap; otherwise
 *  enqueue, pump, and report the honest position. (The per-IP request-RATE limit is applied upstream at
 *  the route via SPEND_RATE_LIMITER; these are the per-day submission CAPS.) */
export async function submitDemoRender(
  deps: DemoRenderDeps,
  input: { renderableId: string; ip: string; jobId: string },
): Promise<SubmitResult> {
  if (!(await deps.backend.reachable())) {
    return { ok: false, reason: "paused", message: "renders are paused right now -- the demo GPU is offline. Browse the catalog, or run your own studio to render." };
  }
  const renderable = await getRenderable(deps.db, input.renderableId);
  if (!renderable) {
    return { ok: false, reason: "unknown-scene", message: "that scene is not on the demo menu" };
  }
  if ((await countActive(deps.db)) >= deps.caps.queueDepth) {
    return { ok: false, reason: "queue-full", message: "the render queue is full right now -- try again in a few minutes" };
  }
  const day = utcDay(deps.now);
  const ipCount = await bumpCounter(deps.db, `render:ip:${input.ip}:${day}`, day);
  if (ipCount > deps.caps.perIpDaily) {
    return { ok: false, reason: "ip-cap", message: `you have used your ${deps.caps.perIpDaily} demo renders for today -- resets at UTC midnight` };
  }
  const globalCount = await bumpCounter(deps.db, `render:global:${day}`, day);
  if (globalCount > deps.caps.globalDaily) {
    return { ok: false, reason: "global-cap", message: "the demo has hit its daily render budget -- browse the catalog, or run your own studio" };
  }
  await enqueueJob(deps.db, { id: input.jobId, renderableId: input.renderableId, ip: input.ip, now: deps.now });
  await pump(deps);
  const row = await getJob(deps.db, input.jobId);
  const status: DemoRenderState = row?.status ?? "queued";
  const position = row ? await queuePosition(deps.db, row) : 0;
  return { ok: true, jobId: input.jobId, status, position, waitSeconds: honestWaitSeconds(position, deps.caps.etaSeconds) };
}

export type PollResult =
  | { status: "queued"; position: number; waitSeconds: number }
  | { status: "running" }
  | { status: "done"; clipUrl: string }
  | { status: "failed"; error: string }
  | { status: "not_found" };

/** Advance + report one job. Releases a stale job, promotes the queue if the slot is free, and -- for a
 *  running job -- polls the box, folding a completed clip (public URL) or an honest failure. */
export async function pollDemoRender(deps: DemoRenderDeps, jobId: string): Promise<PollResult> {
  await pump(deps); // release stale + promote head if the slot is free (also advances a just-freed queue)
  let row = await getJob(deps.db, jobId);
  if (!row) return { status: "not_found" };
  if (row.status === "done") return { status: "done", clipUrl: row.clip_url ?? "" };
  if (row.status === "failed") return { status: "failed", error: row.error ?? "render failed" };
  if (row.status === "queued") {
    const position = await queuePosition(deps.db, row);
    return { status: "queued", position, waitSeconds: honestWaitSeconds(position, deps.caps.etaSeconds) };
  }
  // running
  if (!row.poll_token) return { status: "running" }; // just claimed; the pump submits within the tick
  const p = await deps.backend.poll(row.poll_token);
  if (p.ok && "pending" in p) return { status: "running" };
  if (p.ok) {
    const clipUrl = buildClipUrl(deps.artifactOrigin, p.clipKey);
    await markDone(deps.db, jobId, clipUrl, deps.now);
    await pump(deps); // free slot -> promote the next queued job
    return { status: "done", clipUrl };
  }
  await markFailed(deps.db, jobId, "render failed on the GPU box: " + p.error, deps.now);
  await pump(deps);
  row = await getJob(deps.db, jobId);
  return { status: "failed", error: row?.error ?? "render failed" };
}
