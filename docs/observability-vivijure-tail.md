# vivijure-tail: structured logs to Grafana (design / RFC)

Status: **RFC -- pending Conrad's sink decision.** Author: Strummer (infra). PM/SME: Mackaye.
Target batch: **v0.3.1** (fold the tail-worker + `tail_consumers` deploy into the v0.3.1 cut).

Goal: stop eyeballing render state by hand. Ship the `vivijure-studio` core's structured logs
into Grafana so we get dashboards (phase funnels, soft-degrade rates per module, RunPod/VPC error
rates, per-render drill-down) and alerting off real data, not console scrolling.

This doc is an ICD: it fixes the contract (event shape -> labels/lines -> sink) so the pipeline is
reproducible from the doc alone. No em-dashes/en-dashes anywhere (project rule).

--------------------------------------------------------------------------------

## 1. Current state (what we actually have today)

Verified against origin/main. Two facts shape everything below:

1. **There is no unified `@event`/`film_finish` emit stream yet.** The core logs via
   `console.log` / `console.warn` with a consistent tagged convention, and keeps canonical
   machine-readable state in **R2 job documents**, not on a log channel:
   - `console.warn(\`film ${job.film_id}: master degraded -- ${m.degraded.join("; ")}\`)`
     (`src/film-orchestrator.ts:1244`)
   - `console.warn(\`film.finish degraded for ${job.film_id}: ${degraded} -- film shipped WITHOUT cards\`)`
     (`src/film-orchestrator.ts:1009-1012`)
   - R2 `FilmJob` doc carries `phase` (keyframe|clips|dialogue|speech|finish|assemble|master|mux|done|failed),
     `master.{chain,applied,degraded}`, `film_finish.{applied,errors,degraded}` (`src/film-orchestrator.ts:73-165`).
   - Chain outcomes: `ChainResult.{applied[],errors[],degraded[]}`, reasons formatted `"<module>: <reason>"`
     (`src/modules/registry.ts:346-408`).
2. **The five labels we want -- `{worker, level, phase, module, job_id}` -- are derivable today**
   from the console convention (`worker`=scriptName, `level`=console method, `job_id` from the
   `film <id>` / `clips-<id>` prefix, `phase`/`module` best-effort from the message), but only by
   **parsing English**. That is fragile and untestable. See section 4 for the hardening.

`[observability] enabled = true` is already set (`wrangler.toml:20-21`); worker name `vivijure-studio`,
`compatibility_date = 2026-06-01`. No `tail_consumers` configured yet.

--------------------------------------------------------------------------------

## 2. Sink options

| Dim | (a) Self-host Loki+Grafana on dischord | (b) Grafana Cloud (managed Loki) | (c) CF-native only (Workers Observability) |
|---|---|---|---|
| IaC / control | Full. Compose in fleet-chezmoi, mirrors Gatus. Our box, our rules. | Partial. Dashboards as code possible; the store is vendor-side. | Full but shallow. Already on; query via dashboard + observability MCP. |
| Vendor / lock-in | None. | Grafana Cloud account + egress off-fleet. | None (CF), but not Grafana. |
| Cost | Compute we already own; only cost is disk + restic->R2 backup of Loki chunks. | Free tier (50 GB logs / 14-day retention) then per-GB. Render logs are bursty; tier creep likely. | Included with Workers; retention/quotas are CF-set. |
| Ops burden | One more stateful compose stack to run + back up (acceptable; same shape as Gatus). | Lowest. No infra to run. | Lowest. Nothing to run. |
| Dashboards | Grafana, full LogQL, our panels. | Grafana, same. | No Grafana. CF dashboard + MCP queries only; weak for cross-render funnels. |
| Data residency | On-fleet (HEL1), private. | Off-fleet (vendor region). | CF edge. |
| Blast radius of sink outage | Tail worker drops on push failure (renders unaffected, by design). | Same, plus public-internet dependency. | N/A (passive). |

### Recommendation: **(a) self-host Loki+Grafana on dischord**, with **(c) retained as the always-on baseline.**

