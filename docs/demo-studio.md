# The Public Demo Studio (`demo.vivijure.com`)

The demo studio is a **read-only, zero-spend** deployment of the SAME studio Worker
(`src/index.ts`), running at **demo.vivijure.com** so anyone can browse the real catalog and watch
finished showcase films without an account, an operator token, or a single GPU second billed.

It is a separate deploy from the production studio: its own Worker (`vivijure-demo`), its own D1, and
`AUTH_MODE=demo`. It shares NO bindings, secrets, or data with production.

## What "demo mode" is

`AUTH_MODE=demo` (a `[vars]` entry, EXPLICIT -- the gate fails closed on an unknown mode, v0.12.1)
flips three behaviors from ONE normalization (`isDemoMode` in `src/auth-gate.ts`; the structural twin
`isDemoEnv` in `src/modules/registry.ts` -- change both together):

- **Reads open, writes denied.** Every `GET`/`HEAD` on `/api/*` is served; every mutation is denied
  at the gate with `403 {"error":"demo studio is read-only: mutations are disabled on this
  deployment. Run your own studio to render."}` (`verifyDemoRequest`). A presented token is ignored
  -- there is no operator path into a demo deploy, so a leaked/guessed token is worthless here.
- **`GET /api/modules` advertises `host: {dispatch:false, readonly:true}`.** The frontend gates every
  mutation affordance on `host.readonly`, so the UI renders browse-only from the registry projection.
- **The catalog comes from the seeded `installed_modules` rows** (`discoverModules` demo exception),
  NOT from live module service bindings or a dispatch namespace -- the demo binds none.
- **CSP admits the showcase host.** `applyResponseSecurity` emits `STUDIO_DEMO_CSP`
  (`src/asset-response.ts`): the base studio CSP plus `media-src 'self' https://assets.skyphusion.net`,
  so the seeded showcase MP4s play.

## The binding-absence rule (the zero-spend proof)

A demo deploy binds **ONLY** the demo D1 (`DB`) and the static `ASSETS`. It has **NO** AI, RunPod
secrets, R2 buckets, Secrets Store secrets, `MODULE_*` service bindings, `MODULE_DISPATCH` namespace,
VPC services, tail consumer, cron `[triggers]`, or rate-limit binding. That **absence is the proof**
that the demo cannot spend money: no code path can reach a GPU, an LLM, or storage.

> Every read path the demo exercises tolerates the absent bindings (the catalog is the seeded rows,
> the films are absolute `assets.skyphusion.net` URLs, and every write is denied at the gate before
> any binding is touched). If something at boot or deploy ever demands one of these bindings, that is
> a **BLOCKER to escalate, NOT a binding to add**. Adding a binding to silence a warning would spend
> money and break the promise this deploy exists to keep.

