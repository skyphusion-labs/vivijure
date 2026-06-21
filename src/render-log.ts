// v0.141.0: per-render logs in R2.
//
// When a render reaches a terminal status, the control plane already holds the
// RunPod job view (status, timing, the COMPLETED envelope, and on failure the
// GPU side's diagnostics tail). We persist a human-readable version of that to
// R2 at a CONVENTIONAL key derived from the job id, so the History UI can offer
// a "view logs" link with no new DB column and no read-path changes. The object
// is served through /api/artifact, which serves by key (single-tenant studio
// behind CF Access; no per-user ownership stamp).
import type { Env } from "./env";
import type { RunpodJobView } from "./runpod-submit";

// Conventional R2 key for a job's log. The History UI derives the same key from
// the row's job_id, so there is nothing to store in D1.
export function renderLogKey(jobId: string): string {
  return `renders/logs/${jobId}.txt`;
}

// Bound free-text fields (an error string, an output blob) so a pathological GPU diagnostics dump
// cannot produce an unbounded R2 log object (issue #17). Generous enough to keep real diagnostics
// intact; a marker records how much was dropped.
const MAX_LOG_FIELD = 4000;
function clampLog(s: string): string {
  return s.length > MAX_LOG_FIELD
    ? `${s.slice(0, MAX_LOG_FIELD)}\n...[truncated ${s.length - MAX_LOG_FIELD} chars]`
    : s;
}

// Pure: format a RunPod job view into a readable per-render log. Kept pure so it
// is unit-testable; the caller supplies the timestamp.
export function buildRenderLogText(view: RunpodJobView, generatedAtIso: string): string {
  const lines: string[] = [];
  lines.push(`Render log - job ${view.jobId}`);
  lines.push(`Generated: ${generatedAtIso}`);
  const raw =
    view.statusRaw && view.statusRaw !== view.status ? ` (${view.statusRaw})` : "";
  lines.push(`Status: ${view.status}${raw}`);
  if (typeof view.executionTimeMs === "number") {
    lines.push(`Execution: ${(view.executionTimeMs / 1000).toFixed(1)}s`);
  }
  if (typeof view.delayTimeMs === "number") {
    lines.push(`Queue delay: ${(view.delayTimeMs / 1000).toFixed(1)}s`);
  }
  if (view.error) {
    lines.push("", "Error:", clampLog(view.error));
  }
  if (view.output !== undefined && view.output !== null) {
    lines.push("", "Output / diagnostics:");
    if (typeof view.output === "string") {
      lines.push(clampLog(view.output));
    } else {
      try {
        lines.push(clampLog(JSON.stringify(view.output, null, 2)));
      } catch {
        lines.push(clampLog(String(view.output)));
      }
    }
  }
  return lines.join("\n") + "\n";
}

// v0.146.0: cloud image-to-video (animate-cloud) per-render logs. A cloud
// animation is N independent provider calls (one per shot) routed through the
// AI Gateway, not a single RunPod job, so its log is shaped per-shot rather
// than from a RunpodJobView. Each shot records the model, the AI Gateway log id
// (so the run is traceable in the gateway dashboard), the resulting clip URL,
// and -- best-effort -- the gateway log object itself (request/response/cost),
// fetched via env.AI.gateway(GATEWAY_ID).getLog(). Written to the SAME
// conventional key as GPU logs (renders/logs/<jobId>.txt) so the History "logs"
// link works for cloud rows with no UI change.
export interface CloudAnimateLogShot {
  shot_id: string;
  model: string;
  status: "ok" | "failed";
  log_id: string | null;
  video_url?: string | null;
  error?: string | null;
  // Best-effort AI Gateway log content for this shot (null when log storage is
  // off, the id is unknown, or the lookup failed). Stringified into the log.
  gateway_log?: unknown;
}

export interface CloudAnimateLogInput {
  jobId: string;
  model: string;
  status: string; // the row's terminal status (COMPLETED / FAILED)
  executionTimeMs?: number | null;
  error?: string | null;
  shots: CloudAnimateLogShot[];
}

