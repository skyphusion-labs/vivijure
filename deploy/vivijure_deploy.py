#!/usr/bin/env python3
"""vivijure-deploy: a guided installer that stands up the whole Vivijure stack on YOUR OWN
Cloudflare + RunPod accounts (BYO keys + GPU). One input surface, idempotent re-runs, a teardown.

This is the Phase 1 SKELETON (see issue #244 for the design + options survey). It implements:
  - the single input surface + correct secret handling (hidden prompts, never echoed or logged),
  - the provisioning-order SPINE with the cross-wiring constraints encoded (most importantly:
    seed the Cloudflare Secrets Store BEFORE deploying the workers -- a module worker's
    secrets_store_secrets binding fails at deploy if its secret does not yet exist; see #237),
  - idempotent reconcile scaffolding (a local state file: create-if-absent, never duplicate),
  - a teardown path.
The actual provider API calls are marked TODO(phase1) -- the spine, the order, and the secret
handling are the reviewable surface here.

WHAT THIS TOOL COLLECTS (and what it never will):
  COLLECTS: exactly three infra credentials, for YOUR accounts -- a Cloudflare account id, a
  Cloudflare API token, and a RunPod API key. Nothing else.
  NEVER: it does NOT collect, prompt for, store, or transmit any payment information, credit-card
  number, bank detail, or cryptocurrency wallet/seed/address (BTC/XMR/anything). A deploy tool has
  no business touching payment or wallet data; this one bills nothing and routes nothing. Vivijure is
  AGPL and you are encouraged to read this file end to end -- the secret surface is deliberately
  minimal and obvious.

Design ethos: Cloudflare-first, minimal deps (Python 3 stdlib + wrangler via npx; boto3 only for
the optional R2/volume seed step, lazily imported). No subscription, not-our-infra: your keys, your
GPU, your data.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------------------------------
# Constants: the concrete resource set this stack needs (mirrors the repo's wrangler.toml + #244).
# --------------------------------------------------------------------------------------------------

STATE_FILE = ".vivijure-deploy.json"  # resource ids only, NEVER secrets. Safe to commit? No -- gitignore it.

# R2 buckets the studio binds (render outputs + the doc/RAG store).
R2_BUCKETS = ("vivijure", "skyphusion-llm")
D1_DATABASE = "vivijure-studio"

# The secrets the studio + module workers read. Seeded into the account-level Cloudflare Secrets Store
# (see #237/#238), NOT via `wrangler secret put`. Keyed by the binding name the code reads.
#   from the user's input:   RUNPOD_API_KEY
#   minted/derived here:      RUNPOD_ENDPOINT_ID (from RunPod step), GATEWAY_ID (from the AI Gateway),
#                             R2_S3_ACCESS_KEY_ID / R2_S3_SECRET_ACCESS_KEY (scoped R2 token), etc.
STORE_SECRETS = (
    "RUNPOD_API_KEY",
    "RUNPOD_ENDPOINT_ID",
    "GATEWAY_ID",
    "R2_S3_ACCESS_KEY_ID",
    "R2_S3_SECRET_ACCESS_KEY",
    "R2_S3_ENDPOINT",
)

# RunPod serverless endpoints to stand up (each is an id the studio needs). The cloud-i2v passthroughs
# run through the backend endpoint; upscale + musetalk are dedicated. A first deploy can opt into a
# subset -- upscale/lipsync degrade gracefully.
RUNPOD_ENDPOINTS = ("vivijure-backend", "vivijure-upscale", "vivijure-musetalk")
GHCR_IMAGE = "ghcr.io/skyphusion-labs/vivijure-backend"  # public image -> NO registry auth (see note).


# --------------------------------------------------------------------------------------------------
# Inputs + secret handling (the part that must be exactly right).
# --------------------------------------------------------------------------------------------------


@dataclass
class Secrets:
    """The three infra credentials, held in memory only for the lifetime of one run. Never written to
    the state file, never logged, never passed on a command line (argv lands in shell history)."""

    cf_account_id: str
    cf_api_token: str
    runpod_api_key: str

    def presence(self) -> str:
        """A SAFE summary for the user: emits SET / missing only -- never a value. Uses the ${var:+SET}
        discipline (a presence test that cannot expand to the secret)."""
        def p(v: str) -> str:
            return "SET" if v else "missing"
        return (
            f"cloudflare_account_id={'SET' if self.cf_account_id else 'missing'} "
            f"cloudflare_api_token={p(self.cf_api_token)} "
            f"runpod_api_key={p(self.runpod_api_key)}"
        )


def collect_secrets(noninteractive_env: bool = False) -> Secrets:
    """Collect the three credentials via HIDDEN prompts (getpass: no terminal echo). Values are read
    straight into memory; nothing is printed back, logged, or stored. The account id is not secret
    (an identifier) but we still never echo the token/key.

    For CI/headless use, allow reading from the environment (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
    / RUNPOD_API_KEY) so a value never has to be typed where it could be captured -- still never argv.
    """
    if noninteractive_env:
        s = Secrets(
            cf_account_id=os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip(),
            cf_api_token=os.environ.get("CLOUDFLARE_API_TOKEN", "").strip(),
            runpod_api_key=os.environ.get("RUNPOD_API_KEY", "").strip(),
        )
    else:
        print("Enter your OWN account credentials. Input is hidden and is never echoed, logged, or stored.")
        print("(This tool collects ONLY these three. It never asks for payment, card, or wallet data.)\n")
        cf_account_id = input("  Cloudflare account id: ").strip()
        cf_api_token = getpass.getpass("  Cloudflare API token (hidden): ").strip()
        runpod_api_key = getpass.getpass("  RunPod API key (hidden): ").strip()
        s = Secrets(cf_account_id, cf_api_token, runpod_api_key)

    missing = [n for n, v in (
        ("cloudflare_account_id", s.cf_account_id),
        ("cloudflare_api_token", s.cf_api_token),
        ("runpod_api_key", s.runpod_api_key),
    ) if not v]
    if missing:
        die(f"missing required credential(s): {', '.join(missing)}")
    return s


# --------------------------------------------------------------------------------------------------
# Small helpers: logging that NEVER prints a secret, a stdlib HTTP call, subprocess for wrangler.
# --------------------------------------------------------------------------------------------------


def log(msg: str) -> None:
    print(f"[vivijure-deploy] {msg}")


def die(msg: str, code: int = 1) -> "None":
    print(f"[vivijure-deploy] ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def http_json(method: str, url: str, token: str, body: dict | None = None) -> dict:
    """A minimal stdlib HTTPS call returning parsed JSON. The bearer token rides in the header (never
    in the URL or argv). Used for the Cloudflare + RunPod REST APIs. Raises on non-2xx."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("authorization", f"Bearer {token}")
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode() or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        # Surface the status, NOT the request body (which may carry a secret).
        die(f"{method} {url.split('?')[0]} -> HTTP {e.code}")
    except urllib.error.URLError as e:
        die(f"{method} {url.split('?')[0]} -> network error: {e.reason}")
    return {}


