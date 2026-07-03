# Deploy-time config injection: `wrangler.toml.example` -> rendered `wrangler.toml`

How vivijure keeps account-specific config (the CF Access AUD, resource IDs) **out of the public
repo** while still deploying a complete `wrangler.toml`. The committed file is a **template**; the
real file is **rendered at deploy** from encrypted CI secrets. This doc is written so you can
reproduce the pattern in any repo from the doc alone.

If you know Jenkins, you already know this pattern under different names. The map is in section 2.

---

## 1. The problem and the shape of the fix

`wrangler.toml` mixes two kinds of content:

- **Structure** (safe to publish): binding *names* (`R2_RENDERS`, `DB`, `MODULE_*`), the worker name,
  route patterns, the module service names. This is the useful, readable shape of the worker.
- **Account-specific values** (do not publish): the CF Access **AUD**, the D1 `database_id`, the
  Workers-VPC `service_id`s, the rate-limit `namespace_id`. None is a *credential* (you still need a
  signed JWT / API token to do anything), but they are account-internal identifiers, and the AUD in
  particular is the thing we just spent effort getting out of the public surface.

vivijure is a **public** repo. So we:

1. Commit `wrangler.toml.example` -- the full file with the account-specific values replaced by
   `${PLACEHOLDER}` tokens. Structure stays visible.
2. **Stop tracking** the real `wrangler.toml` (`.gitignore` + `git rm --cached`). It still lives on
   disk and on the deployed worker; it just leaves git history.
3. The deploy workflow **renders** the real `wrangler.toml` from the template at build time, filling
   the placeholders from **encrypted GitHub Actions secrets**, then runs `wrangler deploy`.

Net: the public repo shows the binding structure; the opaque IDs live only in the encrypted secret
store and on the live worker.

---

## 2. Jenkins -> GitHub Actions (the part to internalize)

This is the same "inject config at build from a secret store" pattern you ran in Jenkins. The names
change; the moving parts do not.

| Jenkins | GitHub Actions | In this repo |
|---|---|---|
| Credentials store (Manage Jenkins -> Credentials) / secret files on the controller | **Encrypted repository secrets** (repo Settings -> Secrets and variables -> Actions) | `ACCESS_AUD`, `VPC_*_ID`, ... |
| Config File Provider / `withCredentials` writing a file at build | The **render step** (`envsubst < template > real`) in the workflow | `Render core wrangler.toml` step in `ci.yml` |
| Build agent / node | GitHub-hosted **runner** (here a `node:22-alpine` container on `ubuntu-latest`) | `runs-on: ubuntu-latest`, `container: node:22-alpine` |
| Pipeline `stage { }` | A **job** (`jobs:`) made of **steps** (`steps:`) | `ci` job, `deploy` job |
| "Only deploy on a release tag" (`when { tag }`) | A job/step **condition** | `if: startsWith(github.ref, 'refs/tags/v')` |
| Secrets masked in console output | Secrets **auto-masked** in logs; **write-only** (you cannot read them back, only overwrite) | -- |
| `Jenkinsfile` in the repo | **Workflow YAML** in `.github/workflows/` | `.github/workflows/ci.yml` |

Two Jenkins instincts to drop:
- GitHub secrets are **write-only**. You set them; you cannot read them back in the UI or API. Lost
  the value? Re-set it. (Keep the source of truth in your encrypted store -- here, crew-secrets.)
- The runner is **ephemeral** and **fork-safe**. vivijure takes outside PRs, so CI runs on a
  GitHub-hosted sandbox, and **secrets are NOT exposed to pull-request runs from forks** -- only to
  trusted events (push/tag on the base repo). That is exactly why deploy is gated to tags (section 4).

---

## 3. The pieces, walked

### 3a. `wrangler.toml.example` (the template, committed)
A byte-for-byte copy of the working `wrangler.toml` with **only** the account-specific values turned
into `${NAME}` tokens. What is parameterized here, and why each is a value not structure:

| Placeholder | What it is |
|---|---|
| `${ACCESS_TEAM_DOMAIN}` | Zero-Trust team hostname (`<team>.cloudflareaccess.com`) -- F2 JWT `iss` check |
| `${ACCESS_AUD}` | the vivijure Access application AUD -- F2 JWT `aud` check |
| `${D1_DATABASE_ID}` | the D1 database UUID |
| `${VPC_VIDEO_FINISH_ID}` / `${VPC_IMAGE_PREP_ID}` / `${VPC_AUDIO_BEAT_SYNC_ID}` / `${VPC_AUDIO_MIX_ID}` | Workers-VPC service IDs |
| `${SPEND_RATE_LIMITER_NS_ID}` | the rate-limit namespace id |
| `${AUTH_MODE}` | the #423 auth-gate mode: `token` (the self-host default) or `access` (our prod posture) |
| `${WEB_ANALYTICS_TOKEN}` | optional CF Web Analytics beacon token for `/welcome`; blank = no beacon ships |

`account_id` is **not** in the file at all -- wrangler reads it from `CLOUDFLARE_ACCOUNT_ID` (already a
CI secret), the cleaner mechanism. Binding names, bucket names, the route pattern, and the module
service names are **kept literal** -- they are the readable structure and are not sensitive.

### 3b. Stop tracking the real file
```
# .gitignore
/wrangler.toml
```
```
git rm --cached wrangler.toml      # untrack; the file STAYS on disk and on the deployed worker
```
A fresh clone will not have `wrangler.toml`; you render it (section 5). The `.example` is the source
of truth from now on -- **edit the `.example`, not the real file**, or your change never reaches CI.

### 3c. The secrets
Set once (write-only; values come from the encrypted store, never typed into a PR):
```
printf '%s' "$VALUE" | gh secret set ACCESS_AUD --repo skyphusion-labs/vivijure
# ... one per placeholder
gh secret list --repo skyphusion-labs/vivijure        # names only; values are not readable
```
> Note (best practice): GitHub also has **repository *variables*** (Settings -> Variables) for
> *non-sensitive* config -- they are readable in logs. The truly structural IDs here (D1 id, VPC ids)
> could be variables rather than secrets. We use secrets uniformly to keep one mechanism and because
> the AUD is the sensitive one driving this. If you split them, the workflow reads `${{ vars.NAME }}`
> for variables and `${{ secrets.NAME }}` for secrets.

### 3d. The render step (`.github/workflows/ci.yml`, before `Deploy core worker`)
```yaml
- name: Render core wrangler.toml
  env:
    AUTH_MODE:          ${{ vars.AUTH_MODE }}    # a VARIABLE, not a secret; unset -> render FAILS LOUD (see below)
    ACCESS_TEAM_DOMAIN: ${{ secrets.ACCESS_TEAM_DOMAIN }}
    ACCESS_AUD:         ${{ secrets.ACCESS_AUD }}
    # ... the rest (D1 / VPC / rate-limit ids, WEB_ANALYTICS_TOKEN)
  run: |
    set -eu
    apk add --no-cache gettext >/dev/null          # node:22-alpine has no envsubst; gettext provides it
    if [ -z "${AUTH_MODE:-}" ]; then echo "::error::AUTH_MODE unset"; exit 1; fi; export AUTH_MODE   # fail loud, no default (#423): a silent 'access' default would mis-posture prod (Access app removed)
    VARS='$AUTH_MODE $ACCESS_TEAM_DOMAIN $ACCESS_AUD $D1_DATABASE_ID $VPC_VIDEO_FINISH_ID $VPC_IMAGE_PREP_ID $VPC_AUDIO_BEAT_SYNC_ID $VPC_AUDIO_MIX_ID $SPEND_RATE_LIMITER_NS_ID $WEB_ANALYTICS_TOKEN'
    envsubst "$VARS" < wrangler.toml.example > wrangler.toml
    grep -q '${' wrangler.toml && { echo "::error::unsubstituted placeholder"; exit 1; } || true
    # mode-aware auth guard (#423): AUTH_MODE guaranteed non-empty by the fail-loud check above; access mode also needs armed vars.
    grep -Eq 'AUTH_MODE = ".+"' wrangler.toml || { echo "::error::AUTH_MODE empty"; exit 1; }
    if [ "$AUTH_MODE" = "access" ]; then
      grep -Eq 'ACCESS_AUD = ".+"' wrangler.toml && grep -Eq 'ACCESS_TEAM_DOMAIN = ".+"' wrangler.toml \
        || { echo "::error::F2 vars empty"; exit 1; }
    fi
```
Three things worth understanding:
- **`apk add gettext`**: Alpine ships no `envsubst`. On a stock `ubuntu-latest` (no container) it is
  already present and you can drop this line.
