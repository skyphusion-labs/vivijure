# Security model

This document states the ACTUAL security posture of the Vivijure Studio worker: what authenticates a
request, what a leaked value can reach, and which surfaces are intentionally public. It is the
authoritative reference; the contract should be reproducible from here without reading the code.

The studio is **single-operator by design**. There is no tenant model, no per-user identity, no
account system: the anti-SaaS identity strip (#292) deliberately removed the `user_email` /
tenancy primitive so there is no seam to hang multi-tenancy on. "Who are you" is answered once, by
the deploy's auth gate: the built-in studio API token (`AUTH_MODE = "token"`, section 1b, the
production posture on `vivijure.skyphusion.org` and the quickstart default) or Cloudflare Access
(`AUTH_MODE = "access"`, sections 1/1a, the optional edge-identity hardening for team/org
deployments). Everything behind the gate belongs to the one operator.

## 1. Access mode: the trust boundary is Cloudflare Access (at the edge)

> **Production runs token mode (section 1b), not access mode.** As of v0.12.0 the whole-hostname
> Cloudflare Access app on `vivijure.skyphusion.org` was removed and `AUTH_MODE = "token"` is the
> live production posture; the in-worker token gate is the front door. Sections 1 and 1a below
> describe `AUTH_MODE = "access"` as the OPTIONAL edge-identity mode -- keep them as the reference
> for anyone who chooses it, but read "production" in this document as the token gate.

