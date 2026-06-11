// Storyboard render history persistence (v0.34.0).
//
// One row per RunPod job submitted via POST /api/storyboard/render. The
// row is inserted at submit time and updated by the poll + cancel handlers
// with the latest status, output, error, and timing fields. GET /api/
// storyboard/renders lists the authenticated user's rows newest first.
//
// Ownership: user_email comes from cf-access-authenticated-user-email at
// submit time and is the filter key for the list endpoint. Poll / cancel
// proxy to RunPod regardless of DB state (so jobs submitted before
// v0.34.0 are still pollable directly via their jobId); the row UPDATE is
// a no-op when no row exists for that jobId. This keeps the existing
// stateless /api/storyboard/render flow working unchanged.

import type { Env } from "./env";
import type { RunpodJobView } from "./runpod-submit";
import { writeRenderLog } from "./render-log";

// Fresh row at submit time.
export interface NewRenderRow {
  userEmail: string;
  jobId: string;
  project: string;
  bundleKey: string;
  qualityTier: string;
  renderOverrides?: Record<string, unknown>;
  status: string;
  // v0.40.0: 'full' = the train + keyframes + I2V + assemble pipeline;
  // 'keyframes-only' = preview pass producing SDXL keyframes only.
  // Stored verbatim. Defaults to 'full' when omitted.
  mode?: "full" | "keyframes-only" | "cloud-finalized";
  // v0.55.0: optional FK to storyboard_projects(id). NULL on rows
  // submitted without an active project (the transient v0.42.0 flow).
  projectId?: number | null;
  // v0.145.2: FK to the keyframes-only preview render this row was derived
  // from (finalize / animate-cloud children). NULL on a top-level render.
  parentId?: number | null;
}

// One uploaded SDXL keyframe (v0.39.0). The GPU side writes these to R2
// at COMPLETED and returns the list in its job-output envelope; we mirror
// them on the renders row so the UI can render thumbnails without re-
// pulling the output blob.
export interface KeyframeRef {
  shot_id: string;
  key: string;
}

