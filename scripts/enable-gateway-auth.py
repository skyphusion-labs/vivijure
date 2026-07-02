#!/usr/bin/env python3
"""Enable authentication on the deploy's AI Gateway (deploy.sh, finding F16).

Unified Billing requires an AUTHENTICATED gateway. A gateway created via the API defaults to
authentication=false, which passes planner calls through KEYLESS -- the provider then 401s
("x-api-key header is required") even with a valid CF_AIG_TOKEN on the worker. Both pieces
are required; this script handles the toggle.

Prints "ok" to stdout when authentication is (already or now) enabled; prints a reason to
stderr and exits non-zero otherwise -- deploy.sh then points the operator at the dashboard
toggle (gateway Settings -> Authenticated Gateway).

Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (AI Gateway Edit) + GATEWAY_ID in env.
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

# Read-only / server-owned fields the full-object PUT must not echo back.
READ_ONLY = ("id", "created_at", "modified_at", "internal_id", "account_id", "account_tag")


def req(url, method="GET", body=None):
    r = urllib.request.Request(
        url, method=method,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(r).read())


def main():
    gateways = req(BASE).get("result") or []
    cur = next((g for g in gateways if g.get("id") == GW), None)
    if cur is None:
        print(f"gateway {GW} not found on the account", file=sys.stderr)
        return 1
    if cur.get("authentication") is True:
        print("ok")
        return 0
    body = {k: v for k, v in cur.items() if k not in READ_ONLY}
    body["authentication"] = True
    out = req(f"{BASE}/{GW}", "PUT", body)
    if out.get("success") and (out.get("result") or {}).get("authentication") is True:
        print("ok")
        return 0
    print("update failed: " + json.dumps(out.get("errors"))[:200], file=sys.stderr)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 -- any failure means "use the dashboard toggle"
        print(f"failed: {e}", file=sys.stderr)
        sys.exit(1)
