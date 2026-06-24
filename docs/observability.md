# Observability: where logs go, and how to query them

There are **two** observability surfaces for the Vivijure workers, and they hold
different things. Querying the wrong one is the single most common diagnosability
trap on this project, so read this before you conclude "the logs are missing."

## TL;DR -- which tool for what

| You want...                                                              | Use                                   |
|--------------------------------------------------------------------------|---------------------------------------|
| Request line, status, duration, cron/fetch trigger, invocation outcome   | **CF Workers Observability** (query API / dashboard "Observability" tab) |
| Your `console.log` lines, structured `{ "ev": ... }` events, app state    | **Grafana / Loki** (`grafana.skyphusion.org`) |

**The gotcha:** the CF observability **query API** returns ONLY invocation-summary
events (`type: cf-worker-event` -- the request line, status, and the cron/fetch
trigger), even when `observability.logs.enabled = true`. Your `console.log`
content does **not** come back through that API. If you filter the CF obs API for
a token that only exists in a log body (e.g. `shots_expected`) you get `[]`, and
it looks like the log was dropped. It was not. It is in Loki.

## The pipeline

```
worker  --console.log/exceptions-->  tail_consumers = [ vivijure-tail ]
        --(vivijure-tail worker)-->  LOKI_VPC  (vpc_service binding)
        --(Cloudflare VPC connector)-->  Loki  (monitoring-loki-1 on dischord)
        --(datasource)-->  Grafana  (grafana.skyphusion.org)
```

The tail consumer is what carries the rich per-invocation `logs[]` and
`exceptions[]`. That is its whole job. The CF obs dataset is a separate, summary
only index.

## Config (must be mirrored in `wrangler.toml`)

```toml
[observability]
enabled = true
head_sampling_rate = 1

[[tail_consumers]]
service = "vivijure-tail"
```

Both are live on the deployed `vivijure-studio` worker today
(`observability.logs.enabled = true, persist = true, invocation_logs = true`;
`tail_consumers = [{ service = "vivijure-tail" }]`). The tail worker is deployed
separately and reaches Loki through its `LOKI_VPC` `vpc_service` binding.

## Loki labels (the tail extracts these from the JSON)

| Label          | Meaning / values                                                   |
|----------------|--------------------------------------------------------------------|
| `worker`       | the worker `scriptName`, e.g. `vivijure-studio`, `synthetic-smoke` |
| `service_name` | service identity (often `unknown_service` on bare invocation rows) |
| `level`        | `info`, `error`, ...                                                |
| `module`       | the `MODULE_*` worker name, or `none` for core lines               |
| `phase`        | scatter pipeline stage: `clips`, `dialogue`, `assemble` (`smoke` for the synthetic smoke worker; `unknown` for invocation summaries) |

Because `phase` is a real label, you can slice the scatter pipeline without a
full text scan: `{worker="vivijure-studio", phase="assemble"}`.

## Line shape (important: double-wrapped)

A Loki line is `{"msg":"<inner>"}`:

- **Invocation summary:** `inner` is the request line, e.g.
  `{"msg":"GET https://vivijure.skyphusion.org/... 200","kind":"invocation","outcome":"ok","status":200}`.
- **App log:** `inner` is your `console.log` payload as a string, e.g.
  `{"msg":"{\"ev\":\"scatter.assemble.result\",\"sent\":3,\"clipsReceived\":3,\"durationSeconds\":11.051,\"expectedSeconds\":11.0}"}`.

So to parse structured fields you unwrap twice: `| json | line_format "{{.msg}}" | json`.

## Query recipes (Grafana -> Explore -> Loki datasource)

```logql
# all studio application logs
{worker="vivijure-studio"}

# scatter gather + assemble-result lines, by label (no text scan)
{worker="vivijure-studio", phase="assemble"}

# the assemble-result duration guard line specifically
{worker="vivijure-studio"} |= "scatter.assemble.result"

# anything carrying a given structured field
{worker="vivijure-studio"} |= "shots_expected"

# parse the structured fields out (double-unwrap), then filter
{worker="vivijure-studio"} | json | line_format "{{.msg}}" | json | ev="scatter.assemble.result"

# errors only
{worker="vivijure-studio", level="error"}
```

```logql
# D1 durability events (scatter submit hardening, #290): retries, exhaustion, swallowed errors.
# Healthy = silent. A spike here is the early warning that the D1 path is flapping.
{worker="vivijure-studio"} |~ "d1\\.(retry|exhausted|error)"
```

## Reaching Loki from off-fleet (the jello / crew-agent caveat)

Loki and Grafana run on **dischord** (`10.1.1.2`), on the private fleet estate.
Two facts decide how you query them:

- **Grafana UI is public** at `grafana.skyphusion.org` (cloudflared + Access, same
  pattern as `status.skyphusion.org -> gatus`). From a laptop browser this Just
  Works; it is the default path for a human.
- **Loki itself is network-isolated** (`3100/tcp`, no public port; the tail worker
  pushes to it over the Cloudflare VPC connector, not a public endpoint).

**The caveat for crew agents:** the WARP mesh is **retired** from the fleet, and
public `:22` is closed fleet-wide. A crew agent running on **jello** therefore has
**no direct route** to `10.1.1.2:3100` (a `curl http://10.1.1.2:3100/...` returns
`000` / timeout, NOT a worker fault). To query Loki directly from off-fleet you
must first cross the **lagwagon bastion**:

```bash
# option A: jump host for a one-shot docker-network query on dischord
ssh -J lagwagon dischord "docker run --rm --network monitoring_default \
  curlimages/curl:latest -s \
  --data-urlencode 'query={worker=\"vivijure-studio\"}' \
  --data-urlencode since=1h \
  http://monitoring-loki-1:3100/loki/api/v1/query_range"

# option B: route the whole private estate locally, then curl as if on-fleet
sshuttle --dns -r conrad@lagwagon.internal 10.1.0.0/16
```

If neither bastion path is set up in your shell (e.g. a non-interactive crew
session with no `~/.ssh/config` for lagwagon), **use the Grafana web UI or the CF
Workers Observability API instead**; both are reachable without fleet access, and
CF-obs already carries the invocation truth (status, timing, cron). Do not read an
unreachable Loki as a missing-logs / broken-pipeline signal; confirm reachability
first.

## Direct Loki API (from the fleet, no Grafana UI)

Loki has no published host port (it is `3100/tcp`, network-internal on dischord).
Query it from inside its docker network:

```bash
docker run --rm --network monitoring_default curlimages/curl:latest -s \
  --data-urlencode 'query={worker="vivijure-studio"} |= `scatter`' \
  --data-urlencode 'since=24h' --data-urlencode 'limit=20' \
  http://monitoring-loki-1:3100/loki/api/v1/query_range
```

Label discovery: `.../loki/api/v1/labels` and `.../loki/api/v1/label/<name>/values`.

## When the CF obs API IS the right tool

Use the CF Workers Observability query API / dashboard for: invocation counts,
latency percentiles, status-code distributions, confirming a cron fired (or
stopped firing), and invocation-level exception outcomes. Example: verifying a
`*/N` cron no longer fires is a CF-obs query (filter `$metadata.origin = cron`),
not a Loki query, because that is an invocation event, not an app log.