// Pure: format a cloud-animate run into a readable per-render log. Caller
// supplies the timestamp so this stays unit-testable.
export function buildCloudAnimateLogText(
  p: CloudAnimateLogInput,
  generatedAtIso: string,
): string {
  const lines: string[] = [];
  lines.push(`Render log - cloud animation job ${p.jobId}`);
  lines.push(`Generated: ${generatedAtIso}`);
  lines.push(`Status: ${p.status}`);
  lines.push(`Model: ${p.model}`);
  if (typeof p.executionTimeMs === "number") {
    lines.push(`Execution: ${(p.executionTimeMs / 1000).toFixed(1)}s`);
  }
  lines.push(`Shots: ${p.shots.length}`);
  if (p.error) lines.push("", "Error:", clampLog(p.error));
  for (const s of p.shots) {
    lines.push("", `--- ${s.shot_id} (${s.status}) ---`);
    lines.push(`Model: ${s.model}`);
    lines.push(`AI Gateway log id: ${s.log_id ?? "(none captured)"}`);
    if (s.video_url) lines.push(`Provider clip URL: ${s.video_url}`);
    if (s.error) lines.push(`Error: ${clampLog(s.error)}`);
    if (s.gateway_log !== undefined && s.gateway_log !== null) {
      lines.push("AI Gateway log:");
      try {
        lines.push(clampLog(JSON.stringify(s.gateway_log, null, 2)));
      } catch {
        lines.push(clampLog(String(s.gateway_log)));
      }
    }
  }
  return lines.join("\n") + "\n";
}

// Best-effort: enrich each shot with its AI Gateway log object, then write the
// cloud-animate log to R2 at the conventional key. NEVER throws. Returns the
// key on success, null on failure. The gateway lookups are individually guarded
// so one missing/expired log id cannot drop the whole file.
export async function writeCloudAnimateLog(
  env: Env,
  input: CloudAnimateLogInput,
): Promise<string | null> {
  try {
    const gw = (
      env.AI as unknown as {
        gateway?: (id: string) => { getLog: (logId: string) => Promise<unknown> };
      }
    ).gateway;
    // Enrich each shot with its AI Gateway log object on a LOCAL COPY -- never mutate
    // the caller's shot objects (issue #15). The lookups run CONCURRENTLY (one per
    // shot) instead of serially, and each is individually guarded, so one slow or
    // missing log id neither blocks the others nor drops the file; a failed lookup
    // just leaves gateway_log undefined and is logged rather than swallowed silently.
    let shots = input.shots;
    if (gw && env.GATEWAY_ID) {
      const gateway = gw(env.GATEWAY_ID);
      shots = await Promise.all(
        input.shots.map(async (s) => {
          if (!s.log_id) return { ...s };
          try {
            return { ...s, gateway_log: await gateway.getLog(s.log_id) };
          } catch (e) {
            console.warn(
              `cloud-animate log: AI Gateway getLog failed for shot ${s.shot_id} (log ${s.log_id}): ${e instanceof Error ? e.message : String(e)}`,
            );
            return { ...s };
          }
        }),
      );
    }
    const key = renderLogKey(input.jobId);
    const text = buildCloudAnimateLogText({ ...input, shots }, new Date().toISOString());
    await env.R2_RENDERS.put(key, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    return key;
  } catch (e) {
    console.warn(
      `cloud-animate log write failed for job ${input.jobId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// Best-effort: write the per-render log to R2. NEVER throws; logging must not
// break the render-resolve path. Returns the key on success, null on failure.
export async function writeRenderLog(
  env: Env,
  view: RunpodJobView,
): Promise<string | null> {
  try {
    const key = renderLogKey(view.jobId);
    const text = buildRenderLogText(view, new Date().toISOString());
    await env.R2_RENDERS.put(key, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    return key;
  } catch (e) {
    console.warn(
      `render log write failed for job ${view.jobId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
