# Security model

This document states the ACTUAL security posture of the Vivijure Studio worker: what authenticates a
request, what a leaked value can reach, and which surfaces are intentionally public. It is the
authoritative reference; the contract should be reproducible from here without reading the code.

The studio is **single-operator by design**. There is no tenant model, no per-user identity, no
account system: the anti-SaaS identity strip (#292) deliberately removed the `user_email` /
tenancy primitive so there is no seam to hang multi-tenancy on. "Who are you" is answered once, at
the edge, by Cloudflare Access; everything behind it belongs to the one operator.

## 1. The trust boundary is Cloudflare Access (at the edge)

Authentication is enforced by the **Cloudflare Access** application in front of the worker, not by
in-worker code. The Access app covers the whole production surface:

- `vivijure.skyphusion.org` (production UI + JSON API), and
- the `*.workers.dev` host (covered because `workers_dev = true` is published).

The Access policy admits a Skyphusion Labs email identity, a service token, or a production-IP
bypass for internal callers (the GPU backend and the Slate bot, which carry no email identity).

Because the boundary is the edge, **the worker does not re-check identity per route**. A naive
in-worker `require email` gate would break the IP-bypass and service-token callers, which is why the
data routes do not add one. The single-operator assumption is sound ONLY while Access covers the
entire `/api/*` surface. If you add a new public hostname or route, confirm Access still covers it.

### Consequence for `/api/artifact/<key>`
Artifacts are served by R2 key with no per-row ownership check. This is safe **only** because the
whole worker is Access-gated and single-tenant: there is exactly one operator, so "serving by key"
cannot cross an ownership boundary (there is none). This property depends entirely on section 1.

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
enforces. When unset the backstop is NOT armed: the Worker allows `/api/*` (relying solely on the
edge gate, the pre-F2 model) and logs a loud one-time warning. **Production MUST arm it.**

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
with section 1 (the whole surface is Access-gated to the single operator), there is no privilege
boundary BETWEEN jobs to cross: all jobs belong to the one operator. Scoping job-to-job would
enforce a boundary that does not exist in a single-operator studio.

### `isValidJobId` is a format gate, not an entropy source
`isValidJobId` (`/^[A-Za-z0-9_-]{1,128}$/`) validates the SHAPE of an inbound, RunPod-issued id so a
malformed value cannot steer a request or force a needless 404 round-trip. It does not generate
entropy and is not the capability check: the entropy lives at mint time (`crypto.randomUUID()`),
not in this regex. Do not mistake loosening/tightening the regex for an entropy change.

## 3. Intentionally public (unauthenticated) surfaces

Two surfaces are reachable without Access, by design. Both are reviewed to leak nothing internal:

- **`/welcome`** -- the marketing landing page (`welcome.html`). It is the ONLY path with a public
  Access bypass, scoped to `/welcome` by a separate path-scoped Access app; that bypass does NOT
  extend to `/api/*`.
- **`GET /api/modules`** -- the registry projection that the self-assembling UI renders from. It
  returns only the PUBLIC view of each installed module (name, version, hooks, config schema
  markers). Internal binding VALUES never cross this projection; an `install`-scope config value
  (e.g. a notify-email recipient) lives only behind the authenticated config route and is never
  emitted here. Today the projection is empty (no modules installed). If you add a module, keep its
  secret/internal fields off the public projection.

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

## Checklist when changing the surface

- [ ] New hostname or route -> confirm the Cloudflare Access app still covers it (`/api/*` must stay
      gated; only `/welcome` is public).
- [ ] New job-keyed route -> the id must be `crypto.randomUUID()`-minted; never accept a
      caller-chosen low-entropy id as a capability.
- [ ] New module field -> internal/secret values stay off the `GET /api/modules` projection.
- [ ] New R2/key consumer -> mint a per-function, least-privilege token (Object R/W, single bucket);
      do not reuse a broader token.
- [ ] New module response field consumed by the core -> it is UNTRUSTED; validate its shape
      before acting on it (a module is community code).
- [ ] Arming the F2 backstop (`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`) -> first confirm EVERY internal
      caller carries an Access JWT (service token, not IP bypass), or it will be denied.

## References

- #4 / #292 -- identity strip: no tenant model by design (this is why Access is the boundary).
- #10 -- jobId capability model: entropy + scoping (documented here).
- #6 -- R2 key / presign input-boundary safety.
- #18 -- presign credential blast radius + `/api/modules` disclosure posture.
- [DEPLOYMENT.md](DEPLOYMENT.md) -- per-function key issuance and scopes.
