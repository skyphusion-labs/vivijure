# Production Deploy Runbook -- vivijure-studio (feature-complete cut)

Owner: Strummer (infra), and the deploy executor on Conrad's go (post-QA). This document is a
checklist, not an automation; nothing here deploys until a human runs it. Cut target: **v0.3.0**
(current `main` is `0.2.6`; this cut adds the cloud-keyframe, alibaba-wan-lora, subtitle, AND
audio-master (master hook) modules, so it is a MINOR bump, see section 3).

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
  This is the `plan-enhance-py` pattern: keep the core binding commented out until the module worker
  is live, then uncomment it in the SAME change.
- **The 3 CPU containers are NOT deployed by `wrangler`.** `video-finish`, `image-prep`, and
  `audio-beat-sync` run always-on on the fleet (dischord) as Docker services via
  `containers/compose.yaml`, reached over Workers VPC bindings (`VIDEO_FINISH_VPC` etc.). They are
  deployed OUT OF BAND. **This cut changes `video-finish` (new `/subtitle` route), so the container
  must be rebuilt + redeployed on the fleet BEFORE the subtitle module goes live** (see section 1.0
  and section 4).
- **Fresh-create workers start with NO secrets.** `wrangler deploy` preserves secrets on an EXISTING
  worker, but a brand-new module worker (cloud-keyframe, alibaba-wan-lora) is created empty. Its
  secrets must be seeded once, by hand, AFTER its first deploy and BEFORE it is relied on. (The
  durable fix for this -- Secrets Store bindings, PR #237 -- is not merged yet, so for this cut we
  seed secrets imperatively.)

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
container. Rebuild + redeploy `video-finish` on dischord before the subtitle module is live:

