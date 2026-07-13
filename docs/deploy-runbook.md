# Production Deploy Runbook -- vivijure-studio (feature-complete cut)

Owner: Strummer (infra), and the deploy executor on Conrad's go (post-QA). This document is a
checklist, not an automation; nothing here deploys until a human runs it. Cut target: **v0.3.0**
(current `main` is `0.2.6`; this cut adds the cloud-keyframe, alibaba-wan-lora, subtitle, AND
audio-master (master hook) modules, so it is a MINOR bump, see section 3).

> **Status (post-deploy reconciliation):** this cut SHIPPED. v0.3.0 went live with all five new modules
> (cloud-keyframe, alibaba-wan-lora, subtitle, speech-upscale, audio-master); the follow-ups v0.3.1
> (keyframe backend selectable), v0.3.2 (`tail_consumers` -> `vivijure-tail` observability), and v0.3.3
> (cloud i2v duration fixes) are also live. The sections below have been reconciled to that shipped
> reality (module names, audio-master = CPU VPC container not RunPod, speech-upscale shipped).

> **Historical runbook (the 2026-06 v0.3.0 cut) -- read with today's map.** The deploy-ordering
> rules here (modules before core, tag-gated CI, rollback) still hold, and this stays the reference
> for them. Since it was written: module secrets moved to declarative Secrets Store bindings (#237
> shipped -- the imperative `wrangler secret put` seeding below is the old way), the CI deploy job
> iterates EVERY modules/*/wrangler.toml with an explicit reviewed skip-list (no hardcoded loop to
> maintain), the studio gained a built-in token login (#423; Cloudflare Access is optional
> hardening now), and Phase 3 WfP dispatch SHIPPED (v0.8.0, 2026-07-01). Standing up a NEW studio?
> Use `./deploy.sh` + [DEPLOYMENT.md](DEPLOYMENT.md), not this document.

Scope decision: this is ONE feature-complete v0.3.0 cut WITH master. The QA contract walk runs after
master merges and before we tag, so master is merged + green before the tag. The out-of-band fleet
container rebuild(s) (video-finish, and audio-master if it ships a container) are Strummer's to run at
deploy time with Conrad's go.

Style: no em-dashes or en-dashes (double hyphen `--` only).

---

## 0. Context you must hold before touching anything

- **Deploy is tag-gated.** `.github/workflows/ci.yml` deploys ONLY on a pushed `v*` tag, after `ci`
  (typecheck + test) passes. A bare push/merge to `main` runs the gate but NEVER deploys. So merging
  the release-prep change to `main` is safe; the deploy happens only when you push the tag.
- **Deploy ordering is the whole game.** The CI `deploy` job runs, in order:
  1. deploy every module worker in the loop list,
  2. apply D1 migrations (`wrangler d1 migrations apply vivijure-studio --remote`),
  3. deploy the core worker (`npm run deploy`).
  The core binds each module as a `[[services]]` dependency. **A `[[services]]` binding pointing at a
  worker that does not exist makes the core `wrangler deploy` FAIL.** Typecheck/test does NOT catch a
  dangling binding; only a real deploy does. Modules therefore MUST exist before the core deploys.
  This is the commented-binding pattern: keep the core binding commented out until the module worker is live, then uncomment it
  in the SAME change.
- **The 3 CPU containers are NOT deployed by `wrangler`.** `video-finish`, `image-prep`, and
  `audio-beat-sync` run always-on on the operator's container host as Docker services via
  `containers/compose.yaml`, reached over Workers VPC bindings (`VIDEO_FINISH_VPC` etc.). They are
  deployed OUT OF BAND. **This cut changes `video-finish` (new `/subtitle` route), so the container
  must be rebuilt + redeployed on the fleet BEFORE the subtitle module goes live** (see section 1.0
  and section 4).
- **Fresh-create workers start with NO secrets.** `wrangler deploy` preserves secrets on an EXISTING
  worker, but a brand-new module worker (cloud-keyframe, alibaba-wan-lora) is created empty. Its
  secrets must be seeded once, by hand, AFTER its first deploy and BEFORE it is relied on. (The
  durable fix for this -- Secrets Store bindings, PR #237 -- shipped AFTER this cut; module secrets
  are declarative store bindings today, and this imperative seeding is the historical mitigation.)

Pre-flight identity / account:
- `CLOUDFLARE_ACCOUNT_ID` is injected (never hardcoded); CI uses the `CLOUDFLARE_ACCOUNT_ID` +
  `CLOUDFLARE_API_TOKEN` repo secrets. For the manual pre-deploy steps below, export the same two in
  your shell (or rely on your `.dev.vars` / wrangler login) from a trusted box.
- Production domain: `vivijure.skyphusion.org` (custom_domain route on the core).

---

## 1. Deploy ordering -- modules before core

For each NEW module: deploy the worker first, seed its secret(s), then add/uncomment its core
binding and add it to the CI loop in the SAME release change. Do these in the order listed.

### 1.0 PREREQUISITE -- redeploy the video-finish container on the fleet (subtitle depends on it)

The subtitle module forwards its SRT spec to the `video-finish` container over `VIDEO_FINISH_VPC`,
hitting the new `POST /subtitle` route. That route does not exist on the currently-running fleet
container. Rebuild + redeploy `video-finish` on your container host before the subtitle module is live:

```bash
# on your container host, from the repo checkout used for the always-on services:
docker compose -f containers/compose.yaml build video-finish
docker compose -f containers/compose.yaml up -d video-finish
# confirm the new route is up:
curl -fsS http://<video-finish-host>:<port>/health        # liveness
# /subtitle is a POST; reachability is verified via the VPC smoke in section 4.
```

No `service_id` change: `VIDEO_FINISH_VPC` stays `019ecbe6-9fc1-70a0-9946-14bbec0f51bc`. This is a
container content update only, so the core/module VPC bindings are unaffected.

### 1.1 cloud-keyframe -> `MODULE_CLOUD_KEYFRAME`  (NEW binding, add fresh)

Service: `vivijure-module-cloud-keyframe`. GPUless reference-conditioned keyframe (FLUX-2 direct;
nano-banana-pro via AI Gateway).

```bash
# 1) deploy the module worker (creates it):
npx wrangler deploy -c modules/cloud-keyframe/wrangler.toml

# 2) secret: GATEWAY_ID -- ONLY needed if the nano-banana-pro PROXIED model will be selected.
#    FLUX-2 runs direct on the AI binding and needs no secret. Seed only if enabling the proxied path:
npx wrangler secret put GATEWAY_ID -c modules/cloud-keyframe/wrangler.toml   # AI Gateway slug
```

Core binding to ADD to `wrangler.toml` (no block exists yet; place it beside the other keyframe/cloud
modules; note it is SEPARATE from the existing GPU `MODULE_KEYFRAME`):

```toml
[[services]]
binding = "MODULE_CLOUD_KEYFRAME"
service = "vivijure-module-cloud-keyframe"
```

### 1.2 alibaba-wan-lora -> `MODULE_ALIBABA_WAN_LORA`  (binding already present, COMMENTED -- uncomment)

Service: `vivijure-module-alibaba-wan-lora`. Wan 2.2 i2v 720p on the RunPod public managed endpoint
with custom operator LoRAs.

```bash
# 1) deploy the module worker (creates it):
npx wrangler deploy -c modules/alibaba-wan-lora/wrangler.toml

# 2) secret: per-module scoped RunPod key:
npx wrangler secret put RUNPOD_API_KEY -c modules/alibaba-wan-lora/wrangler.toml
```

Core binding: UNCOMMENT the existing block in `wrangler.toml` (the 3 lines currently prefixed `# `):

```toml
[[services]]
binding = "MODULE_ALIBABA_WAN_LORA"
service = "vivijure-module-alibaba-wan-lora"
```

### 1.3 subtitle -> `MODULE_SUBTITLE`  (NEW binding, add fresh; no secret)

Service: `vivijure-module-subtitle`. `film.finish` hook; burns a time-synced SRT via the video-finish
container. No R2 binding, no S3 secret -- it only formats the SRT and forwards the spec over VPC.

```bash
# 1) deploy the module worker (creates it). REQUIRES section 1.0 done first (container /subtitle route):
npx wrangler deploy -c modules/subtitle/wrangler.toml
# no secret to seed.
```

Core binding to ADD to `wrangler.toml` (no block exists yet; it already carries `VIDEO_FINISH_VPC` in
its own `modules/subtitle/wrangler.toml`, same `service_id` as the core):

```toml
[[services]]
binding = "MODULE_SUBTITLE"
service = "vivijure-module-subtitle"
```

### 1.4 speech-upscale -> `MODULE_SPEECH_UPSCALE`  (shipped in v0.3.0)

Shipped on `main` as `modules/speech-upscale/` (service `vivijure-module-speech-upscale`). It is a
RunPod module -- the dedicated `vivijure-audio-upscale` CUDA endpoint, NOT a CPU container -- so the
deploy pattern matches alibaba-wan-lora; since #238 its two RunPod secrets are Secrets-Store-bound (not per-module wrangler secret put):

```bash
npx wrangler deploy -c modules/speech-upscale/wrangler.toml
# RUNPOD_API_KEY (shared) + RUNPOD_ENDPOINT_ID (store secret AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID = the
# vivijure-audio-upscale endpoint) are seeded ONCE in the account Secrets Store, not per-module
# `wrangler secret put`; deploy.sh (full profile) seeds them. See docs/DEPLOYMENT.md.
```

Core binding:

```toml
[[services]]
binding = "MODULE_SPEECH_UPSCALE"
service = "vivijure-module-speech-upscale"
```

### 1.5 audio-master (the `master` hook module) -> shipped in v0.3.0

Shipped as `modules/audio-master/` (service `vivijure-module-audio-master`, core binding
`MODULE_AUDIO_MASTER`). It masters the assembled audio bed (music upscale: soxr 48k + air lift; LUFS
loudness) on the always-on `audio-master` CPU container on the fleet over Workers VPC -- pure CPU
ffmpeg, NEVER RunPod/GPU (GPU money is for GPU work only). The module worker is CREDENTIALLESS: it
holds no R2 creds and no RunPod key, so there are NO secrets to set -- the core presigns the R2 URLs
and the worker reaches the container over the `AUDIO_MASTER_VPC` binding. (NOTE, post-ship: the audio
bed / master VPC binding shipped as `AUDIO_MIX_VPC` in the current `wrangler.toml`; this historical
runbook keeps the older working name `AUDIO_MASTER_VPC` throughout -- read the two as the same binding.)

Deploy the module worker (no secrets):

```bash
npx wrangler deploy -c modules/audio-master/wrangler.toml
```

Core binding (ADD in the section-2 commit):

```toml
[[services]]
binding = "MODULE_AUDIO_MASTER"
service = "vivijure-module-audio-master"
```

The `master` phase runs after assemble, before mux (orchestrator tasks #16/#17), so a missing/dangling
master binding breaks the core deploy exactly like any other module -- deploy the module worker before
core, same as 1.1-1.3.

**Container (REQUIRED -- audio-master ships a CPU container).** The worker reaches the always-on
`audio-master` container (`containers/audio-master/`, slim ffmpeg) through a `[[vpc_services]]`
`AUDIO_MASTER_VPC` block in the core `wrangler.toml` (its own `service_id`, mirrored as a `Fetcher` in
`src/env.ts` -- VPC bindings are explicit, NOT covered by the `MODULE_${string}` index signature). The
container is NOT a `wrangler` deploy; it needs its own out-of-band fleet build, like video-finish in
section 1.0. At deploy time (Strummer, on Conrad's go):

```bash
# on your container host, BEFORE the audio-master module worker is relied on:
docker compose -f containers/compose.yaml build audio-master
docker compose -f containers/compose.yaml up -d audio-master
curl -fsS http://<audio-master-host>:<port>/health
```

Add the `[[vpc_services]]` `AUDIO_MASTER_VPC` block to core `wrangler.toml` and its `Fetcher` field to
`src/env.ts` in the section-2 release-prep commit (alongside the service binding).

---

## 2. Binding uncomments + CI loop (one change with the core redeploy)

All of the following land in a SINGLE release-prep commit on `main` (the same change that the tag will
build). This keeps every binding pointing at an already-deployed module.

1. `wrangler.toml` (core):
   - ADD `[[services]] MODULE_CLOUD_KEYFRAME -> vivijure-module-cloud-keyframe` (1.1)
   - UNCOMMENT `[[services]] MODULE_ALIBABA_WAN_LORA -> vivijure-module-alibaba-wan-lora` (1.2)
   - ADD `[[services]] MODULE_SUBTITLE -> vivijure-module-subtitle` (1.3)
   - ADD `[[services]] MODULE_AUDIO_MASTER -> vivijure-module-audio-master` (1.5; audio-master DOES
     ship a CPU container, so ALSO add its `[[vpc_services]]` `AUDIO_MASTER_VPC` block, see 1.5)
   - ADD `[[services]] MODULE_SPEECH_UPSCALE -> vivijure-module-speech-upscale` (1.4)
2. `src/env.ts` (hand-authored `Env`): **no edit needed for the module bindings.** `Env` uses the
   generic template-literal index signature `[key: \`MODULE_${string}\`]: Fetcher | undefined;`
   (confirmed line 71 on `main`, per Joan's audio-stack assessment), so every `MODULE_*` binding
   auto-discovers with no per-binding field. EXCEPTION: a NEW `[[vpc_services]]` binding (e.g. an
   audio-master CONTAINER's `AUDIO_MASTER_VPC`, see 1.5) is NOT covered by that index signature and
   MUST be added as an explicit `Fetcher` field in `Env`, or `npm run typecheck` (the CI gate) fails.
3. `.github/workflows/ci.yml` deploy loop: add the new module dir names so future tag deploys keep
   them live. The loop at the time (ci.yml has SINCE moved to deploy-by-default -- it iterates every
   `modules/*/wrangler.toml` with an explicit reviewed skip-list, so this maintenance step no longer
   exists):
   ```
   for module in own-gpu finish-rife finish-upscale finish-lipsync keyframe seedance kling \
     minimax-hailuo google-veo vidu-q3 alibaba-wan film-titles dialogue-gen; do
   ```
   Add: `cloud-keyframe alibaba-wan-lora subtitle speech-upscale audio-master`. Order within the loop does not matter (all modules
   deploy before the core); only modules-before-core matters, which the job already guarantees.

Note: the manual `wrangler deploy` of each new module in section 1 is what makes the FIRST tag deploy
safe (the workers already exist + carry secrets). Adding them to the CI loop makes EVERY subsequent
tag deploy re-ship them so they never drift. Both steps are needed for a new module.

---

## 3. The tag (release mechanism + version)

Mechanism (verified against `.github/workflows/ci.yml`): pushing a `v*` tag triggers `ci`, then the
gated `deploy` job (modules -> D1 migrations -> core). Nothing else deploys prod.

Version: current `main` `package.json` is `0.2.6`. This cut adds new user-facing capabilities (cloud
keyframe, LoRA cloud i2v, subtitles), so per SemVer (pre-1.0 `0.MINOR.PATCH`) it is a **MINOR** bump:

**Recommended: `v0.3.0`.** Bump `package.json` `version` to `0.3.0` (and `CHANGELOG.md` if the repo
keeps one) in the release-prep commit, then:

```bash
# after the release-prep change is merged to main and CI is green on main:
git checkout main && git pull
git tag v0.3.0
git push origin v0.3.0
# watch the Actions run: ci -> deploy (module loop -> d1 migrate -> core)
```

Do NOT tag until: sections 1 + 2 are done (INCLUDING master, 1.5), the QA contract walk has passed on
the merged `main`, `npm run typecheck` and `npm test` are green locally and on `main`, and the
video-finish container redeploy (1.0) -- plus any audio-master container (1.5) -- is confirmed up.

### Fallback -- incremental cut if master slips

The plan above is one feature-complete v0.3.0 with master. IF master (1.5) slips QA or is not green by
the cut window, the lower-risk fallback is to ship WITHOUT it and add it next:

- `v0.3.0` = cloud-keyframe + alibaba-wan-lora + subtitle only (drop the master binding + loop entry +
  any audio-master container step from sections 1.5 / 2).
- `v0.3.1` = master alone, once merged + green: deploy its module worker (+ container if any), add its
  binding + loop entry (and `[[vpc_services]]` + `Env` field if it has a container), then tag.

Each tag is an independent, fully-ordered deploy, so splitting is safe. Default to the single v0.3.0
cut; use this split only if master is not ready at go time.

---

## 4. Verify (post-deploy smoke)

1. **CI deploy job green.** Actions run for the tag shows module loop + `d1 migrations apply` + core
   deploy all succeeded. A core failure here is almost always a dangling binding (a module that did
   not deploy or a name typo) -- cross-check section 1/2.
2. **VPC video-finish up on your container host, new routes reachable.** It is VPC-live on your container host (NOT a CF
   Container). From a path that can reach it (over your private network or the VPC):
   ```bash
   curl -fsS http://<video-finish-host>:<port>/health
   ```
   Then exercise the routes through a real render: `/film-titles`
   (film-titles) and the NEW `/subtitle` (subtitle module). The cleanest check is a short
   talking-shot render with subtitles enabled -- assert the structured `film_finish` channel reports
   `applied` includes the subtitle step (NOT a silent degrade to raw clips).
3. **New module workers healthy.** Confirm each is live and discovered:
   ```bash
   for m in cloud-keyframe alibaba-wan-lora subtitle speech-upscale audio-master; do
     npx wrangler deployments list --name vivijure-module-$m | head -3
   done
   curl -fsS https://vivijure.skyphusion.org/api/modules | \
     grep -oE 'cloud-keyframe|alibaba-wan-lora|subtitle|speech-upscale|audio-master'   # all should appear
   ```
   If audio-master ships a container, also `curl -fsS http://<audio-master-host>:<port>/health` on the
   fleet, same as video-finish (2).
   The frontend is a projection of `/api/modules`, so a module showing there is wired end-to-end.
