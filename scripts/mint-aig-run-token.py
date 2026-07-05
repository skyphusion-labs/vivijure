#!/usr/bin/env python3
"""Mint (or --check) the "AI Gateway Run"-only API token for CF_AIG_TOKEN (deploy.sh, findings F16/F4).

Default mode MINTS the token and prints the TOKEN VALUE (and nothing else) to stdout on success, so
deploy.sh can pipe it straight into the Secrets Store -- the value never touches a log or the terminal.

--check mode mints nothing and prints NO secret. It exits 0 if an active token named
`vivijure-planner-aig-run` still exists on the account, 4 if it is confirmed absent, and 1 if it could
not determine (API/scope error). deploy.sh uses it to validate a reused Secrets Store token whose value
it cannot read back (#516): store secret VALUES are write-only, so a live gateway probe is impossible in
the reuse branch; confirming the underlying account API token is still active is the best free check.

Every failure path prints a PRECISE reason to stderr and exits non-zero; deploy.sh surfaces that reason
verbatim instead of guessing (#515).

Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the environment. The mint path needs
"Account API Tokens: Edit" on the deploy token (403 code 9109 otherwise); --check needs read access to
the same account token list.
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
NAME = "vivijure-planner-aig-run"


def req(url, method="GET", body=None):
    r = urllib.request.Request(
        url, method=method,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(r).read())


def token_active():
    """True if an ACTIVE token named NAME exists on the account."""
    existing = req(f"{API}/tokens?per_page=50").get("result") or []
    return any(t.get("name") == NAME and t.get("status") == "active" for t in existing)


def do_check():
    # Weaker-but-free reuse validation (#516): the Secrets Store value cannot be read back, so we
    # cannot probe the gateway with it. We CAN confirm the underlying account API token still exists
    # and is active. This catches the common failure (the minted token was later revoked/deleted). It
    # cannot catch a same-name token rotated out from under a stale store value; that is a documented
    # limit of a value-less check. A hard API/scope error returns 1 (caller: "could not determine"),
    # distinct from 4 (confirmed absent), so deploy.sh does not nuke a possibly-working reuse.
    if token_active():
        return 0
    print(f"no active {NAME} token on the account", file=sys.stderr)
    return 4


def do_mint():
    # Idempotency: never stack orphan Run tokens on the account across re-runs. An existing token's
    # value is unrecoverable, so treat it as mint-unavailable -- deploy.sh prints the delete-the-orphan
    # remedy (#515), and its store-secret-exists check catches the normal re-run before we get here.
    if token_active():
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


def main():
    ap = argparse.ArgumentParser(description="Mint or --check the vivijure planner AI Gateway Run token.")
    ap.add_argument("--check", action="store_true",
                    help="validate an active token exists (prints NO secret); exit 0 active, 4 absent, 1 unknown")
    args = ap.parse_args()
    return do_check() if args.check else do_mint()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as e:
        print(f"cloudflare API HTTP {e.code}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 -- any failure means "use the paste/validate fallback"
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