Rationale: (a) is the only option that meets the actual goal (Grafana dashboards) AND honors the
IaC / no-vendor / on-fleet tenets. It is one more compose stack next to Gatus -- a shape we already
operate. (c) stays on for free as belt-and-suspenders (live `wrangler tail`, CF console, the
observability MCP) but does not deliver Grafana, so it cannot be the answer on its own. (b) is the
right fallback if we ever want zero fleet-ops, but it adds a vendor + egress + tier creep for a
workload we can host for the cost of a disk volume. **Conrad makes the final call; this is the lean.**

--------------------------------------------------------------------------------

## 3. vivijure-tail design (the tail worker)

A new Worker `vivijure-tail` in this repo (proposed path `tail/`: `tail/wrangler.toml` + `tail/src/index.ts`).

### Producer wiring (the core)
```toml
# vivijure-studio core wrangler.toml -- ADD (at the v0.3.1 deploy, AFTER vivijure-tail is live):
tail_consumers = [ { service = "vivijure-tail" } ]
```

### Handler shape (confirmed against CF docs)
```js
export default {
  async tail(events, env, ctx) {
    // events = TailItem[]; one per producer invocation.
    // TailItem: { scriptName, outcome, eventTimestamp, logs[], exceptions[] }
    //   logs[]:       { timestamp, level: debug|info|log|warn|error, message: any[] }
    //   exceptions[]: { timestamp, name, message }
    try {
      const streams = shapeToLoki(events, env);            // section 3.1
      if (streams.length) ctx.waitUntil(pushToLoki(streams, env)); // never block; never throw back
    } catch (_) { /* swallow: a logging failure must never affect a render */ }
  }
};
```
Hard rule: the tail worker MUST NOT throw into the producer and MUST NOT add render latency.
All sink I/O goes through `ctx.waitUntil`; failures are dropped (sink outage != render outage).

### 3.1 Shaping to Loki -- label cardinality is the key decision
Loki performance is governed by label cardinality: every distinct label-set is a stream. `job_id`
is HIGH cardinality (one value per render), so **`job_id` must NOT be a stream label.**

- **Stream labels (low cardinality):** `{ worker, level, phase, module }`
  - `worker` = `item.scriptName` (e.g. `vivijure-studio`)
  - `level`  = `log.level` mapped to `info|warn|error` (`log`/`debug`/`info`->info, `warn`->warn, `error`+exceptions->error)
  - `phase`  = parsed (section 4); `unknown` when not derivable
  - `module` = parsed (section 4); `none` when not a module event
- **Log line (the value):** structured JSON string carrying the high-cardinality + detail fields:
  `{ ts, job_id, msg, reason?, applied?, degraded?, errors?, outcome }`. `job_id` is then a
  LogQL JSON field (`| json | job_id="film-..."`), queryable without being a label.
- Each `tail()` call emits ONE Loki push with all events batched into streams.

Loki push contract:
```
POST  {LOKI base}/loki/api/v1/push
body  { "streams": [ { "stream": {worker,level,phase,module},
                       "values": [ ["<unix_nanos_string>", "<json line>"], ... ] } ] }
```
Timestamps in nanoseconds (string). Exceptions become `level=error` lines with `name`+`message`.

--------------------------------------------------------------------------------

## 4. Hardening: a canonical structured emit (recommended, coordinate with Rollins)

Parsing English console lines is fragile and not unit-testable -- it also fights Conrad's
"structured, machine-readable state channel" tenet. Proposed small core change (backend lane,
Rollins), shippable in parallel:

- Add one helper, e.g. `logEvent({evt, job_id, phase, module, level, ...})` that does a single
  `console.log(JSON.stringify({ _v: 1, evt, job_id, phase, module, level, ...rest }))`.
- Replace the canonical emit sites (module dispatch outcome, soft-degrade with reason, RunPod/VPC
  error, phase transition) with `logEvent(...)`. Human `console.warn` lines can stay alongside.
- The tail worker then PREFERS JSON: if a `log.message[0]` parses as our `{_v:1,...}` schema, use
  its fields for labels/line directly (no regex). Else fall back to the regex parse of the legacy
  line, else ship it raw at the right level. This makes the pipeline testable (assert on the
  structured channel, per the project testing philosophy) and robust to copy edits.

Phasing: the tail worker can SHIP first against the current console lines (regex parse), and the
structured emit lands as a fast-follow that the worker already prefers. No blocking dependency.

--------------------------------------------------------------------------------

## 5. Transport: how the edge tail worker reaches the sink