// Shape returned to clients by /api/storyboard/renders. snake_case mirrors
// the DB column names so the UI does not double-normalize. output_json is
// parsed back to a JS object (or null when the row has none).
export interface RenderRow {
  id: number;
  user_email: string;
  job_id: string;
  project: string;
  bundle_key: string;
  quality_tier: string;
  render_overrides: Record<string, unknown> | null;
  status: string;
  output_key: string | null;
  output: unknown;
  error: string | null;
  execution_time_ms: number | null;
  delay_time_ms: number | null;
  submitted_at: number;
  updated_at: number;
  completed_at: number | null;
  label: string | null;
  keyframes: KeyframeRef[] | null;
  // v0.40.0: 'full' or 'keyframes-only'. v0.42.0 adds 'finalized' as
  // the mode for rows produced by the keyframes -> finalize pipeline.
  // Legacy rows are stored NULL; the row normalizer collapses NULL ->
  // 'full' so callers can rely on a non-null value.
  mode: "full" | "keyframes-only" | "finalized" | "cloud-finalized";
  // v0.42.0: shot_ids the user marked as approved in the keyframes-
  // only preview, before clicking finalize. Metadata-only; the GPU
  // is not informed of this set in v0.42.0 (finalize runs Wan I2V +
  // assembly over every shot regardless). NULL or empty array means
  // nothing locked.
  locked_shots: string[] | null;
  // v0.55.0: optional FK to storyboard_projects(id). NULL when the
  // submit was not associated with any project.
  project_id: number | null;
  // v0.126.0: render-history organization. folder_path is a free-form
  // "/"-delimited path the user files the render under (null = unfiled);
  // tags is a deduped, lowercased list. Both default to null / [] on
  // legacy rows that predate the columns.
  folder_path: string | null;
  tags: string[];
  // v0.145.2: FK to the keyframes-only preview render this row was derived
  // from (finalize / animate-cloud children). NULL on a top-level render.
  // The UI uses it to union a derived animation back onto its keyframes and
  // to group the several versions (GPU + per-model cloud) of one keyframes set.
  parent_id: number | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// v0.55.0: parse + validate a project_id intake (from the request body
// or query string). Pure so vitest can assert the contract without env.
// Returns null for any non-positive-integer input, which the caller
// then treats as "no project filter" / "transient submit".
export function normalizeProjectIdInput(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

// v0.136.0: how long after submit we keep treating a RunPod "job not found"
// (404 on /status) as a momentary post-submit propagation race rather than a
// dropped job. RunPod's /run can return IN_QUEUE before /status can see the
// job; we show "SUBMITTED" during this window and only fail the row once the
// 404 persists past it. Generous on purpose: false-failing a real job is worse
// than a slightly delayed phantom verdict.
export const PHANTOM_GRACE_SECONDS = 150;

// v0.136.0: classify a render whose RunPod /status poll returned 404 ("job not
// found"). Pure so the grace-window contract is unit-testable without a DB.
//   - "terminal": our row already reached a terminal state, so RunPod simply
//     garbage-collected a finished job; serve the cached row, do not fail it.
//   - "confirming": still inside the grace window; RunPod may not have
//     registered the job yet. Keep polling, report SUBMITTED.
//   - "phantom": past the grace window with no record; the submission was
//     dropped before it ran. Fail the row.
export type PhantomDecision = "terminal" | "confirming" | "phantom";

export function classifyMissingJob(
  rowStatus: string,
  submittedAtSec: number,
  nowSec: number,
  graceSec: number = PHANTOM_GRACE_SECONDS,
): PhantomDecision {
  if (isTerminalStatus(rowStatus)) return "terminal";
  return nowSec - submittedAtSec < graceSec ? "confirming" : "phantom";
}

export async function insertRender(env: Env, row: NewRenderRow): Promise<void> {
  const now = nowSeconds();
  const overrides = row.renderOverrides ? JSON.stringify(row.renderOverrides) : null;
  const mode = row.mode ?? "full";
  const projectId = typeof row.projectId === "number" && row.projectId > 0
    ? row.projectId
    : null;
  const parentId = typeof row.parentId === "number" && row.parentId > 0
    ? row.parentId
    : null;
  await env.DB.prepare(
    `INSERT INTO renders (
      user_email, job_id, project, bundle_key, quality_tier,
      render_overrides, status, submitted_at, updated_at, mode,
      project_id, parent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO NOTHING`,
  )
    .bind(
      row.userEmail,
      row.jobId,
      row.project,
      row.bundleKey,
      row.qualityTier,
      overrides,
      row.status,
      now,
      now,
      mode,
      projectId,
      parentId,
    )
    .run();
}

// Best-effort UPDATE from a poll / cancel response. No-op when no row
// exists for the jobId (matches the "back-compat for pre-v0.34.0 jobs"
// policy). Ownership is NOT checked here; the route handler enforces
// authn via Cloudflare Access at the edge and authz via user_email at
// the list endpoint.
export async function updateRenderFromView(env: Env, view: RunpodJobView): Promise<void> {
  const now = nowSeconds();
  const completed = TERMINAL_STATUSES.has(view.status) ? now : null;

  // Pull output_key out of the GPU side's COMPLETED envelope when present.
  let outputKey: string | null = null;
  let keyframesJson: string | null = null;
  let modeFromOutput: string | null = null;
  if (
    view.output &&
    typeof view.output === "object" &&
    !Array.isArray(view.output)
  ) {
    const o = view.output as Record<string, unknown>;
    if (typeof o.output_key === "string" && o.output_key.length > 0) {
      outputKey = o.output_key;
    }
    // v0.39.0: extract the keyframes list (GPU 0.4.0+) so we can render
    // thumbnails in the history row without re-parsing output_json.
    const refs = normalizeKeyframes(o.keyframes);
    if (refs.length > 0) keyframesJson = JSON.stringify(refs);
    // v0.40.0: GPU 0.4.2+ surfaces the run mode in the envelope. We mirror
    // it into the row so the UI can render the keyframes-only flow even
    // if the row was inserted before the mode column had a value.
    // v0.42.0: also recognize "finalized" mode from the GPU's finalize
    // action; same COALESCE-write pattern.
    if (typeof o.mode === "string" && o.mode.length > 0) {
      modeFromOutput = o.mode;
    }
  }

  const outputJson = view.output !== undefined ? JSON.stringify(view.output) : null;

  await env.DB.prepare(
    `UPDATE renders SET
      status = ?,
      output_key = COALESCE(?, output_key),
      output_json = ?,
      error = ?,
      execution_time_ms = ?,
      delay_time_ms = ?,
      updated_at = ?,
      completed_at = COALESCE(?, completed_at),
      keyframes_json = COALESCE(?, keyframes_json),
      mode = COALESCE(?, mode)
    WHERE job_id = ?`,
  )
    .bind(
      view.status,
      outputKey,
      outputJson,
      view.error ?? null,
      view.executionTimeMs ?? null,
      view.delayTimeMs ?? null,
      now,
      completed,
      keyframesJson,
      modeFromOutput,
      view.jobId,
    )
    .run();

  // v0.141.0: on terminal status, persist a per-render log to R2 (conventional
  // key renders/logs/<jobId>.txt) so History can offer a "view logs" link. The
  // row now exists/updated, so read its owner for the artifact ownership stamp.
  // Best-effort: writeRenderLog never throws, and we swallow lookup errors too,
  // so logging can never block or break the render-resolve path.
  if (completed !== null) {
    try {
      const owner = await env.DB.prepare(
        `SELECT user_email FROM renders WHERE job_id = ?`,
      )
        .bind(view.jobId)
        .first<{ user_email: string }>();
      if (owner?.user_email) {
        await writeRenderLog(env, view, owner.user_email);
      }
    } catch {
      // logging is best-effort; ignore
    }
  }
}

// v0.146.0: cloud-animate progress feedback. A cloud animation runs one
// provider call per shot for several minutes, so write a lightweight
// "done of total" marker into output_json as each shot lands; the History row
// surfaces "animating shot k/N" while the job is in flight. Guarded to
// non-terminal rows so it can never clobber a row that already finished (the
// finalize step overwrites output_json with the real output at COMPLETED).
export async function setCloudAnimateProgress(
  env: Env,
  jobId: string,
  done: number,
  total: number,
): Promise<void> {
  const now = nowSeconds();
  const json = JSON.stringify({ mode: "cloud-finalized", progress: { done, total } });
  await env.DB.prepare(
    `UPDATE renders SET output_json = ?, updated_at = ?
       WHERE job_id = ?
         AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`,
  )
    .bind(json, now, jobId)
    .run();
}

// v0.154.0 (Phase 4 hybrid, slice-3): per-lane progress for a hybrid animation.
// A hybrid run drives a GPU finalize (~20-30 min) and a cloud per-shot loop, so a
// single "done/total" counter hides which lane is moving. This writes both lanes
// plus an overall done/total (kept for the v0.146.0 cloud-animate badge that reads
// progress.done/total). `gpu.status` reflects the GPU lane phase ("queued" |
// "rendering" | "done" | "failed"); gpu.done can carry the pod's render fraction
// (rounded to whole shots) so the long GPU wait shows movement. Same terminal
// guard as setCloudAnimateProgress so it can never clobber a finished row.
export interface HybridLaneProgress {
  gpu: { done: number; total: number; status?: string };
  cloud: { done: number; total: number };
}

export async function setHybridProgress(
  env: Env,
  jobId: string,
  lanes: HybridLaneProgress,
): Promise<void> {
  const now = nowSeconds();
  const done = lanes.gpu.done + lanes.cloud.done;
  const total = lanes.gpu.total + lanes.cloud.total;
  const json = JSON.stringify({
    mode: "cloud-finalized",
    progress: { done, total, gpu: lanes.gpu, cloud: lanes.cloud },
  });
  await env.DB.prepare(
    `UPDATE renders SET output_json = ?, updated_at = ?
       WHERE job_id = ?
         AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`,
  )
    .bind(json, now, jobId)
    .run();
}

// v0.136.0: minimal row snapshot the poll handlers need when RunPod returns a
// 404 for the job. submitted_at drives the grace-window decision; output /
// output_key / error let us serve a cached terminal row (RunPod GC'd a job we
// already finished) without re-polling. Returns null when we hold no row for
// the jobId (a pre-history job or someone else's id).
export interface RenderPollRow {
  status: string;
  submitted_at: number;
  output: unknown;
  output_key: string | null;
  error: string | null;
}

export async function getRenderForPoll(
  env: Env,
  jobId: string,
): Promise<RenderPollRow | null> {
  const r = await env.DB.prepare(
    `SELECT status, submitted_at, output_json AS output, output_key, error
     FROM renders WHERE job_id = ?`,
  )
    .bind(jobId)
    .first<Record<string, unknown>>();
  if (!r) return null;
  let output: unknown = null;
  const opRaw = r.output;
  if (typeof opRaw === "string" && opRaw.length > 0) {
    try {
      output = JSON.parse(opRaw);
    } catch {
      output = opRaw;
    }
  }
  return {
    status: String(r.status),
    submitted_at: Number(r.submitted_at),
    output,
    output_key: r.output_key ? String(r.output_key) : null,
    error: r.error ? String(r.error) : null,
  };
}

// v0.161.1: the owner email for a render row by jobId. The cron sweep needs it
// to drive a scatter parent's gather (resolveScatterGather is owner-scoped) for
// a fire-and-forget scatter with no client polling.
export async function getRenderOwnerEmail(env: Env, jobId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT user_email FROM renders WHERE job_id = ?`)
    .bind(jobId)
    .first<{ user_email?: unknown }>();
  return r && typeof r.user_email === "string" && r.user_email.length > 0 ? r.user_email : null;
}

// v0.136.0: fail a render row by jobId (used when RunPod has no record of the
// job past the grace window). Guarded so it never clobbers a row that already
// reached a terminal state. Returns true iff a non-terminal row was flipped.
export async function markRenderFailedByJobId(
  env: Env,
  jobId: string,
  error: string,
): Promise<boolean> {
  const now = nowSeconds();
  const res = await env.DB.prepare(
    `UPDATE renders SET
       status = 'FAILED',
       error = ?,
       completed_at = COALESCE(completed_at, ?),
       updated_at = ?
     WHERE job_id = ?
       AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`,
  )
    .bind(error.slice(0, 2000), now, now, jobId)
    .run();
  return ((res.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
}

// v0.122.0: off-GPU finish bookkeeping. When a render used finish_offloaded, the
// pod returns clips (no assembled MP4); the Worker assembles via the video-finish
// container on poll-completion. finish_state (NULL -> 'finishing' -> 'done' |
// 'failed') is the idempotency lock so concurrent polls don't double-run the
// container.

// Atomically claim the finish for this job. Returns true iff THIS caller won the
// claim (flipped finish_state to 'finishing'); a concurrent poll that lost gets
// false and should report "still finishing". 'failed' is re-claimable (retry).
export async function claimFinish(env: Env, jobId: string): Promise<boolean> {
  const now = nowSeconds();
  const res = await env.DB.prepare(
    `UPDATE renders SET finish_state = 'finishing', updated_at = ?
     WHERE job_id = ? AND COALESCE(finish_state, '') NOT IN ('finishing', 'done')`,
  )
    .bind(now, jobId)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function markFinishDone(
  env: Env,
  jobId: string,
  outputKey: string,
  outputJson: string,
): Promise<void> {
  const now = nowSeconds();
  await env.DB.prepare(
    `UPDATE renders SET output_key = ?, output_json = ?, status = 'COMPLETED',
       finish_state = 'done', completed_at = COALESCE(completed_at, ?), updated_at = ?
     WHERE job_id = ?`,
  )
    .bind(outputKey, outputJson, now, now, jobId)
    .run();
}

// v0.139.0: atomically claim the render-done email for a job (once-only). Flips
// notified_at NULL -> now in a single conditional UPDATE for a TERMINAL row, so
// concurrent pollers and the cron sweep can never double-send. Keyframe previews
// are excluded (fast, not worth an email). Returns the row facts for the email
// when THIS caller won the claim, else null (already claimed / not eligible).
// The decision is made exactly once even when the owner has notifications off
// (the caller claims, then checks prefs, then maybe sends).
export interface RenderNotifyRow {
  user_email: string;
  project: string;
  status: string;
  output_key: string | null;
  error: string | null;
  execution_time_ms: number | null;
  mode: string | null;
}

export async function claimRenderNotify(
  env: Env,
  jobId: string,
): Promise<RenderNotifyRow | null> {
  const now = nowSeconds();
  const res = await env.DB.prepare(
    `UPDATE renders SET notified_at = ?
       WHERE job_id = ? AND notified_at IS NULL
         AND status IN ('COMPLETED', 'FAILED')
         AND COALESCE(mode, 'full') != 'keyframes-only'`,
  )
    .bind(now, jobId)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) return null;
  const row = await env.DB.prepare(
    `SELECT user_email, project, status, output_key, error, execution_time_ms, mode
       FROM renders WHERE job_id = ?`,
  )
    .bind(jobId)
    .first<RenderNotifyRow>();
  return row ?? null;
}

// v0.139.0: jobs to resolve in the background (the cron sweep) so a fire-and-
// forget API render still reaches terminal + emails its owner without a client
// polling. Only non-terminal rows recent enough to still be live on RunPod;
// keyframe previews excluded (never emailed). Bounded so one tick is cheap.
// v0.161.1: scatter shard children (parent_id IS NOT NULL) are excluded -- the
// parent's gather owns their lifecycle + the single notify, so a shard must not
// be swept (RunPod-polled + emailed) on its own. Scatter PARENTS (parent_id NULL)
// stay in the sweep; the scheduled handler drives their gather, never RunPod-polls.
export async function listUnresolvedNotifiableJobs(
  env: Env,
  maxAgeSeconds: number,
  limit = 25,
): Promise<string[]> {
  const cutoff = nowSeconds() - Math.max(0, maxAgeSeconds);
  const res = await env.DB.prepare(
    `SELECT job_id FROM renders
       WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
         AND notified_at IS NULL
         AND COALESCE(mode, 'full') != 'keyframes-only'
         AND parent_id IS NULL
         AND submitted_at >= ?
       ORDER BY submitted_at ASC
       LIMIT ?`,
  )
    .bind(cutoff, Math.min(Math.max(1, limit), 100))
    .all();
  const rows = (res.results ?? []) as Array<{ job_id?: unknown }>;
  return rows.map((r) => String(r.job_id)).filter((s) => s.length > 0);
}

export async function markFinishFailed(env: Env, jobId: string, error: string): Promise<void> {
  const now = nowSeconds();
  await env.DB.prepare(
    `UPDATE renders SET finish_state = 'failed', error = ?, updated_at = ? WHERE job_id = ?`,
  )
    .bind(error.slice(0, 2000), now, jobId)
    .run();
}

export async function getFinishState(
  env: Env,
  jobId: string,
): Promise<{ finish_state: string | null; output_key: string | null; user_email: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT finish_state, output_key, user_email FROM renders WHERE job_id = ?`,
  )
    .bind(jobId)
    .first<{ finish_state: string | null; output_key: string | null; user_email: string | null }>();
  return row ?? null;
}

// v0.42.0: defensive parse of a locked-shots array stored as JSON in
// the renders.locked_shots_json column OR coming in over the wire on
// a PATCH. Drops non-string + empty + duplicate entries; clamps the
// list length to a sane upper bound so a malformed client cannot
// stuff arbitrary blobs into the row.
const MAX_LOCKED_SHOTS = 200;

export function normalizeLockedShots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 80) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_LOCKED_SHOTS) break;
  }
  return out;
}

