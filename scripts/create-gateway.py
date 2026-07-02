#!/usr/bin/env python3
"""Ensure the deploy's AI Gateway exists (deploy.sh, finding F2).

A first-time operator otherwise has to hand-create an AI Gateway in the dashboard before deploy.sh
can run. This creates it via the API when it is missing, with authentication AND
cache_invalidate_on_update ON at birth -- a gateway created with authentication=false breaks Unified
Billing (planner calls pass through keyless and the provider 401s), so we never want the default-off
state to exist even briefly.

Idempotent: if the gateway already exists this is a no-op success (its auth toggle is handled
separately by enable-gateway-auth.py). Prints "ok" to stdout on exists-or-created; prints a reason to
stderr and exits non-zero otherwise (deploy.sh then prints the one manual dashboard step). A deploy
token without "AI Gateway: Edit" cannot create -- that is a soft failure, not a dead deploy.

Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN + GATEWAY_ID in env.
"""
import json
import os
import sys
import urllib.error
import urllib.request

ACCT = os.environ["CLOUDFLARE_ACCOUNT_ID"].strip()
TOK = os.environ["CLOUDFLARE_API_TOKEN"].strip()
GW = os.environ["GATEWAY_ID"].strip()
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/ai-gateway/gateways"


def req(url, method="GET", body=None):
    r = urllib.request.Request(
        url, method=method,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(r).read())


def exists():
    try:
        req(f"{BASE}/{GW}")
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def main():
    if exists():
        print("ok")  # already present; enable-gateway-auth.py handles the auth toggle
        return 0
    # Create with the Unified-Billing-safe defaults: authenticated + cache-invalidate-on-update at
    # birth. The other fields are the CF-required create-body members (no caching, no rate limit).
    body = {
        "id": GW,
        "authentication": True,
        "cache_invalidate_on_update": True,
        "cache_ttl": 0,
        "collect_logs": True,
        "rate_limiting_interval": 0,
        "rate_limiting_limit": 0,
        "rate_limiting_technique": "fixed",
    }
    out = req(BASE, "POST", body)
    if out.get("success"):
        print("ok")
        return 0
    print("create failed: " + json.dumps(out.get("errors"))[:200], file=sys.stderr)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 -- any failure means "create it in the dashboard"
        print(f"failed: {e}", file=sys.stderr)
        sys.exit(1)
