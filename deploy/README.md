# vivijure-deploy (alternative guided installer)

> **The primary deploy path is the one-script `./deploy.sh` at the repo root** (see the top-level
> README and [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md); `deploy/constellation.sh` is the top
> orchestrator for the whole constellation). This Python installer is an **alternative** for operators
> who want interactive prompts plus a `down` teardown and want the RunPod side provisioned for them.
> It is not a competing front door: reach for it when you want the guided UX, otherwise use `deploy.sh`.

Stand up the whole Vivijure stack on **your own** Cloudflare + RunPod accounts (BYO keys + GPU). One
input surface, idempotent re-runs, a teardown path -- the guided Python installer from the design in
#244 (not full Terraform -- RunPod's IaC is too immature and the Cloudflare side needs Wrangler for
code/migrations regardless). What it adds over `deploy.sh`: it also provisions the RunPod template /
network volume / endpoints, mints the scoped R2 S3 token, creates the Cloudflare Access app, and can
tear the whole stack back down by recorded id -- steps `deploy.sh` leaves to you.

**Status: complete provisioning spine, NOT yet live-tested.** The CLI, the single input surface, the
secret handling, and every provider call (Cloudflare + RunPod) are implemented and verified against the
CF/RunPod API docs + the RunPod OpenAPI -- but the end-to-end `up` has NOT been run against a live
account. Treat the first run accordingly, and **set the required config below first**.

> `up` provisions REAL resources on your accounts -- it mints an R2 API token, creates an Access app,
> RunPod endpoints, D1, R2 buckets, etc. `down` removes what it created (see State + teardown).

## Required config before a live run

A few non-secret values must be set (constants at the top of `vivijure_deploy.py`; the run **dies loud**
if any is missing, rather than POSTing an empty value):

- `DEPLOY_DOMAIN` -- the studio hostname behind CF Access (match the core worker's route).
- `OPERATOR_EMAIL` -- the one email allowed through the Access self-only policy.
- `DATACENTER_ID` -- an available RunPod data-center id (`GET /datacenters`) for the network volumes.
- `BACKEND_IMAGE_TAG` -- an explicit released backend tag (e.g. `0.2.27`); never `latest`.
- `GPU_TYPE_IDS` -- the endpoint GPU type id(s) (`GET /gputypes`).

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
python3 deploy/vivijure_deploy.py up --noninteractive   # read creds from env (CI/headless)
python3 deploy/vivijure_deploy.py down          # teardown by recorded id (keeps your R2/D1 data)
python3 deploy/vivijure_deploy.py down --delete-data    # also delete R2 buckets + D1
```

For `--noninteractive`, export `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `RUNPOD_API_KEY`
(so a value is never typed where it could be captured) -- still never argv.

## The provisioning order (why it is the way it is)

The pieces are mutually dependent, so the order is load-bearing:

1. **Cloudflare infra** -- D1, the two R2 buckets, AI Gateway (its slug = `GATEWAY_ID`), the Access
   app; mint a scoped R2 S3 token for the GPU backend.
2. **RunPod** -- registry-auth (only if the image is private; leave it UNSET for the public GHCR
   image, or a stale auth aborts even a public pull), template (pins the image), network volume,
   endpoints. Captures `RUNPOD_ENDPOINT_ID`(s). Must precede step 3.
3. **Seed the Cloudflare Secrets Store** -- `RUNPOD_API_KEY` (yours), `RUNPOD_ENDPOINT_ID` (step 2),
   `GATEWAY_ID` (step 1), `R2_S3_*` (step 1). **This MUST happen before the deploy:** a module
   worker's `secrets_store_secrets` binding fails at `wrangler deploy` if the store secret does not
   yet exist (see #237). A re-run re-seeds rotated values before re-deploying.
4. **D1 migrations** (`wrangler d1 migrations apply` -- Terraform cannot do this).
5. **Deploy** module workers, then the core (the core binds each module as a `[[services]]`
   dependency, so modules ship first).
6. **(Phase 2, optional)** the three CPU helper containers on your own box + their CF VPC services.
   Without them the studio still renders clips; it just cannot do the final concat / title cards.

## State + idempotency

`up` is reconcile-shaped: look up each resource by name/id in `.vivijure-deploy.json`,
create-if-absent, record the id. Safe to re-run after a partial failure. The state file holds
resource ids only -- never secrets -- and should be gitignored.

`down` deletes by those recorded ids: the RunPod endpoints/volumes/templates, the workers (modules +
core via `wrangler delete`), the Access app, AI Gateway, the Secrets Store, and **the minted R2 API
token** (so a teardown never leaves a live credential behind). It prints a summary of what it removed.
`--delete-data` additionally deletes the R2 buckets + D1 (your render + project data); without it,
those are left intact. (A re-run of `up` re-mutates the module wrangler.tomls with the store id during
deploy and restores the placeholder after, so your checkout stays clean on success.)

## Roadmap

- **Done:** the CLI, input/secret handling, the full CF + RunPod provisioning spine, seed-before-deploy
  ordering, idempotent reconcile, and teardown (incl. the minted R2 token).
- **Next:** a first live-account end-to-end run to shake out anything the docs did not capture; the
  CPU-container bring-up + VPC wiring; RunPod endpoint tuning (scaler/idle) + optional boto3 model-seed.
- **Later:** an optional Cloudflare Terraform module (D1/R2/AI-Gateway/Access/Secrets-Store/routes are
  all TF-native now) sharing this same RunPod script; a Deploy-to-Cloudflare button for the CF half.
