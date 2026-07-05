# Quick start: put your studio online

This is the short path. Fill in your keys once, run one script, and you have a working Vivijure
Studio that can write a storyboard and render it to video. It takes a few steps, not a weekend.

When you finish this page you will have the **standard install**: the studio core, cloud and own-GPU
render, and the **media stack** (the always-on CPU helpers that assemble your rendered clips into one
finished film, add title cards, and polish the audio). The media stack is standard because the film
assembly step runs inside it: without it, a render gives you a folder of separate clips, not a single
movie. The only things NOT included are the three GPU "finish" satellites (sharper video, lip-sync);
those cost extra GPU money and stay opt-in (see [opt-in-tiers.md](opt-in-tiers.md)).

New here? The one-page picture of how the parts fit together is in
[constellation.md](constellation.md). You are about to stand up the **Studio** box in the center of
that map.

## Before you start

You need two accounts and one tool:

- A **Cloudflare** account (hosts the studio and your data). Sign up at dash.cloudflare.com.
- A **RunPod** account (rents the GPUs that render your video). Sign up at runpod.io.
- **Node 22 or newer** on your computer.
- **Docker** on the computer that will run the media-stack containers (usually the same computer). The
  media stack is five small always-on CPU containers; `docker compose` starts them.

> **A note on cost.** Vivijure runs on your own accounts and you pay your own bills. The good news:
> the full standard install fits Cloudflare's **free** plan. You can install it free and render films
> free; you pay only for what you use (RunPod GPU seconds, cloud render API calls, and the AI Gateway
> credits the planner spends, or $0 if you render on your own GPU). This is live-proven: a brand-new
> free-plan account ran the whole 23-module standard bundle and rendered finished 1080p films on all
> three render paths (own GPU, cloud, and local GPU). The one thing that needs Cloudflare's **Workers
> Paid** plan ($5/month) is the three GPU "finish" satellites (sharper video, lip-sync); everything on
> this page runs free. One caveat: a plan change (free to paid, or back) only takes effect after you
> redeploy the core, because a running Worker keeps the plan it was deployed under.

You do **not** need to own a domain. The studio ships with its own login (a studio API token the
deploy script mints for you), and it can serve on the free `workers.dev` address that comes with
your Cloudflare account. If you do own a domain in Cloudflare, you can use that instead; either
way, put the address you picked in `DEPLOY_HOSTNAME` in your key file.

## Two dashboard steps the script cannot do for you

