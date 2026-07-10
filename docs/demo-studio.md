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
   ```

   Seeds: the 26 real module manifests (display-only, `script_name = demo-seed-<name>`, invocable by
   nothing), plus browseable projects, cast, and COMPLETED render rows whose `output_key` is an
   absolute `assets.skyphusion.net` showcase MP4.

4. **Deploy the Worker** (creates the `demo.vivijure.com` custom domain -- Workers custom domains own
   DNS + the cert; a first-level subdomain under `vivijure.com` gets Universal SSL, NO ACM needed):

   ```bash
   wrangler deploy -c wrangler.demo.toml
   ```

   A green deploy prints exactly three bindings: `DB (vivijure-demo)`, `ASSETS`, and
   `AUTH_MODE ("demo")`. If it prints any other binding, the config drifted -- stop.

## Live verify (assert on JSON/headers, not prose)

| # | Request | Expect |
|---|---------|--------|
| 1 | `GET /api/modules` | `200`, 26 modules, `host: {dispatch:false, readonly:true}` |
| 2 | `POST /api/render/film` | `403` with reason `demo studio is read-only: ...` |
| 3 | `GET /planner` | `200` HTML, `content-security-policy` contains `media-src 'self' https://assets.skyphusion.net` |
| 4 | a seeded render's `output_key` (an `assets.skyphusion.net` showcase mp4) | `curl -I` -> `200` |
| 5 | `GET /` (root) | `200`, loads unauthenticated (no token prompt) |

> Note: for the first few seconds after the custom domain provisions, the edge may return a
> transient `500 (error code 1104)` while the cert warms; retry and it clears.
