# Changelog

Notable changes per release. SemVer-style (pre-1.0: PATCH for fixes / backend-only tweaks, MINOR
for new features). Newest first.

## v0.16.3

**The lipsync degrade reason survives the new backend envelope (#569), and tag deploys stop
tripping on their own guard (#568).** PATCH. musetalk v0.1.2/v0.1.3 (satellite #24: the full
faceless taxonomy -- import-path regression, false-positive bboxes, zero-detection crashes) returns
soft-degrades as `{ok:false, detail}`; finish-lipsync (0.1.3) now records that detail, with `error`
kept as the legacy fallback. CI placeholder guards are comment-aware and use fixed-string grep (the
regex form silently matched nothing on GNU grep).

## v0.16.2

**Voiced films on faceless shots stop hard-failing at lip-sync (#565).** PATCH. RunPod lifts the
musetalk handler's soft-degrade return ({ok:false, error}) into a job-level FAILED envelope, so the
finish-lipsync passthrough branch was unreachable: a legitimate no-face shot failed the whole film
after full keyframe + i2v spend. The module now recognizes the handler's structured ok:false inside
a FAILED envelope (a genuine crash leaves none) and passes the original clip through, recorded as
passthrough:backend-soft-degrade per #77; a real crash still fails loud. Module 0.1.2; first
dedicated finish-lipsync test file. Satellite envelope + early no-face exit tracked in
vivijure-musetalk#24.

## v0.16.1

**The Studio MCP driver ships, and API dialogue actually reaches the film (#563).** PATCH
(retro-added entry; tagged 2026-07-06). `src/mcp.ts` exposes the studio as MCP tools
(projects / cast / storyboard / bundle / preflight / submit + poll film). startFilmJob now remaps
`dialogue_lines` shot ids through the same positional coercion as the scenes (#564), so an API
caller with its own id scheme (s1/s2: Slate, the Studio MCP) no longer ships a silent, uncaptioned
film after paying for TTS.

## v0.16.0

**The studio stops trusting its clips: output validation lands at both layers (#523).** MINOR.
A render engine that returns a structurally broken file, or a "valid" mp4 full of pure noise, is
now caught at the gate instead of being polished and shipped. Layer 1 rejects broken files at
motion-clip intake; Layer 2 rejects garbage pixels at the film finish boundary; both fail the shot
BEFORE any finish/upscale GPU spend, with the real error on the shot. Plus the S20 planner/provision
fix batch.

- **Layer 1: structural mp4 validation at motion-clip intake (#556, #523).** Every adopted clip's
  mp4 box tree is parsed in-Worker from bounded R2 ranged reads (no full download): ftyp/moov
  present, duration/dimension sanity, minimum size. A structurally broken clip fails its shot at
  intake with a `clip.validate` structured event; the fail is sticky (R2 reclaim never re-adopts a
  known-bad clip). Engine-agnostic: applies to own-gpu, cloud i2v, and local-door clips alike.
- **Layer 2: pixel-content validation at the film finish boundary (#558, #557, #523).** The
  video-finish container grows `POST /inspect`: keyframe-vs-first-frame similarity is the primary
  corrupt signal (a noise clip scores ~0.0 against its own keyframe), chroma/structure ratio is the
  warn-only fallback (empirically tuned on real fixtures: noise 5.6-5.7 vs good <= 2.5, threshold
  4.0). Verdicts: `corrupt` fails the shot pre-spend, `suspect` completes the film flagged
  `content_degraded`, an unreachable/older container degrades to `skip` -- content validation never
  hard-fails a render by being absent. Emits `clip.content_validate` structured events.
- **video-finish image fix (#559).** The #558 image build omitted `inspect_core.py` from the
  Dockerfile COPY list (crash-loop on import at container start); one-line fix. Ships as
  `vj-video-finish` 0.2.1; the 0.2.0 image tag is known-broken, never deploy it.
- **Provisioning hardening (#551, #553, #555).** `runpod-provision.py` pins the backend image tag
  by default and rejects bare `:latest`; finish satellites provision with their correct per-service
  R2 env; the upscale satellite pins to its first current-main release `vivijure-upscale:0.2.7`.
- **Planner fixes (#550, #554).** Numeric override fields get bounds hints and the render button
  gates on out-of-bounds values (#544 / #546); the pre-jobId window can no longer re-enable the
  render button mid-submit and double-fire a film (#552).
- **Deploy fixes (#541, #549).** `INSTALL_LOCAL_GPU=1` seeds the local-gpu door secrets so a fresh
  install stops failing with code 10182; deploy.sh surfaces the real planner-mint failure reason
  and validates a reused token before reporting ARMED.
- **Misc (#542, #547).** compose.yaml drops explicit `container_name` so two projects can coexist
  (#533); alibaba-wan-lora pins its seed `config_schema` floor at `min: -1`.
- **Docs (#543, #548).** The free-plan hedge flips to the proven S18 verdict (install free, render
  free, Workers Paid only for the 3 GPU satellites) plus the local-GPU door move recipe; R2 token
  scoping on a first install documented (bucket does not exist yet).

## v0.15.0

**The media stack becomes part of the standard install, and the whole studio is proven live on a
$0 Cloudflare account.** MINOR. The S18 payload: the finish/media containers stop being an optional
tier (the pre-local-door privacy rationale is gone), deploy.sh automates the entire tunnel + VPC
leg, a film that loses its finish container still delivers clips, and the free-plan gate PASSED on
a fresh free-plan account -- full standard install E2E and all THREE render routes (own-gpu
serverless, cloud i2v, local-gpu door) shipped assembled 1080p24 films. The #521 verdict: install
free, render free (pay only usage), Workers Paid ($5/mo) buys ONLY the 3-GPU-satellite suite; a
plan flip needs a core redeploy.

- **Media stack promoted to the standard install; tunnel + VPC fully automated (#519 / #520 /
  #513, #527).** The 5 CPU media containers + cloudflared tunnel + 5 Workers VPC services are now
  part of the default `deploy.sh` run: profiles collapse to `standard` / `satellites`
  (`minimal` / `full` become warn-aliases), `INSTALL_LOCAL_GPU=1` is the separate local-door
  opt-in, and the new `scripts/setup-media-vpc.py` creates/adopts the tunnel, creates the VPC
  services, injects the service ids, and emits a `0600` `tunnel.env`. Only the 3 GPU satellites
  (upscale / lipsync / speech-upscale) remain optional.
- **Degrade to completed-with-clips when video-finish is unavailable (#519, #524).** If
  `VIDEO_FINISH_VPC` is unbound or unreachable after bounded retry at assemble, the film now
  COMPLETES with a loud `finish_unavailable` block (`delivered: "clips"` + presigned clip URLs)
  instead of hard-failing; at mux the degrade delivers a `silent_film`. You can close your laptop
  and still get your clips. A GENUINE container error still fails the render loud with the real
  per-shot error (the #245 / #249 honest-failure guards are untouched).
- **Free-plan subrequest scoping (#521 / #535, #526 + #538).** Root cause of the free-tier
  `Too many subrequests` failures was scan-count, not module-count (a trimmed 18-module install
  still failed): the film tick discovered the registry per interested-module scan, and the
  keyframe->clips transition tick ran TWO full discovery fan-outs (46/50 subrequests before any
  work). Discovery now runs once per film tick (#526) and is threaded request-scoped through the
  clip-job path (#538). Post-fix, all three render routes complete on the free plan's 50-subrequest
  cap.
- **Zombie GPU-job cancel (#536, #538).** The clip orchestrator persists the backend job id per
  shot and best-effort-cancels it on shot failure / job teardown, gated so it fires once; R2
  reclaim runs FIRST, so a clip that already landed is adopted, never cancelled. Kills the class
  where the studio gives up but an H200 keeps burning.
- **Media tunnel adoption + named token scopes (#528 / #531, #532).** `setup-media-vpc.py` now
  adopts an existing `vivijure-media` tunnel instead of creating a split-brain second one, and
  hard-stops if it detects a split (services pointing at a tunnel it did not adopt). Deploy-time
  scope errors now name the exact missing token scope (e.g. `Cloudflare Tunnel:Edit`,
  `Connectivity Directory:Admin`) instead of a bare CF `10000`.
- **Serverless provisioning defaults to datacenter GPUs (#517, #530).** `runpod-provision.py`
  defaults new endpoints to the H200 / B200 pool (the baked-image sm target), not the consumer
  pool a fresh account would otherwise land on.
- **Docs swept to the standard/satellites shape (#529)**; quickstart, DEPLOYMENT, opt-in-tiers,
  CONTRACT and the runbook all describe the post-#519 install (Joan). **Node diagnostic reports
  gitignored (#525)** after a near-miss: a `--report-on-fatalerror` OOM dump (full env, creds
  included) landed in a working tree and was caught by push protection; `report.[0-9]*.json` can
  never be committed again.

## v0.14.3

**S16 backlog burn-down: retire two dead modules, harden the tag deploy, finish the Secrets Store
migration.** PATCH. No new feature surface; three footgun/parity fixes ahead of announce.

- **Retire openai-sora + alibaba-wan25; deploy `EXCLUDE` empty (#306 / #509).** Both were never
  core-bound and never live: openai-sora's un-exclude was gated on the parked Sora build (#184) and still
  carried an unresolved CF `workers.dev/subdomain` first-deploy blocker; alibaba-wan25 was a redundant
  OLDER sibling (Wan 2.5) of the shipped alibaba-wan (Wan 2.6). Deleted both module dirs + their tests,
  swept the two names from 7 sibling `motion.backend` READMEs + the deploy-runbook, and cleared the
  retired plan-enhance-py (#469) leftovers. The CI `EXCLUDE` list goes to empty (the skip-list MECHANISM
  is kept for the next not-ready module). The code is recoverable from git history if #184 revives Sora.
- **Bounded transient-retry in the module-deploy loop (#492 / #510).** The tag-deploy "Deploy module
  workers" step ran `wrangler deploy` per module with no retry, so a single transient Cloudflare API
  hiccup (e.g. the Workflows trigger registration that failed the v0.13.0 deploy) aborted the whole
  ordered deploy under `set -eu`, skipping the core render, D1 migrations, core deploy, and the
  post-deploy gate. Ported deploy.sh's pattern: an `until` retry, up to 3 attempts with a 3s backoff; a
  persistent (non-transient) failure still fails the step loud after the attempts are exhausted. POSIX sh
  / BusyBox ash, now at parity with deploy.sh.
- **speech-upscale bound from the Secrets Store (#238 / #511).** The last secret-bearing module still on
  imperative `wrangler secret put`. Because it deploys via the CI glob loop but CI never runs
  `wrangler secret put`, a CI/fresh deploy shipped it credless -> silent `no-runpod-secrets` passthrough
  (the v0.2.2 finish-upscale class #237 exists to kill). It now binds `RUNPOD_API_KEY` (shared) +
  `RUNPOD_ENDPOINT_ID` (store secret `AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID`, the vivijure-audio-upscale
  endpoint) from the account Secrets Store via the string-tolerant `secretValue()` resolver; deploy.sh +
  docs updated. This finishes the #238 migration (the core worker and every other secret-bearing module
  were already done).

## v0.14.2

**Every full-render submit path now bounces an unresolved motion backend at the door.** PATCH. Extends
the v0.14.1 / #500 novice-first hardening (a full render with no resolvable motion backend rejects at
submit, not deep at assemble with `no clips rendered to assemble`) to the remaining submit paths, and
closes the planner's default-pick hole.

- **Core preflight on the last two submit paths (#504).** The reusable `motionBackendPreflightError`
  (`src/modules/registry.ts`) is now wired into `hStartFilm` (`POST /api/render/film`) and
  `hScatterRender` (`POST /api/storyboard/render/scatter`), resolving the EXPLICIT `motion_backend` (the
  top-level field or `render_overrides.motion_backend`, NEVER the `serving[0]`/door default) exactly as
  `hSubmitRender` does. Neither endpoint has a keyframes-only mode, so the check is unconditional; both
  reject with a 400 listing the serving `motion.backend` names before any keyframe/shard GPU work. With
  Slate now always sending an explicit backend (slate v0.2.1, `skyphusion-labs/slate#58`), every
  full-render submit path is covered and the `serving[0]`/door default is unreachable for a full render.
- **Planner no-default-force-pick (#501).** With 2+ serving `motion.backend` modules the planner used to
  preselect the order-first door (locality-blind), so a novice clicking straight to submit sent a
  possibly-non-operational door EXPLICITLY -- passing the new submit preflight, then failing downstream.
  Every door radio now starts unchecked and submit blocks with a novice cue, `pick a render backend
  before rendering (Label A, Label B)`, until a door is chosen (or `motion_backend` is supplied via the
  expert JSON). Single-backend and zero-backend cases are unchanged, and a keyframes-only preview is
  exempt (no motion leg). Stays a projection of the registry; no module manifest touched. (Authored by
  Joan, #506.)

## v0.14.1

**Novice-first: a full render with no resolvable motion backend bounces at the door, not deep at assemble.**
PATCH. A full (non-`keyframesOnly`) film render whose effective `motion_backend` did not resolve to an
installed, serving `motion.backend` module used to burn the keyframe phase and then fail with the opaque
`no clips rendered to assemble` (an assemble-leg symptom of a submit-leg cause). It now rejects with a
400 at submit, naming the problem and listing the installed backends, before any keyframe GPU work.

- **Core submit preflight (#500 / #503).** `hSubmitRender` resolves the EXPLICIT `motion_backend` (the
  top-level field or `render_overrides.motion_backend`, NEVER the `serving[0]` default) and returns 400
  with the serving `motion.backend` module names when it does not resolve; `keyframesOnly` renders are
  unaffected (they have no motion leg). New reusable `motionBackendPreflightError(modules, choice)`
  helper (`src/modules/registry.ts`). Root cause confirmed against the live registry: an omitted backend
  defaulted (via `pickOneForHook`) to `serving[0]` = the `local-gpu` door (`ui.order` 4), not
  `alibaba-wan` (order 70), and the door has no seeded backend URL server-side, so the motion phase
  produced zero clips.
- **Planner caller side (#502).** The planner now ALWAYS sends an explicit `motion_backend` when at
  least one serving backend is installed; it previously OMITTED it in the single-backend case (relying
  on the core `serving[0]` default), which the new preflight would have rejected. The pre-existing
  render surface already renders the 400 `{error}` string verbatim, so the novice sees the full backend
  list when a pick is genuinely needed.
- **Follow-ups noted (next-sprint triage, not in this release):** planner default motion-backend pick
  (#501); extend the same preflight to `hStartFilm` + `hScatterRender` once Slate sends an explicit
  backend (#504); the Slate caller-side fix (`skyphusion-labs/slate#58`).

## v0.14.0

**The local-consumer door goes live in production.** The `local-gpu` module (the 12GB LTX "local"
door) is now deployed and bound into the core registry, so the studio routes renders to a
self-hosted GPU backend. MINOR: a new module binds into prod.

- **`local-gpu` deployed + core-bound (#383 / #384).** Flip 1 (#383) dropped `local-gpu` from the CI
  deploy `EXCLUDE` so `vivijure-module-local-gpu` ships on this tag; flip 2 (#384) added the core
  `[[services]]` `MODULE_LOCAL_GPU` binding so the registry discovers the door. The tag lane deploys
  modules BEFORE the core, so the module ships first and the core binds an existing service (no
  dangling-binding failure). The `local-gpu` door slice of #306 is now live.
- **Backend = a disposable RunPod SECURE pod behind a trycloudflare quick tunnel.**
  `LOCAL_BACKEND_URL` + `LOCAL_BACKEND_TOKEN` live in the Cloudflare Secrets Store (freshly seeded,
  verified live through the tunnel), so the module no longer `10182`s on an unseeded binding (the
  v0.7.6 failure). `LOCAL_BACKEND_URL` is re-seeded per pod, and the door FAILS LOUD when no pod is
  attached; it never silently degrades. The old "once the homelab box is up" condition is void (the
  door runs on a RunPod pod, not local hardware).
- **`deploy.sh` is store-first; the planner token is a fail-closed deploy prerequisite (#479 / #498).**
  The one-script self-host deploy now fills the core `store_id`, seeds every core store secret (incl.
  `R2_S3_*`) before the deploys that bind them, and resolves + seeds `CF_AIG_TOKEN` +
  `PLAN_ENHANCE_CF_AIG_TOKEN` up front. A `[[secrets_store_secrets]]` binding to an unseeded store
  secret hard-fails `wrangler deploy` (code `10182`), so the planner token can no longer be an
  "arm-later" step: if it is neither pasted nor auto-mintable the deploy stops early with the exact
  fix, before anything ships. Only `STUDIO_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` stay direct worker
  secrets.

## v0.13.2

**Re-includes `dialogue-gen` + `music-gen` in the module deploy loop now that the Cloudflare
Workflows write path has recovered.** The v0.13.1 re-cut held these two modules (the only ones that
bind a Cloudflare Workflow) on their live versions because `PUT /accounts/{id}/workflows/{name}` was
returning `10001 workflows.api.error.internal_server` (Cloudflare Durable Objects incident in ENAM,
CF support case 02220294, ongoing since 2026-07-02). Their workers stayed live/healthy throughout;
only re-registration on a new tag was blocked, so there was zero functional loss.

- **Cloudflare resolved the incident and closed case 02220294 (2026-07-03).** Verified
  evidence-grade against the live API, not the status email: a throwaway single-`[[workflows]]`
  probe worker deployed clean (the exact `PUT .../workflows/{name}` succeeded, no `10001`), then was
  deleted. The write path is genuinely back.
- **`dialogue-gen` + `music-gen` dropped from the CI `EXCLUDE` and the temp why-comment removed**
  (#493 / #495), mirroring the plan-enhance un-exclude (#476). This tag re-deploys both through the
  loop; no repo/code/config change to the modules themselves.

## v0.13.1

**Same S9 hardening payload as v0.13.0, re-cut so it actually reaches production. The v0.13.0 tag
deploy was blocked by an active Cloudflare Workflows API outage (`10001 internal_server` on the
Workflows write path, ongoing since 2026-07-02), which fails `wrangler deploy` when it re-registers
a module's Workflow trigger. No repo/code/config change; a Cloudflare-side incident.**

- **dialogue-gen + music-gen held on their live versions (temporary).** These are the only two
  modules that bind a Cloudflare Workflow. Both were UNCHANGED in S9 and their workers + workflows
  are already live and healthy, so holding them back re-deploys nothing functional -- the
  re-registration Cloudflare is rejecting is a no-op. They are excluded from the deploy loop until
  the Cloudflare Workflows write path recovers. Tracked in #493 (revert = drop both from the CI
  `EXCLUDE` and re-run the deploy once Cloudflare closes the incident).
- **Everything else in v0.13.0 ships:** the core worker, D1 migration `0010` (opaque `public_id`
  backfill), and the post-deploy gate self-check all deploy normally (the core binds no Workflow).

The full S9 changeset is unchanged from the v0.13.0 entry below (opaque ids F13, spend fail-closed
F7, deploy self-check W3, ALLOW_UNAUTHENTICATED loudness W4, single-user docs W5). v0.13.0 stays in
history as the Cloudflare-blocked attempt.

## v0.13.0

**S9 strict security hardening: the single-user studio becomes bulletproof-by-default without
Cloudflare Access. Externally-addressable ids are now unguessable, the spend limiter and the deploy
path fail CLOSED, and the docs lean into single-user. BEHAVIOR CHANGES (MINOR): a bare sequential
`:id` no longer resolves, and a broken spend limiter now denies instead of allowing.**

- **Opaque public ids on cast / projects / renders (F13, #487).** `storyboard_projects`,
  `cast_members` and `renders` now expose a UUID-class `public_id` (122 bits) as their ONLY external
  id; the internal INTEGER PK and every internal FK are unchanged. Every `:id` route resolves
  `public_id` -> row, so a bare enumerable integer (`/api/cast/export/1`) now 404s instead of walking
  the library. **Hard cut, no dual-accept window** (pre-announce, prod=dev). Migration `0010_public_ids`
  adds the column and backfills existing rows with a per-row v4 UUID in pure SQL (additive; applied by
  the deploy lane BEFORE the new worker goes live). New rows get `crypto.randomUUID()` on insert.
- **UI consumes the opaque ids (F13 / #489).** The planner frontend routes, fetches and any
  sort/lookup-by-id move off the numeric id onto `public_id`; vanilla JS, still projected from the
  registry.
- **Spend limiter fails CLOSED by default (F7, #488).** A broken or unbound rate/spend limiter now
  DENIES (503) instead of allowing; `SPEND_LIMIT_FAIL_CLOSED="false"` is the documented opt-out. A
  novice self-funding their own GPU has the money path fail closed like everything else.
- **Post-deploy gate self-check (W3, #485).** `deploy.sh` and the tag-deploy CI lane now curl the live
  worker with NO bearer on `/api/*` after deploy and REQUIRE 403; anything else fails LOUDLY (a 200 is
  flagged "your studio may be OPEN"). Automates the v0.12.0 live-matrix proof so an open studio cannot
  ship silently. Bounded ~60s retry absorbs edge-propagation lag; no new secrets.
- **Loud ALLOW_UNAUTHENTICATED signalling (W4, #486).** `deploy.sh` prints an unmissable banner when
  the auth opt-out is present in the rendered config or environment (honest that it is inert under a
  set `AUTH_MODE`), and the in-Worker allow branch emits a structured `{"ev":"auth.allow_unauthenticated"}`
  event so an accidentally-open deploy is queryable in the tail/Loki channel.
- **Honest single-user framing (W5, #490).** `SECURITY.md` stops apologizing for missing
  multi-tenancy and states the model plainly: one operator, one token set, all data is yours; a named
  token is a rotation handle, not an isolation boundary. Updated to match the landed F13/F7 hardening.

## v0.12.1

**The #238 Secrets Store migration completes on the core worker, the R2 S3 presign identifiers
become `[vars]`, and plan-enhance rejoins the deploy loop. Config + deploy only; no behavior change.**

- **Core Secrets Store migration deploys (#238 / #473).** The studio worker's `CF_AIG_TOKEN`,
  `GATEWAY_ID`, `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` (store `secret_name` `BACKEND_RUNPOD_ENDPOINT_ID`),
  `R2_S3_ACCESS_KEY_ID` and `R2_S3_SECRET_ACCESS_KEY` move from `wrangler secret put` to declarative
  `[[secrets_store_secrets]]` bindings; the tag deploy replaces the stale `secret_text` in place.
  `STUDIO_API_TOKEN` stays an operator-minted worker secret. Values are seeded once in the crew
  Secrets Store and never touch CI/GitHub.
- **R2 S3 presign identifiers -> `[vars]` (#475).** `R2_S3_ENDPOINT` + `R2_S3_BUCKET` are identifiers,
  not secrets, so they render into `wrangler.toml` `[vars]` at deploy from `CLOUDFLARE_ACCOUNT_ID`
  (no wrangler secret, no new CI variable).
- **plan-enhance un-excluded (#476).** Its `PLAN_ENHANCE_CF_AIG_TOKEN` store secret is now seeded, so
  the module rejoins the CI module deploy loop.
- **AUTH_MODE render fails loud when unset.** The core render no longer defaults an unset `AUTH_MODE`
  to `access`; it errors instead (mirroring `deploy.sh`). Since the whole-hostname Access app was
  removed, a silent `access` default would mis-posture prod. `vars.AUTH_MODE` must be set explicitly.

## v0.12.0

**The module-api/1 deprecation window closes and the Secrets Store migration lands, and prod edge auth
flips from Cloudflare Access to the built-in token gate. Config + release only; no behavior regressions.**

- **module-api/1 deprecation window closed (#294).** The first-party modules are migrated
  vivijure-module/1 -> /2 (batches #461-#466, plus #468 for the excluded sora/wan25), closing the #293
  window. Conformance green per module.
- **Secrets Store migration, module half (part of #238).** The non-looped module workers (#462) and the
  plan-enhance module (#470) move their credentials from `wrangler secret put` to declarative
  `[[secrets_store_secrets]]` bindings (GATEWAY_ID, CF_AIG_TOKEN, per-endpoint RunPod ids). Values are
  seeded once in the crew Secrets Store and never touch CI/GitHub.
- **Token-mode edge auth (prod flip).** The studio worker moves AUTH_MODE access -> token: the built-in
  bearer gate (operator token + D1 named per-consumer tokens, #446) becomes the enforced door and the
  Cloudflare Access application is removed from vivijure.skyphusion.org. Drops the Zero-Trust
  prerequisite for self-host; the browser UI supplies the operator bearer via the existing token shim.
- **plan-enhance store migration ships config-complete but deploy-deferred.** Its per-function token
  PLAN_ENHANCE_CF_AIG_TOKEN is not seeded yet, so plan-enhance is temporarily in the CI EXCLUDE list; the
  currently-live worker keeps running untouched and it un-excludes in the #238 core-migration release
  once the token is seeded.
- **plan-enhance-py proof module retired (#306 / #469).** The Python variant is deleted; the TS
  plan-enhance module is the shipped path.
- **planner + data hygiene (#467, #454/#459/#460, #457, #458/#406).** History-list diffability restored
  and keyframe-stage labels genericized/registry-projected; renders-db raw-row shapes typed; the
  speech-upscale RunPod endpoint id genericized in docs.

## v0.11.0

**The structural-debt sprint: per-consumer API tokens, locality-driven classification, contract-carried
finish conventions, and the god-files split -- 21 PRs across the constellation, zero behavior regressions
(1233 tests green throughout).**

- **Named per-consumer bearer tokens (#445 -> #446).** The studio auth-gate now accepts named tokens
  beside the operator login: D1 `api_tokens` (migration 0009) stores SHA-256 hashes only; a match
  authenticates as `api-token:<name>`; deny reasons are identical across credential classes (no oracle).
  `scripts/studio-consumer-token.sh` mints (plaintext lands ONLY in a chmod-600 file), revokes, lists.
  A bot or satellite gets its own independently revocable credential instead of the operator login.
- **Locality-driven motion classification (#448).** The core classifies motion.backend modules by their
  declared `ui.locality`, never by module name. Fixes a live mislabel: a local door serving
  motion.backend passed the old name filter and could become the default "cloud" model. Missing door
  classes now fail honestly, naming the missing locality.
- **Contract-carried finish conventions (#450).** Finish modules declare `finish_artifacts` in the
  manifest (output-key convention + applied-tag rules); the core's R2-authoritative recovery reads the
  declaration instead of regexing binding names. Third-party finish modules can now opt into recovery.
- **God-files split (#451, #453).** `validateStoryboard` decomposed into section validators;
  the pure film model (shapes, summaries, retry/adoption logic, stall math) extracted to
  `src/film-model.ts` with a re-export barrel -- zero test edits either time. `public/planner.js`
  (7224 lines) split into 16 modules with byte-identical-slice proof (#447), i2v labels project
  through the registry (#455).
- **Installer parity (#452).** `vivijure_deploy.py` learns AUTH_MODE token/access: token mode mints
  the operator secret via the same path as deploy.sh (F18-lite keep-unless-rotate) and skips the
  Access app; consumer tokens point at studio-consumer-token.sh, never a second mint.
- **Constellation (same sprint, other repos):** satellite CI unified on semver-tagged immutable images
  (no :latest); musetalk loads models once per warm worker (~5GB reload per job eliminated); the finish
  stage NVENC-encodes with honest CPU fallback and streams interpolation (bounded RAM); the local doors
  share a byte-identical `vivijure_local/core/`; the backend gains a live SECURE-only RunPod pod client,
  proven by a paid smoke that caught two real bugs before any gate depended on it.

## v0.10.0

**Deploy ratification + the fix-it-all sprint: a cold deploy provisions everything (planner armed,
gateway created, tokens minted once), renders fail honestly instead of masking or leaking spend, and
concurrency/spend safety get real guards.**

- **One-script cold deploy, ratified end to end.** deploy.sh now arms the storyboard planner cold
  (auto-mints the AI-Gateway Run token when the deploy token can, with a paste fallback; #434),
  script-creates the AI Gateway itself with authentication + cache-invalidate-on-update ON at birth
  (#442), serves on workers.dev hostnames (#433), preflights npm ci (#432), and STOPS reminting
  `STUDIO_API_TOKEN` on re-runs -- saved logins survive; `--rotate-token` mints fresh (#442). The
  provisioner writes the env names the backend handler actually reads (#438). Proven by a virgin
  re-run: green end to end, zero interventions.
- **Honest RunPod polls (F17/#141, all 16 RunPod-driving modules; #440).** A backend whose error
  path leaves the job status stuck now gets its structured error surfaced (stage + message + job id)
  instead of polling forever and masking as "job not found"; the module cancels the hung job so it
  stops billing the worker; and a virgin endpoint's image pull no longer false-fails the first-ever
  job (the poll consults `/health` and waits out a genuine cold start, bounded at 15 min).
- **No more double-submits.** `advanceFilmJob` runs under a whole-tick D1 lease (migration 0007), so
  the 1-min cron and client polls can no longer race the same phase transition into duplicated GPU
  spend; the loser reads the job read-only (#439).
- **Spend posture knobs (#441).** `SPEND_LIMIT_FAIL_CLOSED` flips the F3 rate-limit guard to deny
  (503) when the limiter itself is broken; `SPEND_DAILY_CEILING` caps spend-route submissions per UTC
  day in D1 (migration 0008), returning 429 until midnight. Both off unless set.
- **Contract consistency (additive, no api bump; #443).** `score` output gains the shared `degraded`
  chain convention; `film.finish`'s optional `applied` is now a documented decision, and conformance
  type-checks both when present.
- **Docs tell the token-mode truth (#435-#437).** Quickstart/README/DEPLOYMENT rewritten for the
  shipped token auth (Access is optional hardening), the deploy docs match the ratified script, and
  teardown deletes the auto-minted Run token.

## v0.9.0

**Browser-grade media serving (#416): HTTP byte ranges on artifacts and worker-authoritative cache
headers.**

- **Byte-range requests on `/api/artifact`.** The artifact route ignored `Range` entirely, so
  Safari/iOS (which require ranged media) could not play planner films at all and a Chrome seek
  refetched from byte 0. It now advertises `Accept-Ranges: bytes` and serves 206 + `Content-Range`
  for closed, open-ended, and suffix ranges, a true 416 with `bytes */size` when out of bounds, a
  graceful full 200 on malformed or multi-part ranges, and supports HEAD (#421).
- **Cache headers are the worker's job now.** Bare non-page responses default to `no-store` at the
  response chokepoint (set-if-absent), artifacts keep `private, max-age=300`, and static assets keep
  the ASSETS binding's revalidate-always header. A deployment is cache-correct without any zone-level
  bypass rule; ours is reframed in the docs as optional hardening, so outsider deployments no longer
  depend on a dashboard setting they cannot see (#421).

## v0.8.4

**Planner regression sweep closes (#411): the NULL-string mapping fix and a module-bound local dev
environment.**

- **SQL NULL no longer serialized as the string "null".** The renders list mapped NULL
  `project` / `bundle_key` / `quality_tier` through a bare `String()`, shipping the literal, truthy
  string `"null"` to the planner: "null" labels and download names, and a bundle-less row that looked
  re-render eligible. Those fields now coerce to `""` like the sibling nullable fields, so the
  planner's existing truthiness gating is correct with no frontend change (#418).
- **Module-bound local dev environment.** `.dev-modbound/dev-modbound.sh` runs the core plus every
  in-tree module worker in one local `wrangler dev` fleet: the real 25-module catalog projects into
  the planner while every module invoke stays inert (binding-free dev configs; no GPU or provider
  spend possible). Includes a dev-only planner AI mock (`PLANNER_AI_MOCK`, unset in prod, live path
  unchanged) whose canned output runs the real extract/parse/validate pipeline, with sentinels for
  pass, validator-reject, and parse-failure. Closes the dev-parity gap the sweep surfaced; recipe in
  `docs/dev-modbound.md` (#419).

## v0.8.3

**Planner regression-sweep fixes (#411): the keyframe lightbox and the dead progress-stream path.**

- **Keyframe lightbox is styled.** Clicking a keyframe thumbnail opened an overlay whose classes had
  no CSS at all, dumping an unstyled full-size image at the page bottom (same never-implemented class
  as the v0.8.2 player fix). The lightbox is now a fixed full-viewport overlay: image contained and
  aspect-preserved at any shape (2x-upscaled, portrait, 1:1), backdrop + Escape dismiss (#412).
- **Dead render-progress stream removed.** The planner opened an SSE connection to a `/stream`
  endpoint that never existed server-side, so every render flashed "stream closed; falling back to
  8s polling" before polling anyway. The dead client path is gone; the 8-second poll on the
  structured status channel is the single, silent mechanism. Server-side SSE is tracked as a
  post-announce enhancement (#414, #415).

## v0.8.2

**Planner: upscaled films display correctly; hook-contract enforcement at runtime; support/security
contact docs.**

- **Upscaled clips no longer blow out the history card.** The inline film player and per-shot motion
  clips had no CSS sizing, so a 2x-upscaled MP4 rendered at intrinsic resolution and the card's
  `overflow:hidden` clipped it to a blown-up crop. Players now size to the card and keep the clip's
  own aspect (#410). Trigger for the full planner regression sweep (#411).
- **Runtime hook-contract enforcement (F5b).** The core now validates a module's terminal output
  against its hook contract at the orchestrator consumption seams (render, film, score, cast-image);
  an envelope-correct but malformed payload takes that seam's existing honest-degrade with a
  traceable per-module reason instead of being threaded downstream (#345, #408).
- **Support and security contact docs.** `SUPPORT.md` (GitHub Issues first, support@skyphusion.org
  next) and a root `SECURITY.md` reporting policy (private reports to security@skyphusion.org,
  linking the `docs/SECURITY.md` posture doc) now ship in this and every constellation repo (#409).

## v0.8.1

**Pre-announce polish: honest public docs, a cleaner deploy front door, and edge-cache purge on release.**

- **Welcome page reflects the real constellation.** The "how it fits together" table now lists both
  local self-host doors (`vivijure-local-12gb` / `-16gb`) and all three finish satellites
  (`vivijure-musetalk` / `-upscale` / `-audio-upscale`), with a pointer to `docs/constellation.md`. The
  stale "seven motion backends" claim is replaced with backend-agnostic wording (#403).
- **Deploy hygiene.** The real account Secrets Store id is templated out of the public module configs
  behind a `REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID` placeholder; `deploy.sh` (outsider path) fills it
  from the operator's store and CI fills it from the `SECRETS_STORE_ID` repo variable, fail-closed, so
  a tag deploy never ships a dangling `[[secrets_store_secrets]]` binding. `deploy/vivijure_deploy.py`
  is demoted to a labelled alternative so `deploy.sh` is the single documented front door. The
  speech-upscale opt-in now names its per-module `RUNPOD_ENDPOINT_ID` secret (#404).
- **Edge-cache purge on release.** The tag-gated deploy job now purges the Cloudflare edge cache for
  `/welcome` and `/` after the core deploys, so a release stops serving a stale welcome page. Opt-in
  and self-host safe: a no-op unless `CF_ZONE_ID`, `CF_PURGE_HOST`, and `CF_CACHE_PURGE_TOKEN` are all
  set; honest failure (the worker is already live, so a purge error never rolls back) (#405).

## v0.8.0

**Workers-for-Platforms dynamic dispatch goes live: install a module without redeploying the core.**

- **WfP dispatch enabled in prod (Phase 3 deploy).** The `vivijure-modules` dispatch namespace is
  created and the core now binds `MODULE_DISPATCH`, so a module uploaded into the namespace is reached
  at request time via `env.MODULE_DISPATCH.get(<script>).fetch(...)` -- no core redeploy to install one.
  This lands the host-side dispatch work (#391 / #392 / #393) as a running capability; `GET /api/modules`
  now reports `host.dispatch: true`. Conformance-gated install routes + the operator CLI drive uploads.
- **Free-self-host promise preserved, by construction.** The `[[dispatch_namespaces]]` block still ships
  COMMENTED in `wrangler.toml.example`. Our prod render uncomments it only when the repo variable
  `ENABLE_WFP_DISPATCH == "1"` (set once, after the namespace exists); a community fork never sets it, so
  its render stays commented and deploys on the free plan with zero WfP dependency. The dispatch layer is
  also runtime-gated on `MODULE_DISPATCH` being bound, so behavior is identical when it is absent.
- `local-gpu` stays in the CI deploy EXCLUDE: under WfP the multi-tenant local door becomes a
  per-tenant namespace upload, not a `[[services]]` deploy -- a follow-on once tenant onboarding lands.

## v0.7.7

- **Exclude the WIP `local-gpu` module from deploy (#382).** It has no core `[[services]]` binding and its Secrets Store secrets are unseeded, so its deploy failed (code 10182) and broke v0.7.6. Fenced out until the homelab door lands.

## v0.7.6

- **Planner: BYO locality tag + bind the finalize gate to the BYO door (#381).** Three-value locality (local | byo | cloud) surfaced to the planner; finalize gated behind the BYO door.

## v0.7.5

- **Run the worker on static pages so security headers actually land (#377).** Re-fixes header stamping on `/welcome` and all pages without the redirect loop v0.7.3 introduced.

## v0.7.4

- **Revert `run_worker_first` (#375).** It broke `/welcome` with a 307 redirect loop; reverted pending the correct fix (landed in v0.7.5).

## v0.7.3

- **`run_worker_first` so the worker stamps headers on `/welcome` + all pages (#374).** Reverted in v0.7.4, superseded by v0.7.5.

## v0.7.2

- **Substitute `WEB_ANALYTICS_TOKEN` in the wrangler.toml render (#373).** The analytics beacon token now renders from the Actions secret.

## v0.7.1

- **Render wrangler.toml BEFORE applying D1 migrations (#372).** `wrangler d1` needs the rendered config to resolve the D1 binding and `migrations_dir`.

## v0.7.0

- **Worker-owned security headers on every response class (#371).** One source of truth for headers across page, API, and asset responses.

## v0.6.6

- **Durable module secrets via Cloudflare Secrets Store (#237).** Module secrets bind declaratively from the account Secrets Store, so a fresh-create can no longer start secretless and silently degrade.

## v0.6.5

- **Open a character on load so highlight + detail pane stay in sync (#146).**

## v0.6.4

- **Reconcile LoRA training rows wedged in `training` back to `failed` (#295).**

## v0.6.3

- **Exclude not-ready modules from deploy (#305):** openai-sora, alibaba-wan25, plan-enhance-py.

## v0.6.2

- **Fix exit-127 in the dynamic module deploy (#304).** POSIX sh only, no bash-isms (the CI container's `/bin/sh` is BusyBox ash).

## v0.6.1

- **Deploy ALL modules dynamically, not a hardcoded include-list (#303).** Fixes deploy-drift where a new module was forgotten and the live worker served stale.

## v0.6.0

- **Operator install-config page, registry-projected (#301).** Per-module install config edited from a settings page projected off the registry.

## v0.5.0

- **Strip `user_email` to zero: identity-free, anti-SaaS by architecture (#292 / #293).** No user identity is stored; the studio is self-hosted software, not a data-collecting service.

## v0.4.2

- **Write the runnable R2 doc before the D1 rows so a submit cannot orphan a render (#289 / #290).**

## v0.4.1

- **Fail loud on a partial assemble (#287 / #288).** Never silently complete a 1-of-N scatter gather.

## v0.4.0

- **Run the `film.finish` chain on the scatter gather (#286).** Subtitles and title/credit cards applied on the scatter assemble path.

## v0.3.3

- **Clamp seedance duration minimum to 4 (#279 / #282).** The endpoint allows [4,12] and 400s on 3.

## v0.3.2

- **Wire `tail_consumers` -> `vivijure-tail` (#278).** Deploy-ordered observability tail consumer.

## v0.3.1

- **Make the keyframe backend user-selectable (#275).** cloud-keyframe becomes reachable alongside the GPU keyframe.

## v0.3.0

- **Wire every `config_schema`-bearing hook end to end (#274):** speech + film.finish + master config knobs plumbed through; gated the v0.3.0 cut.

## v0.2.6

**Launch prep: fail-loud finish, the talking showcase, and the render-pipeline diagram.**

- **Fail loud on a failed finish chain (#245 / #249):** a finish step that genuinely fails (after the bounded retry + R2 reclaim) now fails the render with the real per-shot error instead of silently advancing to done and shipping the raw i2v clip with `applied=[]`. `clipKeysFromFilmJob` returns finished clips only when a finish chain was set up, never substituting a raw clip for a non-done shot. The honest-failures safety net: a finish failure can no longer ship a green-but-unfinished film.
- **Welcome page + README:** the "Vivijure Speaks" talking-character showcase on the public welcome page (#240), and a render-pipeline mermaid diagram in the README (storyboard to keyframe to dialogue + motion.backend to the finish chain to assemble to mux).
- Pairs with **backend-v0.2.27** (the RIFE pad-to-64 fix, verified live VOICED+FULL on a non-64 resolution): the finish chain now runs on every cloud i2v output dimension, so all seven motion backends do the full lip-sync + upscale path.
- **693 tests**, typecheck-clean.

## v0.2.5

**Preflight fix: the pre-render safety check actually runs now.** Found in a full planner regression pass.

- **preflight route wired + envelope unwrapped (#242 / #243):** `src/preflight.ts` (the real validator: shape + cast-readiness) was written but never imported, so `/api/storyboard/preflight` only ran the shape gate against the wrong object: it read `.title`/`.scenes` off the `{storyboard, castBindings}` envelope (undefined) and returned HTTP 400 on every valid storyboard. The client threw on the non-2xx and showed only "HTTP 400" with no reasons, and its bundle gate never activated. The handler now unwraps `.storyboard`, runs the full chain (validateStoryboard -> checkStoryboardShape -> checkCastBindingsReady -> summarize), and returns the PreflightResult at HTTP 200 with `ok:false` + structured issues for a storyboard-with-problems (validation findings are data, not an HTTP failure). The client now renders the issues and the bundle gate works. D1 is only queried when cast bindings are present.
- **690 tests** (8 new preflight-route tests incl. the exact old-bug payload as a regression guard), typecheck-clean.

## v0.2.4

**Cloud i2v duration enum fix.** Unblocks the cloud motion backends for short shots.

- **kling + wan duration snap (#241):** the Kling ({5,10}) and Wan 2.6 ({5,10,15}) cloud i2v modules accept only a discrete duration enum, not a continuous range; the old continuous clamp passed a 4s shot straight through and the provider 400'd at submit (so a cloud talking render failed before any clip rendered). Duration now snaps UP to the smallest allowed value at or above the per-shot seconds (4s -> 5; a 7s shot -> 10, never clipped shorter than the shot). The other six cloud modules likely share the bug; tracked as follow-up.
- **683 tests**, typecheck-clean.

## v0.2.3

**Finish-chain self-heal: a GC'd or frozen mid-chain finish step now recovers from R2.** Builds on v0.2.2's silent-render fixes.

- **R2-presence advance for any finish step (#239):** when a finish step's RunPod poll job is GC'd-after-complete (a 404) or freezes IN_PROGRESS (poll pends forever), and that step's OWN expected output is already in R2, the orchestrator folds it in and advances to the next module -- instead of polling a ghost job to the hard deadline. This fixes the wedge where RIFE completed and its output landed in R2 but the finish chain never advanced, so lip-sync was never dispatched and the shot pended forever. Per-step advance on the step's own artifact (not final-artifact adoption), so the remaining modules still run -- it cannot ship a half-finished clip.
- **682 tests**, typecheck-clean.

## v0.2.2

**The talking-character showcase fix: a scatter film keeps its voice end to end.** Builds on v0.2.1's self-heal so the orchestration now reliably delivers per-shot dialogue + lip-sync through gather and assemble.

- **Scatter keeps clip audio (#234):** when a render has dialogue, the gather concat now preserves each lip-synced clip's baked-in audio (and silent-pads an audio-less clip to a uniform track), instead of stripping all audio and producing a silent film.
- **No mid-chain finish adoption (#234):** a finish shot whose module fails mid-chain is no longer adopted from its intermediate R2 clip as "done" -- only the chain's final artifact is adoptable, so a failed lip-sync can no longer masquerade as a finished (silent) clip.
- **Bounded finish-step retry (#234):** a transient finish-module blip (5xx / timeout / lost poll token) re-dispatches the step up to 3 attempts; a deterministic reject (4xx / no face) still fails loud -- so a momentary MuseTalk cold-start no longer silences a shot.
- **Watchdog spares D1-blocked shards (#230):** a shard that is merely retrying a transient D1 error is no longer declared dead by the watchdog.
- **voiced-verify (#236):** a `scripts/` checker that gates a render on per-shot lip-sync + non-silent audio (volumedetect), not just stream presence.
- **677 tests**, typecheck-clean.

## v0.2.1

**Production hardening: tag-gated deploys + render self-heal.** First release cut under the new tag gate.

- **Tag-gated deploys (#228):** a push/merge to `main` now runs typecheck + test only; the Cloudflare deploy (module workers -> D1 migrations -> core) fires ONLY on a pushed `v*` SemVer tag. A merge can no longer redeploy production or interrupt an in-flight render.
- **D1 transient self-heal (#229):** the render-advance hot path retries transient `D1_ERROR` internal blips (4 attempts, short backoff) while constraint / SQL errors still fail fast, so a momentary D1 hiccup no longer wedges a shard until the watchdog -- the every-60s sweep now genuinely self-heals.
- **trainLoras fails hard (#227):** a render bound to a character with no trained cast LoRA now 400s naming the character ("train them on the Cast page first") instead of silently inline-retraining the LoRA every render.
- **665 tests**, typecheck-clean.

## v0.2.0

**Phase 1: render API + studio UI.** The film studio is fully home in this worker; the AI Playground
(`skyphusion-llm-public`) no longer owns render or planner routes.

- **Render spine:** film orchestrator (keyframe -> motion -> finish -> assemble), scatter-gather,
  render-from-keyframes, regen-shot, cron sweep for orphaned jobs, module-driven overrides UI.
- **Cast:** training-set gen via `cast.image`, LoRA train/status, portrait + multi-scene image chat,
  ref/source management, artifact copy from chat outputs.
- **Library:** renders CRUD, finalize / animate-cloud / animate-hybrid, adopt backfill, prefs,
  notify hook (`notify-email` module).
- **Authoring:** plan / refine / yaml / markers / bundle / score-bed / beat analyze / enhance chain.
- **Eleven module workers** bound in `wrangler.toml` (keyframe, own-gpu, seedance, kling, finish-rife,
  cast-image, notify-email, music-gen, narration-gen, beat-sync, plan-enhance).
- **368+ tests**, typecheck-clean CI.

## v0.1.0

**Phase 0: the module host.** First cut of Vivijure Studio as a standalone Cloudflare Worker, split
out of `skyphusion-llm-public` so the AI Playground and the film studio no longer share a roof.

- **The module contract (`vivijure-module/1`)** in `src/modules/types.ts`: hooks, manifest,
  `invoke` envelope, reference `finish` payloads.
- **The registry** in `src/modules/registry.ts`: discovers `MODULE_*` bindings, validates manifests,
  clamps config, indexes by hook.
- **`GET /api/modules`** plus the **self-assembling frontend** (`public/`): UI is a projection of
  the registry; zero modules installed is a valid lean studio.
- **`docs/module-api.md`**: the design spec.
- Tests cover manifest validation, hook indexing, discovery against faked bindings.