// v0.126.0: normalize a free-form folder path. Splits on "/", trims each
// segment, drops empties (so leading / trailing / doubled slashes collapse),
// rejoins, and caps length. Returns null for "unfiled" (empty / non-string).
export function normalizeFolderPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parts = raw
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const joined = parts.join("/");
  return joined.length > 200 ? joined.slice(0, 200) : joined;
}

const MAX_TAGS = 24;
const MAX_TAG_LEN = 40;

// v0.126.0: normalize a tag list. Lowercase + trim each, drop empties, cap
// each tag's length and the total count, dedupe (order-preserving). Mirrors
// normalizeLockedShots; used on both the PATCH write path and the read path.
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().toLowerCase().slice(0, MAX_TAG_LEN);
    if (!tag) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// Best-effort coerce `output.keyframes` from a job envelope into a
// well-formed KeyframeRef[]. Anything that does not look like an
// object with string `shot_id` + `key` is dropped silently; that
// way a GPU side that adds future fields to each entry does not
// crash the UPDATE.
export function normalizeKeyframes(raw: unknown): KeyframeRef[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyframeRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.shot_id !== "string" || e.shot_id.length === 0) continue;
    if (typeof e.key !== "string" || e.key.length === 0) continue;
    out.push({ shot_id: e.shot_id, key: e.key });
  }
  return out;
}