def wrangler(args: list[str], *, cwd: Path, secret_stdin: str | None = None) -> None:
    """Run `npx wrangler ...`. A secret value (if any) is piped via STDIN, NEVER placed on argv (argv
    is visible in `ps` and shell history). CLOUDFLARE_API_TOKEN/ACCOUNT_ID are passed via the child
    env, not the command line."""
    cmd = ["npx", "wrangler", *args]
    log("wrangler " + " ".join(a for a in args if not a.startswith("-c") or True))
    proc = subprocess.run(
        cmd, cwd=str(cwd),
        input=(secret_stdin.encode() if secret_stdin is not None else None),
        # env is set by the caller (export CLOUDFLARE_* before invoking) -- not modeled in this stub.
    )
    if proc.returncode != 0:
        die(f"wrangler {' '.join(args[:2])} failed (exit {proc.returncode})")


def module_dirs(repo: Path) -> list[str]:
    """Enumerate the module workers to deploy (modules/<name>/wrangler.toml), deployed BEFORE the core."""
    mods = sorted(p.name for p in (repo / "modules").iterdir() if (p / "wrangler.toml").exists()) if (repo / "modules").is_dir() else []
    return mods


# --------------------------------------------------------------------------------------------------
# State: idempotent reconcile. Records resource ids (NEVER secrets) so a re-run reconciles and a
# teardown can delete by id.
# --------------------------------------------------------------------------------------------------


@dataclass
class State:
    path: Path
    data: dict = field(default_factory=dict)

    @classmethod
    def load(cls, repo: Path) -> "State":
        p = repo / STATE_FILE
        data = json.loads(p.read_text()) if p.exists() else {}
        return cls(p, data)

    def save(self) -> None:
        # Guard: refuse to persist anything that looks like a secret name -> value mapping.
        self.path.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n")

    def get(self, key: str):
        return self.data.get(key)

    def put(self, key: str, value) -> None:
        self.data[key] = value
        self.save()


# --------------------------------------------------------------------------------------------------
# The provisioning spine. ORDER MATTERS -- the comments encode the #244 cross-wiring constraints.
# Each step is reconcile-shaped: look up by name/id in state, create-if-absent, record the id.
# --------------------------------------------------------------------------------------------------