```bash
# on the fleet host (dischord), from the repo checkout used for the always-on services:
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

### 1.4 speech-upscale -> `MODULE_SPEECH_UPSCALE`  (PLACEHOLDER -- lands via Mackaye's speech cherry-pick)

NOT on `main` at the time of writing. Once Mackaye's speech cherry-pick lands `modules/speech-upscale/`
(verify the exact dir + service name then), the pattern is identical to alibaba-wan-lora:

```bash
npx wrangler deploy -c modules/speech-upscale/wrangler.toml         # VERIFY path after cherry-pick
npx wrangler secret put RUNPOD_API_KEY -c modules/speech-upscale/wrangler.toml
```

Core binding (confirm exact name against the merged module before use):

```toml
[[services]]
binding = "MODULE_SPEECH_UPSCALE"
service = "vivijure-module-speech-upscale"
```

UNKNOWN to confirm before cutting: module dir name, service name, whether it also needs
`RUNPOD_ENDPOINT_ID`, and whether it relies on a CPU container (and thus a fleet redeploy like 1.0).

### 1.5 audio-master (the `master` hook module) -> IN the cut  (details fold in when Rollins delivers)

IN the v0.3.0 cut (Conrad's feature-complete target = with master). Rollins is building the
`audio-master` worker (RunPod CPU bridge: soxr + loudnorm) plus its CPU container handler (crew tasks
#18/#19/#20). The QA contract walk runs after master merges and before we tag, so master will be merged
+ green before the tag; we fold its real binding/secret/container details into this section the moment
Rollins delivers. Expected shape (CONFIRM each against the merged module):

```bash
npx wrangler deploy -c modules/audio-master/wrangler.toml          # name TBD -- VERIFY
npx wrangler secret put RUNPOD_API_KEY -c modules/audio-master/wrangler.toml   # likely; CONFIRM
```

Core binding (name TBD -- CONFIRM against the merged module; ADD/uncomment in the section-2 commit):

```toml
[[services]]
binding = "MODULE_AUDIO_MASTER"          # TBD -- confirm
service = "vivijure-module-audio-master" # TBD -- confirm
```

TO CONFIRM when Rollins delivers: binding/service name, secret set, and whether it ships a NEW CPU
container. The `master` phase runs after assemble, before mux (orchestrator tasks #16/#17 merged), so a
missing/dangling master binding breaks the core deploy exactly like any other module -- it must be
deployed before core, same as 1.1-1.3.

**Conditional -- IF audio-master ships a NEW CPU container** (the container-vs-worker split in section 0
applies; a container is NOT a `wrangler` deploy): it needs its own out-of-band fleet build, just like
video-finish in section 1.0, plus a `[[vpc_services]]` binding in the core `wrangler.toml` (a NEW
`service_id`, mirrored as a `Fetcher` in `src/env.ts` -- VPC bindings are explicit, NOT covered by the
`MODULE_${string}` index signature). At deploy time (Strummer, on Conrad's go):

```bash
# on the fleet host (dischord), prerequisite BEFORE the audio-master module worker is relied on:
docker compose -f containers/compose.yaml build audio-master    # service name TBD -- VERIFY
docker compose -f containers/compose.yaml up -d audio-master
curl -fsS http://<audio-master-host>:<port>/health
```

Add the corresponding `[[vpc_services]]` block to core `wrangler.toml` and its `Fetcher` field to
`src/env.ts` in the section-2 release-prep commit (alongside the service binding). If audio-master is
worker-only (no container), skip this conditional block entirely.

---

## 2. Binding uncomments + CI loop (one change with the core redeploy)

All of the following land in a SINGLE release-prep commit on `main` (the same change that the tag will
build). This keeps every binding pointing at an already-deployed module.

1. `wrangler.toml` (core):
   - ADD `[[services]] MODULE_CLOUD_KEYFRAME -> vivijure-module-cloud-keyframe` (1.1)
   - UNCOMMENT `[[services]] MODULE_ALIBABA_WAN_LORA -> vivijure-module-alibaba-wan-lora` (1.2)
   - ADD `[[services]] MODULE_SUBTITLE -> vivijure-module-subtitle` (1.3)
   - ADD `[[services]] MODULE_AUDIO_MASTER -> vivijure-module-audio-master` (1.5, name TBD -- confirm
     when Rollins delivers; IF it ships a container, ALSO add its `[[vpc_services]]` block, see 1.5)
   - (speech-upscale only if its cherry-pick has landed -- otherwise leave out)
2. `src/env.ts` (hand-authored `Env`): **no edit needed for the module bindings.** `Env` uses the
   generic template-literal index signature `[key: \`MODULE_${string}\`]: Fetcher | undefined;`
   (confirmed line 71 on `main`, per Joan's audio-stack assessment), so every `MODULE_*` binding
   auto-discovers with no per-binding field. EXCEPTION: a NEW `[[vpc_services]]` binding (e.g. an
   audio-master CONTAINER, see 1.5) is NOT covered by that index signature and MUST be added as an
   explicit `Fetcher` field in `Env`, or `npm run typecheck` (the CI gate) fails.
3. `.github/workflows/ci.yml` deploy loop: add the new module dir names so future tag deploys keep
   them live. Current loop:
   ```
   for module in own-gpu finish-rife finish-upscale finish-lipsync keyframe seedance kling \
     minimax-hailuo google-veo vidu-q3 alibaba-wan text-overlay film-titles dialogue-gen; do
   ```
   Add: `cloud-keyframe alibaba-wan-lora subtitle audio-master` (audio-master dir name TBD -- confirm;
   add `speech-upscale` only if it is in the cut). Order within the loop does not matter (all modules
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
2. **VPC video-finish up on the fleet, new routes reachable.** It is VPC-live on the fleet (NOT a CF
   Container). From a path that can reach the fleet (mesh `*.internal` or the VPC):
   ```bash
   curl -fsS http://<video-finish-host>:<port>/health
   ```
   Then exercise the routes through a real render: `/overlay` (text-overlay), `/film-titles`
   (film-titles), and the NEW `/subtitle` (subtitle module). The cleanest check is a short
   talking-shot render with subtitles enabled -- assert the structured `film_finish` channel reports
   `applied` includes the subtitle step (NOT a silent degrade to raw clips).
3. **New module workers healthy.** Confirm each is live and discovered (add `audio-master` once its
   service name is confirmed):
   ```bash
   for m in cloud-keyframe alibaba-wan-lora subtitle audio-master; do   # audio-master name TBD
     npx wrangler deployments list --name vivijure-module-$m | head -3
   done
   curl -fsS https://vivijure.skyphusion.org/api/modules | \
     grep -oE 'cloud-keyframe|alibaba-wan-lora|subtitle|audio-master'   # all should appear
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

- **audio-master (master hook) -- IN the cut, details to fold in:** binding name, service name, secret
  set, and whether it ships a NEW CPU container all TBD (Rollins, tasks #18/#19/#20). It is part of the
  feature-complete v0.3.0 (merged + QA-green before the tag); we fold its real values into 1.5 / 2 the
  moment Rollins delivers. If it brings a container, it needs an out-of-band fleet build + a
  `[[vpc_services]]` binding + an explicit `Env` `Fetcher` field, not a `wrangler` deploy. (Fallback if
  it slips: the incremental v0.3.0-then-v0.3.1 split in section 3.)
- **speech-upscale:** confirm dir/service name, secret set (RUNPOD_API_KEY assumed), and container
  dependency after Mackaye's speech cherry-pick lands. Only in the cut if landed by go time.
- **src/env.ts mirroring -- RESOLVED:** `Env` uses the generic `[key: \`MODULE_${string}\`]: Fetcher`
  index signature (line 71 on `main`), so `MODULE_*` bindings need NO `Env` edit. Only a NEW
  `[[vpc_services]]` binding (an audio-master container) needs an explicit `Fetcher` field.
- **Secrets durability:** until PR #237 (Secrets Store bindings) merges, module secrets are
  imperative; a fresh-create or wipe loses them. For this cut, seed-by-hand-then-verify is the
  control. Do not wipe/recreate a module worker without re-seeding its secret.
- **Deploy executor:** Strummer runs the out-of-band fleet container rebuild(s) and the tag at deploy
  time, on Conrad's go, after QA passes.