### If (a) self-host: push over Workers VPC (reuse the CPU-container pattern)
The tail worker runs on the CF edge; Loki runs on dischord. Rather than expose Loki publicly, put
the **Loki push path on Workers VPC** -- the exact pattern we use for the CPU containers:
- Loki container on dischord, joined to the `vivijure` (or `monitoring_default`) docker network the
  cloudflared connector already serves.
- A Workers VPC Service `loki` (host `loki`, http_port 3100) over the dischord tunnel
  `d0835ae0-fe7c-481e-b36b-1129655c05d7` (the live tunnel; note the compose.yaml header comment that
  still says `3111f3fe` is stale -- separate doc fix).
- `vivijure-tail/wrangler.toml`: `[[vpc_services]] binding = "LOKI_VPC"`, `service_id = <new>`,
  `remote = true`; the worker does `env.LOKI_VPC.fetch("http://loki:3100/loki/api/v1/push", ...)`.
- Loki on a private net is network-isolated like the credentialless CPU containers, so the push path
  needs no token (optionally a `LOKI_PUSH_TOKEN` secret if we add Loki auth).
- **Grafana** (human UI) stays public behind cloudflared + Access at `grafana.skyphusion.org`, exactly
  like `status.skyphusion.org -> gatus` (new ingress block in `cloudflared/config.yml`; new CF Access
  app). Grafana reads Loki in-cluster at `http://loki:3100`.

This keeps Loki private, adds no public log endpoint, and reuses wiring I just stood up for audio-master.

### If (b) Grafana Cloud: push over public HTTPS
`env.LOKI_URL` + basic-auth user/token as wrangler secrets; no VPC. Simpler worker, vendor egress.

--------------------------------------------------------------------------------

## 6. Deploy ordering (same dangling-binding hazard as modules)

`tail_consumers` is a binding to a service that must EXIST at deploy time, or the core
`wrangler deploy` fails (typecheck/tests will NOT catch it). Order, folded into v0.3.1:

1. (self-host) Loki+Grafana stack up on dischord (fleet-chezmoi PR); create the `loki` Workers VPC
   Service; Grafana ingress + Access live.
2. Deploy `vivijure-tail` (with `LOKI_VPC` binding, if self-host).
3. THEN add `tail_consumers` to the core wrangler.toml and deploy the core (the v0.3.1 tag).
4. Verify end to end: run a render, confirm a real log line lands in Grafana (Explore: `{worker="vivijure-studio"}`),
   and a degrade shows with its `module`/`reason`.

--------------------------------------------------------------------------------

## 7. Secrets (never committed; per-function keys)

| Secret | Where | Path |
|---|---|---|
| Loki push token (only if Loki auth enabled) | `vivijure-tail` worker | `wrangler secret put LOKI_PUSH_TOKEN` |
| Loki URL + basic-auth (only if Grafana Cloud) | `vivijure-tail` worker | `wrangler secret put LOKI_URL / LOKI_USER / LOKI_TOKEN` |
| Grafana admin password | dischord fleet stack | `system/.../monitoring/.env` (0600, `.env.example` in git) |
| CF Access service token for grafana.skyphusion.org | CF Access app (console) | not in repo (mirrors Gatus) |

Self-host + VPC push needs NO worker secret for the push path (network-isolated), which is the
cleanest option.

--------------------------------------------------------------------------------

## 8. Build plan (Phase 2, on Conrad's blessed direction)

1. (self-host) fleet-chezmoi PR: Loki+Grafana in `system/stacks/dischord/monitoring/compose.yaml`
   (+ `loki/` config, retention, restic->R2 backup of the Loki volume + a Gatus heartbeat); cloudflared
   ingress `grafana.skyphusion.org`; CF Access app. Deploy is plain `docker compose` (Jenkins is retired).
2. vivijure PR: the `vivijure-tail` worker (`tail/`), Loki shaping + push, the VPC binding (self-host);
   conformance-style test asserting the event->stream mapping on sample TailItems.
3. vivijure PR (at the tag): add `tail_consumers` to the core; deploy in the v0.3.1 order above.
4. (parallel, Rollins) the `logEvent` structured emit (section 4).
5. End-to-end verification (section 6.4). All PRs authored strummer@skyphusion.org.