1. **Enable R2** (Cloudflare's storage). It is a one-time terms-and-billing acceptance that only
   works in the dashboard. Open <https://dash.cloudflare.com/?to=/:account/r2> and click through
   the enable screen. Skip this and the deploy stops at the bucket step and prints this same link.
2. **Load AI credits** (they pay for storyboard writing; $10 minimum plus a small card fee). Do
   this AFTER you create your AI Gateway -- the credits page only appears once a gateway exists.
   The click-by-click walkthrough, with screenshots, is in
   [DEPLOYMENT.md](DEPLOYMENT.md) section 2d.

## The keys you will paste in

The deploy asks for a handful of keys. Each one is for **your own** account, and you pay your own
bills. This page just lists them; [DEPLOYMENT.md](DEPLOYMENT.md) sections 2a-2d show exactly where
to click to get each one, and why each is needed.

- Cloudflare **account id** and an **API token** (scoped to your account; 2a has the exact
  permission list).
- RunPod **API key** and your **endpoint id** (the RunPod endpoint running the render backend).
  No endpoint yet? `python3 scripts/runpod-provision.py` creates one for you (DEPLOYMENT.md
  section 4).
- Two **R2 storage keys** (an access key and secret) for the GPU backend.
- An **AI Gateway** slug (routes and bills the storyboard-writing calls).
- Optionally `CF_AIG_TOKEN`, the token that lets the planner spend your AI credits. Leave it
  blank: the script mints one for you when your API token carries the one extra permission
  listed in 2a. If it cannot, the deploy still finishes and prints the exact steps to do it
  by hand.

There is no login key to create. The script mints your studio's login token itself and prints it
once at the end -- save it like a password.

## The three steps

```bash
# 1. Make your key file from the example, then open it and fill in your keys.
cp deploy.env.example deploy.env

# 2. Set DEPLOY_HOSTNAME in deploy.env to where your studio should live
#    (your domain, or your free workers.dev address -- the file shows both).

# 3. Deploy. This is safe to re-run.
./deploy.sh
```

That is it for the Cloudflare side. The script installs its own npm tools on first run. Leave
`VIVIJURE_PROFILE=standard` (the default) in `deploy.env` for your first deploy. One more step brings
up the media-stack containers on your own box -- see just below.

> **Keep `deploy.env` private.** It holds your keys. It is already set to be ignored by git, so it
> will not be committed. Never share it or paste it anywhere.

## Bring up the media stack

`deploy.sh` set up the Cloudflare side of the media stack for you: the tunnel and the private VPC
links the studio uses to reach your containers. The last piece is starting those containers on your
own computer:

```bash
docker network create vivijure                        # once, if it does not exist
docker compose -f containers/compose.yaml up -d --build
```

That starts the five CPU helpers (film assembly, image prep, audio beat-sync, audio mix, audio
master). The `cloudflared` service in that compose file already has its connector token wired in by
the deploy (`containers/tunnel.env`), so the studio can reach the containers privately. The full
walk-through is [DEPLOYMENT.md](DEPLOYMENT.md) section 5.

If you skip this step, your studio still deploys and still renders; a finished render just delivers
your separate clips instead of one assembled film, with a clear "finish unavailable" status. Start the
containers whenever you want finished films.

## What the script does for you

You do not have to run any of this by hand. The script:

1. Installs the code's tools (`npm ci`) if they are missing.
2. Creates your database and your two storage buckets (skips them if they already exist).
3. Puts your module secrets into Cloudflare's Secrets Store.
4. Writes the real `wrangler.toml` config from the template, for your profile and hostname
   (including the `workers.dev` switch if that is where you deploy).
5. Applies the database setup.
6. Deploys the render modules first, then the studio core (the order Cloudflare requires).
7. Sets the studio's secrets, arms the storyboard planner (the AI Gateway token and the
   gateway's authentication switch), mints your **studio API token**, and prints that token
   ONCE at the end.

If anything is missing or wrong, it **stops right there** and tells you, so you never end up with a
half-built studio.

## Your login: the studio API token

The last lines of a green deploy print your studio API token. It is shown ONCE and stored nowhere
else -- copy it somewhere safe, like a password manager.

The studio does no other login checking, but it **fails closed**: every `/api/*` request needs
this token, so without it nobody (including you) can read or change anything. Open your studio's
web address; the page asks for the token before showing your work; paste it once and your browser
remembers it. API callers send it as `Authorization: Bearer <token>`.

Lost it? Mint a new one and paste that instead:

```bash
openssl rand -hex 32 | npx wrangler secret put STUDIO_API_TOKEN
```

Want a stronger front door (single sign-on, a team, audit logs)? That is Cloudflare Access, the
optional hardening path: set `AUTH_MODE=access` in `deploy.env` (the script then requires the two
`ACCESS_*` values and refuses to run without them). Details in [SECURITY.md](SECURITY.md).

## Make your first film

Open your studio's web address in a browser and paste your token when asked. Create a project,
write a short storyboard, add a cast member, and render. The page builds itself from the modules
you installed, so everything you turned on shows up on its own.

Remember: the storyboard planner spends your **AI credits** (dashboard step 2 above), and renders
spend your **RunPod** balance. If the planner refuses with a billing error, load credits on the
gateway's Credits page (DEPLOYMENT.md 2e).

## Growing later

Title cards, on-screen text, beat-synced music, and audio mastering are already part of your standard
install -- they run on the media stack you just started. When you want the GPU "finish" satellites --
sharper video (upscale) or talking characters (lip-sync) -- those are the **opt-in add-ons**. Each one
is explained in plain words -- what it is, what it adds, and how to turn it on -- in
[opt-in-tiers.md](opt-in-tiers.md). When you are ready, set `VIVIJURE_PROFILE=satellites` in
`deploy.env` (after standing up the extra RunPod endpoints) and run `./deploy.sh` again.

## If something goes wrong

- The script prints a clear error and stops. Read the last line; it names what is missing.
- Re-running is safe. Fix the value in `deploy.env` and run `./deploy.sh` again.
- For a manual, step-by-step walk-through of every piece, use [DEPLOYMENT.md](DEPLOYMENT.md).