> **Phase B (#631) update:** the demo now also does bounded CLICK-TO-RENDER + a capped OSS assistant, so
> the invariant is no longer pure absence but **bounded spend in two disjoint families** (owned-GPU render
> + gateway-capped OSS tokens), with RunPod + frontier credits STILL zero by absence. See "Phase B" below
> for exactly what opens and what stays absent.

## Config

`wrangler.demo.toml.example` is the committed template (mirrors `wrangler.toml.example`
conventions: `account_id` is NEVER hardcoded, it is read from `CLOUDFLARE_ACCOUNT_ID`). The real
`wrangler.demo.toml` is gitignored and rendered from the example with the demo D1 id injected
(`${D1_DEMO_DATABASE_ID}`).

## Provision + deploy (start to finish)

All commands run with `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` in the environment.

1. **Create the demo D1** (NEVER touch the prod `vivijure-studio` DB):

   ```bash
   wrangler d1 create vivijure-demo
   # paste the returned database_id into wrangler.demo.toml (or the D1_DEMO_DATABASE_ID CI var)
   ```

2. **Apply the base schema** (the numbered migrations `0001..0010`):

   ```bash
   wrangler d1 migrations apply vivijure-demo --remote -c wrangler.demo.toml
   ```

3. **Apply the seed EXPLICITLY** (it lives under `migrations/demo/`, a subdirectory `wrangler d1
   migrations apply` does NOT scan, so it can never auto-apply to prod). The seed is idempotent
   (`INSERT OR IGNORE`, high explicit ids `>=9000`):

   ```bash
   wrangler d1 execute vivijure-demo --remote -c wrangler.demo.toml \
     --file=migrations/demo/0001_demo_seed.sql
   # Cast portrait backfill. 0001 seeds portrait_key on a FRESH install, but a LIVE demo D1 that already
   # ran 0001 keeps its NULL portraits (0001 is INSERT OR IGNORE -- it never touches an existing row), so
   # this UPDATE backfills the standing cast rows. Idempotent (guarded by portrait_key IS NULL); a no-op
   # on a fresh install where 0001 already set them.
   wrangler d1 execute vivijure-demo --remote -c wrangler.demo.toml \
     --file=migrations/demo/0003_demo_cast_portraits.sql
   ```

   Seeds: the 26 real module manifests (display-only, `script_name = demo-seed-<name>`, invocable by
   nothing), plus browseable projects, cast (each with an absolute `assets.skyphusion.net` portrait image
   -- still no R2 binding), and COMPLETED render rows whose `output_key` is an absolute
   `assets.skyphusion.net` showcase MP4.

4. **Deploy the Worker** (creates the `demo.vivijure.com` custom domain -- Workers custom domains own
   DNS + the cert; a first-level subdomain under `vivijure.com` gets Universal SSL, NO ACM needed):

   ```bash
   wrangler deploy -c wrangler.demo.toml
   ```

   A green deploy prints exactly three bindings: `DB (vivijure-demo)`, `ASSETS`, and
   `AUTH_MODE ("demo")`. If it prints any other binding, the config drifted -- stop.

## Phase B: click-to-render + assistant (#631)

Phase B turns the read-only demo into a **bounded** click-to-render demo, without reopening the two spend
families the demo exists to keep at zero.

**Render (constraints 1-5).** A visitor picks ONE **seeded** scene from the menu (`GET /api/demo/menu`,
projected from the `demo_renderable` rows) and `POST /api/demo/render {scene}` renders ONE LTX i2v clip on
the standing Vultr vGPU box via a **demo-scoped `local-gpu` door** (`MODULE_LOCAL_GPU`). The render is
SERIAL (one box, global concurrency 1) with an honest FIFO queue: `GET /api/demo/render/:id` reports
`queued` (+ position + wait), `running`, `done` (+ the public clip URL), or `failed`. A depth cap refuses
enqueue past ~10 ("queue is full"); per-IP + global daily caps (`demo_counter`) + the per-IP burst limiter
(`SPEND_RATE_LIMITER`) bound abuse. The box reads the seeded keyframe from an **isolated demo R2 prefix**
and writes the clip there; the demo builds the artifact URL as `DEMO_ARTIFACT_ORIGIN/<clip_key>` and binds
**no** R2 itself. When the box is offline (`DEMO_RENDER_ENABLED != "true"` or `MODULE_LOCAL_GPU` unbound)
the demo reports **renders paused** (`host.render.available=false`); browse keeps working and submit is
refused plainly -- the swappable-backend state for the box's ~2026-08-04 credit horizon.

**CSAM by construction (constraint 4).** The visitor's ENTIRE input is a seeded scene id -- no free text,
no uploads. Every prompt + keyframe is curator-vetted, so the bright line is satisfied structurally, not by
a filter.

**Assistant (constraints 6-9).** `POST /api/demo/chat {message}` runs a demo-scoped OSS model
(`DEMO_ASSISTANT_MODEL`, a Workers-AI llama-3.3-70b class) behind its OWN hard-capped AI Gateway
(`GATEWAY_ID` = the demo gateway, which carries the hard daily budget). Per-IP + global daily caps
(`demo_counter`) are checked BEFORE the model call, so an exhausted visitor spends zero tokens; the cap
reply is plain text and browse keeps working (honest exhaustion). The prompt is demo-scoped with a low
output cap and NO tool/binding reach beyond read-only studio state. `GET /api/modules` projects
`host.assistant = { model: "oss", note: "..." }` so the "free model" note renders wherever the assistant
surfaces (constraint 9).

**The write surface** is exactly two routes: `POST /api/demo/render` and `POST /api/demo/chat`
(`DEMO_WRITE_ROUTES` in `src/auth-gate.ts`). Every other mutation -- including the prod render/plan/chat
routes -- stays denied by `verifyDemoRequest`.

### Binding delta (what OPENS vs what STAYS ABSENT)

**Opens** (added to the Phase-A `DB` + `ASSETS`): `MODULE_LOCAL_GPU` (the demo-scoped local-gpu door),
`AI` + `GATEWAY_ID` (the demo gateway), `SPEND_RATE_LIMITER`, and the `DEMO_*` vars; the demo D1 gains the
`0002_demo_render.sql` tables (`demo_renderable`, `demo_render_queue`, `demo_counter`).

**Stays absent** (still the proof): `RUNPOD_*`, every frontier BYOK key, `R2` / `R2_RENDERS` / `R2_S3_*`,
the CPU-container VPCs, `MODULE_DISPATCH` + every other `MODULE_*`, cron `[triggers]`, tail, `STUDIO_API_TOKEN`.

### Rollout (gated through the lead)

The isolated demo R2 prefix creds, the regenerated `LOCAL_BACKEND_TOKEN`, the stable **named** box tunnel,
and the demo AI Gateway id are minted/provisioned by the lead/infra and WIRED into the rendered
`wrangler.demo.toml` + the demo-scoped local-gpu worker (values never in CI, never in a transcript). The
seeded `demo_renderable` rows carry `REPLACE_WITH_*` keyframe placeholders until the curator keyframes are
uploaded to the demo prefix; an unresolved placeholder fails the render honestly, never a silent success.
**A fresh adversarial security pass on the LIVE demo is a Phase B SHIP GATE** (the write surface went from
zero routes to two; the Phase A verdict does not carry over).

## Live verify (assert on JSON/headers, not prose)

| # | Request | Expect |
|---|---------|--------|
| 1 | `GET /api/modules` | `200`, 26 modules, `host: {dispatch:false, readonly:true}` |
| 2 | `POST /api/render/film` | `403` with reason `demo studio is read-only: ...` |
| 3 | `GET /planner` | `200` HTML, `content-security-policy` contains `media-src 'self' https://assets.skyphusion.net` |
| 3b | `GET /cast` (or `/planner`) | `200` HTML, `content-security-policy` `img-src` contains `https://assets.skyphusion.net`; the cast list shows all 4 portraits, no CSP violation in the console |
| 4 | a seeded render's `output_key` (an `assets.skyphusion.net` showcase mp4) | `curl -I` -> `200` |
| 4b | a seeded cast `portrait_key` (e.g. `.../vivijure/showcase/cast/kesh.jpg`) | `curl -I` -> `200` |
| 5 | `GET /` (root) | `200`, loads unauthenticated (no token prompt) |

| 6 | `GET /api/demo/menu` | `200`, `scenes: [...]` seeded; `available` reflects `DEMO_RENDER_ENABLED` + the door |
| 7 | `POST /api/demo/render {scene:<seeded id>}` when paused | `503` reason `paused` (renders paused; browse still 200) |
| 8 | `POST /api/render/film` (a prod write route) | `403` read-only (the carve-out is ONLY the two demo routes) |
| 9 | `GET /api/modules` in Phase B | `host.render.available` present; `host.assistant.{model,note}` present when `AI` is bound |
| 10 | `GET /api/storyboard/models` | `200` with `{"models":[]}` -- a demo never advertises frontier planning models it cannot invoke |
| 11 | `GET /api/voices` | `200` with `{"voices":[]}` -- the same honesty rule for the TTS voice catalog |

> Note: for the first few seconds after the custom domain provisions, the edge may return a
> transient `500 (error code 1104)` while the cert warms; retry and it clears.
