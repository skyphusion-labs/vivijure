#!/usr/bin/env python3
"""Provision the media-stack tunnel + Workers VPC services (deploy.sh, #519).

The media stack (5 always-on CPU containers reached over Workers VPC) is part of the STANDARD
install as of #519. This script automates the whole VPC leg with the API so the operator never
touches the dashboard:

  1. resolve ONE cloudflared tunnel (adoption-first, #531): if any of the 5 named VPC Services
     already exist, adopt the tunnel THEY point at; only create a new tunnel on a true first install
     (no services yet). A split state (services across >1 tunnel) is a hard, actionable stop.
  2. reuse-or-create the 5 Workers VPC Services (video-finish / image-prep / audio-beat-sync /
     audio-mix / audio-master), each pointing at that ONE tunnel and resolving the matching docker
     service name on the operator's `vivijure` network,
  3. write the tunnel connector token to a 0600 file (for containers/compose.yaml), NEVER stdout,
  4. print a JSON map of the NON-secret ids to stdout for deploy.sh to inject into the configs.

Idempotent: a re-run adopts the existing tunnel + reuses the existing services, so it never errors,
duplicates, or splits the stack. Adoption is by the SERVICES' tunnel, not by tunnel NAME, so an
operator whose tunnel is named anything (or created out of band) is upgraded cleanly (#531).

Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in env. Beyond the base deploy scopes in
docs/DEPLOYMENT.md 2a the token needs `Cloudflare Tunnel: Write` (create the tunnel + read its
connector token) and `Connectivity Directory: Admin` (create the VPC services). A pre-#519 token
lacks these; the script names the EXACT missing scope (Write shows up as a 1001 on the connector-token
fetch, which fires on EVERY run; Admin shows up as 10196 on a service create) with the re-mint step,
instead of a raw "Authentication error" (#528).

stdout (ONLY on success): {"tunnel_id": "...", "services": {"video-finish": "<id>", ...}}
stderr: human-readable progress + any error reason. Exit non-zero on any failure.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

ACCT = os.environ["CLOUDFLARE_ACCOUNT_ID"].strip()
TOK = os.environ["CLOUDFLARE_API_TOKEN"].strip()
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}"

# The media-stack services. name == the docker service name in containers/compose.yaml == the VPC
# Service `host.hostname` the cloudflared connector resolves on the `vivijure` network. Every
# container listens on PORT 8000 internally (compose x-common), so http_port is 8000 for all.
SERVICES = [
    ("video-finish", 8000),
    ("image-prep", 8000),
    ("audio-beat-sync", 8000),
    ("audio-mix", 8000),
    ("audio-master", 8000),
]

# The exact upgrade sentence a pre-#519 token needs (#528). Printed under a scope-specific line.
UPGRADE_HINT = ("your token predates the media-stack scopes; re-mint per docs/DEPLOYMENT.md section 2a "
                "(adds Cloudflare Tunnel: Write + Connectivity Directory: Admin) and update deploy.env")


class ScopeError(RuntimeError):
    """A privileged call failed in a way that maps to a specific missing token scope (#528)."""


def req(url, method="GET", body=None):
    r = urllib.request.Request(
        url, method=method,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(r).read())


def err_codes(e):
    """Return (list_of_int_codes, raw_json_str) from an HTTPError body, best-effort."""
    try:
        body = json.loads(e.read())
        codes = [x.get("code") for x in (body.get("errors") or []) if isinstance(x, dict)]
        return codes, json.dumps(body.get("errors"))[:300]
    except Exception:  # noqa: BLE001
        return [], f"HTTP {getattr(e, 'code', '?')}"


def scoped(fn, scope, codes_that_mean_missing):
    """Run fn(); on an HTTPError whose code/status implies the missing scope, raise a ScopeError that
    names it (#528). Any other HTTPError re-raises as-is (a genuine, non-scope failure)."""
    try:
        return fn()
    except urllib.error.HTTPError as e:
        codes, raw = err_codes(e)
        if e.code in (401, 403) or any(c in codes_that_mean_missing for c in codes):
            raise ScopeError(f"your token lacks '{scope}'\n  {UPGRADE_HINT}\n  (Cloudflare said: {raw})")
        raise


def service_tunnel(s):
    return ((s.get("host") or {}).get("resolver_network") or {}).get("tunnel_id")


def list_services():
    # needs Connectivity Directory read; a token with no connectivity scope 403s here.
    return scoped(
        lambda: req(f"{API}/connectivity/directory/services?per_page=100").get("result") or [],
        "Connectivity Directory: Admin", {10196})


def fetch_token(tid):
    """Return the connector token for the tunnel. Tunnel:Write-gated (1001 if the token is read-only).
    This is the Write preflight -- it runs before any service create, so a read-only token fails HERE
    with a named-scope message rather than late and generically (#528)."""
    out = scoped(lambda: req(f"{API}/cfd_tunnel/{tid}/token"),
                 "Cloudflare Tunnel: Write", {1001, 10000})
    if not out.get("success"):
        raise RuntimeError("tunnel token fetch failed: " + json.dumps(out.get("errors"))[:300])
    token = out.get("result")
    if not isinstance(token, str) or not token:
        raise RuntimeError("tunnel token response was empty")
    return token


def reuse_or_create_tunnel(name):
    """First-install path (no existing services define a tunnel): reuse a non-deleted tunnel of this
    name, else create one. Tunnel list + create are Tunnel:Write-gated."""
    got = scoped(lambda: req(f"{API}/cfd_tunnel?name={name}&is_deleted=false").get("result") or [],
                 "Cloudflare Tunnel: Write", {1001, 10000})
    for t in got:
        if t.get("name") == name and not t.get("deleted_at"):
            print(f"reusing tunnel {name} ({t['id']})", file=sys.stderr)
            return t["id"]
    # config_src=cloudflare -> remotely-managed tunnel; CF generates the secret, the token endpoint
    # returns the connector token. Workers VPC routes by the service definitions, so this tunnel needs
    # NO ingress config -- the connector just needs network reach to the containers.
    out = scoped(lambda: req(f"{API}/cfd_tunnel", "POST", {"name": name, "config_src": "cloudflare"}),
                 "Cloudflare Tunnel: Write", {1001, 10000})
    if not out.get("success"):
        raise RuntimeError("tunnel create failed: " + json.dumps(out.get("errors"))[:300])
    tid = out["result"]["id"]
    print(f"created tunnel {name} ({tid})", file=sys.stderr)
    return tid


def resolve_tunnel(existing_by_name, name):
    """Adoption-first tunnel resolution (#531). Return the ONE tunnel id the stack should use.

    - If existing services all point at ONE tunnel -> ADOPT it (ignore the name convention).
    - If they point at >1 tunnel -> split-brain: hard stop with what to run.
    - If no service defines a tunnel -> first install: reuse/create by name.
    """
    tids = {}
    for svc_name, _ in SERVICES:
        s = existing_by_name.get(svc_name)
        if not s:
            continue
        tid = service_tunnel(s)
        if tid:
            tids.setdefault(tid, []).append(svc_name)
    if len(tids) == 1:
        tid = next(iter(tids))
        print(f"adopting the tunnel the existing VPC services already point at ({tid})", file=sys.stderr)
        return tid
    if len(tids) > 1:
        detail = "; ".join(f"{t} <- {', '.join(svcs)}" for t, svcs in tids.items())
        raise RuntimeError(
            "media VPC services are SPLIT across multiple tunnels: " + detail + ".\n"
            "  This cannot be resolved automatically. Point all 5 services at ONE tunnel, or delete the\n"
            "  stale service(s) (CF dashboard -> Networking -> Connectivity, or the connectivity/directory\n"
            "  API), then re-run ./deploy.sh -- it will recreate the missing services against one tunnel.")
    return reuse_or_create_tunnel(name)


def create_service(name, port, tid):
    body = {"name": name, "type": "http", "http_port": port,
            "host": {"hostname": name, "resolver_network": {"tunnel_id": tid}}}
    r = scoped(lambda: req(f"{API}/connectivity/directory/services", "POST", body),
               "Connectivity Directory: Admin", {10196})
    if not r.get("success"):
        raise RuntimeError(f"service {name} create failed: " + json.dumps(r.get("errors"))[:300])
    sid = r["result"]["service_id"]
    print(f"created service {name} ({sid})", file=sys.stderr)
    return sid


def write_token(token, token_file):
    """Write the connector token to a 0600 file as TUNNEL_TOKEN=... (never stdout)."""
    fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"TUNNEL_TOKEN={token}\n")
    print(f"wrote connector token -> {token_file} (0600)", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tunnel-name", default="vivijure-media",
                    help="tunnel name for a FIRST install only; ignored when services already exist")
    ap.add_argument("--token-file", required=True,
                    help="0600 file to write TUNNEL_TOKEN= into (for docker compose)")
    args = ap.parse_args()

    existing = list_services()
    by_name = {s.get("name"): s for s in existing}

    # 1. resolve the ONE tunnel (adopt the services' tunnel, else create) -- #531.
    tid = resolve_tunnel(by_name, args.tunnel_name)
    # 2. fetch its connector token FIRST (the Tunnel:Write preflight, #528) and write it to 0600.
    write_token(fetch_token(tid), args.token_file)
    # 3. reuse existing services, create only the missing ones -- all against the ONE adopted tunnel.
    out = {}
    for name, port in SERVICES:
        s = by_name.get(name)
        if s:
            print(f"reusing service {name} ({s.get('service_id')})", file=sys.stderr)
            out[name] = s.get("service_id")
        else:
            out[name] = create_service(name, port, tid)
    # stdout: ONLY the non-secret ids, machine-readable for deploy.sh.
    print(json.dumps({"tunnel_id": tid, "services": out}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ScopeError as e:
        print("media-vpc setup failed: " + str(e), file=sys.stderr)
        sys.exit(1)
    except urllib.error.HTTPError as e:
        _, raw = err_codes(e)
        print("Cloudflare API error: " + raw, file=sys.stderr)
        print("  (the deploy token needs Cloudflare Tunnel: Write + Connectivity Directory: Admin; "
              "see docs/DEPLOYMENT.md 2a)", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(f"media-vpc setup failed: {e}", file=sys.stderr)
        sys.exit(1)
