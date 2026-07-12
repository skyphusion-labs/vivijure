#!/usr/bin/env python3
"""vivijure-deploy: a guided installer that stands up the whole Vivijure stack on YOUR OWN
Cloudflare + RunPod accounts (BYO keys + GPU). One input surface, idempotent re-runs, a teardown.

What it does (see issue #244 for the design + options survey):
  - one input surface + correct secret handling (hidden prompts, never echoed, logged, or on argv),
  - the full provisioning spine: Cloudflare (D1, R2 x2, AI Gateway, Secrets Store + an R2 S3 token
    mint, plus a CF Access app ONLY when AUTH_MODE=access), then RunPod (a serverless template +
    endpoint per satellite, volume-less), then seed -> migrate -> deploy. In the default AUTH_MODE=token the studio's /api/* gate
    is a built-in bearer token (STUDIO_API_TOKEN worker secret, minted + printed once); no CF Access,
    no Zero Trust dashboard step. AUTH_MODE=access provisions the edge Access app + arms the in-worker
    JWT backstop instead. This mirrors deploy.sh; see docs/SECURITY.md sections 1b (token) and 1/1a. The cross-wiring order is enforced -- most importantly the Secrets Store is seeded BEFORE
    the workers deploy (a module's secrets_store_secrets binding fails at deploy if its secret does
    not yet exist; see #237), and RunPod endpoint ids are captured before RUNPOD_ENDPOINT_ID is seeded,
  - idempotent reconcile (a local state file of resource IDS, never secrets: create-if-absent),
  - `up` / `plan` / `down` -- teardown removes the RunPod + CF resources it created, by recorded id.

HONESTY NOTE: the provider calls are REAL. `up` provisions against YOUR live Cloudflare + RunPod
accounts -- it mints an R2 API token, creates an Access app, RunPod endpoints, etc. The calls are
written against the CF/RunPod API docs + the RunPod OpenAPI, but have NOT been integration-tested end
to end on a live account; treat the first run accordingly. A few values you MUST set before a live run
(DEPLOY_DOMAIN, OPERATOR_EMAIL for access mode; GPU_TYPE_IDS) are flagged at the top and the run dies
loud if any is missing. The per-endpoint image tags default to each satellite released tag.

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
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
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
STORE_NAME = "vivijure"  # the account-level Secrets Store name (#237/#238)
# The placeholder the module wrangler.tomls ship with (#237). After creating the store the installer
# replaces it with the real store id so the secrets_store_secrets bindings resolve at deploy.
STORE_ID_PLACEHOLDER = "REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID"
# Single-tenant studio gating (config, NOT secrets -- set these for your deploy):
DEPLOY_DOMAIN = ""    # AUTH_MODE=access only: the studio hostname behind CF Access (the edge app host)
OPERATOR_EMAIL = ""   # AUTH_MODE=access only: the one email allowed through the Access self-only policy

# The /api/* auth gate (mirrors deploy.sh + src/auth-gate.ts). "token" (default -- the self-host
# quickstart) mints a STUDIO_API_TOKEN worker secret and gates on Authorization: Bearer; NO Cloudflare
# Access, no Zero Trust dashboard step. "access" puts CF Access at the edge and arms the in-worker JWT
# backstop (needs the two PUBLIC Zero-Trust identifiers below). See docs/SECURITY.md 1b / 1 / 1a.
AUTH_MODE = "token"
ACCESS_TEAM_DOMAIN = ""  # AUTH_MODE=access only: your Zero Trust team hostname (public identifier)
ACCESS_AUD = ""          # AUTH_MODE=access only: the studio Access application AUD (public identifier)

# The secrets the studio + module workers read. Seeded into the account-level Cloudflare Secrets Store
# (see #237/#238), NOT via `wrangler secret put`. Keyed by the binding name the code reads.
#   from the user's input:   RUNPOD_API_KEY
#   minted/derived here:      RUNPOD_ENDPOINT_ID (from RunPod step), GATEWAY_ID (from the AI Gateway),
#                             R2_S3_ACCESS_KEY_ID / R2_S3_SECRET_ACCESS_KEY (scoped R2 token), etc.
# The store keys are the UNION of every `secret_name` the deployed workers bind across
# wrangler.toml.example + all modules/*/wrangler.toml (test_secret_map.py asserts this manifest stays
# in sync with the tomls). NOTE the store key is the `secret_name`, NOT the in-code binding var: e.g.
# finish-lipsync binds var RUNPOD_ENDPOINT_ID FROM store secret MUSETALK_RUNPOD_ENDPOINT_ID. The old
# seed set (a bare RUNPOD_ENDPOINT_ID) was read by NOTHING -- the core binds BACKEND_RUNPOD_ENDPOINT_ID
# and the satellites bind their own per-endpoint names (#658). Grouped by how the value is sourced.
AUTO_STORE_NAMES = (       # the installer resolves + seeds these (user key / RunPod ids / CF derived)
    "RUNPOD_API_KEY",
    "BACKEND_RUNPOD_ENDPOINT_ID",
    "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID",
    "MUSETALK_RUNPOD_ENDPOINT_ID",
    "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID",
    "GATEWAY_ID",
    "R2_S3_ACCESS_KEY_ID",
    "R2_S3_SECRET_ACCESS_KEY",
)
OPERATOR_STORE_NAMES = (   # the operator supplies these post-install; seeded as a MARKED placeholder
    "CF_AIG_TOKEN",              #   so the module deploy resolves (else 10182), then flagged to replace.
    "PLAN_ENHANCE_CF_AIG_TOKEN",
    "LOCAL_BACKEND_URL",
    "LOCAL_BACKEND_TOKEN",
)
STORE_BINDING_NAMES = AUTO_STORE_NAMES + OPERATOR_STORE_NAMES

# Which RunPod endpoint id seeds which store secret name (the core + each finish satellite read a
# DISTINCT per-endpoint store key). Keys MUST equal RUNPOD_ENDPOINTS.
ENDPOINT_SECRET_NAMES = {
    "vivijure-backend": "BACKEND_RUNPOD_ENDPOINT_ID",
    "vivijure-upscale": "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID",
    "vivijure-musetalk": "MUSETALK_RUNPOD_ENDPOINT_ID",
    "vivijure-audio-upscale": "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID",
}

# Seeded for the operator-supplied class so the module deploy resolves; the operator replaces it
# post-install (finalize prints the checklist). Deliberately obvious + non-functional.
OPERATOR_PLACEHOLDER = "REPLACE_ME__vivijure-deploy-operator-secret"

# RunPod serverless endpoints to stand up (each is an id the studio needs). Each finish satellite runs
# its OWN container image (see runpod_images()); a satellite templated with the backend image fails
# every finish job (#678). audio-upscale is first-class -- modules/speech-upscale binds
# AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID (#658). A first deploy can opt into a subset -- upscale/lipsync
# degrade gracefully.
RUNPOD_ENDPOINTS = ("vivijure-backend", "vivijure-upscale", "vivijure-musetalk", "vivijure-audio-upscale")


# --------------------------------------------------------------------------------------------------
# Instance isolation (#244). DEPLOY_PREFIX is the ONE seam that lets a SECOND instance stand up on the
# SAME Cloudflare account without colliding with (or silently adopting) the first -- a second studio, a
# proving run beside a live service, a name coincidence. Default EMPTY = today's verbatim behavior,
# byte-for-byte, zero delta for a real outsider.
# --------------------------------------------------------------------------------------------------

DEPLOY_PREFIX = ""  # e.g. "proving" -> every globally-named resource becomes "proving-<name>". Empty = verbatim.

# Runtime flag (NOT a constant): `up --adopt` opts INTO reusing a pre-existing same-name resource this
# instance did not create. Default False = REFUSE to silently adopt (guards a shared account).
_ADOPT = False


def prefixed(name: str) -> str:
    """The ONE name-derivation seam. Empty DEPLOY_PREFIX -> the name verbatim (zero delta). Set ->
    "<prefix>-<name>". EVERY globally-scoped resource name (D1, both R2 buckets, the Secrets Store, the
    AI Gateway slug, the R2 S3 token, the core + module worker names, the state file) derives through
    here -- never string-scatter the prefix."""
    p = DEPLOY_PREFIX.strip()
    return f"{p}-{name}" if p else name


def state_file_name() -> str:
    """The per-instance state file. Prefixed so two instances on one account keep disjoint state (the
    leading dot of the hidden file is preserved; the prefix goes after it)."""
    p = DEPLOY_PREFIX.strip()
    return f".{p}-vivijure-deploy.json" if p else STATE_FILE


def token_file_name() -> str:
    """The 0600 file the operator STUDIO_API_TOKEN is written to under --noninteractive (#681), beside
    the state file. Prefixed like the state file so two instances stay disjoint."""
    p = DEPLOY_PREFIX.strip()
    return f".{p}-vivijure-studio-token" if p else ".vivijure-studio-token"


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

    # Presence map holds BOOLEANS only: the credential values themselves never enter the data
    # structure the logged `missing` names are derived from, so no static-analysis taint path
    # (and no future refactor accident) can carry a value into die()/log().
    present = {
        "cloudflare_account_id": bool(s.cf_account_id),
        "cloudflare_api_token": bool(s.cf_api_token),
        "runpod_api_key": bool(s.runpod_api_key),
    }
    missing = [n for n, ok in present.items() if not ok]
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


class DeployHTTPError(Exception):
    """A non-2xx / network failure surfaced to a caller that wants to RECOVER (the RunPod
    create-500-after-success flake, #675, or a delete-on-missing, #682) rather than die(). Carries the
    status code only -- never the request body (which may hold a secret). URL is path-only."""
    def __init__(self, method: str, url: str, code):
        self.method, self.url, self.code = method, url.split("?")[0], code
        super().__init__(f"{method} {self.url} -> HTTP {code}")


def http_json(method: str, url: str, token: str, body: dict | None = None, *, raise_on_error: bool = False) -> dict:
    """A minimal stdlib HTTPS call returning parsed JSON. The bearer token rides in the header (never
    in the URL or argv). Used for the Cloudflare + RunPod REST APIs. Non-2xx die()s by default;
    raise_on_error=True raises DeployHTTPError instead so a caller can recover (#675/#682)."""
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
        if raise_on_error:
            raise DeployHTTPError(method, url, e.code)
        die(f"{method} {url.split('?')[0]} -> HTTP {e.code}")
    except urllib.error.URLError as e:
        if raise_on_error:
            raise DeployHTTPError(method, url, None)  # network-level: no HTTP status
        die(f"{method} {url.split('?')[0]} -> network error: {e.reason}")
    return {}


CF_API = "https://api.cloudflare.com/client/v4"
AI_GATEWAY_ID = "vivijure"  # the AI Gateway slug -> becomes the GATEWAY_ID secret


def cf_api(method: str, path: str, token: str, body: dict | None = None):
    """Cloudflare API v4 call. Unwraps the {result, success, errors} envelope and dies on success:false,
    surfacing the error MESSAGE only (never the request body, which may carry a secret). `path` is
    relative to CF_API and may carry an /accounts/{acct}/ prefix."""
    out = http_json(method, CF_API + path, token, body)
    if isinstance(out, dict) and out.get("success") is False:
        msgs = "; ".join(str(e.get("message", e)) for e in (out.get("errors") or [])) or "success:false"
        die(f"Cloudflare {method} {path.split('?')[0]} -> {msgs}")
    return out.get("result") if isinstance(out, dict) and "result" in out else out


def empty_r2_bucket(acct: str, tok: str, bucket: str) -> int:
    """#686: Cloudflare refuses to DELETE a non-empty R2 bucket (HTTP 409, code 10008 "bucket is not
    empty"), so any install that actually rendered could not be torn down by `down --delete-data` -- it
    died loud at the bucket step and the user had to empty it by hand. List every object (paginated by
    cursor) and DELETE it FIRST, returning the count removed. An already-empty bucket returns 0
    (idempotent). Data deletion is already behind the explicit --delete-data flag, so emptying the
    bucket is consistent with the user's stated intent."""
    base = f"/accounts/{acct}/r2/buckets/{bucket}/objects"
    removed = 0
    cursor = None
    while True:
        q = "?per_page=1000" + (f"&cursor={urllib.parse.quote(cursor, safe='')}" if cursor else "")
        env = http_json("GET", CF_API + base + q, tok)
        if isinstance(env, dict) and env.get("success") is False:
            msgs = "; ".join(str(e.get("message", e)) for e in (env.get("errors") or [])) or "success:false"
            die(f"Cloudflare GET {base} -> {msgs}")
        objs = (env.get("result") if isinstance(env, dict) else None) or []
        for o in objs:
            key = o.get("key") if isinstance(o, dict) else None
            if not key:
                continue
            cf_api("DELETE", f"{base}/{urllib.parse.quote(key, safe='')}", tok)
            removed += 1
        info = (env.get("result_info") if isinstance(env, dict) else None) or {}
        cursor = info.get("cursor") if isinstance(info, dict) else None
        if not cursor or not objs:
            break
    return removed


def create_if_absent(*, kind: str, account: str, token: str, list_path: str, create_path: str,
                     create_body: dict, name: str, name_key: str, id_key: str,
                     list_unwrap: str | None = None, known_id: str | None = None) -> "ReconcileResult":
    """Idempotent reconcile by NAME -> returns the resource id. Lists existing, matches name_key, else
    POSTs create_body. list_unwrap handles nested list results (e.g. R2 buckets under 'buckets').

    NO-SILENT-ADOPT guard (#244): a pre-existing resource with the SAME name that THIS instance did not
    create (known_id, from our state file, does not match it) is NOT adopted silently -- the run DIES,
    unless `up --adopt` was passed. This is the footgun killer on a shared account: a name coincidence
    with another live deployment (e.g. a test instance beside this one) can no longer be hijacked."""
    listed = cf_api("GET", list_path.format(acct=account), token)
    items = (listed.get(list_unwrap) if (list_unwrap and isinstance(listed, dict)) else listed) or []
    for it in (items if isinstance(items, list) else []):
        if isinstance(it, dict) and it.get(name_key) == name:
            rid = str(it.get(id_key, name))
            if known_id is not None and str(known_id) == rid:
                log(f"  {kind} '{name}' exists ({rid}) [created by this instance]")
                return ReconcileResult(rid, adopted=False)
            if _ADOPT:
                log(f"  {kind} '{name}' exists ({rid}) -- ADOPTING (--adopt)")
                return ReconcileResult(rid, adopted=True)
            die(f"refusing to adopt pre-existing {kind} '{name}' ({rid}): this instance did not create it "
                f"(not recorded in {state_file_name()}). It may belong to another deployment on this "
                f"account. Re-run `up --adopt` to reuse it deliberately, or set DEPLOY_PREFIX to isolate.")
    created = cf_api("POST", create_path.format(acct=account), token, create_body)
    rid = str(created.get(id_key, name)) if isinstance(created, dict) else name
    log(f"  {kind} '{name}' created ({rid})")
    return ReconcileResult(rid, adopted=False)


def cf_env_for(s: "Secrets") -> dict:
    """The Cloudflare creds Wrangler reads from the ENVIRONMENT (never argv): token + account id."""
    return {"CLOUDFLARE_API_TOKEN": s.cf_api_token, "CLOUDFLARE_ACCOUNT_ID": s.cf_account_id}


def wrangler(args: list[str], *, cwd: Path, cf_env: dict | None = None, secret_stdin: str | None = None) -> None:
    """Run `npx wrangler ...`. A secret value (if any) is piped via STDIN, NEVER placed on argv (argv is
    visible in `ps` and shell history). CLOUDFLARE_API_TOKEN/ACCOUNT_ID ride in the child ENV, not the
    command line."""
    cmd = ["npx", "wrangler", *args]
    log("wrangler " + " ".join(args[:3]))  # never log a value -- args here are subcommands/flags only
    child_env = dict(os.environ)
    if cf_env:
        child_env.update(cf_env)
    proc = subprocess.run(
        cmd, cwd=str(cwd),
        input=(secret_stdin.encode() if secret_stdin is not None else None),
        env=child_env,
    )
    if proc.returncode != 0:
        die(f"wrangler {' '.join(args[:2])} failed (exit {proc.returncode})")


def module_dirs(repo: Path) -> list[str]:
    """Enumerate the module workers to deploy (modules/<name>/wrangler.toml), deployed BEFORE the core."""
    mods = sorted(p.name for p in (repo / "modules").iterdir() if (p / "wrangler.toml").exists()) if (repo / "modules").is_dir() else []
    return mods


def module_worker_name(repo: Path, mod: str) -> str:
    """The deployed worker NAME of a module = its wrangler.toml `name` (NOT the dir name). Read once so a
    prefixed deploy passes `--name prefixed(name)` and the core binds that same prefixed name."""
    m = re.search(r'(?m)^\s*name\s*=\s*"([^"]+)"', (repo / "modules" / mod / "wrangler.toml").read_text())
    if not m:
        die(f"module {mod}: no `name` in modules/{mod}/wrangler.toml")
    return m.group(1)


def core_worker_name(repo: Path) -> str:
    """The core worker NAME = the root wrangler.toml `name` (default 'vivijure-studio'). Falls back to
    wrangler.toml.example when the rendered toml is not present yet (the installer renders it -- F1)."""
    src = repo / "wrangler.toml" if (repo / "wrangler.toml").exists() else repo / "wrangler.toml.example"
    m = re.search(r'(?m)^\s*name\s*=\s*"([^"]+)"', src.read_text())
    if not m:
        die(f"no `name` in {src.name}")
    return m.group(1)


def render_core_toml(text: str, *, account_id: str, d1_id: str, store_id: str,
                     primary_bucket: str = None, prefix: str = "", module_service_names=()) -> str:
    """PURE render of a DEPLOYABLE core wrangler.toml from wrangler.toml.example (F1). ALWAYS does the
    base-install render; the prefix branch adds instance isolation on top. account_id is NEVER hardcoded
    -- the caller passes CLOUDFLARE_ACCOUNT_ID.

    Base install is MEDIA-LESS -- the studio's documented degrade mode (clips render; no final concat /
    title cards). The installer does NOT yet provision the media stack (phase-2 is a stub), so the
    render STRIPS every binding whose target a base install does not create, else `wrangler deploy`
    dangles:
      - substitute the ${...} placeholders (AUTH_MODE, ACCESS_*, R2_S3_ENDPOINT/BUCKET, the rate-limit
        namespace id, D1_DATABASE_ID) + the Secrets Store store_id placeholder,
      - inject the created D1 database_id + Secrets Store store_id,
      - enable workers_dev + drop the custom-domain [[routes]] (a base install verifies on workers.dev),
      - STRIP [[vpc_services]] (media-stack VPC), tail_consumers (vivijure-tail), and [[migrations]]
        (a delete-class migration for a Durable-Object class this fresh worker never had hard-fails).
    Isolation (prefix set): additionally prefix the R2 bucket bindings + repoint [[services]] to the
    prefixed module worker names."""
    p = (prefix or "").strip()
    pb = primary_bucket or R2_BUCKETS[0]
    def pfx(n):
        return f"{p}-{n}" if p else n
    for k, v in {
        "${AUTH_MODE}": AUTH_MODE,
        "${ACCESS_TEAM_DOMAIN}": ACCESS_TEAM_DOMAIN,
        "${ACCESS_AUD}": ACCESS_AUD,
        "${R2_S3_ENDPOINT}": f"https://{account_id}.r2.cloudflarestorage.com",
        "${R2_S3_BUCKET}": pfx(pb),
        "${SPEND_RATE_LIMITER_NS_ID}": "1001",
        "${D1_DATABASE_ID}": d1_id or "",
    }.items():
        text = text.replace(k, v)
    if store_id:
        text = text.replace(STORE_ID_PLACEHOLDER, store_id)
    if d1_id:
        text = re.sub(r'(?m)^(database_id\s*=\s*").*?(")', lambda m: m.group(1) + d1_id + m.group(2), text)
    if p:
        for b in R2_BUCKETS:
            text = text.replace(f'bucket_name = "{b}"', f'bucket_name = "{pfx(b)}"')
        for w in module_service_names:
            text = text.replace(f'service = "{w}"', f'service = "{pfx(w)}"')
    text = re.sub(r'(?m)^workers_dev\s*=\s*false\s*$', 'workers_dev = true', text)
    text = re.sub(r'(?ms)^\[\[routes\]\].*?(?=^\[|\Z)', '', text)
    text = re.sub(r'(?ms)^\[\[vpc_services\]\].*?(?=^\[|\Z)', '', text)
    text = re.sub(r'(?ms)^\[\[migrations\]\].*?(?=^\[|\Z)', '', text)
    text = re.sub(r'(?m)^tail_consumers\s*=\s*\[.*?\]\s*$', '', text)
    return text


def render_module_toml(text: str) -> str:
    """Base-install render of a module wrangler.toml: STRIP [[vpc_services]] (the media-stack VPC
    services are unprovisioned by a base install; binding one dangles the deploy). The store_id
    placeholder is handled separately (replace_store_id_placeholder)."""
    return re.sub(r'(?ms)^\[\[vpc_services\]\].*?(?=^\[|\Z)', '', text)
    def pfx(n):
        return f"{p}-{n}"
    for w in module_service_names:
        text = text.replace(f'service = "{w}"', f'service = "{pfx(w)}"')
    for b in R2_BUCKETS:
        text = text.replace(f'bucket_name = "{b}"', f'bucket_name = "{pfx(b)}"')
        text = text.replace(f'R2_S3_BUCKET = "{b}"', f'R2_S3_BUCKET = "{pfx(b)}"')
    if d1_id:
        text = re.sub(r'(?m)^(database_id\s*=\s*").*?(")', lambda m: m.group(1) + d1_id + m.group(2), text)
    if store_id:
        text = re.sub(r'(?m)^(\s*store_id\s*=\s*").*?(")', lambda m: m.group(1) + store_id + m.group(2), text)
    text = re.sub(r'(?m)^workers_dev\s*=\s*false\s*$', 'workers_dev = true', text)
    text = re.sub(r'(?ms)^\[\[routes\]\].*?(?=^\[|\Z)', '', text)
    text = re.sub(r'(?ms)^\[\[vpc_services\]\].*?(?=^\[|\Z)', '', text)
    text = re.sub(r'(?ms)^\[\[migrations\]\].*?(?=^\[|\Z)', '', text)
    text = re.sub(r'(?m)^tail_consumers\s*=\s*\[.*?\]\s*$', '', text)
    return text


# --------------------------------------------------------------------------------------------------
# State: idempotent reconcile. Records resource ids (NEVER secrets) so a re-run reconciles and a
# teardown can delete by id. Provenance (#659): adopted resources are flagged so `down` skips them.
# --------------------------------------------------------------------------------------------------


@dataclass
class ReconcileResult:
    rid: str
    adopted: bool = False


@dataclass
class State:
    path: Path
    data: dict = field(default_factory=dict)

    @classmethod
    def load(cls, repo: Path) -> "State":
        p = repo / state_file_name()
        data = json.loads(p.read_text()) if p.exists() else {}
        return cls(p, data)

    # Keys that would carry a SECRET VALUE -- never allowed in the state file (it holds ids/names only).
    _SECRET_KEY_HINTS = ("secret", "password", "api_token", "token_value", "_value")

    def save(self) -> None:
        # State holds resource ids/names only; the put() guard below enforces no secret-valued key lands here.
        self.path.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n")

    def get(self, key: str):
        return self.data.get(key)

    def resource_id(self, key: str) -> str | None:
        """Return a resource id from state. Legacy plain-string entries are treated as created."""
        v = self.data.get(key)
        if v is None:
            return None
        if isinstance(v, dict):
            rid = v.get("id")
            return str(rid) if rid is not None else None
        return str(v)

    def is_adopted(self, key: str) -> bool:
        """True when this run adopted a pre-existing resource (--adopt). Missing flag = created."""
        v = self.data.get(key)
        if isinstance(v, dict):
            return bool(v.get("adopted"))
        return False

    def put_resource(self, key: str, rid, *, adopted: bool = False) -> None:
        """Record a resource id with provenance. Created resources stay plain strings (backward compat)."""
        if any(h in key.lower() for h in self._SECRET_KEY_HINTS):
            die(f"refusing to write '{key}' to the state file -- it looks like a secret value (state holds ids only)")
        if adopted:
            self.data[key] = {"id": rid, "adopted": True}
        else:
            self.data[key] = rid
        self.save()

    def put(self, key: str, value) -> None:
        # Real guard (not just a comment): refuse to persist a key whose name implies a secret VALUE.
        # Ids/names only -- note r2_token_id is the access-key ID, not the secret it derives.
        if any(h in key.lower() for h in self._SECRET_KEY_HINTS):
            die(f"refusing to write '{key}' to the state file -- it looks like a secret value (state holds ids only)")
        self.data[key] = value
        self.save()

    def remove(self, key: str) -> None:
        """Drop a state entry after its resource is deleted (down) or invalidated (mint-lost heal), so
        state always reflects live reality and a re-run is idempotent (#682/#680)."""
        if key in self.data:
            del self.data[key]
            self.save()


# --------------------------------------------------------------------------------------------------
# The provisioning spine. ORDER MATTERS -- the comments encode the #244 cross-wiring constraints.
# Each step is reconcile-shaped: look up by name/id in state, create-if-absent, record the id.
# --------------------------------------------------------------------------------------------------


def preflight(repo: Path, s: Secrets) -> None:
    """Fail fast before touching anything: deps present, tokens actually valid, repo looks right."""
    if shutil.which("npx") is None:
        die("npx (Node) not found -- wrangler is required to deploy the workers")
    if not (repo / "wrangler.toml.example").exists():
        die(f"run from the vivijure repo root (no wrangler.toml.example at {repo})")
    # Validate the CF token with a real, harmless authenticated call (token verify).
    http_json("GET", "https://api.cloudflare.com/client/v4/user/tokens/verify", s.cf_api_token)
    # Validate the RunPod key (list endpoints; empty is fine).
    http_json("GET", "https://rest.runpod.io/v1/endpoints", s.runpod_api_key)
    log("preflight ok: deps present, both credentials valid")


def provision_access_app(account: str, token: str, st: State) -> None:
    """Gate the single-tenant studio behind CF Access: a self-hosted app on DEPLOY_DOMAIN with a
    self-only allow policy (OPERATOR_EMAIL). Shapes confirmed against the CF Access API docs --
    app = {name, domain, type:'self_hosted', policies:[...]}; policy = {name, decision:'allow',
    include:[{email:{email}}]}. Reconciled by domain so a re-run does not duplicate. No-op (with a
    loud warn) if the two config values are unset -- better an explicit ungated warning than a wrong
    gate."""
    if AUTH_MODE != "access":
        log("  token mode: NOT creating a CF Access app -- the built-in bearer-token gate is the studio's auth (docs/SECURITY.md 1b)")
        return
    if not DEPLOY_DOMAIN or not OPERATOR_EMAIL:
        die("AUTH_MODE=access needs DEPLOY_DOMAIN + OPERATOR_EMAIL (the edge Access app host + operator email) -- refusing to deploy an ungated studio")
    app = create_if_absent(kind="Access app", account=account, token=token,
        list_path="/accounts/{acct}/access/apps", create_path="/accounts/{acct}/access/apps",
        create_body={
            "name": "Vivijure Studio",
            "domain": DEPLOY_DOMAIN,
            "type": "self_hosted",
            "policies": [{
                "name": "operator only",
                "decision": "allow",
                "include": [{"email": {"email": OPERATOR_EMAIL}}],
            }],
        },
        name=DEPLOY_DOMAIN, name_key="domain", id_key="id", known_id=st.resource_id("access_app_id"))
    st.put_resource("access_app_id", app.rid, adopted=app.adopted)


def mint_r2_s3_token(account: str, token: str, st: State) -> dict:
    """Create an account-scoped API token with the R2 read/write permission group and DERIVE the S3
    credentials. Confirmed against developers.cloudflare.com/r2/api/tokens/:
      Access Key ID     = the token's `id`
      Secret Access Key = SHA-256 hex digest of the token's `value`
    The token value is returned ONCE by CF; the derived secret is held in memory for the seed step and
    is NEVER written to state. NOT cleanly idempotent (CF returns the value once), so a state flag skips
    a re-mint on re-run -- the secret was already seeded into the store on the first run."""
    endpoint = f"https://{account}.r2.cloudflarestorage.com"
    if st.resource_id("r2_token_id"):
        log("  R2 S3 token already minted (id in state) -- skipping re-mint (secret already seeded)")
        return {"R2_S3_ACCESS_KEY_ID": st.resource_id("r2_token_id"), "R2_S3_SECRET_ACCESS_KEY": "", "R2_S3_ENDPOINT": endpoint}
    groups = cf_api("GET", f"/accounts/{account}/tokens/permission_groups", token) or []
    pg = next((g for g in groups if isinstance(g, dict) and g.get("name") == "Workers R2 Storage Write"), None)
    if not pg:
        log("  WARN: 'Workers R2 Storage Write' permission group not found -- R2 S3 token NOT minted")
        return {"R2_S3_ACCESS_KEY_ID": "", "R2_S3_SECRET_ACCESS_KEY": "", "R2_S3_ENDPOINT": endpoint}
    # Scope: to the PREFIXED primary render bucket when isolating (a proving / second instance must not
    # hold a key that can reach another instance's -- or prod's -- buckets), else account-wide (verbatim).
    if DEPLOY_PREFIX.strip():
        resources = {f"com.cloudflare.api.account.{account}.r2.bucket.{prefixed(R2_BUCKETS[0])}": "*"}
    else:
        resources = {f"com.cloudflare.api.account.{account}": "*"}
    created = cf_api("POST", f"/accounts/{account}/tokens", token, {
        "name": prefixed("vivijure-r2-s3"),
        "policies": [{
            "effect": "allow",
            "permission_groups": [{"id": pg["id"]}],
            "resources": resources,
        }],
    }) or {}
    token_id, token_value = created.get("id", ""), created.get("value", "")
    secret = hashlib.sha256(token_value.encode()).hexdigest() if token_value else ""
    if token_id:
        st.put("r2_token_id", token_id)  # the access-key id (NOT the secret) -- safe in state
    log("  minted R2 S3 token (access-key id recorded; secret held in memory only)")
    return {"R2_S3_ACCESS_KEY_ID": token_id, "R2_S3_SECRET_ACCESS_KEY": secret, "R2_S3_ENDPOINT": endpoint}


def revoke_token_tolerant(account: str, token: str, token_id: str) -> None:
    """Revoke a CF API token, tolerating already-gone. Used by the #680 mint-lost heal (re-mint after a
    stale token) AND by down (#682): the token may have been revoked out-of-band -- dashboard, or an
    operator cleanup, exactly what happened in the live pass -- and neither path should die on that. A
    404 or a CF invalid-token-id error means already-revoked (log + continue); any other failure still
    dies loud."""
    try:
        out = http_json("DELETE", f"{CF_API}/accounts/{account}/tokens/{token_id}", token, raise_on_error=True)
    except DeployHTTPError as e:
        if e.code == 404:
            log("  R2 token already revoked (HTTP 404) -- continuing")
            return
        die(f"revoking the R2 token failed: HTTP {e.code}")
        return
    if isinstance(out, dict) and out.get("success") is False:
        errs = out.get("errors") or []
        msgs = "; ".join(str(x.get("message", x)) for x in errs)
        codes = {x.get("code") for x in errs if isinstance(x, dict)}
        # CF invalid-token-id family: 1000 (invalid api token), 7000/7003 (routing / bad identifier),
        # or a message that names a missing/invalid id -> treat as already-revoked.
        if (codes & {1000, 7000, 7003}) or any(w in msgs.lower() for w in ("not found", "invalid", "could not route")):
            log(f"  R2 token already revoked ({msgs or 'invalid id'}) -- continuing")
            return
        die(f"Cloudflare DELETE of the R2 token -> {msgs or 'success:false'}")


def provision_cloudflare_infra(repo: Path, s: Secrets, st: State) -> dict:
    """Step 1. The CF data-plane resources the workers bind (D1, R2 x2, AI Gateway), reconciled by name.
    Returns the IN-MEMORY derived values the secret seed needs (GATEWAY_ID slug + R2 S3 creds);
    identifiers are also recorded in state. Also mints the scoped R2 S3 token and creates the Access app."""
    acct, tok = s.cf_account_id, s.cf_api_token
    log("provisioning Cloudflare infra (D1, R2 x2, AI Gateway; Access app only when AUTH_MODE=access) ...")

    d1 = create_if_absent(kind="D1 database", account=acct, token=tok,
        list_path="/accounts/{acct}/d1/database", create_path="/accounts/{acct}/d1/database",
        create_body={"name": prefixed(D1_DATABASE)}, name=prefixed(D1_DATABASE), name_key="name",
        id_key="uuid", known_id=st.resource_id("d1_id"))
    st.put_resource("d1_id", d1.rid, adopted=d1.adopted)

    prefixed_buckets = [prefixed(b) for b in R2_BUCKETS]
    for nb in prefixed_buckets:
        bucket = create_if_absent(kind="R2 bucket", account=acct, token=tok,
            list_path="/accounts/{acct}/r2/buckets", create_path="/accounts/{acct}/r2/buckets",
            create_body={"name": nb}, name=nb, name_key="name", id_key="name", list_unwrap="buckets",
            known_id=st.resource_id(f"r2_bucket_{nb}"))
        st.put_resource(f"r2_bucket_{nb}", bucket.rid, adopted=bucket.adopted)
    st.put("r2_buckets", prefixed_buckets)

    gw_slug = prefixed(AI_GATEWAY_ID)
    gateway = create_if_absent(kind="AI Gateway", account=acct, token=tok,
        list_path="/accounts/{acct}/ai-gateway/gateways", create_path="/accounts/{acct}/ai-gateway/gateways",
        create_body={"id": gw_slug, "cache_ttl": 0, "cache_invalidate_on_update": False, "collect_logs": True,
                     "rate_limiting_interval": 0, "rate_limiting_limit": 0, "rate_limiting_technique": "fixed"},
        name=gw_slug, name_key="id", id_key="id", known_id=st.resource_id("gateway_id"))
    st.put_resource("gateway_id", gateway.rid, adopted=gateway.adopted)

    # Scoped R2 S3 token: mint + derive (Access Key ID = token id; Secret = SHA-256(token value)).
    # CF returns the secret ONCE; it is held in memory for the seed step, never written to state.
    r2 = mint_r2_s3_token(acct, tok, st)
    # Access app + self-only policy gating the single-tenant studio (shapes confirmed against the CF
    # Access API docs). No-op with a warn if DEPLOY_DOMAIN / OPERATOR_EMAIL are unset.
    provision_access_app(acct, tok, st)
    return {"GATEWAY_ID": gateway.rid, **r2}


RUNPOD_API = "https://rest.runpod.io/v1"  # the current REST API (Bearer key; OpenAPI at /v1/openapi.json)
GPU_TYPE_IDS: list = []  # REQUIRED -- endpoint GPU type id(s) (GET /gputypes)

# Per-endpoint image + released tag (#678). One manifest -- a finish satellite MUST run its own image,
# never the backend image. Tags are BARE semver GHCR tags (never a git :sha -- the endpoint-image pin
# rule); each is an override knob defaulting to that repo current released tag. Bump the default when a
# satellite ships a new tag, or edit a knob to pin a specific tag for a run.
BACKEND_IMAGE_TAG = "0.4.9"        # ghcr.io/skyphusion-labs/vivijure-backend
UPSCALE_IMAGE_TAG = "0.2.9"        # ghcr.io/skyphusion-labs/vivijure-upscale
MUSETALK_IMAGE_TAG = "0.1.4"       # ghcr.io/skyphusion-labs/vivijure-musetalk
AUDIO_UPSCALE_IMAGE_TAG = "0.1.0"  # ghcr.io/skyphusion-labs/vivijure-audio-upscale


def runpod_images() -> dict:
    """endpoint name -> (image, tag). A function (not a module constant) so the *_IMAGE_TAG knobs can
    be edited in place -- or monkeypatched in a test -- and still flow through."""
    return {
        "vivijure-backend": ("ghcr.io/skyphusion-labs/vivijure-backend", BACKEND_IMAGE_TAG),
        "vivijure-upscale": ("ghcr.io/skyphusion-labs/vivijure-upscale", UPSCALE_IMAGE_TAG),
        "vivijure-musetalk": ("ghcr.io/skyphusion-labs/vivijure-musetalk", MUSETALK_IMAGE_TAG),
        "vivijure-audio-upscale": ("ghcr.io/skyphusion-labs/vivijure-audio-upscale", AUDIO_UPSCALE_IMAGE_TAG),
    }


def rp_api(method: str, path: str, key: str, body: dict | None = None, *, raise_on_error: bool = False):
    """RunPod REST v1 call (plain JSON, no envelope; Bearer key in the header)."""
    return http_json(method, RUNPOD_API + path, key, body, raise_on_error=raise_on_error)


def _rp_items(listed) -> list:
    """Normalize a RunPod list response to a plain list (top-level array, or data/endpoints/templates)."""
    if isinstance(listed, list):
        return listed
    if isinstance(listed, dict):
        return listed.get("data") or listed.get("endpoints") or listed.get("templates") or []
    return []


def rp_reconcile(*, kind: str, key: str, list_path: str, create_path: str, create_body: dict,
                 name: str, name_key: str = "name", id_key: str = "id", known_id: str | None = None) -> ReconcileResult:
    """Idempotent reconcile by NAME against the RunPod REST API -> returns the resource id. Same
    no-silent-adopt guard as create_if_absent (#244): a same-name resource this instance did not create
    dies unless `up --adopt`. Create is #675-tolerant: RunPod intermittently returns 5xx AFTER creating
    the resource server-side ("unexpected end of JSON input"), so on a create error we RE-LIST before
    giving up -- a same-name resource that was absent pre-create is one we just made; record it rather
    than orphan it (and rather than die telling the user to --adopt a resource we created)."""
    for it in _rp_items(rp_api("GET", list_path, key)):
        if isinstance(it, dict) and it.get(name_key) == name:
            rid = str(it.get(id_key, ""))
            if known_id is not None and str(known_id) == rid:
                log(f"  RunPod {kind} '{name}' exists ({rid}) [created by this instance]")
                return ReconcileResult(rid, adopted=False)
            if _ADOPT:
                log(f"  RunPod {kind} '{name}' exists ({rid}) -- ADOPTING (--adopt)")
                return ReconcileResult(rid, adopted=True)
            die(f"refusing to adopt pre-existing RunPod {kind} '{name}' ({rid}): this instance did not "
                f"create it (not in {state_file_name()}). Re-run `up --adopt` to reuse it, or rename via DEPLOY_PREFIX.")
    # No same-name resource pre-existed -> create it.
    try:
        created = rp_api("POST", create_path, key, create_body, raise_on_error=True)
    except DeployHTTPError as e:
        # #675: the create may have SUCCEEDED server-side despite the error. Re-list; a same-name
        # resource now present (absent pre-create above) is ours -- record it, do not orphan or die.
        match = next((it for it in _rp_items(rp_api("GET", list_path, key))
                      if isinstance(it, dict) and it.get(name_key) == name), None)
        if match:
            rid = str(match.get(id_key, ""))
            log(f"  RunPod {kind} '{name}' create returned HTTP {e.code} but the resource EXISTS on "
                f"re-list ({rid}) -- recording as created-by-this-instance (#675)")
            return ReconcileResult(rid, adopted=False)
        die(f"RunPod {kind} '{name}' create failed ({e}) and no same-name resource exists on re-list")
    rid = str(created.get(id_key, "")) if isinstance(created, dict) else ""
    log(f"  RunPod {kind} '{name}' created ({rid})")
    return ReconcileResult(rid, adopted=False)


def provision_runpod(repo: Path, s: Secrets, st: State, cf_derived: dict) -> dict:
    """Step 2. RunPod must come BEFORE secret-seeding because RUNPOD_ENDPOINT_ID is a seeded secret.
    Order within: registry-auth (only if the image is private) -> a serverless template per endpoint
    (pin the endpoint image, R2 env) -> endpoint (volume-less; baked images ship weights in-layer).
    Returns {endpoint_name: endpoint_id}. Reconciled by name. Consumes the
    R2 S3 creds (cf_derived, from the CF R2-token mint) for the backend env.

    GOTCHA encoded: for a PUBLIC GHCR image, leave containerRegistryAuthId UNSET. A stale/blank-but-
    present auth makes RunPod attempt auth and abort even a public pull."""
    key = s.runpod_api_key
    log("provisioning RunPod (registry-auth?, per-endpoint serverless templates, endpoints; volume-less) ...")

    # Required config -- die loud rather than POST an empty/unpinned value (relying on a remote 400).
    images = runpod_images()
    for ep in RUNPOD_ENDPOINTS:
        img, tag = images.get(ep, (None, None))
        if not img:
            die(f"no image mapping for RunPod endpoint {ep!r} (see runpod_images())")
        if not tag or tag == "latest":
            die(f'set an explicit released tag for {ep} (bare semver, e.g. "0.4.9") -- never empty or "latest"')
    if not GPU_TYPE_IDS:
        die("set GPU_TYPE_IDS to the endpoint GPU type id(s) (GET /gputypes)")

    # Public GHCR image -> NO registry auth (leave containerRegistryAuthId unset; the blank-auth gotcha).
    registry_auth_id = None  # for a PRIVATE image, rp_reconcile a containerregistryauth here first.

    # The env the pod reads to reach R2 (S3), from the CF R2-token mint (cf_derived). If the mint warned
    # (e.g. the permission group was missing), the creds are empty -> abort rather than ship an endpoint
    # that cannot read R2.
    if not cf_derived.get("R2_S3_ACCESS_KEY_ID"):
        die("R2 S3 creds were not minted (see the CF R2-token warning above) -- aborting before creating RunPod endpoints that cannot read R2")
    # RunPod template env is a key->value OBJECT (confirmed against the v1 OpenAPI), not an array.
    backend_env = {
        "R2_S3_ACCESS_KEY_ID": cf_derived.get("R2_S3_ACCESS_KEY_ID", ""),
        "R2_S3_SECRET_ACCESS_KEY": cf_derived.get("R2_S3_SECRET_ACCESS_KEY", ""),
        "R2_ENDPOINT": cf_derived.get("R2_S3_ENDPOINT", ""),
        "R2_BUCKET": prefixed(R2_BUCKETS[0]),
    }

    endpoints: dict = {}
    for ep in RUNPOD_ENDPOINTS:
        image, tag = images[ep]
        tmpl = rp_reconcile(kind="template", key=key, list_path="/templates", create_path="/templates",
            create_body={
                "name": f"{ep}-tmpl",
                "imageName": f"{image}:{tag}",  # this endpoint OWN image (#678), not the backend for all
                # isServerless marks this a SERVERLESS template. Without it RunPod defaults to a POD
                # template and the endpoint create then fails 100% ("Serverless endpoints cannot use pod
                # templates") -- #677. Confirmed against the v1 OpenAPI + a live proving run.
                "isServerless": True,
                "containerDiskInGb": 500,
                "env": backend_env,
                **({"containerRegistryAuthId": registry_auth_id} if registry_auth_id else {}),
            }, name=f"{ep}-tmpl", known_id=st.resource_id(f"runpod_template_{ep}"))
        st.put_resource(f"runpod_template_{ep}", tmpl.rid, adopted=tmpl.adopted)  # persist NOW (RunPod-phase parity)
        # No network volume (#676): the baked image ships the weights in-layer, so a volume only pins the
        # endpoint to one datacenter (shrinking the schedulable GPU pool) + bills ~$7/mo for nothing.
        # Prod runs volume-less; this mirrors it.
        ep_res = rp_reconcile(kind="endpoint", key=key, list_path="/endpoints", create_path="/endpoints",
            create_body={
                "name": ep, "templateId": tmpl.rid,
                "gpuTypeIds": GPU_TYPE_IDS,
                "workersMin": 0, "workersMax": 1,
                # scaler/idle/timeout tuning (scalerType / scalerValue / idleTimeout / executionTimeoutMs)
                # is optional; confirm the exact fields against the live /v1/openapi.json before tuning.
            }, name=ep, known_id=st.resource_id(f"runpod_endpoint_{ep}"))
        st.put_resource(f"runpod_endpoint_{ep}", ep_res.rid, adopted=ep_res.adopted)  # persist NOW
        endpoints[ep] = ep_res.rid

    # Weights ship IN the baked image (backend >= 0.3.0), and the backend also self-preloads any
    # additional weights from R2 on the first cold start -- there is nothing to pre-seed (the old
    # volume-S3 pre-seed path is gone with the volume, #676).
    log("  NOTE: no model pre-seed step -- weights are baked into the image and self-preload from R2 on "
        "the first job.")
    return endpoints


def replace_store_id_placeholder(repo: Path, store_id: str) -> None:
    """Wire the real Secrets Store id into the module wrangler.tomls (replace the #237 placeholder) so
    the secrets_store_secrets bindings resolve at deploy. Idempotent: a no-op once already replaced."""
    n = 0
    for toml in sorted((repo / "modules").glob("*/wrangler.toml")):
        text = toml.read_text()
        if STORE_ID_PLACEHOLDER in text:
            toml.write_text(text.replace(STORE_ID_PLACEHOLDER, store_id))
            n += 1
    log(f"  wired store_id into {n} module wrangler.toml(s)")


def restore_store_id_placeholder(repo: Path, store_id: str) -> None:
    """Undo replace_store_id_placeholder after a successful deploy, so the working tree is left CLEAN
    (the user's checkout is not dirtied with their store id). Only runs on success; a failed deploy
    leaves the tomls mutated, and a re-run reconciles them."""
    if not store_id:
        return
    n = 0
    for toml in sorted((repo / "modules").glob("*/wrangler.toml")):
        text = toml.read_text()
        if store_id in text and STORE_ID_PLACEHOLDER not in text:
            toml.write_text(text.replace(store_id, STORE_ID_PLACEHOLDER))
            n += 1
    if n:
        log(f"  restored the store_id placeholder in {n} module wrangler.toml(s) (working tree left clean)")


def resolved_secret_values(runpod_api_key: str, cf_derived: dict, runpod_endpoints: dict) -> dict:
    """The AUTO-sourced store secret values (store secret_name -> value). Operator-class names are NOT
    here (they seed as placeholders). Pure -- unit tested. Keys == AUTO_STORE_NAMES."""
    vals = {
        "RUNPOD_API_KEY": runpod_api_key,
        "GATEWAY_ID": cf_derived.get("GATEWAY_ID", ""),
        "R2_S3_ACCESS_KEY_ID": cf_derived.get("R2_S3_ACCESS_KEY_ID", ""),
        "R2_S3_SECRET_ACCESS_KEY": cf_derived.get("R2_S3_SECRET_ACCESS_KEY", ""),
    }
    for ep, secname in ENDPOINT_SECRET_NAMES.items():
        vals[secname] = runpod_endpoints.get(ep, "")
    return vals


def _r2_mint_lost(*, token_id_in_state: bool, secret_value: str, secret_in_store: bool) -> bool:
    """#680: the R2 token id is recorded but its derived secret is GONE (a prior run died between mint
    and seed; CF returns the secret once) AND the store has no R2_S3_SECRET_ACCESS_KEY. That state
    perma-fails the core deploy (10182) and no re-run heals it -- so re-mint. A HEALTHY re-run (secret
    present in the store) is NOT mint-lost: the skip-empty guard keeps the seeded value as-is."""
    return token_id_in_state and not secret_value and not secret_in_store


def seed_secrets(repo: Path, s: Secrets, st: State, cf_derived: dict, runpod_endpoints: dict) -> list:
    """Step 3. CRITICAL ORDER: seed the Secrets Store BEFORE deploying the workers. A module worker's
    secrets_store_secrets binding references a store secret by name; `wrangler deploy` FAILS if that
    secret does not yet exist (#237). Values flow from: the user's RUNPOD_API_KEY, the per-endpoint
    RunPod ids under their own store names (BACKEND_/VIDEO_UPSCALE_/MUSETALK_/AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID,
    step 2), GATEWAY_ID + the scoped R2 S3 creds (step 1). Operator-supplied secrets (CF AI Gateway
    tokens, a local-backend URL/token) seed as MARKED placeholders so the module deploy resolves; the
    operator replaces them post-install (finalize prints the checklist). Returns the placeholder names.

    Secret VALUES are sent in the HTTPS request body of the Secrets Store API (never on argv, never
    logged) -- the non-interactive analogue of wrangler's hidden prompt. Re-run reseeds rotated values."""
    acct, tok = s.cf_account_id, s.cf_api_token
    log("seeding the Cloudflare Secrets Store (BEFORE deploy) ...")

    store = create_if_absent(kind="Secrets Store", account=acct, token=tok,
        list_path="/accounts/{acct}/secrets_store/stores", create_path="/accounts/{acct}/secrets_store/stores",
        create_body={"name": prefixed(STORE_NAME)}, name=prefixed(STORE_NAME), name_key="name",
        id_key="id", known_id=st.resource_id("store_id"))
    store_id = store.rid
    st.put_resource("store_id", store_id, adopted=store.adopted)
    replace_store_id_placeholder(repo, store_id)  # so the deploy's bindings resolve

    base = f"/accounts/{acct}/secrets_store/stores/{store_id}/secrets"
    existing = {x.get("name"): x.get("id") for x in (cf_api("GET", base, tok) or []) if isinstance(x, dict) and x.get("name")}

    # #680 mint-lost heal: token id recorded but its secret is gone AND the store has no
    # R2_S3_SECRET_ACCESS_KEY -> revoke the stale token, re-mint, seed the fresh pair (else the core
    # deploy perma-fails 10182 with no re-run healing it). The healthy re-run does NOT heal.
    if _r2_mint_lost(token_id_in_state=bool(st.resource_id("r2_token_id")),
                     secret_value=cf_derived.get("R2_S3_SECRET_ACCESS_KEY", ""),
                     secret_in_store="R2_S3_SECRET_ACCESS_KEY" in existing):
        old_id = st.resource_id("r2_token_id")
        log("  R2 S3 secret mint-lost (token id in state, secret absent from store) -- revoking + re-minting (#680)")
        revoke_token_tolerant(acct, tok, old_id)       # tolerate an already-revoked stale token
        st.remove("r2_token_id")                       # clear so mint_r2_s3_token re-mints for real
        cf_derived.update(mint_r2_s3_token(acct, tok, st))

    values = resolved_secret_values(s.runpod_api_key, cf_derived, runpod_endpoints)
    # COUPLING NOTE: on a healthy re-run, mint_r2_s3_token returns an EMPTY R2 secret (CF returns the
    # token value only once). The skip-empty guard below protects the already-seeded R2 secret from
    # being overwritten with a blank -- do NOT "fix" it to seed empty values (#680 heals the distinct
    # crashed-between case above).
    pending_operator: list = []
    for name in STORE_BINDING_NAMES:
        if name in OPERATOR_STORE_NAMES:
            # Operator supplies these post-install; the store secret MUST exist or the module deploy
            # fails 10182, but we have no value -> seed a MARKED placeholder + flag it. Never clobber a
            # real value the operator already set on a prior run.
            if name in existing:
                log(f"  {name}: operator-supplied, already in store -- left as-is")
                continue
            cf_api("POST", base, tok, [{"name": name, "value": OPERATOR_PLACEHOLDER, "scopes": ["workers"]}])
            pending_operator.append(name)
            log(f"  seeded {name} = <placeholder> (operator MUST replace post-install)")
            continue
        v = values.get(name, "")
        if not v:
            log(f"  skip {name}: no value this run (already seeded, or not yet resolved) -- left as-is")
            continue
        if name in existing:
            cf_api("PATCH", f"{base}/{existing[name]}", tok, {"value": v, "scopes": ["workers"]})
        else:
            # The Secrets Store create API takes a BULK ARRAY body (a single object is invalid_json_body).
            cf_api("POST", base, tok, [{"name": name, "value": v, "scopes": ["workers"]}])
        log(f"  seeded {name}")  # name only, never the value
    if pending_operator:
        log("POST-INSTALL: these store secrets were seeded as PLACEHOLDERS and must be replaced with your")
        log("  real values before the modules that use them work (all are optional enhance/finish paths):")
        for pname in pending_operator:
            log(f"    - {pname}")
        log("  Replace each in the Cloudflare Secrets Store (dashboard or API) under the 'vivijure' store")
        log("  this installer created; leaving a placeholder just disables that one module.")
    return pending_operator


def run_migrations(repo: Path, s: Secrets) -> None:
    """Step 4. D1 schema migrations (Wrangler only -- Terraform cannot do this). Additive, idempotent."""
    log("applying D1 migrations ...")
    wrangler(["d1", "migrations", "apply", prefixed(D1_DATABASE), "--remote"], cwd=repo, cf_env=cf_env_for(s))


def render_and_write_core_toml(repo: Path, s: Secrets, st: State) -> None:
    """Render a DEPLOYABLE wrangler.toml from wrangler.toml.example (F1), BEFORE migrations + deploy --
    `wrangler d1 migrations apply` AND `wrangler deploy` both need it present. Uses the D1 + Secrets
    Store ids captured in state; account_id from CLOUDFLARE_ACCOUNT_ID (never hardcoded). Media-less
    base install (VPC / tail / routes / DO-migration blocks stripped -- see render_core_toml)."""
    mods = module_dirs(repo)
    rendered = render_core_toml((repo / "wrangler.toml.example").read_text(),
        account_id=s.cf_account_id, d1_id=str(st.resource_id("d1_id") or ""), store_id=str(st.resource_id("store_id") or ""),
        primary_bucket=R2_BUCKETS[0], prefix=DEPLOY_PREFIX.strip(),
        module_service_names=[module_worker_name(repo, m) for m in mods])
    (repo / "wrangler.toml").write_text(rendered)
    log(f"  rendered wrangler.toml from the example ({'isolated' if DEPLOY_PREFIX.strip() else 'verbatim'}, media-less)")


def deploy_workers(repo: Path, s: Secrets, st: State) -> None:
    """Step 5. Modules BEFORE the core (the core binds each module as a [[services]] dependency).
    F1: the installer RENDERS a deployable wrangler.toml from wrangler.toml.example (with the D1 +
    Secrets Store ids it just created); it no longer requires a pre-rendered toml. Base install is
    MEDIA-LESS -- the module [[vpc_services]] blocks (5 media-stack modules) + the core VPC / tail /
    routes / DO-migration blocks are stripped, since a base install does not provision those targets."""
    mods = module_dirs(repo)
    isolate = bool(DEPLOY_PREFIX.strip())
    log(f"deploying {len(mods)} module workers, then the core (media-less base install)"
        f"{' (isolated: ' + DEPLOY_PREFIX.strip() + ')' if isolate else ''} ...")
    env = cf_env_for(s)
    acct, d1_id, store_id = s.cf_account_id, str(st.resource_id("d1_id") or ""), str(st.resource_id("store_id") or "")
    for m in mods:
        mp = repo / "modules" / m / "wrangler.toml"
        text = mp.read_text()
        name_extra = ["--name", prefixed(module_worker_name(repo, m))] if isolate else []
        if "[[vpc_services]]" in text:  # a media-stack module -> strip its VPC binding (base install)
            tmp = repo / "modules" / m / ".wrangler-base.toml"
            tmp.write_text(render_module_toml(text))
            try:
                wrangler(["deploy", "-c", f"modules/{m}/.wrangler-base.toml", *name_extra], cwd=repo, cf_env=env)
            finally:
                tmp.unlink(missing_ok=True)
        else:
            wrangler(["deploy", "-c", f"modules/{m}/wrangler.toml", *name_extra], cwd=repo, cf_env=env)
    # The core, AFTER every module (service bindings). Carry the /api/* auth mode as a NON-SECRET var.
    core_vars = ["--var", f"AUTH_MODE:{AUTH_MODE}"]
    if AUTH_MODE == "access":
        core_vars += ["--var", f"ACCESS_TEAM_DOMAIN:{ACCESS_TEAM_DOMAIN}", "--var", f"ACCESS_AUD:{ACCESS_AUD}"]
    # wrangler.toml was rendered earlier (render_and_write_core_toml, before migrations -- both
    # `wrangler d1 migrations apply` and `wrangler deploy` need it present). Deploy the core.
    name_extra = ["--name", prefixed(core_worker_name(repo))] if isolate else []
    wrangler(["deploy", *name_extra, *core_vars], cwd=repo, cf_env=env)


def _mint_studio_token() -> str:
    """256 bits of randomness, hex -- the operator studio API token. Stdlib `secrets` (no openssl dep;
    deploy.sh uses openssl only because bash has no CSPRNG)."""
    import secrets as _secrets
    return _secrets.token_hex(32)


def _core_secret_present(repo: Path, s: "Secrets", name: str) -> bool:
    """True iff `name` is already a secret on the deployed CORE worker. Reads `wrangler secret list`
    with capture and checks only whether the NAME appears -- the values are never captured or returned
    (F18-lite: a re-run keeps the existing token so saved studio logins survive)."""
    child_env = dict(os.environ)
    child_env.update(cf_env_for(s))
    try:
        proc = subprocess.run(["npx", "wrangler", "secret", "list"], cwd=str(repo),
                              env=child_env, capture_output=True, text=True)
    except Exception:
        return False
    if proc.returncode != 0:
        return False
    return f'"{name}"' in (proc.stdout or "")


def set_studio_api_token(repo: Path, s: "Secrets", rotate: bool, noninteractive: bool = False) -> None:
    """Token mode only, AFTER deploy (a worker secret is safe to set post-deploy, applied live). Mint
    the operator STUDIO_API_TOKEN and store it as a WORKER SECRET via `wrangler secret put` (piped on
    STDIN, never argv) -- the SAME path deploy.sh uses, not a second mint. F18-lite: a re-run KEEPS the
    existing token (saved studio logins keep working) unless --rotate-token is passed. The token is
    printed ONCE to the operator's own terminal and written to no file. Per-consumer credentials (bots,
    satellites) are a SEPARATE class: scripts/studio-consumer-token.sh (docs/SECURITY.md 1b-i) -- do NOT
    hand out the operator token."""
    if not rotate and _core_secret_present(repo, s, "STUDIO_API_TOKEN"):
        log("  STUDIO_API_TOKEN already set on the core (prior run); keeping it (pass --rotate-token to mint a fresh one)")
        return
    token = _mint_studio_token()
    wrangler(["secret", "put", "STUDIO_API_TOKEN"], cwd=repo, cf_env=cf_env_for(s), secret_stdin=token)
    if noninteractive:
        # #681: under --noninteractive stdout is typically piped/tee'd (CI logs), so do NOT print the
        # value. Write it to a 0600 file beside the state file; print only the path.
        tpath = repo / token_file_name()
        fd = os.open(str(tpath), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(token + "\n")
        os.chmod(tpath, 0o600)  # tighten even if the file pre-existed with a looser mode
        print(f"\n  Operator STUDIO_API_TOKEN written to {tpath} (mode 0600). The VALUE is not printed.")
        print("  API callers send it as  Authorization: Bearer <token>. Re-run --rotate-token to replace it.\n")
        return
    # The one INTENTIONAL secret-to-terminal: the operator's login on their OWN deploy, shown once,
    # stored nowhere else (mirrors deploy.sh's SAVE-THIS-NOW banner).
    print("\n  ============================= SAVE THIS NOW =============================")
    print("  Your studio API token (shown ONCE, stored nowhere else):\n")
    print(f"      {token}\n")
    print("  This is your studio login. Open the studio and paste it when asked; API callers")
    print("  send it as  Authorization: Bearer <token>. Re-run with --rotate-token to mint a")
    print("  fresh one (invalidates the old). Per-bot/satellite tokens: scripts/studio-consumer-token.sh")
    print("  (docs/SECURITY.md 1b-i) -- never hand out this operator token.")
    print("  =========================================================================\n")


def validate_auth_config() -> None:
    """Fail fast on a bad auth config before touching anything (mirrors deploy.sh's AUTH_MODE guard)."""
    if AUTH_MODE not in ("token", "access"):
        die(f'AUTH_MODE must be "token" or "access" (got: {AUTH_MODE!r})')
    if AUTH_MODE == "access" and (not ACCESS_TEAM_DOMAIN or not ACCESS_AUD):
        die("AUTH_MODE=access requires ACCESS_TEAM_DOMAIN + ACCESS_AUD (the public Zero-Trust identifiers)")


def bring_up_containers(repo: Path) -> None:
    """Step 6 (Phase 2 / optional). The 3 CPU helper containers run on the user's OWN box (Docker),
    reached over CF VPC bindings. Without them the studio still renders clips; it just cannot do the
    final concat / title cards. Phase 2."""
    log("(phase 2) CPU containers + VPC services -- skipped in phase 1")


def finalize(repo: Path, st: State) -> None:
    # Honesty rider: a degrade is NEVER silent -- the installer says the media stack was not provisioned.
    log("MEDIA STACK NOT PROVISIONED (installer phase-2 is roadmap): the studio is running in its "
        "documented media-less mode -- clips render, no final concat / title cards.")
    log("done. studio URL + recorded resource ids are in " + str(repo / state_file_name()))


# --------------------------------------------------------------------------------------------------
# Orchestration: up / down / plan.
# --------------------------------------------------------------------------------------------------


def bind_state_to_account(st: State, s: Secrets) -> None:
    """#684: bind the state file to the Cloudflare account that created it. State records resource ids
    with NO account, so running the same clone against a SECOND account silently reused the first
    account's ids -- a stale r2_token_id skips the R2 mint, so the new account's core deploy 10182s (the
    #680 failure shape, reachable with no crash), and a same-name resource on the new account would look
    adopted-by-this-instance. Record cf_account_id at first write; die loud on a mismatch thereafter.
    The account id is an identifier (not a secret), safe to record + name in the error."""
    recorded = st.get("cf_account_id")
    if recorded and recorded != s.cf_account_id:
        die(f"state file {state_file_name()} belongs to Cloudflare account {recorded}, but the supplied "
            f"credentials are for {s.cf_account_id}. Refusing to reuse another account's resource ids. "
            f"For a second account use a separate clone, remove {state_file_name()} for a fresh install, "
            f"or set DEPLOY_PREFIX to isolate the instance (its state file is per-prefix).")
    if not recorded:
        st.put("cf_account_id", s.cf_account_id)


def cmd_up(repo: Path, dry_run: bool, noninteractive: bool, rotate_token: bool = False) -> None:
    validate_auth_config()  # cheap, credential-free; runs for plan and up alike
    # The plan is order-only -- it needs NO credentials, so never prompt for secrets in a dry-run.
    if dry_run:
        log(f"PLAN (dry-run) -- AUTH_MODE={AUTH_MODE}; order (no credentials needed, no changes made):")
        if DEPLOY_PREFIX.strip():
            log(f"  ISOLATED (DEPLOY_PREFIX={DEPLOY_PREFIX.strip()!r}): every resource -> {DEPLOY_PREFIX.strip()}-<name> "
                f"(e.g. D1 {prefixed(D1_DATABASE)!r}); state {state_file_name()!r}; the core deploys from a transformed "
                f"toml (no custom domain -- workers.dev). A foreign same-name resource is NOT adopted silently (use --adopt).")
        else:
            log("  VERBATIM (DEPLOY_PREFIX empty): prod-shape names; a pre-existing same-name resource this instance "
                "did not create is NOT adopted silently (pass --adopt to override).")
        cf_step = ("provision Cloudflare infra (D1, R2 x2, AI Gateway, scoped R2 token"
                   + (", Access app" if AUTH_MODE == "access" else "; NO Access app -- token mode") + ")")
        steps = [
            "preflight (deps + token validity)",
            cf_step,
            "provision RunPod (registry-auth?, per-endpoint serverless template, endpoints; volume-less) -> capture endpoint ids",
            "seed Cloudflare Secrets Store  <-- BEFORE deploy (#237)",
            "run D1 migrations",
            "deploy module workers, then the core (core carries the AUTH_MODE var)",
        ]
        if AUTH_MODE == "token":
            steps.append("mint + put STUDIO_API_TOKEN worker secret (operator login; kept on re-run unless --rotate-token)")
        steps.append("(phase 2 -- NOT run: roadmap) media stack; base install is media-less (clips render, no final concat/titles)")
        for i, name in enumerate(steps, 1):
            log(f"  {i}. {name}")
        return
    s = collect_secrets(noninteractive_env=noninteractive)
    log("credential presence: " + s.presence())  # SET/missing only
    st = State.load(repo)
    preflight(repo, s)
    bind_state_to_account(st, s)  # #684: refuse to reuse another account's state
    cf_derived = provision_cloudflare_infra(repo, s, st)
    runpod_endpoints = provision_runpod(repo, s, st, cf_derived)
    seed_secrets(repo, s, st, cf_derived, runpod_endpoints)  # MUST precede deploy (#237); prints the operator checklist
    render_and_write_core_toml(repo, s, st)  # F1: wrangler.toml must exist for migrations + deploy
    run_migrations(repo, s)
    deploy_workers(repo, s, st)
    if AUTH_MODE == "token":
        set_studio_api_token(repo, s, rotate_token, noninteractive)  # operator login (worker secret, safe post-deploy)
    restore_store_id_placeholder(repo, st.resource_id("store_id"))  # leave the working tree clean post-deploy
    bring_up_containers(repo)
    finalize(repo, st)


def deployed_worker_ids(acct: str, tok: str) -> set:
    """The set of Worker script names currently deployed on the account (CF API). Used to gate the
    teardown WARN on reality (#682): `wrangler delete` exits 1 even on a SUCCESSFUL delete."""
    res = cf_api("GET", f"/accounts/{acct}/workers/scripts", tok)
    return {x.get("id") for x in (res or []) if isinstance(x, dict) and x.get("id")}


def wrangler_delete_tolerant(args: list, *, cwd: Path, cf_env: dict, label: str, verify_gone=None) -> None:
    """`wrangler delete` for teardown that TOLERATES a worker that was never deployed (F4). A partial /
    failed `up` MUST still be teardownable -- that is half of what `down` is for. A worker that does not
    exist (CF code 10007) is a SKIP + note, never an abort, so teardown always reaches the D1 / bucket /
    Secrets Store cleanup.

    #682: `wrangler delete` exits 1 even on a SUCCESSFUL delete (its post-delete confirmation /
    references flow), which floods a clean teardown with false 'delete failed' WARNs and would drown a
    real failure. So on a non-zero exit that is not the known already-gone case, gate the WARN on
    REALITY via verify_gone() -- if the worker actually vanished, the delete succeeded."""
    child_env = dict(os.environ)
    if cf_env:
        child_env.update(cf_env)
    proc = subprocess.run(["npx", "wrangler", *args], cwd=str(cwd), env=child_env,
                          capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0:
        log(f"  deleted {label}")
        return
    if "does not exist" in out or "10007" in out:
        log(f"  skip {label}: not deployed (already gone)")
        return
    if verify_gone is not None:
        try:
            if verify_gone():
                log(f"  deleted {label} (wrangler exited {proc.returncode}, but the worker is gone -- verified via API)")
                return
        except Exception:
            pass  # verification itself failed -> fall through to the honest WARN
    log(f"  WARN {label}: delete failed (exit {proc.returncode}); continuing teardown")


def cmd_down(repo: Path, delete_data: bool, noninteractive: bool = False, include_adopted: bool = False) -> None:
    """Teardown in reverse dependency order, by recorded id. R2 buckets + D1 hold user data and are
    LEFT in place unless --delete-data is given. Adopted resources (--adopt) are skipped unless
    --include-adopted is passed (#659)."""
    st = State.load(repo)
    s = collect_secrets(noninteractive_env=noninteractive)  # F3: env-cred path (like up), else hidden prompts
    bind_state_to_account(st, s)  # #684: don't tear down against the wrong account
    log("teardown (reverse dependency order, by recorded id) ...")
    if include_adopted:
        log("WARNING: --include-adopted will DELETE adopted resources (pre-existing before this deploy)")

    # RunPod first
    # before delete; surface the API error rather than force.
    key = s.runpod_api_key
    for ep in RUNPOD_ENDPOINTS:
        for kind, skey, url in (
            ("endpoint", f"runpod_endpoint_{ep}", "/endpoints"),
            ("volume", f"runpod_volume_{ep}", "/networkvolumes"),     # legacy state (installer is volume-less now)
            ("template", f"runpod_template_{ep}", "/templates"),
        ):
            rid = st.resource_id(skey)
            if not rid:
                continue
            if st.is_adopted(skey) and not include_adopted:
                log(f"  skipping adopted RunPod {kind} {rid}")
                continue
            try:
                rp_api("DELETE", f"{url}/{rid}", key, raise_on_error=True)
                log(f"  deleted RunPod {kind} {ep} ({rid})")
            except DeployHTTPError as e:
                # #682: RunPod returns 404 OR 500 for a missing resource -- both mean already-gone.
                if e.code in (404, 500):
                    log(f"  RunPod {kind} {ep} ({rid}): already absent (HTTP {e.code}) -- skipping")
                else:
                    die(f"RunPod delete {kind} {ep} failed: {e}")
            st.remove(skey)  # state reflects reality -> a re-run does not re-attempt this delete

    # CF teardown by recorded id, in dependency-safe order. The minted R2 API TOKEN is the security
    # footgun -- it must NOT survive a `down`. A delete error surfaces loud (cf_api dies), never silent.
    acct, tok = s.cf_account_id, s.cf_api_token
    removed: list = []

    # Workers (modules + core) via `wrangler delete`. wrangler may prompt for confirmation depending on
    # version; that surfaces (it is not silently skipped).
    isolate = bool(DEPLOY_PREFIX.strip())
    live = lambda: deployed_worker_ids(acct, tok)  # fresh each call (teardown mutates the account)
    for m in module_dirs(repo):
        wname = prefixed(module_worker_name(repo, m))
        extra = ["--name", wname] if isolate else []
        wrangler_delete_tolerant(["delete", "-c", f"modules/{m}/wrangler.toml", *extra],
                                 cwd=repo, cf_env=cf_env_for(s), label=f"worker {m}",
                                 verify_gone=(lambda n=wname: n not in live()))
    core_extra = ["--name", prefixed(core_worker_name(repo))] if isolate else []
    wrangler_delete_tolerant(["delete", *core_extra],
                             cwd=repo, cf_env=cf_env_for(s), label="core worker",
                             verify_gone=(lambda: prefixed(core_worker_name(repo)) not in live()))
    removed.append("workers (modules + core)")

    sid = st.resource_id("store_id")
    if sid:
        if st.is_adopted("store_id") and not include_adopted:
            log(f"  skipping adopted Secrets Store {sid}")
        else:
            base = f"/accounts/{acct}/secrets_store/stores/{sid}/secrets"
            for sec_id in {x.get("id") for x in (cf_api("GET", base, tok) or []) if isinstance(x, dict) and x.get("id")}:
                cf_api("DELETE", f"{base}/{sec_id}", tok)
            cf_api("DELETE", f"/accounts/{acct}/secrets_store/stores/{sid}", tok)
            removed.append("Secrets Store (store + secrets)")
            st.remove("store_id")
    aid = st.resource_id("access_app_id")
    if aid:
        if st.is_adopted("access_app_id") and not include_adopted:
            log(f"  skipping adopted Access app {aid}")
        else:
            cf_api("DELETE", f"/accounts/{acct}/access/apps/{aid}", tok)
            removed.append("Access app")
            st.remove("access_app_id")
    gw = st.resource_id("gateway_id")
    if gw:
        if st.is_adopted("gateway_id") and not include_adopted:
            log(f"  skipping adopted AI Gateway {gw}")
        else:
            cf_api("DELETE", f"/accounts/{acct}/ai-gateway/gateways/{gw}", tok)
            removed.append("AI Gateway")
            st.remove("gateway_id")
    rt = st.resource_id("r2_token_id")
    if rt:
        if st.is_adopted("r2_token_id") and not include_adopted:
            log(f"  skipping adopted R2 API token {rt}")
        else:
            revoke_token_tolerant(acct, tok, rt)  # tolerate a token revoked out-of-band (#682)
            removed.append("R2 API token")
            st.remove("r2_token_id")

    log("CF removed by id: " + (", ".join(removed) if removed else "(nothing was recorded in state)"))

    if not delete_data:
        log("NOTE: R2 buckets + D1 (your DATA) left intact. Re-run with --delete-data to remove them.")
    else:
        for b in (st.get("r2_buckets") or []):
            bkey = f"r2_bucket_{b}"
            if st.is_adopted(bkey) and not include_adopted:
                log(f"  skipping adopted R2 bucket {b}")
                continue
            emptied = empty_r2_bucket(acct, tok, b)  # #686: CF refuses a non-empty bucket delete
            if emptied:
                log(f"  emptied R2 bucket {b} ({emptied} object(s))")
            cf_api("DELETE", f"/accounts/{acct}/r2/buckets/{b}", tok)
            log(f"  deleted R2 bucket {b}")
            st.remove(bkey)
        d1 = st.resource_id("d1_id")
        if d1:
            if st.is_adopted("d1_id") and not include_adopted:
                log(f"  skipping adopted D1 database {d1}")
            else:
                cf_api("DELETE", f"/accounts/{acct}/d1/database/{d1}", tok)
                log("  deleted D1 database")
                st.remove("d1_id")


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
    up.add_argument("--rotate-token", action="store_true",
                    help="token mode: mint a FRESH STUDIO_API_TOKEN even if one exists (invalidates the old login)")
    up.add_argument("--adopt", action="store_true",
                    help="reuse a pre-existing same-name resource this instance did not create (default: refuse)")
    sub.add_parser("plan", help="alias for `up --dry-run`")
    down = sub.add_parser("down", help="teardown by recorded id")
    down.add_argument("--delete-data", action="store_true", help="ALSO delete R2 buckets + D1 (your data)")
    down.add_argument("--noninteractive", action="store_true", help="read creds from env (CI/headless), never argv")
    down.add_argument("--include-adopted", action="store_true",
                      help="also delete adopted resources (pre-existing before --adopt); destructive")

    args = ap.parse_args(argv)
    repo = Path.cwd()
    if args.cmd == "up":
        global _ADOPT
        _ADOPT = bool(getattr(args, "adopt", False))
        cmd_up(repo, dry_run=args.dry_run, noninteractive=args.noninteractive, rotate_token=args.rotate_token)
    elif args.cmd == "plan":
        cmd_up(repo, dry_run=True, noninteractive=False)
    elif args.cmd == "down":
        cmd_down(repo, delete_data=args.delete_data, noninteractive=args.noninteractive,
                 include_adopted=args.include_adopted)


if __name__ == "__main__":
    main()
