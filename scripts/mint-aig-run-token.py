#!/usr/bin/env python3
"""Mint a minimal "AI Gateway Run"-only API token for CF_AIG_TOKEN (deploy.sh, finding F16).

Prints the TOKEN VALUE (and nothing else) to stdout on success so deploy.sh can pipe it
straight into `wrangler secret put` -- the value never touches a log file or the terminal.
Prints a reason to stderr and exits non-zero on any failure; deploy.sh then falls back to
the paste-the-token banner.

Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the environment. The deploy token
must carry "Account API Tokens: Edit" for the mint to succeed (403 code 9109 otherwise --
that scope is optional in the docs recipe precisely because it can mint further tokens).
"""
import json
import os
import sys
import urllib.error
import urllib.request

ACCT = os.environ["CLOUDFLARE_ACCOUNT_ID"].strip()
TOK = os.environ["CLOUDFLARE_API_TOKEN"].strip()
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}"
NAME = "vivijure-planner-aig-run"


def req(url, method="GET", body=None):
    r = urllib.request.Request(
        url, method=method,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(r).read())


def main():
    # Idempotency: never stack orphan Run tokens on the account across re-runs. An existing
    # token's value is unrecoverable, so treat it as mint-unavailable (the banner tells the
    # operator to paste a token; deploy.sh's secret-exists check catches the normal re-run).
    existing = req(f"{API}/tokens?per_page=50").get("result") or []
    if any(t.get("name") == NAME and t.get("status") == "active" for t in existing):
        print(f"token {NAME} already exists; its value cannot be re-read", file=sys.stderr)
        return 3
    groups = req(f"{API}/tokens/permission_groups").get("result") or []
    run = next((g for g in groups if g.get("name") == "AI Gateway Run"), None)
    if not run:
        print("permission group 'AI Gateway Run' not found", file=sys.stderr)
        return 1
    out = req(f"{API}/tokens", "POST", {
        "name": NAME,
        "policies": [{
            "effect": "allow",
            "resources": {f"com.cloudflare.api.account.{ACCT}": "*"},
            "permission_groups": [{"id": run["id"], "name": run["name"]}],
        }],
    })
    value = (out.get("result") or {}).get("value")
    if not out.get("success") or not value:
        print("mint failed: " + json.dumps(out.get("errors"))[:200], file=sys.stderr)
        return 1
    sys.stdout.write(value)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as e:
        print(f"mint failed: HTTP {e.code}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 -- any failure means "use the paste fallback"
        print(f"mint failed: {e}", file=sys.stderr)
        sys.exit(1)