4. **Smoke render.** Kick one short end-to-end render that exercises the new lanes (cloud keyframe ->
   alibaba-wan-lora i2v -> master phase (audio-master, after assemble before mux) -> finish chain with
   subtitle) and assert on the structured `@event` / `film_finish` channel, not on prose. Confirm
   `degraded` is false and `applied` lists the expected steps (including master + subtitle). This is
   the same path the QA contract walk covers; the smoke render is the post-deploy re-confirmation.

---

## 5. Rollback

The deploy is a worker version push + (additive) D1 migrations. Roll back the worker first; the D1
migrations are additive (the CI comment guarantees additive-only; a destructive one is manually
gated), so old code runs safely against the newer schema.

1. **Fast path -- roll back the core worker to the previous version** (no code change, seconds):
   ```bash
   npx wrangler deployments list --name vivijure-studio          # find the prior good version id
   npx wrangler rollback --name vivijure-studio [<version-id>]   # revert core to it
   ```
   Roll back any individual misbehaving module the same way (`--name vivijure-module-<m>`). Because the
   core's `[[services]]` bindings only require the module worker to EXIST, rolling a module back to a
   prior version does not dangle the binding.
2. **Clean path -- revert the release in git + re-tag a patch.** Revert the release-prep commit (or
   `git revert` the binding/loop change), which re-comments the new bindings, then cut a `v0.3.1` tag.
   CI redeploys the prior topology. Use this if the rollback needs to persist across future deploys.
