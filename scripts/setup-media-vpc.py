#!/usr/bin/env python3
"""Provision the media-stack tunnel + Workers VPC services (deploy.sh, #519).

The media stack (5 always-on CPU containers reached over Workers VPC) is part of the STANDARD
install as of #519. This script automates the whole VPC leg with the API so the operator never
touches the dashboard:

  1. reuse-or-create ONE cloudflared tunnel (default name: vivijure-media),
  2. reuse-or-create the 5 Workers VPC Services (video-finish / image-prep / audio-beat-sync /
     audio-mix / audio-master), each pointing at that tunnel and resolving the matching docker
     service name on the operator's `vivijure` network,
  3. write the tunnel connector token to a 0600 file (for containers/compose.yaml), NEVER stdout,
  4. print a JSON map of the NON-secret ids to stdout for deploy.sh to inject into the configs.

Idempotent: a re-run reuses the existing tunnel (matched by name, non-deleted) and the existing
services (matched by name), so it never errors or duplicates. If an existing service points at a
different tunnel than the one resolved here (e.g. the tunnel was deleted + recreated out of band),
it is a WARN on stderr -- recreate that service by hand; this script does not mutate a live one.

Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in env. The token needs, beyond the deploy
scopes in docs/DEPLOYMENT.md 2a: `Cloudflare Tunnel: Write` (create the tunnel + read its token) and
`Connectivity Directory: Admin` (create the VPC services). Missing either surfaces as a clear error
(CF code 10196 for the Connectivity scope), not a silent half-setup.

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


def req(url, method="GET", body=None):
    r = urllib.request.Request(
        url, method=method,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(r).read())


def cf_err(e):
    """Extract the CF error array from an HTTPError body, best-effort."""
    try:
        return json.dumps(json.loads(e.read()).get("errors"))[:300]
    except Exception:  # noqa: BLE001
        return f"HTTP {e.code}"


def ensure_tunnel(name):
    """Return the tunnel id, reusing a non-deleted tunnel of this name or creating one."""
    got = req(f"{API}/cfd_tunnel?name={name}&is_deleted=false").get("result") or []
    for t in got:
        if t.get("name") == name and not t.get("deleted_at"):
            print(f"reusing tunnel {name} ({t['id']})", file=sys.stderr)
            return t["id"]
    # config_src=cloudflare -> remotely-managed tunnel; CF generates the secret, the token endpoint
    # returns the connector token. Workers VPC routes by the service definitions below, so this
    # tunnel needs NO ingress config -- the connector just needs network reach to the containers.
    out = req(f"{API}/cfd_tunnel", "POST", {"name": name, "config_src": "cloudflare"})
    if not out.get("success"):
        raise RuntimeError("tunnel create failed: " + json.dumps(out.get("errors"))[:300])
    tid = out["result"]["id"]
    print(f"created tunnel {name} ({tid})", file=sys.stderr)
    return tid


def write_token(tid, token_file):
    """Fetch the connector token and write it to a 0600 file as TUNNEL_TOKEN=... (never stdout)."""
    out = req(f"{API}/cfd_tunnel/{tid}/token")
    if not out.get("success"):
        raise RuntimeError("tunnel token fetch failed: " + json.dumps(out.get("errors"))[:300])
    token = out["result"]
    if not isinstance(token, str) or not token:
        raise RuntimeError("tunnel token response was empty")
    # shell-to-file only; O_TRUNC so a re-run rewrites cleanly, 0600 so only the operator reads it.
    fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"TUNNEL_TOKEN={token}\n")
    print(f"wrote connector token -> {token_file} (0600)", file=sys.stderr)


def ensure_services(tid):
    """Return {name: service_id} for the 5 services, reusing by name or creating."""
    existing = req(f"{API}/connectivity/directory/services?per_page=100").get("result") or []
    by_name = {s.get("name"): s for s in existing}
    out = {}
    for name, port in SERVICES:
        s = by_name.get(name)
        if s:
            sid = s.get("service_id")
            cur = (((s.get("host") or {}).get("resolver_network") or {}).get("tunnel_id"))
            if cur and cur != tid:
                print(f"WARN: service {name} ({sid}) points at tunnel {cur}, not {tid}; "
                      f"recreate it by hand if the tunnel changed", file=sys.stderr)
            print(f"reusing service {name} ({sid})", file=sys.stderr)
            out[name] = sid
            continue
        body = {
            "name": name,
            "type": "http",
            "http_port": port,
            "host": {"hostname": name, "resolver_network": {"tunnel_id": tid}},
        }
        r = req(f"{API}/connectivity/directory/services", "POST", body)
        if not r.get("success"):
            raise RuntimeError(f"service {name} create failed: " + json.dumps(r.get("errors"))[:300])
        sid = r["result"]["service_id"]
        print(f"created service {name} ({sid})", file=sys.stderr)
        out[name] = sid
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tunnel-name", default="vivijure-media")
    ap.add_argument("--token-file", required=True,
                    help="0600 file to write TUNNEL_TOKEN= into (for docker compose)")
    args = ap.parse_args()

    tid = ensure_tunnel(args.tunnel_name)
    write_token(tid, args.token_file)
    services = ensure_services(tid)
    # stdout: ONLY the non-secret ids, machine-readable for deploy.sh.
    print(json.dumps({"tunnel_id": tid, "services": services}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as e:
        print("Cloudflare API error: " + cf_err(e), file=sys.stderr)
        print("  (the deploy token needs Cloudflare Tunnel: Write + Connectivity Directory: Admin; "
              "see docs/DEPLOYMENT.md 2a)", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(f"media-vpc setup failed: {e}", file=sys.stderr)
        sys.exit(1)
