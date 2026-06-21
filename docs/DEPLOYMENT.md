# Deploying Vivijure Studio

This is the start-to-finish guide to stand up your own Vivijure Studio: the API keys you need,
where to get them, exactly what permission each needs and **why**, and the deploy order.

Vivijure has three pieces:

1. **The Studio Worker** (this repo) -- a single Cloudflare Worker that owns projects, storyboards,
   cast, and render orchestration, plus a registry of opt-in **module workers** (one per capability).
2. **The GPU backend** (`vivijure-backend`) -- a container on **RunPod Serverless** that does the
   heavy lifting: LoRA training, SDXL keyframes, image-to-video, lip-sync.
3. **Three CPU helper containers** (`video-finish`, `image-prep`, `audio-beat-sync`) -- ffmpeg/CPU
   work that runs always-on on your own box, reached privately over a Cloudflare VPC binding. Optional
   for a first deploy (the Worker degrades gracefully without the finish container, just no final
   concat/cards).

You do NOT need a separate API key per video provider. Seedance, Kling, MiniMax, Veo, Sora, Wan,
keyframes, and lip-sync all run **through RunPod**, so one RunPod key covers them.

---

## 1. Accounts you need

| Provider | What it is | Sign up |
|---|---|---|
| **Cloudflare** | Hosts the Worker + your data (D1, R2, Vectorize) and routes LLM calls (AI Gateway). | dash.cloudflare.com |
| **RunPod** | Serverless GPUs that run the render backend (training, keyframes, i2v, lip-sync). | runpod.io |
| **GitHub** (optional) | Only if you build/host the backend image yourself via GHCR + Actions. | github.com |

Everything bills to your own accounts. The Studio is single-user by design -- one operator, your keys.

---

## 2. The keys, their permissions, and WHY

Issue a **separate, narrowly-scoped key per function** -- never one god-token. If a key leaks or you
rotate it, the blast radius is one function, not your whole account.

### 2a. Cloudflare API token (deploy-time)
Create at **dash.cloudflare.com -> My Profile -> API Tokens -> Create Token -> Custom token**.
Scope it to **your account only** (Account Resources -> Include -> your account).

| Permission | Why it's needed |
|---|---|
| `Account > Workers Scripts > Edit` | Deploy the Studio Worker + every module worker (`wrangler deploy`). |
| `Account > D1 > Edit` | Create the `vivijure-studio` database and apply schema migrations on deploy. |
| `Account > Workers R2 Storage > Edit` | Create + write the two buckets: render outputs (`vivijure`) and the doc/RAG store (`skyphusion-llm`). |
| `Account > AI Gateway > Read` | Resolve the AI Gateway the LLM features route through. |
| `Account > Account Settings > Read` | `wrangler` reads account metadata at deploy time. |

> Why so specific: each line maps to a real deploy step below. If a module never touches D1, its
> token never gets D1. This is the whole "least-privilege per function" idea -- you can hand the
> Workers-only token to CI and keep D1/R2 admin off the build runner.

Store it for CI as the repo secret `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID` (your
account id -- an identifier, not a secret).

### 2b. RunPod API key
Create at **runpod.io -> Settings -> API Keys**. One key with **read/write** (it both *runs* jobs and,
if you let it, *manages* your endpoint).

| Why it's needed |
|---|
| The Studio's GPU modules (`own-gpu`, `keyframe`, `finish-rife`, `finish-upscale`, `finish-lipsync`, and the cloud i2v backends) submit jobs to **your** RunPod Serverless endpoint and poll for results. |

You also need your **endpoint id(s)** (`RUNPOD_ENDPOINT_ID`) -- the id of the Serverless endpoint
running the `vivijure-backend` image (see section 4).

### 2c. R2 S3 access keys (for the GPU backend)
Create at **dash.cloudflare.com -> R2 -> Manage R2 API Tokens -> Create API token**, scoped to
**Object Read & Write** on your render bucket.

| Why it's needed |
|---|
| The RunPod backend is NOT a Cloudflare Worker, so it can't use a Worker R2 binding. It talks to R2 over the S3 API to read inputs (refs, bundles) and write outputs (LoRAs, keyframes, clips). Hence a classic access-key/secret pair, scoped to just the render bucket. |

These become the backend env `R2_S3_ACCESS_KEY_ID` / `R2_S3_SECRET_ACCESS_KEY` (and the matching
RunPod secrets the GPU modules pass through).

### 2d. AI Gateway (LLM features)
The storyboard planner, cast-image prompts, dialogue/music generation, and cloud-animate scoring
route LLM/AI calls through a **Cloudflare AI Gateway** (for caching, rate-limit, and one bill).

- `GATEWAY_ID` -- the gateway slug. Create a gateway at **dash.cloudflare.com -> AI -> AI Gateway**.
- `CF_AIG_TOKEN` -- an AI Gateway authentication token (only the `plan-enhance` module needs it);
  create under the gateway's settings.

> Why a gateway instead of a raw provider key: it gives you one place to see spend, cache repeat
> prompts, and swap the underlying model without touching code. Anthropic/other model access is
> billed through Cloudflare's Unified Billing, so you don't manage a separate provider key here.

