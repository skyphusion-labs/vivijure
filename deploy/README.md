# vivijure-deploy (alternative guided installer)

> **The primary deploy path is the one-script `./deploy.sh` at the repo root** (see the top-level
> README and [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md); `deploy/constellation.sh` is the top
> orchestrator for the whole constellation). This Python installer is an **alternative** for operators
> who want interactive prompts plus a `down` teardown and want the RunPod side provisioned for them.
> It is not a competing front door: reach for it when you want the guided UX, otherwise use `deploy.sh`.

Stand up the whole Vivijure stack on **your own** Cloudflare + RunPod accounts (BYO keys + GPU). One
input surface, idempotent re-runs, a teardown path -- the guided Python installer from the design in
#244 (not full Terraform -- RunPod's IaC is too immature and the Cloudflare side needs Wrangler for
code/migrations regardless). What it adds over `deploy.sh`: interactive prompts, the
network-volume + registry-auth side of RunPod (the shell path covers template + endpoint via
`scripts/runpod-provision.py`), a scoped R2 S3 token mint, the Cloudflare Access app (access mode
only), and a `down` teardown by recorded id.

> **Auth mode (#423 / #445):** the installer supports BOTH gates, matching `deploy.sh`.
> `AUTH_MODE=token` (the default) mints a `STUDIO_API_TOKEN` operator login as a worker secret and
> gates `/api/*` on `Authorization: Bearer` -- no Cloudflare Access, no Zero Trust product, and no
> `DEPLOY_DOMAIN`/`OPERATOR_EMAIL` needed. `AUTH_MODE=access` provisions the edge Access app in
> front of the studio (`DEPLOY_DOMAIN` + `OPERATOR_EMAIL`) and arms the in-worker JWT backstop
> (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`) -- the stronger front door for a team or org. Either way the
> core deploy carries the `AUTH_MODE` var so the deployed gate matches. Per-consumer credentials
> (bots, satellites) are a SEPARATE class minted by `scripts/studio-consumer-token.sh`
> (docs/SECURITY.md 1b-i), never the operator token.

**Status: live-proven in the S29 proving pass.** The CLI, the single input surface, the secret
handling, and every provider call (Cloudflare + RunPod) are implemented and verified against the
CF/RunPod API docs + the RunPod OpenAPI, AND the end-to-end `up` was run against live accounts (a
free-plan greenfield `up` + `down`, then a paid-plan `up` + `down`); the findings were fixed in
v0.19.3 (#675-#685) and folded back in. Still **set the required config below first**.

> `up` provisions REAL resources on your accounts -- it mints an R2 API token, creates an Access app,
> RunPod endpoints, D1, R2 buckets, etc. `down` removes what it created (see State + teardown).

## Required config before a live run

A few non-secret values must be set (constants at the top of `vivijure_deploy.py`; the run **dies loud**
if any is missing, rather than POSTing an empty value):

Always:
- `GPU_TYPE_IDS` -- the endpoint GPU type id(s) (`GET /gputypes`).

Optional (each defaults to that satellite's current released tag; override to pin another):
- `BACKEND_IMAGE_TAG` / `UPSCALE_IMAGE_TAG` / `MUSETALK_IMAGE_TAG` / `AUDIO_UPSCALE_IMAGE_TAG` -- the
  per-endpoint GHCR image tags (BARE semver, never `latest`).

There is **no `DATACENTER_ID`**: the installer no longer provisions a network volume (the baked images
ship the weights in-layer), so endpoints schedule across the whole GPU pool for `GPU_TYPE_IDS` instead
of being pinned to one datacenter.

`AUTH_MODE` defaults to `token` and needs nothing else. For `AUTH_MODE=access` ALSO set:
- `DEPLOY_DOMAIN` -- the studio hostname behind CF Access (match the core worker's route).
- `OPERATOR_EMAIL` -- the one email allowed through the Access self-only policy.
- `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` -- the public Zero-Trust identifiers that arm the in-worker backstop.

## What it collects (and never will)

- **Collects:** exactly three infra credentials, for YOUR accounts -- a Cloudflare account id, a
  Cloudflare API token, and a RunPod API key. That is the entire secret surface.
- **Never:** no payment information, no credit-card number, no bank detail, no cryptocurrency
  wallet/seed/address. A deploy tool has no business touching any of that, and this one bills nothing
  and routes nothing. Vivijure is AGPL -- read `vivijure_deploy.py` end to end; the secret surface is
  deliberately minimal and obvious.

Credentials are read via hidden prompts (no terminal echo), held in memory for one run only, never
written to the state file, never logged, and never placed on a command line (argv is visible in `ps`
and shell history). Values reach Wrangler via stdin and the provider APIs via an auth header.

## Usage

```bash
# from the vivijure repo root
python3 deploy/vivijure_deploy.py plan          # print the ordered plan, change nothing
python3 deploy/vivijure_deploy.py up            # provision + seed + deploy (idempotent)
python3 deploy/vivijure_deploy.py up --rotate-token     # token mode: mint a FRESH login (invalidates the old)
python3 deploy/vivijure_deploy.py up --noninteractive   # read creds from env (CI/headless)
python3 deploy/vivijure_deploy.py down          # teardown by recorded id (keeps your R2/D1 data)
python3 deploy/vivijure_deploy.py down --delete-data    # also delete R2 buckets + D1
```

For `--noninteractive`, export `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `RUNPOD_API_KEY`
(so a value is never typed where it could be captured) -- still never argv. In this mode the operator
`STUDIO_API_TOKEN` is written to a `0600` file beside the state file (`.vivijure-studio-token`) and the
PATH is printed, never the value (stdout is typically piped/tee'd in CI). Interactive mode keeps the
one-time SAVE-THIS-NOW banner.

## The provisioning order (why it is the way it is)

The pieces are mutually dependent, so the order is load-bearing:

1. **Cloudflare infra** -- D1, the two R2 buckets, AI Gateway (its slug = `GATEWAY_ID`); mint a
   scoped R2 S3 token for the GPU backend. The CF Access app is created here ONLY in `AUTH_MODE=access`
   (token mode skips it).
2. **RunPod** -- registry-auth (only if the image is private; leave it UNSET for the public GHCR
   image, or a stale auth aborts even a public pull), then a **serverless template per endpoint**
   (each pins that endpoint's OWN image) and the endpoints. **No network volume** -- the baked images
   ship the weights in-layer, so a volume would only pin the pool to one datacenter and bill for
   nothing. Four endpoints: backend + upscale + musetalk + audio-upscale. Captures the endpoint ids
   (seeded under the per-satellite secret names in step 3). Must precede step 3.
3. **Seed the Cloudflare Secrets Store** -- the store keys are the UNION of every `secret_name` the
   deployed workers bind (asserted in `test_secret_map.py`). The installer resolves + seeds the
   auto-sourced ones: `RUNPOD_API_KEY` (yours); the per-endpoint RunPod ids under their OWN store names
   (`BACKEND_` / `VIDEO_UPSCALE_` / `MUSETALK_` / `AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID`, step 2);
   `GATEWAY_ID` + the scoped `R2_S3_*` creds (step 1). Operator-supplied secrets (`CF_AIG_TOKEN`,
   `PLAN_ENHANCE_CF_AIG_TOKEN`, `LOCAL_BACKEND_URL`/`_TOKEN`) seed as MARKED placeholders so the module
   deploy resolves, then a post-install checklist tells you which to replace. **This MUST happen before
   the deploy:** a module worker's `secrets_store_secrets` binding fails at `wrangler deploy` if the
   store secret does not yet exist (see #237). A re-run re-seeds rotated values before re-deploying.
4. **D1 migrations** (`wrangler d1 migrations apply` -- Terraform cannot do this).
5. **Deploy** module workers, then the core (the core binds each module as a `[[services]]`
   dependency, so modules ship first).
6. **(Phase 2, optional)** the five CPU helper containers on your own box (video-finish, image-prep,
   audio-beat-sync, audio-mix, audio-master) + their CF VPC services.
   Without them the studio still renders clips; it just cannot do the final concat / title cards.

## State + idempotency

`up` is reconcile-shaped: look up each resource by name/id in `.vivijure-deploy.json`,
create-if-absent, record the id. Safe to re-run after a partial failure. The state file holds
resource ids only -- never secrets -- and should be gitignored.

The state file is **bound to the Cloudflare account that created it** (#684): it records
`cf_account_id` at first write, and any later `up`/`down` with credentials for a different account
**dies loud** rather than silently reusing the first account's resource ids (which would skip the R2
mint and 10182 the new account's core). To stand up a second account from the same clone, use a
separate checkout, remove the state file for a fresh install, or set `DEPLOY_PREFIX` (its state file
is per-prefix).

`down` deletes by those recorded ids: the RunPod endpoints/templates (and any legacy volume), the
workers (modules + core via `wrangler delete`), the Access app, AI Gateway, the Secrets Store, and
**the minted R2 API token** (so a teardown never leaves a live credential behind). It prints a summary
of what it removed. `--delete-data` additionally deletes the R2 buckets + D1 (your render + project
data); without it, those are left intact.

`down` is **idempotent**: it removes each state entry after the resource is deleted, and treats a
delete-on-missing as already-gone (RunPod returns 404 OR 500 for a missing resource), so the documented
`down` then `down --delete-data` two-step works without dying on an already-deleted resource. Because
`wrangler delete` exits non-zero even on a successful delete, the teardown gates its WARN on whether the
worker actually vanished (checked via the CF API), so a clean teardown no longer emits false failures. (A re-run of `up` re-mutates the module wrangler.tomls with the store id during
deploy and restores the placeholder after, so your checkout stays clean on success.)

## Isolation: a second instance / a proving run (`DEPLOY_PREFIX`)

By default the installer uses the canonical resource names (`vivijure-studio`, the `vivijure` /
`skyphusion-llm` buckets, the `vivijure` Secrets Store + AI Gateway, the `vivijure-module-*` workers).
To stand up a SECOND instance on the SAME Cloudflare account -- a proving run beside a live studio, a
staging copy -- set `DEPLOY_PREFIX` (a constant at the top of `vivijure_deploy.py`, e.g. `"proving"`).
Empty (the default) is byte-for-byte the old behavior; a real outsider sees zero delta.

When set, the prefix is applied through ONE seam (`prefixed()`) to every globally-named resource: the
D1 database, BOTH R2 buckets, the Secrets Store, the AI Gateway slug, the scoped R2 S3 token, the core
worker, every module worker, and the state file (`.proving-vivijure-deploy.json`, so two instances keep
disjoint state). The minted R2 S3 token is scoped to the prefixed bucket. Module workers deploy under
`--name`; the core deploys from a transformed toml (`transform_core_toml`) that repoints its module
service bindings to the prefixed names, rebinds its D1/R2 + injects the prefixed Secrets Store id,
enables `workers_dev`, and drops the custom-domain `[[routes]]` plus the `[[vpc_services]]` /
`tail_consumers` / `[[migrations]]` blocks (an isolated instance needs no domain and does not provision
the media-stack / tail / Durable-Object targets, so binding them would dangle the deploy). A prefixed
instance verifies on its `*.workers.dev` URL.

Assumptions: the operator has already rendered `wrangler.toml` (the installer transforms that rendered
file; it does not render from the example). Workers-for-Platforms dispatch is not prefixed -- an
isolated instance runs the service-binding path (leave `[[dispatch_namespaces]]` commented).

## Safety: no silent adopt (`--adopt`)

`up` reconciles by name. To protect a shared account (e.g. a live test instance beside this one), a
pre-existing resource with the SAME name that THIS instance did not create -- its id is not recorded in
this instance's state file -- is NOT adopted silently: the run stops and names it. A legitimate re-run
(whose state already records the id) reconciles exactly as before. Pass `up --adopt` to deliberately
reuse a pre-existing resource.

## Base install is media-less (the honest degrade)

`up` stands up a WORKING studio, not the full media pipeline. The installer renders a deployable
`wrangler.toml` from `wrangler.toml.example` (it no longer needs a pre-rendered toml -- it injects the
D1 + Secrets Store ids it just created; `account_id` comes from `CLOUDFLARE_ACCOUNT_ID`, never
hardcoded). Because the media stack (the CPU containers + their Cloudflare VPC services) is **not**
provisioned by the installer yet (phase-2 is a roadmap stub), the render STRIPS the bindings whose
targets a base install does not create -- the core + 5 modules `[[vpc_services]]`, the `tail_consumer`,
the custom-domain route (it enables `workers_dev` instead), and the Durable-Object `[[migrations]]`.

The studio therefore comes up in its **documented media-less mode: clips render, but there is no final
concat / title-card step**. A degrade is never silent -- `up` prints this at completion, and it is
stated here. To get the media stack today, use the **primary `./deploy.sh` path** (top-level README /
[docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md)): as of #519 `deploy.sh` provisions the Cloudflare tunnel +
the five Workers VPC services for you via `scripts/setup-media-vpc.py`, and the media stack is
**standard** there. Media-stack provisioning is therefore `deploy.sh` + `setup-media-vpc.py`'s job;
growing that same provisioning into THIS Python installer (`bring_up_containers`) is the phase-2 roadmap
item (#657), likely a paid-plan dependency for the finish path. Until it lands, use `deploy.sh` for a
media-complete install.

## Teardown is non-interactive-capable and partial-safe

`down` takes `--noninteractive` (read creds from env, like `up`) for headless teardown. It is also
partial-safe: a worker that was never deployed (a failed/partial `up`) is skipped, never a hard abort,
so `down` always reaches the D1 / R2 / Secrets Store cleanup. A failed `up` is always teardownable.

## Roadmap

- **Done:** the CLI, input/secret handling, the full CF + RunPod provisioning spine, seed-before-deploy
  ordering, idempotent reconcile, teardown (incl. the minted R2 token), AND the first live-account
  end-to-end run (the S29 proving pass: free + paid greenfield `up`/`down`, findings fixed in v0.19.3).
- **Next:** the CPU-container bring-up + VPC wiring; RunPod endpoint tuning (scaler/idle) + optional
  boto3 model-seed.
- **Later:** an optional Cloudflare Terraform module (D1/R2/AI-Gateway/Access/Secrets-Store/routes are
  all TF-native now) sharing this same RunPod script; a Deploy-to-Cloudflare button for the CF half.
