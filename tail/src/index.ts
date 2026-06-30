// vivijure-tail: a Cloudflare Tail Worker for the vivijure-studio core.
//
// The core logs render state via console.log/warn ("film <id>: ..." convention) and surfaces
// uncaught exceptions. This worker receives those as tail events and pushes them to the self-hosted
// Loki (the operator's monitoring host) over Workers VPC, shaped into Loki streams. It NEVER throws back into the producer
// and NEVER adds render latency (all sink I/O via ctx.waitUntil; failures are dropped).
//
// Label design (Loki cardinality): stream labels are the LOW-cardinality set {worker,level,phase,
// module}. job_id is HIGH-cardinality (one per render) so it lives in the log LINE as a JSON field,
// queryable via LogQL `| json | job_id="film-..."`, never a label.

export interface Env {
  LOKI_VPC: Fetcher;
}

interface TailLog { timestamp?: number; level?: string; message?: unknown[]; }
interface TailException { timestamp?: number; name?: string; message?: string; }
interface TailEvent { request?: { url?: string; method?: string; path?: string }; response?: { status?: number }; cron?: string; scheduledTime?: number; }
interface TailItem { scriptName?: string; outcome?: string; eventTimestamp?: number; event?: TailEvent; logs?: TailLog[]; exceptions?: TailException[]; }

interface Labels { worker: string; level: string; phase: string; module: string; }
interface LokiStream { stream: Labels; values: [string, string][]; }

const PHASES = ["keyframe", "clips", "dialogue", "speech", "finish", "assemble", "master", "mux", "done", "failed"];

function mapLevel(l?: string): "info" | "warn" | "error" {
  const v = (l || "").toLowerCase();
  if (v === "error") return "error";
  if (v === "warn") return "warn";
  return "info"; // debug | log | info
}

function nanos(ms?: number): string {
  const t = typeof ms === "number" && isFinite(ms) ? Math.floor(ms) : Date.now();
  return (BigInt(t) * 1000000n).toString();
}

function flatten(message: unknown[] | undefined): string {
  if (!message || !message.length) return "";
  return message
    .map((m) => {
      if (typeof m === "string") return m;
      try { return JSON.stringify(m); } catch { return String(m); }
    })
    .join(" ");
}

interface Derived { job_id?: string; phase: string; module: string; reason?: string; }

// Best-effort parse of the core's console convention. PREFERS a structured logEvent JSON line
// ({_v:1,...}, the planned fast-follow); falls back to regex over the English line.
export function deriveFields(text: string): Derived {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o && o._v === 1) {
        const phase = typeof o.phase === "string" && PHASES.includes(o.phase) ? o.phase : "unknown";
        return {
          job_id: typeof o.job_id === "string" ? o.job_id : undefined,
          phase,
          module: typeof o.module === "string" ? o.module : "none",
          reason: typeof o.reason === "string" ? o.reason : undefined,
        };
      }
    } catch { /* not our structured line; fall through to regex */ }
  }
  let job_id: string | undefined;
  const film = text.match(/\bfilm[\s_-]([A-Za-z0-9-]{4,})/);
  if (film) job_id = film[1].startsWith("film") ? film[1] : "film-" + film[1];
  if (!job_id) {
    const clips = text.match(/\b(clips-[A-Za-z0-9-]+)/);
    if (clips) job_id = clips[1];
  }
  let phase = "unknown";
  for (const p of PHASES) {
    if (new RegExp("\\b" + p + "\\b").test(text)) { phase = p; break; }
  }
  let module = "none";
  if (/film\.finish/.test(text)) {
    module = "film.finish";
  } else {
    const colon = text.match(/\b([a-z][a-z0-9-]+):\s/); // "<module>: <reason>"
    if (colon && !PHASES.includes(colon[1])) module = colon[1];
  }
  return { job_id, phase, module };
}

export function shapeEventsToLoki(events: TailItem[]): LokiStream[] {
  const map = new Map<string, LokiStream>();
  const add = (labels: Labels, ts: string, line: string) => {
    const key = labels.worker + "|" + labels.level + "|" + labels.phase + "|" + labels.module;
    let s = map.get(key);
    if (!s) { s = { stream: labels, values: [] }; map.set(key, s); }
    s.values.push([ts, line]);
  };
  for (const item of events || []) {
    const worker = item.scriptName || "unknown";
    // Invocation summary -- emitted for EVERY tail event so routine traffic + the live pipeline
    // are visible even when the request makes no console.* calls (CF's auto invocation record is
    // NOT in logs[]). Render detail (console.warn degrades/phases) still rides logs[] below.
    {
      const ev = item.event || {};
      let summary: string;
      if (ev.request) summary = (ev.request.method || "GET") + " " + (ev.request.path || ev.request.url || "/") + (ev.response && ev.response.status != null ? " " + ev.response.status : "");
      else if (ev.cron) summary = "cron " + ev.cron;
      else if (ev.scheduledTime != null) summary = "scheduled";
      else summary = "invocation";
      const oc = item.outcome || "ok";
      const ilevel: "info" | "warn" | "error" = oc === "ok" ? "info" : (oc === "exception" || oc === "exceededCpu" ? "error" : "warn");
      const idf = deriveFields(summary);
      add({ worker, level: ilevel, phase: idf.phase, module: idf.module }, nanos(item.eventTimestamp),
        JSON.stringify({ msg: summary, kind: "invocation", outcome: oc, status: ev.response?.status, path: ev.request?.path }));
    }
    for (const log of item.logs || []) {
      const text = flatten(log.message);
      if (!text) continue;
      const f = deriveFields(text);
      const labels: Labels = { worker, level: mapLevel(log.level), phase: f.phase, module: f.module };
      const line = JSON.stringify({ msg: text, job_id: f.job_id, reason: f.reason, outcome: item.outcome });
      add(labels, nanos(log.timestamp ?? item.eventTimestamp), line);
    }
    for (const ex of item.exceptions || []) {
      const text = (ex.name || "Error") + ": " + (ex.message || "");
      const f = deriveFields(text);
      const labels: Labels = { worker, level: "error", phase: f.phase, module: f.module };
      const line = JSON.stringify({ msg: text, name: ex.name, job_id: f.job_id, outcome: item.outcome ?? "exception" });
      add(labels, nanos(ex.timestamp ?? item.eventTimestamp), line);
    }
  }
  for (const s of map.values()) {
    s.values.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0));
  }
  return [...map.values()];
}

async function pushToLoki(streams: LokiStream[], env: Env): Promise<void> {
  if (!streams.length || !env.LOKI_VPC) return;
  try {
    await env.LOKI_VPC.fetch("http://loki:3100/loki/api/v1/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streams }),
    });
  } catch { /* a sink outage must never affect a render */ }
}

export default {
  async tail(events: TailItem[], env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const streams = shapeEventsToLoki(events);
      if (streams.length) ctx.waitUntil(pushToLoki(streams, env));
    } catch { /* never throw back into the producer */ }
  },
};
