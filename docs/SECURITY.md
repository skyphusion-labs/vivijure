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

## Checklist when changing the surface

- [ ] New hostname or route -> confirm the Cloudflare Access app still covers it (`/api/*` must stay
      gated; only `/welcome` is public).
- [ ] New job-keyed route -> the id must be `crypto.randomUUID()`-minted; never accept a
      caller-chosen low-entropy id as a capability.
- [ ] New module field -> internal/secret values stay off the `GET /api/modules` projection.
- [ ] New R2/key consumer -> mint a per-function, least-privilege token (Object R/W, single bucket);
      do not reuse a broader token.

## References

- #4 / #292 -- identity strip: no tenant model by design (this is why Access is the boundary).
- #10 -- jobId capability model: entropy + scoping (documented here).
- #6 -- R2 key / presign input-boundary safety.
- #18 -- presign credential blast radius + `/api/modules` disclosure posture.
- [DEPLOYMENT.md](DEPLOYMENT.md) -- per-function key issuance and scopes.