3. **A new module is the problem.** Re-comment its `[[services]]` block in `wrangler.toml` and remove
   it from the CI loop, commit, and redeploy the core (or `wrangler rollback` core to the pre-cut
   version). The undeployed/unbound module is simply not discovered by the registry -- correct, it is
   not live. Leaving the module WORKER deployed is harmless; only the core binding gates discovery.
4. **D1.** Do not "roll back" a migration in place. If a migration is the problem, fix forward with a
   new additive migration. (This cut should be additive-only; confirm `migrations/` has no destructive
   step before tagging.)
5. **Container (video-finish).** If the container redeploy (1.0) is the regression, redeploy the prior
   image on the fleet: `docker compose -f containers/compose.yaml up -d video-finish` from the prior
   checkout/tag. The VPC `service_id` is unchanged, so no worker change is needed to revert it.

---

## Unknowns / open items (resolve before "go")

- **audio-master (master hook) -- RESOLVED, shipped in v0.3.0:** service `vivijure-module-audio-master`,
  core binding `MODULE_AUDIO_MASTER`, NO secrets (credentialless). It ships a CPU container
  (`containers/audio-master/`) reached over the `AUDIO_MASTER_VPC` `[[vpc_services]]` binding + an
  explicit `Env` `Fetcher` field -- a pure CPU VPC container, NEVER RunPod/GPU (the GPU-money tenet).
  The container needs an out-of-band fleet build, not a `wrangler` deploy. See 1.5 / 2 for the real values.