def preflight(repo: Path, s: Secrets) -> None:
    """Fail fast before touching anything: deps present, tokens actually valid, repo looks right."""
    if shutil.which("npx") is None:
        die("npx (Node) not found -- wrangler is required to deploy the workers")
    if not (repo / "wrangler.toml").exists():
        die(f"run from the vivijure repo root (no wrangler.toml at {repo})")
    # Validate the CF token with a real, harmless authenticated call (token verify).
    http_json("GET", "https://api.cloudflare.com/client/v4/user/tokens/verify", s.cf_api_token)
    # Validate the RunPod key (list endpoints; empty is fine).
    http_json("GET", "https://rest.runpod.io/v1/endpoints", s.runpod_api_key)
    log("preflight ok: deps present, both credentials valid")


def provision_cloudflare_infra(repo: Path, s: Secrets, st: State) -> None:
    """Step 1. The CF data-plane resources the workers bind, plus the scoped R2 S3 token the GPU
    backend uses. Reconciled by name. TODO(phase1): the create_* API calls."""
    log("provisioning Cloudflare infra (D1, R2 x2, AI Gateway, Access) ...")
    # TODO(phase1): D1 create_if_absent(D1_DATABASE) -> st.put('d1_id', ...)
    # TODO(phase1): for b in R2_BUCKETS: r2 create_if_absent(b)
    # TODO(phase1): AI Gateway create_if_absent -> GATEWAY_ID slug -> st.put('gateway_id', slug)
    # TODO(phase1): Access app create_if_absent for the studio domain (+ optional bypass service token)
    # TODO(phase1): mint a scoped R2 S3 API token (Object R/W on the render bucket) ->
    #               R2_S3_ACCESS_KEY_ID / R2_S3_SECRET_ACCESS_KEY / R2_S3_ENDPOINT (held in memory for seeding)
    raise NotImplementedError("provision_cloudflare_infra: implement create-if-absent calls (CF API)")


def provision_runpod(repo: Path, s: Secrets, st: State) -> dict:
    """Step 2. RunPod must come BEFORE secret-seeding because RUNPOD_ENDPOINT_ID is a seeded secret.
    Order within: registry-auth (only if the image is private) -> template (pin GHCR image) ->
    network volume -> endpoint. Returns {endpoint_name: endpoint_id}. Reconciled by name.

    GOTCHA encoded: for a PUBLIC GHCR image, leave containerRegistryAuthId UNSET. A stale/blank-but-
    present auth makes RunPod attempt auth and abort even a public pull."""
    log("provisioning RunPod (templates, volumes, endpoints) ...")
    # TODO(phase1): registry_auth = None for a public image; create_if_absent only if private.
    # TODO(phase1): for ep in RUNPOD_ENDPOINTS: template create (imageName=GHCR_IMAGE, env=R2_S3_*,
    #               containerRegistryAuthId=registry_auth) -> volume create -> endpoint create
    #               (templateId, networkVolumeId) -> record endpoint id.
    # TODO(phase1): optionally pre-seed the volume via the RunPod S3 API (boto3) to avoid a slow first job.
    raise NotImplementedError("provision_runpod: implement RunPod REST create-if-absent + capture ids")


def seed_secrets(repo: Path, s: Secrets, st: State, runpod_endpoints: dict) -> None:
    """Step 3. CRITICAL ORDER: seed the Secrets Store BEFORE deploying the workers. A module worker's
    secrets_store_secrets binding references a store secret by name; `wrangler deploy` FAILS if that
    secret does not yet exist (#237). Values flow from: the user's RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID
    (from step 2), GATEWAY_ID (from step 1), and the scoped R2 S3 creds (from step 1).

    Each value is piped to wrangler via STDIN (hidden), never argv. Re-run re-seeds rotated values."""
    log("seeding the Cloudflare Secrets Store (BEFORE deploy) ...")
    # TODO(phase1): wrangler secrets-store store create-if-absent -> store_id -> st.put('store_id', ...)
    # TODO(phase1): for name in STORE_SECRETS: resolve its value (from s / runpod_endpoints / step-1
    #               minted creds) and `wrangler secrets-store secret create <store> --name <name>
    #               --scopes workers` with the value on STDIN. Never --value, never argv.
    raise NotImplementedError("seed_secrets: implement Secrets Store seed (stdin-piped, before deploy)")


def run_migrations(repo: Path, s: Secrets) -> None:
    """Step 4. D1 schema migrations (Wrangler only -- Terraform cannot do this). Additive, idempotent."""
    log("applying D1 migrations ...")
    # wrangler d1 migrations apply vivijure-studio --remote   (env carries CLOUDFLARE_*)
    raise NotImplementedError("run_migrations: wrangler d1 migrations apply (after seed, before/with deploy)")


