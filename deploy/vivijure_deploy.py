#!/usr/bin/env python3
"""vivijure-deploy: a guided installer that stands up the whole Vivijure stack on YOUR OWN
Cloudflare + RunPod accounts (BYO keys + GPU). One input surface, idempotent re-runs, a teardown.

What it does (see issue #244 for the design + options survey):
  - one input surface + correct secret handling (hidden prompts, never echoed, logged, or on argv),
  - the full provisioning spine: Cloudflare (D1, R2 x2, AI Gateway, Secrets Store + an R2 S3 token
    mint, plus a CF Access app ONLY when AUTH_MODE=access), then RunPod (template, network volume,
    endpoints), then seed -> migrate -> deploy. In the default AUTH_MODE=token the studio's /api/* gate
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
(DEPLOY_DOMAIN, OPERATOR_EMAIL, DATACENTER_ID, BACKEND_IMAGE_TAG, GPU_TYPE_IDS) are flagged at the top
and the run dies loud if any is missing.

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
STORE_BINDING_NAMES = (  # binding NAMES only (never values) -- the store keys the workers read
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


def create_if_absent(*, kind: str, account: str, token: str, list_path: str, create_path: str,
                     create_body: dict, name: str, name_key: str, id_key: str,
                     list_unwrap: str | None = None, known_id: str | None = None) -> str:
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
                return rid
            if _ADOPT:
                log(f"  {kind} '{name}' exists ({rid}) -- ADOPTING (--adopt)")
                return rid
            die(f"refusing to adopt pre-existing {kind} '{name}' ({rid}): this instance did not create it "
                f"(not recorded in {state_file_name()}). It may belong to another deployment on this "
                f"account. Re-run `up --adopt` to reuse it deliberately, or set DEPLOY_PREFIX to isolate.")
    created = cf_api("POST", create_path.format(acct=account), token, create_body)
    rid = str(created.get(id_key, name)) if isinstance(created, dict) else name
    log(f"  {kind} '{name}' created ({rid})")
    return rid


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
    """The core worker NAME = the root wrangler.toml `name` (default 'vivijure-studio')."""
    m = re.search(r'(?m)^\s*name\s*=\s*"([^"]+)"', (repo / "wrangler.toml").read_text())
    if not m:
        die("no `name` in wrangler.toml")
    return m.group(1)


def transform_core_toml(text: str, *, prefix: str, module_service_names: list, d1_id: str, store_id: str) -> str:
    """PURE text render of the core wrangler.toml for an ISOLATED (prefixed) instance. Empty prefix ->
    unchanged (never called then). A prefixed core CANNOT deploy verbatim: its [[services]] point at
    prod-named modules, its D1/R2 + Secrets Store bindings are prod's, and its [[vpc_services]] /
    tail_consumers / [[routes]] / [[migrations]] targets do not exist for an isolated instance (a
    dangling binding, or a delete-class migration for a class this fresh worker never had, fails
    `wrangler deploy`). This applies exactly the rewrites that make an isolated core deployable:
      - repoint every [[services]] service = "<module>" to the prefixed module worker name,
      - rebind [[r2_buckets]] bucket_name + the R2_S3_BUCKET var to the prefixed buckets,
      - inject the prefixed D1 database_id + the prefixed Secrets Store store_id,
      - enable workers_dev + drop the custom-domain [[routes]] block (an isolated instance verifies on
        workers.dev; it needs no domain),
      - strip [[vpc_services]] + tail_consumers + [[migrations]] (unprovisioned / inapplicable here).
    Unit-tested here; the end-to-end (wrangler accepts it, the isolated core stands up) is proven when a
    prefixed instance is first deployed live."""
    p = prefix.strip()
    if not p:
        return text
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
# teardown can delete by id.
# --------------------------------------------------------------------------------------------------


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

    def put(self, key: str, value) -> None:
        # Real guard (not just a comment): refuse to persist a key whose name implies a secret VALUE.
        # Ids/names only -- note r2_token_id is the access-key ID, not the secret it derives.
        if any(h in key.lower() for h in self._SECRET_KEY_HINTS):
            die(f"refusing to write '{key}' to the state file -- it looks like a secret value (state holds ids only)")
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
    app_id = create_if_absent(kind="Access app", account=account, token=token,
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
        name=DEPLOY_DOMAIN, name_key="domain", id_key="id", known_id=st.get("access_app_id"))
    st.put("access_app_id", app_id)


def mint_r2_s3_token(account: str, token: str, st: State) -> dict:
    """Create an account-scoped API token with the R2 read/write permission group and DERIVE the S3
    credentials. Confirmed against developers.cloudflare.com/r2/api/tokens/:
      Access Key ID     = the token's `id`
      Secret Access Key = SHA-256 hex digest of the token's `value`
    The token value is returned ONCE by CF; the derived secret is held in memory for the seed step and
    is NEVER written to state. NOT cleanly idempotent (CF returns the value once), so a state flag skips
    a re-mint on re-run -- the secret was already seeded into the store on the first run."""
    endpoint = f"https://{account}.r2.cloudflarestorage.com"
    if st.get("r2_token_id"):
        log("  R2 S3 token already minted (id in state) -- skipping re-mint (secret already seeded)")
        return {"R2_S3_ACCESS_KEY_ID": st.get("r2_token_id"), "R2_S3_SECRET_ACCESS_KEY": "", "R2_S3_ENDPOINT": endpoint}
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


def provision_cloudflare_infra(repo: Path, s: Secrets, st: State) -> dict:
    """Step 1. The CF data-plane resources the workers bind (D1, R2 x2, AI Gateway), reconciled by name.
    Returns the IN-MEMORY derived values the secret seed needs (GATEWAY_ID slug + R2 S3 creds);
    identifiers are also recorded in state. Also mints the scoped R2 S3 token and creates the Access app."""
    acct, tok = s.cf_account_id, s.cf_api_token
    log("provisioning Cloudflare infra (D1, R2 x2, AI Gateway; Access app only when AUTH_MODE=access) ...")

    d1_id = create_if_absent(kind="D1 database", account=acct, token=tok,
        list_path="/accounts/{acct}/d1/database", create_path="/accounts/{acct}/d1/database",
        create_body={"name": prefixed(D1_DATABASE)}, name=prefixed(D1_DATABASE), name_key="name",
        id_key="uuid", known_id=st.get("d1_id"))
    st.put("d1_id", d1_id)

    prefixed_buckets = [prefixed(b) for b in R2_BUCKETS]
    for nb in prefixed_buckets:
        create_if_absent(kind="R2 bucket", account=acct, token=tok,
            list_path="/accounts/{acct}/r2/buckets", create_path="/accounts/{acct}/r2/buckets",
            create_body={"name": nb}, name=nb, name_key="name", id_key="name", list_unwrap="buckets",
            known_id=st.get(f"r2_bucket_{nb}"))
        st.put(f"r2_bucket_{nb}", nb)
    st.put("r2_buckets", prefixed_buckets)

    gw_slug = prefixed(AI_GATEWAY_ID)
    gateway = create_if_absent(kind="AI Gateway", account=acct, token=tok,
        list_path="/accounts/{acct}/ai-gateway/gateways", create_path="/accounts/{acct}/ai-gateway/gateways",
        create_body={"id": gw_slug, "cache_ttl": 0, "collect_logs": True,
                     "rate_limiting_interval": 0, "rate_limiting_limit": 0, "rate_limiting_technique": "fixed"},
        name=gw_slug, name_key="id", id_key="id", known_id=st.get("gateway_id"))
    st.put("gateway_id", gateway)  # an identifier (the slug), not a secret -- safe in state

    # Scoped R2 S3 token: mint + derive (Access Key ID = token id; Secret = SHA-256(token value)).
    # CF returns the secret ONCE; it is held in memory for the seed step, never written to state.
    r2 = mint_r2_s3_token(acct, tok, st)
    # Access app + self-only policy gating the single-tenant studio (shapes confirmed against the CF
    # Access API docs). No-op with a warn if DEPLOY_DOMAIN / OPERATOR_EMAIL are unset.
    provision_access_app(acct, tok, st)
    return {"GATEWAY_ID": gateway, **r2}


RUNPOD_API = "https://rest.runpod.io/v1"  # the current REST API (Bearer key; OpenAPI at /v1/openapi.json)
DATACENTER_ID = ""  # REQUIRED for a network volume -- set an available DC id (GET /datacenters or console)
BACKEND_IMAGE_TAG = ""  # REQUIRED -- pin an explicit released tag (e.g. "0.2.27"); never "latest" (reproducibility)
GPU_TYPE_IDS: list = []  # REQUIRED -- endpoint GPU type id(s) (GET /gputypes), e.g. ["NVIDIA H100 80GB HBM3"]


def rp_api(method: str, path: str, key: str, body: dict | None = None):
    """RunPod REST v1 call (plain JSON, no envelope; Bearer key in the header)."""
    return http_json(method, RUNPOD_API + path, key, body)


def rp_reconcile(*, kind: str, key: str, list_path: str, create_path: str, create_body: dict,
                 name: str, name_key: str = "name", id_key: str = "id", known_id: str | None = None) -> str:
    """Idempotent reconcile by NAME against the RunPod REST API -> returns the resource id. Same
    no-silent-adopt guard as create_if_absent (#244): a same-name resource this instance did not create
    dies unless `up --adopt`."""
    listed = rp_api("GET", list_path, key)
    items = listed if isinstance(listed, list) else (
        (listed.get("data") or listed.get("endpoints") or listed.get("templates") or [])
        if isinstance(listed, dict) else [])
    for it in items:
        if isinstance(it, dict) and it.get(name_key) == name:
            rid = str(it.get(id_key, ""))
            if known_id is not None and str(known_id) == rid:
                log(f"  RunPod {kind} '{name}' exists ({rid}) [created by this instance]")
                return rid
            if _ADOPT:
                log(f"  RunPod {kind} '{name}' exists ({rid}) -- ADOPTING (--adopt)")
                return rid
            die(f"refusing to adopt pre-existing RunPod {kind} '{name}' ({rid}): this instance did not "
                f"create it (not in {state_file_name()}). Re-run `up --adopt` to reuse it, or rename via DEPLOY_PREFIX.")
    created = rp_api("POST", create_path, key, create_body)
    rid = str(created.get(id_key, "")) if isinstance(created, dict) else ""
    log(f"  RunPod {kind} '{name}' created ({rid})")
    return rid


def provision_runpod(repo: Path, s: Secrets, st: State, cf_derived: dict) -> dict:
    """Step 2. RunPod must come BEFORE secret-seeding because RUNPOD_ENDPOINT_ID is a seeded secret.
    Order within: registry-auth (only if the image is private) -> template (pin GHCR image, R2 env) ->
    network volume -> endpoint. Returns {endpoint_name: endpoint_id}. Reconciled by name. Consumes the
    R2 S3 creds (cf_derived, from the CF R2-token mint) for the backend env.

    GOTCHA encoded: for a PUBLIC GHCR image, leave containerRegistryAuthId UNSET. A stale/blank-but-
    present auth makes RunPod attempt auth and abort even a public pull."""
    key = s.runpod_api_key
    log("provisioning RunPod (registry-auth?, templates, volumes, endpoints) ...")

    # Required config -- die loud rather than POST an empty/unpinned value (relying on a remote 400).
    if not BACKEND_IMAGE_TAG or BACKEND_IMAGE_TAG == "latest":
        die('set BACKEND_IMAGE_TAG to an explicit released tag (e.g. "0.2.27") -- never empty or "latest"')
    if not DATACENTER_ID:
        die("set DATACENTER_ID to an available RunPod data-center id (GET /datacenters) -- volumes require it")
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
        tmpl_id = rp_reconcile(kind="template", key=key, list_path="/templates", create_path="/templates",
            create_body={
                "name": f"{ep}-tmpl",
                "imageName": f"{GHCR_IMAGE}:{BACKEND_IMAGE_TAG}",
                "containerDiskInGb": 500,
                "env": backend_env,
                **({"containerRegistryAuthId": registry_auth_id} if registry_auth_id else {}),
            }, name=f"{ep}-tmpl", known_id=st.get(f"runpod_template_{ep}"))
        # Network volume for the model weights (warm cache between jobs). dataCenterId is REQUIRED +
        # region-specific (confirmed against the v1 OpenAPI); checked + die-loud at the top of this fn.
        vol_id = rp_reconcile(kind="network volume", key=key, list_path="/networkvolumes",
            create_path="/networkvolumes",
            create_body={"name": f"{ep}-vol", "size": 100, "dataCenterId": DATACENTER_ID},  # size in GB
            name=f"{ep}-vol", known_id=st.get(f"runpod_volume_{ep}"))
        ep_id = rp_reconcile(kind="endpoint", key=key, list_path="/endpoints", create_path="/endpoints",
            create_body={
                "name": ep, "templateId": tmpl_id, "networkVolumeId": vol_id,
                "gpuTypeIds": GPU_TYPE_IDS,
                "workersMin": 0, "workersMax": 1,
                # scaler/idle/timeout tuning (scalerType / scalerValue / idleTimeout / executionTimeoutMs)
                # is optional; confirm the exact fields against the live /v1/openapi.json before tuning.
            }, name=ep, known_id=st.get(f"runpod_endpoint_{ep}"))
        endpoints[ep] = ep_id
        st.put(f"runpod_endpoint_{ep}", ep_id)
        st.put(f"runpod_template_{ep}", tmpl_id)
        st.put(f"runpod_volume_{ep}", vol_id)

    # Model seeding: the backend image self-preloads weights from R2 on first cold start (the
    # R2-mirror-on-cold-start model), so it is not blocking; optionally pre-seed each volume via the
    # RunPod S3 API (boto3, no pod) to avoid a slow first job.
    log("  NOTE: model-seeding via the RunPod volume S3 API (boto3) is an optional follow-up; the image "
        "self-preloads from R2 on first job otherwise.")
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


def seed_secrets(repo: Path, s: Secrets, st: State, cf_derived: dict, runpod_endpoints: dict) -> None:
    """Step 3. CRITICAL ORDER: seed the Secrets Store BEFORE deploying the workers. A module worker's
    secrets_store_secrets binding references a store secret by name; `wrangler deploy` FAILS if that
    secret does not yet exist (#237). Values flow from: the user's RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID
    (step 2), GATEWAY_ID + the scoped R2 S3 creds (step 1).

    Secret VALUES are sent in the HTTPS request body of the Secrets Store API (never on argv, never
    logged) -- the non-interactive analogue of wrangler's hidden prompt. Re-run reseeds rotated values."""
    acct, tok = s.cf_account_id, s.cf_api_token
    log("seeding the Cloudflare Secrets Store (BEFORE deploy) ...")

    store_id = create_if_absent(kind="Secrets Store", account=acct, token=tok,
        list_path="/accounts/{acct}/secrets_store/stores", create_path="/accounts/{acct}/secrets_store/stores",
        create_body={"name": prefixed(STORE_NAME)}, name=prefixed(STORE_NAME), name_key="name",
        id_key="id", known_id=st.get("store_id"))
    st.put("store_id", store_id)
    replace_store_id_placeholder(repo, store_id)  # so the deploy's bindings resolve

    values = {
        "RUNPOD_API_KEY": s.runpod_api_key,
        "RUNPOD_ENDPOINT_ID": runpod_endpoints.get("vivijure-backend", ""),
        "GATEWAY_ID": cf_derived.get("GATEWAY_ID", ""),
        "R2_S3_ACCESS_KEY_ID": cf_derived.get("R2_S3_ACCESS_KEY_ID", ""),
        "R2_S3_SECRET_ACCESS_KEY": cf_derived.get("R2_S3_SECRET_ACCESS_KEY", ""),
        "R2_S3_ENDPOINT": cf_derived.get("R2_S3_ENDPOINT", ""),
    }
    base = f"/accounts/{acct}/secrets_store/stores/{store_id}/secrets"
    existing = {x.get("name") for x in (cf_api("GET", base, tok) or []) if isinstance(x, dict)}
    # COUPLING NOTE: on a re-run, mint_r2_s3_token returns an EMPTY R2 secret (CF returns the token
    # value only once). The skip-empty guard below is what protects the already-seeded R2 secret from
    # being overwritten with a blank on a reconcile -- do NOT "fix" it to seed empty values.
    for name in STORE_BINDING_NAMES:
        v = values.get(name, "")
        if not v:
            log(f"  skip {name}: no value this run (already seeded, or not yet resolved) -- left as-is")
            continue
        if name in existing:
            cf_api("PATCH", f"{base}/{name}", tok, {"value": v, "scopes": ["workers"]})
        else:
            cf_api("POST", base, tok, {"name": name, "value": v, "scopes": ["workers"]})
        log(f"  seeded {name}")  # name only, never the value


def run_migrations(repo: Path, s: Secrets) -> None:
    """Step 4. D1 schema migrations (Wrangler only -- Terraform cannot do this). Additive, idempotent."""
    log("applying D1 migrations ...")
    wrangler(["d1", "migrations", "apply", prefixed(D1_DATABASE), "--remote"], cwd=repo, cf_env=cf_env_for(s))


def deploy_workers(repo: Path, s: Secrets, st: State) -> None:
    """Step 5. Modules BEFORE the core (the core binds each module as a [[services]] dependency).
    Wrangler bundles + uploads. Only reachable AFTER seed_secrets (the store bindings must resolve).
    When DEPLOY_PREFIX is set, every worker deploys under its prefixed name (`--name`) and the core is
    deployed from a transformed, isolated-instance toml (transform_core_toml)."""
    mods = module_dirs(repo)
    isolate = bool(DEPLOY_PREFIX.strip())
    log(f"deploying {len(mods)} module workers, then the core ...{' (isolated: ' + DEPLOY_PREFIX.strip() + ')' if isolate else ''}")
    env = cf_env_for(s)
    for m in mods:
        extra = ["--name", prefixed(module_worker_name(repo, m))] if isolate else []
        wrangler(["deploy", "-c", f"modules/{m}/wrangler.toml", *extra], cwd=repo, cf_env=env)
    # The core, AFTER every module (service bindings). Carry the /api/* auth mode as a NON-SECRET
    # [vars] override so the deployed gate matches AUTH_MODE regardless of the committed wrangler.toml
    # placeholder (STUDIO_API_TOKEN itself is a worker SECRET, set separately -- never a var, never argv).
    core_vars = ["--var", f"AUTH_MODE:{AUTH_MODE}"]
    if AUTH_MODE == "access":
        core_vars += ["--var", f"ACCESS_TEAM_DOMAIN:{ACCESS_TEAM_DOMAIN}", "--var", f"ACCESS_AUD:{ACCESS_AUD}"]
    if isolate:
        rendered = transform_core_toml((repo / "wrangler.toml").read_text(), prefix=DEPLOY_PREFIX.strip(),
            module_service_names=[module_worker_name(repo, m) for m in mods],
            d1_id=str(st.get("d1_id") or ""), store_id=str(st.get("store_id") or ""))
        tmp = repo / f"wrangler.{DEPLOY_PREFIX.strip()}.toml"
        tmp.write_text(rendered)
        try:
            wrangler(["deploy", "-c", tmp.name, "--name", prefixed(core_worker_name(repo)), *core_vars], cwd=repo, cf_env=env)
        finally:
            tmp.unlink(missing_ok=True)
    else:
        wrangler(["deploy", *core_vars], cwd=repo, cf_env=env)


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


def set_studio_api_token(repo: Path, s: "Secrets", rotate: bool) -> None:
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
    log("done. studio URL + recorded resource ids are in " + str(repo / state_file_name()))


# --------------------------------------------------------------------------------------------------
# Orchestration: up / down / plan.
# --------------------------------------------------------------------------------------------------


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
            "provision RunPod (registry-auth?, template, volume, endpoints) -> capture endpoint ids",
            "seed Cloudflare Secrets Store  <-- BEFORE deploy (#237)",
            "run D1 migrations",
            "deploy module workers, then the core (core carries the AUTH_MODE var)",
        ]
        if AUTH_MODE == "token":
            steps.append("mint + put STUDIO_API_TOKEN worker secret (operator login; kept on re-run unless --rotate-token)")
        steps.append("(phase 2) bring up CPU containers + VPC services")
        for i, name in enumerate(steps, 1):
            log(f"  {i}. {name}")
        return
    s = collect_secrets(noninteractive_env=noninteractive)
    log("credential presence: " + s.presence())  # SET/missing only
    st = State.load(repo)
    preflight(repo, s)
    cf_derived = provision_cloudflare_infra(repo, s, st)
    runpod_endpoints = provision_runpod(repo, s, st, cf_derived)
    seed_secrets(repo, s, st, cf_derived, runpod_endpoints)  # MUST precede deploy (#237)
    run_migrations(repo, s)
    deploy_workers(repo, s, st)
    if AUTH_MODE == "token":
        set_studio_api_token(repo, s, rotate_token)  # operator login (worker secret, safe post-deploy)
    restore_store_id_placeholder(repo, st.get("store_id"))  # leave the working tree clean post-deploy
    bring_up_containers(repo)
    finalize(repo, st)


def cmd_down(repo: Path, delete_data: bool) -> None:
    """Teardown in reverse dependency order, by recorded id. R2 buckets + D1 hold user data and are
    LEFT in place unless --delete-data is given."""
    st = State.load(repo)
    s = collect_secrets()  # teardown needs the keys too -- same hidden-prompt handling, never argv
    log("teardown (reverse dependency order, by recorded id) ...")

    # RunPod first (endpoint -> volume -> template). An endpoint with live workers may need scaling to 0
    # before delete; surface the API error rather than force.
    key = s.runpod_api_key
    for ep in RUNPOD_ENDPOINTS:
        eid = st.get(f"runpod_endpoint_{ep}")
        if eid:
            rp_api("DELETE", f"/endpoints/{eid}", key)
            log(f"  deleted RunPod endpoint {ep} ({eid})")
        vid = st.get(f"runpod_volume_{ep}")
        if vid:
            rp_api("DELETE", f"/networkvolumes/{vid}", key)
            log(f"  deleted RunPod volume {ep}")
        tid = st.get(f"runpod_template_{ep}")
        if tid:
            rp_api("DELETE", f"/templates/{tid}", key)
            log(f"  deleted RunPod template {ep}")

    # CF teardown by recorded id, in dependency-safe order. The minted R2 API TOKEN is the security
    # footgun -- it must NOT survive a `down`. A delete error surfaces loud (cf_api dies), never silent.
    acct, tok = s.cf_account_id, s.cf_api_token
    removed: list = []

    # Workers (modules + core) via `wrangler delete`. wrangler may prompt for confirmation depending on
    # version; that surfaces (it is not silently skipped).
    isolate = bool(DEPLOY_PREFIX.strip())
    for m in module_dirs(repo):
        extra = ["--name", prefixed(module_worker_name(repo, m))] if isolate else []
        wrangler(["delete", "-c", f"modules/{m}/wrangler.toml", *extra], cwd=repo, cf_env=cf_env_for(s))
    wrangler(["delete", *(["--name", prefixed(core_worker_name(repo))] if isolate else [])], cwd=repo, cf_env=cf_env_for(s))
    removed.append("workers (modules + core)")

    sid = st.get("store_id")
    if sid:
        base = f"/accounts/{acct}/secrets_store/stores/{sid}/secrets"
        for name in {x.get("name") for x in (cf_api("GET", base, tok) or []) if isinstance(x, dict)}:
            cf_api("DELETE", f"{base}/{name}", tok)
        cf_api("DELETE", f"/accounts/{acct}/secrets_store/stores/{sid}", tok)
        removed.append("Secrets Store (store + secrets)")
    aid = st.get("access_app_id")
    if aid:
        cf_api("DELETE", f"/accounts/{acct}/access/apps/{aid}", tok); removed.append("Access app")
    gw = st.get("gateway_id")
    if gw:
        cf_api("DELETE", f"/accounts/{acct}/ai-gateway/gateways/{gw}", tok); removed.append("AI Gateway")
    rt = st.get("r2_token_id")
    if rt:
        cf_api("DELETE", f"/accounts/{acct}/tokens/{rt}", tok); removed.append("R2 API token")

    log("CF removed by id: " + (", ".join(removed) if removed else "(nothing was recorded in state)"))

    if not delete_data:
        log("NOTE: R2 buckets + D1 (your DATA) left intact. Re-run with --delete-data to remove them.")
    else:
        for b in (st.get("r2_buckets") or []):
            cf_api("DELETE", f"/accounts/{acct}/r2/buckets/{b}", tok)
            log(f"  deleted R2 bucket {b}")
        d1 = st.get("d1_id")
        if d1:
            cf_api("DELETE", f"/accounts/{acct}/d1/database/{d1}", tok)
            log("  deleted D1 database")


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

    args = ap.parse_args(argv)
    repo = Path.cwd()
    if args.cmd == "up":
        global _ADOPT
        _ADOPT = bool(getattr(args, "adopt", False))
        cmd_up(repo, dry_run=args.dry_run, noninteractive=args.noninteractive, rotate_token=args.rotate_token)
    elif args.cmd == "plan":
        cmd_up(repo, dry_run=True, noninteractive=False)
    elif args.cmd == "down":
        cmd_down(repo, delete_data=args.delete_data)


if __name__ == "__main__":
    main()