- **speech-upscale -- RESOLVED, shipped in v0.3.0:** service `vivijure-module-speech-upscale`, a RunPod
  module (the `vivijure-audio-upscale` CUDA endpoint, no container). Secrets: `RUNPOD_API_KEY` +
  `RUNPOD_ENDPOINT_ID`. See 1.4.
- **src/env.ts mirroring -- RESOLVED:** `Env` uses the generic `[key: \`MODULE_${string}\`]: Fetcher`
  index signature (line 71 on `main`), so `MODULE_*` bindings need NO `Env` edit. Only a NEW
  `[[vpc_services]]` binding (an audio-master container) needs an explicit `Fetcher` field.
- **Secrets durability -- RESOLVED since:** PR #237 (Secrets Store bindings) shipped after this
  cut; module secrets are declarative store bindings now, re-established by every deploy.
  Seed-by-hand-then-verify was this cut's mitigation, kept here for the record.
- **Deploy executor:** Strummer runs the out-of-band fleet container rebuild(s) and the tag at deploy
  time, on Conrad's go, after QA passes.

---

## Phase 3 (Workers for Platforms): create the dispatch namespace  (SHIPPED 2026-07-01 as v0.8.0)

> Forward-looking prerequisite for the dynamic-dispatch work in `docs/module-dispatch.md` (sections 2.2
> / 3.1). HISTORY: this shipped 2026-07-01 (v0.8.0, #391-#395) on Conrad's go -- the `vivijure-modules`
> namespace exists in prod and `MODULE_DISPATCH` binds behind the `ENABLE_WFP_DISPATCH` CI variable.
> The section is kept for the ordering rationale, and for a self-hoster who opts into WfP on their
> own account (it remains opt-in and paid; a standard self-host never needs it).

**WfP is OPT-IN, never required to run vivijure.** Dispatch is an OPERATOR CONVENIENCE (install a module
WITHOUT a core redeploy), not a dependency. Workers for Platforms is a PAID Cloudflare add-on, so the
`[[dispatch_namespaces]]` block ships **commented out** in `wrangler.toml.example`: a standard self-host
on the free/standard Workers plan binds modules as `[[services]]` and everything works with ZERO WfP
dependency (the core dispatch layer is runtime-gated on `MODULE_DISPATCH` being bound, so absent it the
behavior is identical). This whole section applies ONLY to an operator who deliberately opts into WfP.

**Why it is a deploy-ordering item.** The `[[dispatch_namespaces]]` binding in `wrangler.toml.example`
(`binding = "MODULE_DISPATCH"`, `namespace = "vivijure-modules"`, shipped commented) is subject to the
SAME existence rule as a `[[services]]` target: once UNCOMMENTED, the namespace must EXIST before the
core that binds it deploys, or `wrangler deploy` of the core FAILS. That is exactly why it ships
commented -- an active binding on an account without WfP breaks the deploy. `npm run typecheck` does NOT
catch a dangling dispatch binding -- only a real deploy does. So the namespace is created ONCE, out of
band, ahead of the first core deploy that carries the (uncommented) binding. After that, modules come and
go INSIDE the namespace with no core redeploy.

**Ordering (once, when Phase 3 ships, on Conrad's go):**

1. Create the `vivijure-modules` dispatch namespace (command below).
2. Verify it exists (`... list` / `... get`).
3. THEN deploy the core with the `MODULE_DISPATCH` binding uncommented in `wrangler.toml`.

Reverse that order and the core deploy trips on a namespace that is not there yet.

### Create the namespace (preferred -- wrangler)

Verified against the repo-pinned wrangler (`4.102.0`): the subcommand is
`wrangler dispatch-namespace create <name>`.

```bash
# from the repo root, authenticated as the deploy identity (CLOUDFLARE_ACCOUNT_ID +
# CLOUDFLARE_API_TOKEN with Workers Scripts:Edit / Workers-for-Platforms permission):
npx wrangler dispatch-namespace create vivijure-modules

# verify:
npx wrangler dispatch-namespace list
npx wrangler dispatch-namespace get vivijure-modules
```

Creating a namespace is idempotent-safe to VERIFY but not to blindly re-run: if it already exists the
create errors. Check `list`/`get` first.

### Create the namespace (fallback -- CF API, if the CLI is unavailable)

The REST create is a POST (not a PUT) to the dispatch-namespaces collection. `account_id` is never
hardcoded -- it comes from `$CLOUDFLARE_ACCOUNT_ID`; the token is the privileged Workers-scoped token,
read from its file, NEVER echoed:

```bash
curl -fsS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data {"name":"vivijure-modules"}

# verify:
curl -fsS \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/vivijure-modules" \
  -H "Authorization: Bearer ${CF_API_TOKEN}"
```

(Wrap the JSON body in single quotes when you actually run it; it is shown unquoted here only to keep
this doc free of nested-quote noise.)

### Do NOT, as part of the v0.3.0 cut (historical gate; Phase 3 has since shipped on Conrad's go)

- Do NOT create the namespace.
- Do NOT uncomment / ship the `MODULE_DISPATCH` binding in a real `wrangler.toml`.
- Do NOT run `wrangler deploy` of the core with the binding present.
- Do NOT run migration `0006_installed_modules.sql` against remote/prod D1.

All of the above are the Phase 3 go, on Conrad's explicit word, sequenced as above.
