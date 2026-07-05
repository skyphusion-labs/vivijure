#!/usr/bin/env python3
"""Provision the vivijure-backend RunPod Serverless endpoint (template + endpoint), IaC-style.

Replaces the manual console walk in docs/DEPLOYMENT.md section 4 with one command. Idempotent by
NAME: if a template/endpoint with the chosen name already exists, it is reused and its id printed;
re-running is always safe. Promoted from the cold-deploy dry run's proven one-off (2026-07-02,
finding F3): the exact template/endpoint shapes below stood up endpoint-per-fresh-account end to
end via REST v1.

SECRETS COME FROM THE ENVIRONMENT ONLY, never argv (argv is visible to every user in `ps`):

    RUNPOD_API_KEY            runpod.io -> Settings -> API Keys (read/write)
    CLOUDFLARE_ACCOUNT_ID     your CF account id (builds the R2 S3 endpoint URL)
    R2_S3_ACCESS_KEY_ID       R2 S3 credentials for the render bucket (DEPLOYMENT.md 2c)
    R2_S3_SECRET_ACCESS_KEY

The simplest way to load them is your existing deploy.env:

    set -a; . ./deploy.env; set +a
    python3 scripts/runpod-provision.py

On success the last line is `RUNPOD_ENDPOINT_ID=<id>`; put that value in deploy.env and run
./deploy.sh. The endpoint is created scale-to-zero (workersMin=0), so it costs nothing until a
render job actually runs. No network volume is attached (the backend self-preloads models from R2
on cold start); attach one later via the RunPod API/console if you want warm weights.

FINISH SATELLITES (#522). Pass --satellite to provision a finish endpoint instead of the backend:

    python3 scripts/runpod-provision.py --satellite upscale        # video upscale (vivijure-upscale)
    python3 scripts/runpod-provision.py --satellite lipsync        # MuseTalk (vivijure-musetalk)
    python3 scripts/runpod-provision.py --satellite audio-upscale  # speech (vivijure-audio-upscale)

A satellite endpoint reads/writes YOUR R2 bucket directly, so it needs the four R2 env vars
(R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) on its template -- which this
script sets for you from the same deploy.env values. The last line prints the deploy.env / store key
for that satellite (e.g. VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID=<id>). Set it in deploy.env and run
./deploy.sh with VIVIJURE_PROFILE=satellites.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://rest.runpod.io/v1"

# The serverless backend image is CUDA >= 12.8 (Blackwell/Hopper-class ONLY, per Conrad ruling F5/#517):
# a consumer/mid-range card (RTX 4090 / A5000 / L4) crash-loops the worker at startup. Default to the
# recommended datacenter set; the full proven pool is RTX 6000 PRO / H200 / B200 (docs/DEPLOYMENT.md
# section 4). Override with --gpu-types only with other same-class (sm_90+) SKUs you have allocated.
DEFAULT_GPU_TYPES = "NVIDIA H200,NVIDIA B200"
# The backend image is pinned to a specific release tag, NOT :latest (#518): a floating tag silently
# changes what a provisioned endpoint runs on the next push. Bump this on a vivijure-backend release
# (it is the current GHCR bare tag; the image tag drops the git backend-v prefix). Override per run
# with --image ghcr.io/skyphusion-labs/vivijure-backend:X.Y.Z.
DEFAULT_IMAGE_TAG = "0.4.4"
DEFAULT_IMAGE = "ghcr.io/skyphusion-labs/vivijure-backend:" + DEFAULT_IMAGE_TAG


# Finish SATELLITES (#522): each runs on its OWN RunPod endpoint and reads/writes YOUR R2 bucket
# directly, so its template env needs the four R2 vars (R2_ENDPOINT_URL / R2_ACCESS_KEY_ID /
# R2_SECRET_ACCESS_KEY / R2_BUCKET -- note satellites use R2_ENDPOINT_URL, unlike the backend's
# R2_ENDPOINT). The vivijure deploy path only ever collected the endpoint IDS, so a bare satellite
# endpoint hit the operator with an R2-mode error at the FIRST full render (finding F10). `tag` is the
# pinned release where one exists; None means that image has no semver release yet (only :latest), so
# provisioning it needs --allow-latest until the repo cuts one. `endpoint_var` is the deploy.env /
# store key deploy.sh reads for that satellite's id.
SATELLITES = {
    "upscale": {
        "image_repo": "vivijure-upscale", "tag": "0.2.7",
        "endpoint_var": "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID",
    },
    "lipsync": {
        "image_repo": "vivijure-musetalk", "tag": "0.1.0",
        "endpoint_var": "MUSETALK_RUNPOD_ENDPOINT_ID",
    },
    "audio-upscale": {
        "image_repo": "vivijure-audio-upscale", "tag": "0.1.0",
        "endpoint_var": "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID",
    },
}


def die(msg: str) -> "None":
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


def need_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        die("missing required env var %s (load deploy.env: set -a; . ./deploy.env; set +a)" % name)
    return val


def call(key: str, method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]


def listing(payload, key):
    """REST v1 list endpoints return either a bare array or {key: [...]}; accept both."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get(key) or []
    return []