- **Explicit `VARS` list** (the SHELL-FORMAT arg to `envsubst`): without it, `envsubst` substitutes
  *every* `${...}` it finds, which can clobber unrelated tokens. Listing only ours means any other
  `${...}` in the file is left alone. Safer and self-documenting.
- **Fail-closed guards, mode-aware since #423**: a missing secret leaves a literal `${NAME}`
  (caught by the first grep); a *blank* secret renders an empty value. `AUTH_MODE` must always
  render non-empty, and in access mode a blank Access var would silently **un-arm** the in-Worker
  gate (deny-default -> `/api` 503), so the render refuses an empty AUD or team domain there. Token
  mode needs no Access vars: they render empty and the token gate ignores them.

### 3e. The deploy gate
The `deploy` job only runs for a pushed version tag:
```yaml
if: startsWith(github.ref, 'refs/tags/v')
```
A bare merge to `main` runs `ci` (typecheck + test) but never deploys -- so a docs merge cannot
redeploy prod or unset F2. Releases are deliberate: `git tag v0.x.y && git push origin v0.x.y`.

---

## 4. Reproduce this for another repo (recipe)
1. `cp wrangler.toml wrangler.toml.example`, then replace each account-specific value with `${NAME}`.
   Keep binding names / structure literal. Decide value-vs-structure with the section-3a question:
   "would another account need a different value here?"
2. Render locally and **diff until byte-identical** (section 6) -- proves you parameterized exactly
   the values and nothing structural.
3. `echo "/wrangler.toml" >> .gitignore` and `git rm --cached wrangler.toml`.
4. `gh secret set` each placeholder (from your encrypted store).
5. Add the render step before `wrangler deploy` in the workflow (copy 3d; drop `apk add` if not Alpine).
6. Commit `wrangler.toml.example`, `.gitignore`, the workflow. The real `wrangler.toml` stays local.

---

## 5. Local development
A fresh clone has no `wrangler.toml`. Render it once:
```
export AUTH_MODE=token D1_DATABASE_ID=...        # ids from your store; token mode needs no ACCESS_*
export ACCESS_TEAM_DOMAIN= ACCESS_AUD= WEB_ANALYTICS_TOKEN=
VARS='$AUTH_MODE $ACCESS_TEAM_DOMAIN $ACCESS_AUD $D1_DATABASE_ID $VPC_VIDEO_FINISH_ID $VPC_IMAGE_PREP_ID $VPC_AUDIO_BEAT_SYNC_ID $VPC_AUDIO_MIX_ID $SPEND_RATE_LIMITER_NS_ID $WEB_ANALYTICS_TOKEN'
envsubst "$VARS" < wrangler.toml.example > wrangler.toml
```

(`./deploy.sh` performs exactly this render for you -- including the profile strip and the
workers.dev branch -- so the manual export is only for driving `wrangler dev` against a
hand-rendered config.)
`CLOUDFLARE_ACCOUNT_ID` and any `wrangler secret`s go in `.dev.vars` (also gitignored) for
`wrangler dev`. After editing bindings: **edit `wrangler.toml.example`**, then re-render.

---

## 6. Safety checks
- **Byte-identical render** (the proof you parameterized correctly, and that the render reproduces the
  *armed* config -- critical, since a wrong AUD or a dropped F2 var would break Access):
  ```
  envsubst "$VARS" < wrangler.toml.example > /tmp/r.toml
  diff wrangler.toml /tmp/r.toml && echo IDENTICAL
  ```
- **Rotation**: change a value in your store -> `gh secret set NAME` -> cut a release tag. The next
  deploy renders the new value. Nothing in git changes.
- **Auth invariant (mode-aware, #423)**: `AUTH_MODE` must render non-empty, and in access mode
  `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` must render non-empty too, or the worker denies `/api` (503).
  The render step enforces both; the external watchdog (`skyphusion-monitor`) catches a regression
  within ~5 min from outside.

## 7. Gotchas
- Alpine has no `envsubst` -> `apk add gettext`.
- Without the explicit `VARS` list, `envsubst` eats *all* `${...}`.
- GitHub secrets are write-only -- keep the source of truth in your encrypted store.
- Fork PRs do not get secrets -> the render/deploy only works on trusted (tag) runs, which is why
  deploy is tag-gated.
- Edit the `.example`, never the rendered file -- the rendered one is gitignored and overwritten.