Sections 1 and 1a describe `AUTH_MODE = "access"` -- the optional edge-identity hardening for
team/org deployments (SSO identity, device posture, audit logs, per-caller service tokens). A
self-host quickstart and Conrad's own production instance both run token mode instead (section 1b)
and need NONE of this; Access is optional hardening, not a deploy prerequisite (#423).

When access mode IS chosen, authentication is enforced by the **Cloudflare Access** application in
front of the worker, not by in-worker code. The Access app covers the whole served surface:

- `vivijure.skyphusion.org` (production UI + JSON API). The `*.workers.dev` host is disabled
  (`workers_dev = false`, #349), so the custom domain is the only served hostname.

The Access policy admits a Skyphusion Labs email identity or an Access **service token**. The only
non-browser caller of `/api` is the **Slate** Discord bot, which authenticates with a service token
(it sends `CF-Access-Client-Id` + `CF-Access-Client-Secret` on every call). The **GPU backend does
NOT call `/api` at all** -- it is a RunPod serverless handler that receives work through the RunPod
job envelope and writes artifacts straight to R2 via boto3 S3, so it never crosses the Access
boundary. (A legacy production-IP bypass for "internal callers" is being removed in the F2 cutover;
the GPU backend never needed it on this path, and Slate uses a service token instead.)

The single-operator assumption is sound ONLY while the active auth gate covers the entire `/api/*`
surface -- the in-worker token gate in production (section 1b), or, in access mode, the Access app.
In access mode the worker ALSO adds an in-code backstop (section 1a, F2) that verifies the Access
JWT itself -- checking the signature + `aud`, NOT an email claim, so a service-token caller (Slate)
passes while an unauthenticated caller is denied. If you add a new public hostname or route, confirm
the active gate still covers it.

### Consequence for `/api/artifact/<key>`
Artifacts are served by R2 key with no per-row ownership check. This is safe **only** because the
whole worker is auth-gated (the token gate in production, section 1b; or Access in access mode) and
single-tenant: there is exactly one operator, so "serving by key" cannot cross an ownership boundary
(there is none). This property depends entirely on the active gate covering `/api/*` (section 1).

**Hardening (F4).** The serve is nonetheless bounded so it cannot become an arbitrary-object read or a
stored-XSS vector even if section 1 ever fails: the key must pass `isSafeRelKey` (no traversal /
absolute / scheme / control bytes) AND start with a known artifact prefix (`ARTIFACT_PREFIXES`),
else `404`; and every response carries `X-Content-Type-Options: nosniff`. The upload routes
(`/api/upload`, `/api/storyboard/character-ref`, `/api/storyboard/audio-upload`) reject any
content-type outside their allowlist (no `"bin"` fallback), so a scriptable type (`text/html`,
`image/svg+xml`) can never be stored and later served back into the operator's authenticated origin.
True cross-tenant isolation still needs an ownership model (the F13 IDOR follow-up); F4 makes these
two endpoints safe-by-default for a downstream deployer in the meantime.

**Byte-range media serving (#416).** `GET` / `HEAD /api/artifact/<key>` supports HTTP range
requests (RFC 7233) so a browser can stream and seek a rendered film -- Safari/iOS refuse to play
media that cannot be range-requested, and Chrome otherwise re-fetches from byte 0 on every seek. A
ranged request returns `206 Partial Content` + `Content-Range` for a satisfiable single range,
`416 Range Not Satisfiable` + `Content-Range: bytes */<size>` for an out-of-bounds one, and a full
`200` (always with `Accept-Ranges: bytes`) when the header is absent, malformed, or a multi-range
(the worker does not emit `multipart/byteranges`). The `isSafeRelKey` + `ARTIFACT_PREFIXES` guard
and `nosniff` apply identically on every path; the object size is resolved via `R2_RENDERS.head()`
up front so an out-of-bounds range is answered `416` rather than mistaken for a missing object
(an R2 `get()` with a bad range returns null, indistinguishable from not-found).

### Downstream deployer requirement (F13)
The single-operator model is **load-bearing**, and this code is public. There is NO ownership
column or per-identity check anywhere (the identity strip #292 removed tenancy by design): every
`:id` route -- `/api/cast/:id` (get/patch/delete/**export**), `/api/storyboard/projects/:id`,
`/api/storyboard/renders/:id`, `/api/render/film/:id` -- trusts the caller. Ids are sequential
integers, so they are trivially enumerable, and `GET /api/cast/export/:id` exfiltrates a whole
character bundle (portrait + LoRA + bible) by id. A downstream operator who deploys this
**multi-tenant, or on a hostname with no authenticating gate at all, is handed a horizontal IDOR**
across all casts/projects/renders/films.

This is intentional (anti-SaaS; we are NOT building a multi-tenant authz layer). The requirement
is therefore a HARD deploy rule, not a code feature: **run this single-operator, behind an
authenticating proxy on EVERY hostname, never on an unauthenticated route.** Arm the F2 backstop
(below) so the reference Worker also fails closed in code, not by documentation alone.

## 1a. In-Worker Access verification backstop (F2)

Section 1's edge boundary is a single point of failure: one Access-config gap (a hostname the app
does not cover, e.g. a published `workers.dev` route) reopens the whole API. To make that
un-reopenable, the Worker can ALSO verify the Access JWT itself (`src/access-auth.ts`). When armed,
it FAILS CLOSED: every `/api/*` request must carry a `Cf-Access-Jwt-Assertion` whose RS256
signature verifies against the team JWKS (`https://<team>/cdn-cgi/access/certs`) and whose `aud`,
`iss`, and `exp`/`nbf` match. Absent, malformed, expired, wrong-audience, unknown-key, bad-signature,
or unverifiable (JWKS unreachable with no cached key) => denied. `/health` and `/welcome` stay open.

**Arming it (config, not secrets -> `wrangler.toml [vars]`):** set `ACCESS_TEAM_DOMAIN` (the Zero
Trust team hostname) and `ACCESS_AUD` (the Access application AUD tag). When BOTH are set the gate
enforces. When BOTH are unset the backstop is NOT armed and the Worker **DENIES `/api/*` (503) by
default** -- fail closed, so a downstream deployer who has not established an auth boundary is never
silently served. The only escape is a conscious, documented opt-out: `ALLOW_UNAUTHENTICATED = "true"`
(for local/dev/test, or a deployer fronting the Worker with their own auth proxy), which allows
`/api/*` with a loud one-time warning. **Production MUST arm it** (set the two vars), not rely on the
opt-out.

> ### LOAD-BEARING CAVEAT: internal callers must carry a JWT before arming
>
> Arming the backstop denies any caller WITHOUT a valid Access JWT. Email-identity and Access
> **service-token** callers carry one (a service token's JWT has `common_name` instead of `email`;
> the gate checks the signature + `aud`, NOT an email claim, so service tokens pass). But a
> **production-IP BYPASS** policy admits traffic with NO JWT -- so the internal callers that today
> reach `/api/*` via IP bypass (the GPU backend, the Slate bot) would be DENIED the moment the
> backstop is armed. Before arming, migrate those callers OFF the IP bypass and ONTO Access service
> tokens (each its own scoped token, per section 4). This both fixes the conflict and is strictly
> stronger than IP allow-listing. Arming without this migration is a self-inflicted outage.

## 1b. Token mode: built-in studio API token (`AUTH_MODE = "token"`, #423)

The quickstart deploy needs an auth gate WITHOUT the Zero Trust product (the 2026-07-02 cold-deploy
dry run proved the Access enable flow kills a first deploy: a fresh account had to hand-edit an
account id into a dashboard URL just to reach the enable button). Token mode is that gate,
entirely in-Worker (`src/auth-gate.ts`):

- `deploy.sh` mints a 256-bit random token (`openssl rand -hex 32`), stores it as the
  `STUDIO_API_TOKEN` **worker secret** (never a var, never a tracked file), and prints it ONCE at
  the end of the deploy. The guided installer (`deploy/vivijure_deploy.py`) does the same in its
  default `AUTH_MODE = "token"`: it skips the CF Access app and mints `STUDIO_API_TOKEN` through the
  identical `wrangler secret put` path (not a second mint), keeping the existing token on a re-run
  unless `--rotate-token` is passed. `AUTH_MODE = "access"` provisions the edge Access app instead.
- Every `/api/*` request must present the token. `Authorization: Bearer <token>` is canonical
  and authenticates EVERY method. The same token in the `vivijure_token` cookie authenticates
  **GET/HEAD only**: the cookie transport exists because the studio loads artifacts through media
  elements (`img`/`video`/`audio` `src` on `/api/artifact/*`, the #416 Range paths) and a media
  element cannot send a header -- and media elements only ever issue GETs, so read-only cookie
  authority costs zero call sites while making the cookie useless for anything state-changing
  even in a SameSite-bypass scenario. A cookie-only mutation is answered `403` (deliberately not
  `405`: the method is allowed, the CREDENTIAL is insufficient) with a reason pointing at the
  bearer header. The frontend shim (`public/auth-token.js`, loaded first on every studio page)
  adds the bearer header to every same-origin `/api/*` fetch and mirrors the same pasted token
  into the cookie (`Secure; SameSite=Strict; Path=/api/`); `SameSite=Strict` stops cross-site
  auto-send. One credential; the second transport is read-only. When a bearer header IS present
  it is authoritative: a bad header denies even if a good cookie rides along.
- The compare is CONSTANT-TIME: both sides are SHA-256 digested and the two fixed-length digests
  are XOR-folded over all 32 bytes, so neither the presented token's length nor the position of
  the first mismatching byte can modulate the comparison time.
- FAIL CLOSED everywhere: token mode with no `STUDIO_API_TOKEN` bound denies everything (403); an
  unknown `AUTH_MODE` value denies everything; `AUTH_MODE` unset keeps the exact pre-#423
  resolution (Access vars set -> verify the JWT; else deny unless the dev-only
  `ALLOW_UNAUTHENTICATED` opt-out), so an existing deploy is untouched by this feature.
- The browser keeps the token in `localStorage`, pasted once into the studio's token prompt. It is
  the operator's single capability for the whole studio: treat it like a password. Rotate it any
  time with `openssl rand -hex 32 | npx wrangler secret put STUDIO_API_TOKEN` and re-paste.

### 1b-i. Named per-consumer tokens (#445)

The operator login above is the human/deploy credential. Every OTHER API consumer (a Discord bot,
a satellite) gets its OWN named token instead of reusing the operator's, per the per-function-keys
rule: a leak burns one consumer, a rotation touches one consumer, and the operator login is never
handed out.

- Mint: `scripts/studio-consumer-token.sh mint <name>` generates a 256-bit token, inserts ONLY its
  SHA-256 hash into the D1 `api_tokens` table (migration 0009), and writes the plaintext to a
  local `chmod 600` file exactly once -- it is never printed to the terminal or stored anywhere
  else. Hand the file's value to the consumer (its `.env`), then delete the file.
- Revoke: `scripts/studio-consumer-token.sh revoke <name>` (idempotent); `list` shows names +
  created/revoked timestamps (never hashes' preimages -- there is nothing secret in the table).
- The gate (`src/auth-gate.ts`) checks the operator secret first (constant-time), then looks the
  presented token's hash up in `api_tokens` where `revoked_at IS NULL`. A named match
  authenticates as `api-token:<name>` (visible in observability), same transport rules as the
  operator token (bearer any method, cookie GET/HEAD only). The deny reason is identical for both
  classes, so a probe cannot learn which class it missed.
- FAIL CLOSED: no D1 binding, an unapplied migration, or a D1 outage simply means no named token
  matches; the operator path is independent and unaffected.

**Scope: full access, not data isolation.** A named token is a full-access credential that happens
to be independently issuable and revocable -- it is NOT a scoped-down or read-only key. Every valid
bearer (the operator secret OR any named token) reaches the ENTIRE API identically: the gate
authenticates the token and records its name in observability (`api-token:<name>`), but no handler
scopes any project, cast member, or render by the caller's identity. There is no owner column and no
per-consumer data boundary (this is the same single-operator capability model as section 2: all data
belongs to the one operator, and job ids are the only per-object capability). So a named token can
read, write, and delete every other consumer's projects, cast, and renders. Issue one to bound
ROTATION and attribution blast radius (a leak burns one consumer, a revoke touches one consumer),
never to isolate data between callers. If you need real per-caller data isolation, that is not token
mode -- put Cloudflare Access in front (`AUTH_MODE = "access"`) and add an owner column; token mode
deliberately does not model it.

Threat-model honesty: token mode authenticates POSSESSION of a bearer secret. Named tokens add
per-caller issuance, revocation, and an identity string in logs -- but still no device posture and
no human identity; that is what Cloudflare Access adds. A single operator on a personal deploy:
token mode is enough. A team, an org, or anything with staff turnover: put Access in front and run
`AUTH_MODE = "access"` (sections 1/1a).

> **Choosing Access anyway -- the enable-flow workaround.** Zero Trust must be enabled once per
> account before an Access app can exist, and the dashboard's entry link can dead-end on a fresh
> account. Go directly to `https://dash.cloudflare.com/<account-id>/one/dashboard` (paste your account
> id), pick a team name (this sets `ACCESS_TEAM_DOMAIN` = `<team>.cloudflareaccess.com`), create
> the Access application for your studio hostname, and copy its AUD tag into `ACCESS_AUD`.

## 2. Job ids are capabilities (possession = access)

Several mutating routes are keyed by a job id (`WHERE job_id = ?`): render progress/finish updates,
scatter-child lookup, failure marks. There is no owner column to scope them by (identity strip), so
the security of these routes rests on the **capability** model: holding a valid job id IS the
authorization for that job, and the ids are unguessable.

Every job id the worker mints comes from `crypto.randomUUID()` (122 bits of entropy):

- render jobs: `clips-<uuid>`
- film jobs: `film-<uuid>`
- scatter parents: `scatter-<uuid>` (the synthetic parent id; see `scatterParentJobId`)
- cast-refs jobs: `refs-<uuid>`

An attacker cannot enumerate or guess a 122-bit id, so possession is a real capability. Combined
with section 1 (the whole surface is auth-gated to the single operator), there is no privilege
boundary BETWEEN jobs to cross: all jobs belong to the one operator. Scoping job-to-job would
enforce a boundary that does not exist in a single-operator studio.

### `isValidJobId` is a format gate, not an entropy source
`isValidJobId` (`/^[A-Za-z0-9_-]{1,128}$/`) validates the SHAPE of an inbound, RunPod-issued id so a
malformed value cannot steer a request or force a needless 404 round-trip. It does not generate
entropy and is not the capability check: the entropy lives at mint time (`crypto.randomUUID()`),
not in this regex. Do not mistake loosening/tightening the regex for an entropy change.

## 3. Intentionally public surfaces, and the `/api/modules` projection

Only **`/welcome`** (the marketing landing page, `welcome.html`) and **`/health`** are reachable
without authentication, by design; both are reviewed to leak nothing internal. On the production
instance `/welcome` and `/health` each sit behind their own path-scoped Cloudflare Access app whose
policy is a public bypass (everyone for `/welcome`, a production-IP allowlist for `/health`); those
path-scoped apps are independent of `AUTH_MODE` and do NOT extend to `/api/*`.

**`GET /api/modules`** -- the registry projection that the self-assembling UI renders from -- sits
BEHIND the auth gate like every other `/api/*` route. Its payload is scrubbed as defense in depth:
it returns only the PUBLIC view of each installed module (name, version, hooks, config schema
markers). Internal binding VALUES never cross this projection; an `install`-scope config value
(e.g. a notify-email recipient) lives only behind the authenticated config route and is never
emitted here. The projection lists whatever the deploy installed -- a minimal `deploy.sh` profile
installs 17 module workers, so it is populated from first boot. If you add a module, keep its
secret/internal fields off the projection.

## 4. Credential blast radius (least privilege per function)

Issue a **separate, narrowly-scoped key per function**; never one god-token (see
[DEPLOYMENT.md](DEPLOYMENT.md) section 2). The blast radius of any one leaked value is bounded to
exactly its function:

- **R2 S3 presign keys** (`R2_S3_ACCESS_KEY_ID` / `R2_S3_SECRET_ACCESS_KEY`): the worker holds an R2
  S3 access-key pair so it can presign URLs for CPU containers that have no R2 binding. The backing
  R2 API token MUST be **Object Read & Write** (not bucket/config admin) and scoped to **the render
  bucket only** (`vivijure`). A leaked presign secret then reaches that bucket's objects and nothing
  else. The worker also signs only for the single `R2_S3_BUCKET` it is configured with.
- **Presigned URLs** are short-lived and key-scoped: the lifetime is clamped to `[1, 604800]`
  seconds and the key is validated by `isPresignSafeKey` before signing, so a hostile expiry or a
  traversal/scheme-injected key cannot widen the grant (#6).
- **Per-consumer keys**: the GPU backend, CI deploy, and AI Gateway each carry their own scoped
  token, so rolling or revoking one never touches the others.

## 5. Input-boundary key safety (#6)

Untrusted strings that become R2 keys or fetch paths are validated at the input boundary:
`isSafeRelKey` (strict relative-key charset, no leading `/`, no `..` segment) for externally
supplied path fields, `sanitizeKeySegment` for derived slugs, and `isPresignSafeKey` as
defense-in-depth on any key about to be signed. This blocks path traversal, absolute keys, URL
schemes, and control/non-ASCII bytes from steering an object reference.

## 6. Spend rate limiting (F3)

The render / train / generate routes each submit a RunPod GPU job or paid AI work, so an abused
session can burn the operator's balance (denial-of-wallet). Every such POST route
(`/api/storyboard/render`, `/api/render/clips`, `/api/render/film`, `.../render/scatter`,
`.../render-from-keyframes`, `.../renders/:id/animate-cloud|animate-hybrid`,
`/api/cast/:id/train-lora`, `/api/cast/:id/generate-refs`, `/api/storyboard/score-bed|music-generate`)
passes a rate limiter before dispatch (`src/rate-limit.ts`, the spend surface is the single
auditable `SPEND_PATTERNS` list). Backend: the Cloudflare native Rate Limiting binding
(`SPEND_RATE_LIMITER`), keyed by `CF-Connecting-IP`; over-limit returns `429` + `Retry-After`.

Posture: **FAIL CLOSED by default (S9 F7).** A healthy limiter does ordinary rate limiting: it allows
within-limit requests and returns `429` + `Retry-After` on an over-limit one. But when the limiter
itself is BROKEN -- `SPEND_RATE_LIMITER` unbound, or `.limit()`/the daily-ceiling check throws -- the
request is DENIED `503`, not allowed. The money path fails closed like the F2 auth backstop
(section 1a), because a novice self-funds the GPU balance and must never silently run unmetered on a
misconfigured limiter. A healthy default deploy (the reference `wrangler.toml.example` binds
`SPEND_RATE_LIMITER`) is unaffected: fail-closed bites only a broken limiter, never a working one.
The binding is per-colo; a Durable Object token bucket is the documented upgrade if cross-colo
(global) accuracy is ever needed.

Two operator knobs (both `[vars]`):

- `SPEND_LIMIT_FAIL_CLOSED = "false"` opts OUT to the old fail-open posture: a broken/unbound limiter
  (or a failing daily-ceiling check) ALLOWS the request (with a one-time warning) instead of denying,
  so a limiter blip never blocks a render -- at the cost of a bounded unmetered window. Any other
  value, including unset, keeps the fail-closed default. A self-hoster funding their own GPU balance
  should leave it at the default (fail closed).
- `SPEND_DAILY_CEILING = "<n>"` caps total spend-route submissions per UTC day, counted atomically
  in D1 (`spend_counter`, migration 0008). Over the ceiling returns `429` with `Retry-After` set to
  UTC midnight. The unit is submissions, not dollars: the studio cannot see GPU pricing, but every
  spend route is one bounded job, so a per-day count is an honest ceiling the operator can size
  (e.g. `"25"` on a hobby deploy). The per-IP limiter runs first; a rate-limited request does not
  consume a ceiling slot.

## 7. Module response hardening (F5)

A module is untrusted (community territory: the operator service-binds third-party Worker code).
The core reads every `/invoke`, `/poll`, `/cancel`, and `/module.json` response through a
size-capped reader (`MAX_MODULE_RESPONSE_BYTES`, 1MB; `src/modules/registry.ts`). Envelopes are
small JSON metadata -- heavy artifacts live in R2, referenced by KEY, never inline -- so the cap is
generous. A response exceeding it (or an unreadable body) becomes an honest `ok:false` DEGRADE,
never an unbounded buffer that could OOM/DoS the core Worker.

> **Follow-up (tracked):** runtime validation of a module's terminal OUTPUT against its hook
> contract (`checkHookOutput`) is NOT yet enforced at runtime -- it runs only in the conformance
> TEST. The core still trusts the output SHAPE a module returns. See the F5-output-validation issue
> for the layering decision (the generic invoke/poll transport is payload-agnostic, so enforcement
> belongs at the per-hook terminal-consumption seams, with a test-fixture sweep).

## 7a. What installing a module grants it

The size cap above protects the core FROM a module; the converse is the operator's trust decision.
To do its job a module is handed, in its `/invoke` input, the presigned R2 GET/PUT URLs for the
specific assets of the job it serves (e.g. a `finish` module gets a GET on the clip to process and a
PUT for its output). So installing a module grants that third-party Worker: (a) READ of the source
asset it processes for that job, and (b) WRITE of its own output object -- meaning a malicious or
buggy module can exfiltrate the asset it is handed or poison its own output (ship a garbage or
hostile clip). That blast radius is deliberately bounded: `InvokeContext` carries only
`{project, job_id}` and NO secrets; every presigned URL is scoped to one specific key with a short
TTL; a module NEVER chooses its own output key (all PUT keys are core-derived); and no long-lived
credential ever crosses the wire. A module cannot reach another job's or another project's assets,
read a secret, or escalate through the dispatch binding. Treat installing a module as granting it
read-and-tamper over the render assets it processes -- install only module code you trust, and
prefer first-party or provenance-checked modules for any hook on a sensitive render.

## 8. Response security headers (worker-owned, single source of truth)

Cloudflare's zone-wide "Add security headers" managed transform is **OFF** (captured in IaC). The
**Worker owns every security header**, stamped at ONE chokepoint: `applyResponseSecurity`
(`src/asset-response.ts`), called on every response that leaves `fetch()`. Nothing else adds or
strips them, so the matrix below is the whole truth. Headers are `set` (overwrite), never appended,
so a re-enabled zone default could not duplicate them.

The CSP is **per response class**: the known studio page routes get the strict studio policy;
`/welcome` gets its own policy (it has one inline `<style>` block + inline `style=` attributes, so
`style-src` allows `'unsafe-inline'` -- scripts stay strict `'self'`); **every other response**
(the JSON API, non-HTML assets, redirects, the 429, and any non-page HTML) gets a **locked**
`default-src 'none'` CSP. A stray or mislabeled `text/html` response on a non-page route therefore
never receives the permissive page policy.

| Response class | Content-Security-Policy | X-Content-Type-Options | X-Frame-Options | Referrer-Policy | Permissions-Policy |
|---|---|---|---|---|---|
| Studio pages (`/`, `/planner`, `/cast`, `/modules`, `/settings`) | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` | `nosniff` | `DENY` | `same-origin` | `camera=(), microphone=(), geolocation=()` |
| `/welcome` (BASE, self-host) | as studio, but `style-src 'self' 'unsafe-inline'`, `img-src`/`media-src` add `https://assets.skyphusion.net` | `nosniff` | `DENY` | `same-origin` | same |
| `/welcome` (analytics ON: `WEB_ANALYTICS_TOKEN` set + 32-hex valid) | BASE plus `https://static.cloudflareinsights.com` on `script-src` and `https://cloudflareinsights.com` on `connect-src` | `nosniff` | `DENY` | `same-origin` | same |
| Everything else (API/JSON, assets, redirects, 429, non-page HTML) | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'` | `nosniff` | `DENY` | `same-origin` | (none -- document-only) |

`frame-ancestors 'none'` supersedes `X-Frame-Options`; the latter is kept for pre-CSP agents.
`Permissions-Policy` is document-only, so it is set on pages, not on JSON/asset responses. The
`/welcome` analytics CSP delta and the analytics beacon injection share ONE gate (`analyticsTokenValid`),
so a self-hoster with no token gets neither and the two can never disagree (#363). A downstream
deployer who re-enables a CDN/proxy header layer should keep it OFF for this origin, or reconcile it
with this matrix, to preserve the single-source-of-truth property.

**Load-bearing assets config.** Because the Worker is the header authority, the Workers Assets binding
MUST route the static pages through the Worker: `run_worker_first = true` (else the edge serves
`/welcome` and the studio pages directly, bypassing the chokepoint -- they get NO headers) AND
`html_handling = "none"` (else `serveStudioAsset`'s `.html` fetch 307-redirects to the pretty URL and
loops). The Worker maps the pretty page routes itself (`STUDIO_PAGE_ASSETS`, including `/` ->
`/index.html`). Changing either setting silently drops header coverage on the static pages; keep them
together. See `wrangler.toml.example`.

**Cache-Control (worker-authoritative, #416).** The Worker sets `Cache-Control` on every response
class, so this origin is correct WITHOUT any Cloudflare zone-level cache rule. A dashboard
cache-bypass rule that a deployment may run is therefore **optional operator hardening, not a
requirement** -- the worker headers are the source of truth (the same posture as the managed
security-header transform above). The chokepoint defaults a non-page response that carries no
`Cache-Control` of its own to `no-store` (SET-IF-ABSENT), so a route's explicit value always wins.

| Response class | Cache-Control | Set by |
|---|---|---|
| Static pages + assets (`/welcome`, studio pages, JS/CSS) | `public, max-age=0, must-revalidate` | Workers Assets binding (preserved through the chokepoint) |
| Artifact (`/api/artifact/<key>`) | `private, max-age=300` | `hServeArtifact` (`private` = never edge-cached, so an authenticated artifact never enters a shared cache) |
| Cast bundle download | `no-store` | `assembleBundle` |
| API/JSON, the 429, marker downloads, any other bare non-page response | `no-store` | chokepoint default (set-if-absent) |

`no-store` on the dynamic/authenticated classes keeps a private API body out of any shared or
browser cache; the static assets keep the binding's revalidating policy so the edge can still cache
them (the `/welcome` release-purge flow depends on that edge cache existing, #405/#407).

## Checklist when changing the surface

- [ ] New hostname or route -> confirm the active auth gate still covers it (in production the
      in-worker token gate; in access mode the Cloudflare Access app). `/api/*` must stay gated;
      only `/welcome` and `/health` are public.
- [ ] New job-keyed route -> the id must be `crypto.randomUUID()`-minted; never accept a
      caller-chosen low-entropy id as a capability.
- [ ] New module field -> internal/secret values stay off the `GET /api/modules` projection.
- [ ] New R2/key consumer -> mint a per-function, least-privilege token (Object R/W, single bucket);
      do not reuse a broader token.
- [ ] New module response field consumed by the core -> it is UNTRUSTED; validate its shape
      before acting on it (a module is community code).
- [ ] Arming the F2 backstop (`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`) -> first confirm EVERY internal
      caller carries an Access JWT (service token, not IP bypass), or it will be denied.
- [ ] Token-mode surface change -> `STUDIO_API_TOKEN` stays a worker SECRET (never a var or a
      tracked file); a new frontend API caller inherits the bearer header from the auth-token.js
      fetch shim automatically. ONLY media-element `src` URLs may rely on the cookie transport,
      which authenticates GET/HEAD alone -- a new mutating route needs no thought here, the cookie
      can never authorize it.
- [ ] New response class / route -> it flows through `applyResponseSecurity`; confirm it lands in
      the right header class (page vs locked) per section 8. CF managed-transform header layers stay
      OFF (the Worker is the single source of truth).
- [ ] New response class / route -> confirm its `Cache-Control` (a dynamic/authenticated body must
      not be cacheable): a bare non-page response defaults to `no-store` at the chokepoint, but set
      an explicit value at the route if it needs a different policy (per section 8).
- [ ] New GPU/paid endpoint -> add its path to `SPEND_PATTERNS` (src/rate-limit.ts) so it is
      rate-limited; an unlisted spend route is a denial-of-wallet hole.

## References

- #4 / #292 -- identity strip: no tenant model by design (this is why Access is the boundary).
- #10 -- jobId capability model: entropy + scoping (documented here).
- #6 -- R2 key / presign input-boundary safety.
- #18 -- presign credential blast radius + `/api/modules` disclosure posture.
- #364 / #370 -- worker-owned response security headers (CSP + companions) + the per-class matrix (section 8).
- #416 -- byte-range media serving on `/api/artifact` + worker-authoritative `Cache-Control` (section 8; the zone cache-bypass rule is optional hardening).
- #423 -- built-in token auth mode (section 1b); Cloudflare Access becomes optional hardening, not a deploy prerequisite.
- [DEPLOYMENT.md](DEPLOYMENT.md) -- per-function key issuance and scopes.