def find_by_name(items, name):
    for it in items:
        if isinstance(it, dict) and it.get("name") == name:
            return it
    return None


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Provision a vivijure RunPod serverless endpoint (idempotent by name): the backend "
                    "by default, or a finish satellite with --satellite. Secrets via env only; see the "
                    "module docstring.")
    ap.add_argument("--satellite", choices=sorted(SATELLITES), default=None,
                    help="provision a finish SATELLITE endpoint (its image + the four R2 env vars) "
                         "instead of the backend (#522): upscale / lipsync / audio-upscale")
    ap.add_argument("--name", default=None, help="template + endpoint name (default: derived from the target)")
    ap.add_argument("--image", default=None, help="image ref (default: the pinned image for the target)")
    ap.add_argument("--allow-latest", action="store_true",
                    help="accept a floating :latest image tag (default REJECTS it; the backend default is pinned)")
    ap.add_argument("--disk-gb", type=int, default=20, help="container disk GiB (default: %(default)s)")
    ap.add_argument("--gpu-types", default=DEFAULT_GPU_TYPES,
                    help="comma-separated RunPod GPU type ids (default: %(default)s). Satellites can run on "
                         "cheaper GPUs than the backend; override here if you want to.")
    ap.add_argument("--workers-max", type=int, default=1,
                    help="max concurrent workers; counts against the ACCOUNT-WIDE worker cap (default: %(default)s)")
    ap.add_argument("--idle-timeout", type=int, default=5, help="seconds before an idle worker scales down (default: %(default)s)")
    ap.add_argument("--bucket", default="vivijure", help="R2 render bucket name (default: %(default)s)")
    args = ap.parse_args()

    # Resolve the provisioning target: the backend (default) or one finish satellite (#522). Each target
    # has its own default name, default image, template env, and the deploy.env/store key its id prints as.
    if args.satellite:
        sat = SATELLITES[args.satellite]
        name = args.name or sat["image_repo"]
        image = args.image or ("ghcr.io/skyphusion-labs/%s:%s" % (sat["image_repo"], sat["tag"] or "latest"))
        endpoint_var = sat["endpoint_var"]
    else:
        name = args.name or "vivijure-backend"
        image = args.image or DEFAULT_IMAGE
        endpoint_var = "RUNPOD_ENDPOINT_ID"

    # Hard rules (learned the expensive way):
    #  - A git-sha tag does not re-provision correctly and needs manual repair -- always rejected.
    #  - :latest FLOATS: a later image push silently changes what the endpoint runs. DEPLOYMENT.md
    #    section 4 mandates pinning the GHCR image tag, so the recommended path (defaults) must produce
    #    a pinned endpoint, not a floating one (#518). Reject a bare :latest unless --allow-latest is an
    #    explicit, deliberate opt-in. The backend default is a pinned release (DEFAULT_IMAGE_TAG); a
    #    satellite with no pinned release yet (SATELLITES[...]['tag'] is None) needs --allow-latest.
    repo_ref = image.rsplit(":", 1)[0] if ":" in image.split("/")[-1] else image
    tag = image.rsplit(":", 1)[1] if ":" in image.split("/")[-1] else "latest"
    if re.fullmatch(r"\d+\.\d+\.\d+", tag):
        pass  # a pinned bare semver -- the recommended shape
    elif tag == "latest":
        if not args.allow_latest:
            hint = "The backend default is the pinned :%s." % DEFAULT_IMAGE_TAG
            if args.satellite and SATELLITES[args.satellite]["tag"] is None:
                hint = ("The %s image has no pinned release yet (only :latest), so this satellite needs "
                        "--allow-latest until its repo cuts one." % SATELLITES[args.satellite]["image_repo"])
            die("refusing to provision an endpoint pinned to a floating :latest tag: a later image push "
                "would silently change what it runs (DEPLOYMENT.md section 4 mandates a pinned tag). Pass "
                "--image %s:X.Y.Z to pin a release, or --allow-latest to accept the floating tag "
                "deliberately. %s" % (repo_ref, hint))
    else:
        die("image tag ':%s' is neither a bare semver :X.Y.Z nor :latest; never pin a RunPod endpoint "
            "to a git sha tag (it does not re-provision correctly)." % tag)

    key = need_env("RUNPOD_API_KEY")
    acc = need_env("CLOUDFLARE_ACCOUNT_ID")
    r2_key = need_env("R2_S3_ACCESS_KEY_ID")
    r2_secret = need_env("R2_S3_SECRET_ACCESS_KEY")
    r2_endpoint = "https://%s.r2.cloudflarestorage.com" % acc

    # Template env. HANDLER-side names (finding F17): the R2_S3_* names are the deploy.env PASTE names
    # only; the containers gate on these. Satellites read/write R2 directly and require R2_ENDPOINT_URL
    # (#522, F10); the backend requires R2_ENDPOINT + HF_HUB_OFFLINE.
    if args.satellite:
        template_env = {
            "R2_ENDPOINT_URL": r2_endpoint,
            "R2_ACCESS_KEY_ID": r2_key,
            "R2_SECRET_ACCESS_KEY": r2_secret,
            "R2_BUCKET": args.bucket,
        }
    else:
        template_env = {
            "R2_ACCESS_KEY_ID": r2_key,
            "R2_SECRET_ACCESS_KEY": r2_secret,
            "R2_BUCKET": args.bucket,
            "R2_ENDPOINT": r2_endpoint,
            "HF_HUB_OFFLINE": "1",
        }

    # ---- endpoint already there? (idempotency, checked FIRST so re-runs are one GET) ----
    s, eps = call(key, "GET", "/endpoints")
    if s != 200:
        die("could not list endpoints (HTTP %s): %s" % (s, eps))
    existing = find_by_name(listing(eps, "endpoints"), name)
    if existing:
        print("endpoint '%s' already exists; reusing it" % name)
        print("%s=%s" % (endpoint_var, existing.get("id")))
        return

    # ---- template (reuse by name, else create) ----
    s, tpls = call(key, "GET", "/templates")
    if s != 200:
        die("could not list templates (HTTP %s): %s" % (s, tpls))
    tpl = find_by_name(listing(tpls, "templates"), name)
    if tpl:
        tid = tpl.get("id")
        print("template '%s' already exists (%s); reusing it" % (name, tid))
    else:
        s, t = call(key, "POST", "/templates", {
            "name": name,
            "imageName": image,
            "isServerless": True,
            "containerDiskInGb": args.disk_gb,
            "env": template_env,
        })
        if s not in (200, 201):
            die("template create failed (HTTP %s): %s" % (s, t))
        tid = t.get("id")
        print("created template '%s' (%s)" % (name, tid))

    # ---- endpoint (scale-to-zero; costs nothing until a job runs) ----
    s, e = call(key, "POST", "/endpoints", {
        "name": name,
        "templateId": tid,
        "computeType": "GPU",
        "gpuTypeIds": [g.strip() for g in args.gpu_types.split(",") if g.strip()],
        "gpuCount": 1,
        "workersMin": 0,
        "workersMax": args.workers_max,
        "idleTimeout": args.idle_timeout,
        "scalerType": "QUEUE_DELAY",
        "scalerValue": 4,
    })
    if s not in (200, 201):
        die("endpoint create failed (HTTP %s): %s" % (s, e))
    eid = e.get("id")
    print("created endpoint '%s'" % name)
    print("next: set this in deploy.env, then run ./deploy.sh")
    print("%s=%s" % (endpoint_var, eid))


if __name__ == "__main__":
    main()