// Fetch one row by D1 PK, scoped to the caller's user_email. Returns null
// when the row does not exist OR when it belongs to another user (we do
// not distinguish so a guessed id cannot enumerate other users' rows).
// v0.136.4: point a finished render at a new MP4 that has audio muxed in
// (produced off-GPU by the video-finish container). Updates output_key plus the
// output_json's output_key / has_audio / seconds so the History download link
// and the audio badge reflect the muxed version. Scoped to user_email; returns
// true iff a row owned by the caller was updated.
export async function setRenderAudioOutput(
  env: Env,
  id: number,
  userEmail: string,
  outputKey: string,
  seconds: number | null,
): Promise<boolean> {
  const now = nowSeconds();
  const res = await env.DB.prepare(
    `UPDATE renders SET
       output_key = ?,
       output_json = json_set(
         COALESCE(output_json, '{}'),
         '$.output_key', ?,
         '$.has_audio', json('true'),
         '$.seconds', ?
       ),
       updated_at = ?
     WHERE id = ? AND user_email = ?`,
  )
    .bind(outputKey, outputKey, seconds, now, id, userEmail)
    .run();
  return ((res.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
}

export async function getRenderByIdForUser(
  env: Env,
  id: number,
  userEmail: string,
): Promise<RenderRow | null> {
  const r = await env.DB.prepare(
    `SELECT
      id, user_email, job_id, project, bundle_key, quality_tier,
      render_overrides, status, output_key, output_json AS output,
      error, execution_time_ms, delay_time_ms,
      submitted_at, updated_at, completed_at, label, keyframes_json, mode,
      locked_shots_json, project_id, folder_path, tags_json, parent_id
    FROM renders
    WHERE id = ? AND user_email = ?`,
  )
    .bind(id, userEmail)
    .first<Record<string, unknown>>();
  if (!r) return null;
  return normalizeRow(r);
}

// Update one row's label. Empty / null clears it. Returns true when the
// row existed and was owned by the caller; false otherwise (so a caller
// can distinguish "not yours" from "saved" if it wants to).
export async function setRenderLabel(
  env: Env,
  id: number,
  userEmail: string,
  label: string | null,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE renders SET label = ?, updated_at = ? WHERE id = ? AND user_email = ?`,
  )
    .bind(label, now, id, userEmail)
    .run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changes > 0;
}

// True when at least one OTHER row references the same output_key. Used
// to gate R2 artifact deletion: re-renders of the same project can share
// an output filename (rp_handler.py writes `renders/<project>/<name>.mp4`,
// so a re-render at the same name would overwrite), and we never want to
// strand a still-referenced artifact.
export async function countOtherRowsWithOutputKey(
  env: Env,
  id: number,
  outputKey: string,
): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM renders WHERE output_key = ? AND id != ?`,
  )
    .bind(outputKey, id)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

// Delete one row by D1 PK + user_email. Returns true when a row was
// actually removed (i.e., the row existed and the caller owned it).
export async function deleteRenderRow(
  env: Env,
  id: number,
  userEmail: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM renders WHERE id = ? AND user_email = ?`,
  )
    .bind(id, userEmail)
    .run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changes > 0;
}

export async function listRendersForUser(
  env: Env,
  userEmail: string,
  limit = 50,
  projectId: number | null = null,
): Promise<RenderRow[]> {
  // Clamp limit so a runaway client cannot drain the DB binding.
  const cap = Math.min(Math.max(1, Math.floor(limit)), 200);
  // v0.55.0: optional project filter. The (user_email, project_id,
  // submitted_at DESC) partial index serves this lookup directly.
  const baseSelect = `SELECT
      id, user_email, job_id, project, bundle_key, quality_tier,
      render_overrides, status, output_key, output_json AS output,
      error, execution_time_ms, delay_time_ms,
      submitted_at, updated_at, completed_at, label, keyframes_json, mode,
      locked_shots_json, project_id, folder_path, tags_json, parent_id
    FROM renders`;
  const stmt = projectId !== null && projectId > 0
    ? env.DB.prepare(
        // v0.138.0: include project-less rows (project_id IS NULL) alongside the
        // active project. Renders submitted outside the UI (the contract API, a
        // headless curl, or an adopted RunPod job) have no project_id, so a strict
        // `project_id = ?` hid them whenever any project was selected. Unioning
        // the loose rows keeps them discoverable without the user having to clear
        // their active project first. In practice the loose set is small (API
        // renders), so it does not crowd out the project's own rows under LIMIT.
        `${baseSelect}
         WHERE user_email = ? AND (project_id = ? OR project_id IS NULL)
         ORDER BY submitted_at DESC
         LIMIT ?`
      ).bind(userEmail, projectId, cap)
    : env.DB.prepare(
        `${baseSelect}
         WHERE user_email = ?
         ORDER BY submitted_at DESC
         LIMIT ?`
      ).bind(userEmail, cap);
  const result = await stmt.all();
  const rows = (result.results ?? []) as unknown as Array<Record<string, unknown>>;
  return rows.map(normalizeRow);
}

// D1 returns JSON columns as opaque strings; parse them back. A malformed
// stored JSON falls back to null (overrides) or the raw string (output) so
// a corrupted row never crashes a list response.
function normalizeRow(r: Record<string, unknown>): RenderRow {
  let overrides: Record<string, unknown> | null = null;
  const oRaw = r.render_overrides;
  if (typeof oRaw === "string" && oRaw.length > 0) {
    try {
      const parsed = JSON.parse(oRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        overrides = parsed as Record<string, unknown>;
      }
    } catch {
      overrides = null;
    }
  }

  let output: unknown = null;
  const opRaw = r.output;
  if (typeof opRaw === "string" && opRaw.length > 0) {
    try {
      output = JSON.parse(opRaw);
    } catch {
      output = opRaw;
    }
  }

  let keyframes: KeyframeRef[] | null = null;
  const kfRaw = r.keyframes_json;
  if (typeof kfRaw === "string" && kfRaw.length > 0) {
    try {
      const parsed = JSON.parse(kfRaw);
      const refs = normalizeKeyframes(parsed);
      if (refs.length > 0) keyframes = refs;
    } catch {
      keyframes = null;
    }
  }

  return {
    id: Number(r.id),
    user_email: String(r.user_email),
    job_id: String(r.job_id),
    project: String(r.project),
    bundle_key: String(r.bundle_key),
    quality_tier: String(r.quality_tier),
    render_overrides: overrides,
    status: String(r.status),
    output_key: r.output_key ? String(r.output_key) : null,
    output,
    error: r.error ? String(r.error) : null,
    execution_time_ms:
      r.execution_time_ms === null || r.execution_time_ms === undefined
        ? null
        : Number(r.execution_time_ms),
    delay_time_ms:
      r.delay_time_ms === null || r.delay_time_ms === undefined
        ? null
        : Number(r.delay_time_ms),
    submitted_at: Number(r.submitted_at),
    updated_at: Number(r.updated_at),
    completed_at:
      r.completed_at === null || r.completed_at === undefined
        ? null
        : Number(r.completed_at),
    label:
      typeof r.label === "string" && r.label.length > 0 ? r.label : null,
    keyframes,
    // v0.40.0: collapse NULL / unknown values to 'full' so callers do
    // not need to do this themselves. Legacy rows pre-dating the mode
    // column read as NULL and are therefore 'full'.
    // v0.42.0 adds 'finalized' as a third recognized value.
    mode:
      r.mode === "keyframes-only"
        ? "keyframes-only"
        : r.mode === "finalized"
          ? "finalized"
          : r.mode === "cloud-finalized"
            ? "cloud-finalized"
            : "full",
    // v0.42.0: parse the locked_shots_json column back into a string
    // array; NULL / empty / malformed -> null (read as "nothing
    // locked"). The normalizer keeps the same MAX_LOCKED_SHOTS cap as
    // the write path so a corrupted row cannot bloat a list response.
    locked_shots: (() => {
      const lsRaw = r.locked_shots_json;
      if (typeof lsRaw !== "string" || lsRaw.length === 0) return null;
      try {
        const parsed = JSON.parse(lsRaw);
        const arr = normalizeLockedShots(parsed);
        return arr.length > 0 ? arr : null;
      } catch {
        return null;
      }
    })(),
    // v0.55.0: NULL for legacy rows or transient (no-project) submits.
    project_id:
      r.project_id === null || r.project_id === undefined
        ? null
        : Number(r.project_id),
    // v0.126.0: organization fields. folder_path is stored verbatim (already
    // normalized on the write path); tags_json is a JSON array re-normalized
    // on read so a hand-edited / corrupted row can never bloat a list.
    folder_path:
      typeof r.folder_path === "string" && r.folder_path.length > 0
        ? r.folder_path
        : null,
    tags: (() => {
      const tRaw = r.tags_json;
      if (typeof tRaw !== "string" || tRaw.length === 0) return [];
      try {
        return normalizeTags(JSON.parse(tRaw));
      } catch {
        return [];
      }
    })(),
    // v0.145.2: NULL on top-level renders; set on finalize / animate-cloud
    // children to the keyframes-only preview render they derive from.
    parent_id:
      r.parent_id === null || r.parent_id === undefined
        ? null
        : Number(r.parent_id),
  };
}

// v0.42.0: PATCH locked_shots on a row, scoped to the caller's
// user_email. Same return-bool semantics as setRenderLabel.
export async function setRenderLockedShots(
  env: Env,
  id: number,
  userEmail: string,
  lockedShots: string[],
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const json = lockedShots.length > 0 ? JSON.stringify(lockedShots) : null;
  const result = await env.DB.prepare(
    `UPDATE renders SET locked_shots_json = ?, updated_at = ? WHERE id = ? AND user_email = ?`,
  )
    .bind(json, now, id, userEmail)
    .run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changes > 0;
}

// v0.161.0: the integer id for a job_id. The scatter submit inserts a parent
// row keyed by a synthetic scatter-<uuid> job_id, then needs its autoincrement
// id to link the child shard rows via parent_id. job_id is UNIQUE + unguessable,
// so this is not user-scoped (the same capability model as getRenderForPoll).
export async function getRenderIdByJobId(env: Env, jobId: string): Promise<number | null> {
  const r = await env.DB.prepare(`SELECT id FROM renders WHERE job_id = ?`)
    .bind(jobId)
    .first<{ id: number }>();
  return r ? Number(r.id) : null;
}

// v0.161.0: the child shard rows of a scatter parent (job_id + last status),
// for the gather watcher to poll each shard and decide finish/wait/fail. A
// scatter parent's children are exactly its shards (no finalize/animate child
// ever points at a scatter parent), so parent_id alone is the right filter.
export async function getScatterChildren(
  env: Env,
  parentId: number,
): Promise<Array<{ job_id: string; status: string }>> {
  const rs = await env.DB.prepare(
    `SELECT job_id, status FROM renders WHERE parent_id = ? ORDER BY id ASC`,
  )
    .bind(parentId)
    .all<{ job_id: string; status: string }>();
  return (rs.results ?? []).map((r) => ({ job_id: String(r.job_id), status: String(r.status) }));
}

// v0.126.0: PATCH the folder_path on a row, scoped to user_email. null / ''
// clears it (unfiled). Same return-bool semantics as setRenderLabel.
export async function setRenderFolder(
  env: Env,
  id: number,
  userEmail: string,
  folderPath: string | null,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE renders SET folder_path = ?, updated_at = ? WHERE id = ? AND user_email = ?`,
  )
    .bind(folderPath, now, id, userEmail)
    .run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changes > 0;
}

// v0.126.0: PATCH the tags on a row, scoped to user_email. An empty list
// stores NULL (untagged). Same return-bool semantics as setRenderLabel.
export async function setRenderTags(
  env: Env,
  id: number,
  userEmail: string,
  tags: string[],
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const json = tags.length > 0 ? JSON.stringify(tags) : null;
  const result = await env.DB.prepare(
    `UPDATE renders SET tags_json = ?, updated_at = ? WHERE id = ? AND user_email = ?`,
  )
    .bind(json, now, id, userEmail)
    .run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changes > 0;
}

// v0.126.0: the distinct tags this user has applied across all their renders,
// most-used first (then alphabetical), for the history tag-filter autocomplete.
export async function listUserTags(env: Env, userEmail: string): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT tags_json FROM renders WHERE user_email = ? AND tags_json IS NOT NULL`,
  )
    .bind(userEmail)
    .all();
  const rows = (result.results ?? []) as unknown as Array<{ tags_json: unknown }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.tags_json !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.tags_json);
    } catch {
      continue;
    }
    for (const tag of normalizeTags(parsed)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}
