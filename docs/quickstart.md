# Quick start: put your studio online

This is the short path. Fill in your keys once, run one script, and you have a working Vivijure
Studio that can write a storyboard and render it to video. It takes a few steps, not a weekend.

When you finish this page you will have the **minimal profile**: the studio core plus cloud and
own-GPU render. That is the whole thing most people need. You can add the extra "finish" parts later
(see [opt-in-tiers.md](opt-in-tiers.md)); you do not need them to start.

New here? The one-page picture of how the parts fit together is in
[constellation.md](constellation.md). You are about to stand up the **Studio** box in the center of
that map.

## Before you start

You need two accounts and one tool:

- A **Cloudflare** account (hosts the studio and your data). Sign up at dash.cloudflare.com.
- A **RunPod** account (rents the GPUs that render your video). Sign up at runpod.io.
- **Node 22 or newer** on your computer, then run `npm install` in this folder once.

You also need a **web address you own** in Cloudflare (a domain in your account), because the studio
has no built-in login and must sit behind Cloudflare Access. More on that in step 4.

## The keys you will paste in

The deploy asks for a handful of keys. Each one is for **your own** account, and you pay your own
bills. This page just lists them; [DEPLOYMENT.md](DEPLOYMENT.md) sections 2a-2d show exactly where to
click to get each one, and why each is needed.

- Cloudflare **account id** and an **API token** (scoped to your account).
- RunPod **API key** and your **endpoint id** (the RunPod endpoint running the render backend).
- Two **R2 storage keys** (an access key and secret) for the GPU backend.
- An **AI Gateway** slug (routes the writing/planning calls).
- Cloudflare **Access** team domain and AUD (these lock down your studio -- required).

## The three steps

```bash
# 1. Install the code's tools (once).
npm install

# 2. Make your key file from the example, then open it and fill in your keys.
cp deploy.env.example deploy.env

# 3. Deploy. This is safe to re-run.
./deploy.sh
```

That is it. Leave `VIVIJURE_PROFILE=minimal` in `deploy.env` for your first deploy.

> **Keep `deploy.env` private.** It holds your keys. It is already set to be ignored by git, so it
> will not be committed. Never share it or paste it anywhere.

## What the script does for you

You do not have to run any of this by hand. The script:

1. Creates your database and your two storage buckets (skips them if they already exist).
2. Puts your module secrets into Cloudflare's Secrets Store.
3. Writes the real `wrangler.toml` config from the template, for the minimal profile.
4. Applies the database setup.
5. Deploys the render modules first, then the studio core (the order Cloudflare requires).
6. Sets the studio's secrets.

If anything is missing or wrong, it **stops right there** and tells you, so you never end up with a
half-built studio.

## Step 4: lock it down (required)

The studio does **no** login checking on its own. Anyone who can reach its web address can read and
delete every project. So you **must** put **Cloudflare Access** in front of your hostname:

1. In Cloudflare, go to **Zero Trust -> Access -> Applications**.
2. Add an application for your studio's web address.
3. Let only yourself (your email) in.

The `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` you put in `deploy.env` turn on a second check inside the
studio itself, so it fails safe even if the front door is misconfigured. Full details in
[SECURITY.md](SECURITY.md). The deploy script **refuses to run** if you leave these two blank.

## Make your first film

Open your studio's web address in a browser (after Access lets you in). Create a project, write a
short storyboard, add a cast member, and render. The page builds itself from the modules you
installed, so everything you turned on shows up on its own.

## Growing later

When you want sharper video, talking characters (lip-sync), title cards, or beat-synced music, those
are the **opt-in tiers**. Each one is explained in plain words -- what it is, what it adds, and how to
turn it on -- in [opt-in-tiers.md](opt-in-tiers.md). When you are ready, set `VIVIJURE_PROFILE=full`
in `deploy.env` (after standing up the extra pieces) and run `./deploy.sh` again.

## If something goes wrong

- The script prints a clear error and stops. Read the last line; it names what is missing.
- Re-running is safe. Fix the value in `deploy.env` and run `./deploy.sh` again.
- For a manual, step-by-step walk-through of every piece, use [DEPLOYMENT.md](DEPLOYMENT.md).