---

## 3. Deploy the Studio (Cloudflare)

Prereqs: Node 22+, `npm install`, and `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` exported).

```bash
# 3a. Create the data resources (one time)
npx wrangler d1 create vivijure-studio          # then paste the database_id into wrangler.toml
npx wrangler r2 bucket create vivijure           # render outputs (keyframes/clips/films/loras) -- R2_RENDERS
npx wrangler r2 bucket create skyphusion-llm     # document / RAG store -- the R2 binding

# 3b. Set the runtime secrets (prompts for each value)
echo "<your-account-id>"            | npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
echo "<runpod-api-key>"             | npx wrangler secret put RUNPOD_API_KEY
echo "<runpod-endpoint-id>"         | npx wrangler secret put RUNPOD_ENDPOINT_ID
echo "<r2-s3-access-key-id>"        | npx wrangler secret put R2_S3_ACCESS_KEY_ID
echo "<r2-s3-secret-access-key>"    | npx wrangler secret put R2_S3_SECRET_ACCESS_KEY
echo "https://<account-id>.r2.cloudflarestorage.com" | npx wrangler secret put R2_S3_ENDPOINT
echo "vivijure"                     | npx wrangler secret put R2_S3_BUCKET
echo "<ai-gateway-slug>"            | npx wrangler secret put GATEWAY_ID

# 3c. Apply the database schema
npx wrangler d1 migrations apply vivijure-studio --remote

# 3d. Deploy. Module workers MUST deploy before the core (the core binds each as a service;
#     a binding to a not-yet-deployed module makes the core deploy fail).
for m in own-gpu finish-rife finish-upscale finish-lipsync keyframe seedance kling \
         minimax-hailuo google-veo vidu-q3 alibaba-wan text-overlay film-titles \
         dialogue-gen cast-image plan-enhance music-gen narration-gen notify-email; do
  npx wrangler deploy -c modules/$m/wrangler.toml
done
npm run deploy   # the core Studio Worker
```

Each module worker takes only the secrets it actually uses (e.g. the i2v modules need
`RUNPOD_API_KEY`; the AI modules need `GATEWAY_ID`). Set those per module with the same
`wrangler secret put -c modules/<name>/wrangler.toml` pattern.

> The whole of 3c--3d is automated in CI on push to `main` (`.github/workflows/ci.yml`), gated behind
> typecheck + tests. For a hosted deploy, set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` as repo
> secrets and let Actions do it.

You now have a working Studio for everything except the GPU render itself.

---

## 4. Deploy the GPU backend (RunPod)

The render backend is the `vivijure-backend` container image, run as a **RunPod Serverless endpoint**.

1. Build/pull the image. The image is published to GHCR (`ghcr.io/skyphusion-labs/vivijure-backend`);
   build it yourself from the `vivijure-backend` repo, or pull the public image.
2. In **runpod.io -> Serverless -> New Endpoint**, point it at the image, pick a GPU (H200/B200 class
   for training + i2v), and attach a **network volume** for the model weights (they self-preload from
   R2 on first run, then stay warm -- avoid scaling fully to zero between jobs or every cold worker
   re-pulls the image).
3. Set the backend env on the endpoint: `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`, `R2_BUCKET`,
   `R2_ENDPOINT` (your `https://<account>.r2.cloudflarestorage.com`), and the HuggingFace/offline
   flags the image documents.
4. Copy the endpoint id into the Studio's `RUNPOD_ENDPOINT_ID` secret (section 3b).

If your GHCR image is private, the endpoint needs registry credentials; a public image needs none
(make sure no stale registry credential is configured, or RunPod will try it and fail even a public
pull).

---

## 5. The CPU helper containers (optional, advanced)

`video-finish` / `image-prep` / `audio-beat-sync` run always-on as Docker on your own box and are
reached over private **Cloudflare VPC** bindings (`VIDEO_FINISH_VPC`, etc.). Bring them up with:

```bash
docker compose -p vivijure-media -f containers/compose.yaml up -d --build
```

Then create the VPC Services in the Cloudflare dashboard pointing at each container, and set the
`service_id` for each `[[vpc_services]]` binding in `wrangler.toml`. Without these, the Studio still
renders clips; it just can't do the final concat/mux or title cards.

---

## 6. Email notifications (optional)

The `notify-email` module sends "your film is done" mail via Cloudflare Email. It is the **only**
place an operator email matters. Bind your sending domain to Cloudflare Email and set the module's
config; everything else in the Studio is single-user and needs no email.

---

## Quick checklist

- [ ] Cloudflare API token (Workers/D1/R2/Vectorize/AI-Gateway scopes above) + account id
- [ ] RunPod API key + a Serverless endpoint running `vivijure-backend` (its id)
- [ ] R2 S3 access key/secret scoped to the render bucket
- [ ] AI Gateway slug (`GATEWAY_ID`) (+ `CF_AIG_TOKEN` for plan-enhance)
- [ ] `wrangler d1 create` + both `r2 bucket create`s, ids in `wrangler.toml`
- [ ] secrets set, migrations applied, **modules deployed before core**
- [ ] (optional) CPU containers up + VPC services wired
- [ ] render a test project end to end