def deploy_workers(repo: Path, s: Secrets) -> None:
    """Step 5. Modules BEFORE the core (the core binds each module as a [[services]] dependency).
    Wrangler bundles + uploads. Only reachable AFTER seed_secrets (the store bindings must resolve)."""
    mods = module_dirs(repo)
    log(f"deploying {len(mods)} module workers, then the core ...")
    # TODO(phase1): for m in mods: wrangler(["deploy", "-c", f"modules/{m}/wrangler.toml"], cwd=repo)
    # TODO(phase1): wrangler(["deploy"], cwd=repo)  # the core
    raise NotImplementedError("deploy_workers: wrangler deploy modules then core (post-seed)")


def bring_up_containers(repo: Path) -> None:
    """Step 6 (Phase 2 / optional). The 3 CPU helper containers run on the user's OWN box (Docker),
    reached over CF VPC bindings. Without them the studio still renders clips; it just cannot do the
    final concat / title cards. Phase 2."""
    log("(phase 2) CPU containers + VPC services -- skipped in phase 1")


def finalize(repo: Path, st: State) -> None:
    log("done. studio URL + recorded resource ids are in " + str(repo / STATE_FILE))


# --------------------------------------------------------------------------------------------------
# Orchestration: up / down / plan.
# --------------------------------------------------------------------------------------------------


def cmd_up(repo: Path, dry_run: bool, noninteractive: bool) -> None:
    # The plan is order-only -- it needs NO credentials, so never prompt for secrets in a dry-run.
    if dry_run:
        log("PLAN (dry-run) -- order (no credentials needed, no changes made):")
        for i, name in enumerate([
            "preflight (deps + token validity)",
            "provision Cloudflare infra (D1, R2 x2, AI Gateway, Access, scoped R2 token)",
            "provision RunPod (registry-auth?, template, volume, endpoints) -> capture endpoint ids",
            "seed Cloudflare Secrets Store  <-- BEFORE deploy (#237)",
            "run D1 migrations",
            "deploy module workers, then the core",
            "(phase 2) bring up CPU containers + VPC services",
        ], 1):
            log(f"  {i}. {name}")
        return
    s = collect_secrets(noninteractive_env=noninteractive)
    log("credential presence: " + s.presence())  # SET/missing only
    st = State.load(repo)
    preflight(repo, s)
    provision_cloudflare_infra(repo, s, st)
    runpod_endpoints = provision_runpod(repo, s, st)
    seed_secrets(repo, s, st, runpod_endpoints)  # MUST precede deploy
    run_migrations(repo, s)
    deploy_workers(repo, s)
    bring_up_containers(repo)
    finalize(repo, st)


def cmd_down(repo: Path, delete_data: bool) -> None:
    """Teardown in reverse dependency order, by recorded id. R2 buckets + D1 hold user data and are
    LEFT in place unless --delete-data is given."""
    st = State.load(repo)
    log("teardown (reverse order, by recorded id) ...")
    # TODO(phase1): delete RunPod endpoints -> volumes -> templates -> registry auth (by id from state)
    # TODO(phase1): delete core + module workers, Access app, AI Gateway, Secrets Store secrets+store
    # TODO(phase1): if delete_data: delete R2 buckets + D1 (else leave them, warn)
    if not delete_data:
        log("NOTE: R2 buckets + D1 (your data) left intact. Re-run with --delete-data to remove them.")
    raise NotImplementedError("cmd_down: implement delete-by-id teardown")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        prog="vivijure-deploy",
        description="Stand up the Vivijure stack on YOUR Cloudflare + RunPod accounts (BYO keys). "
                    "Collects ONLY a CF account id + CF API token + RunPod API key. Never payment or wallet data.",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("up", help="provision + seed + deploy (idempotent; safe to re-run)")
    up.add_argument("--dry-run", action="store_true", help="print the ordered plan and exit (no changes)")
    up.add_argument("--noninteractive", action="store_true", help="read creds from env (CI/headless), never argv")
    sub.add_parser("plan", help="alias for `up --dry-run`")
    down = sub.add_parser("down", help="teardown by recorded id")
    down.add_argument("--delete-data", action="store_true", help="ALSO delete R2 buckets + D1 (your data)")

    args = ap.parse_args(argv)
    repo = Path.cwd()
    if args.cmd == "up":
        cmd_up(repo, dry_run=args.dry_run, noninteractive=args.noninteractive)
    elif args.cmd == "plan":
        cmd_up(repo, dry_run=True, noninteractive=False)
    elif args.cmd == "down":
        cmd_down(repo, delete_data=args.delete_data)


if __name__ == "__main__":
    main()
