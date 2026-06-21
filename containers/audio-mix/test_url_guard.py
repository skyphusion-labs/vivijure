"""Local SSRF-guard validation -- stdlib only, no network, no Docker.

Proves the allowlist clears the py/full-ssrf risk: a Worker-presigned R2 URL
passes, and everything an SSRF attacker would reach (the cloud metadata IP,
loopback / private IPs, plain http, off-allowlist hosts) is rejected WITHOUT a
fetch. Vendored byte-for-byte into each container dir alongside url_guard.py.

Run:  python3 test_url_guard.py
Exits non-zero on any failed assertion.
"""
import os
import sys

import url_guard
from url_guard import validate_fetch_url

# (url, expected_ok) pairs evaluated against the DEFAULT allowlist.
CASES = [
    # Happy path: presigned R2 URLs (with path/query) pass.
    ("https://abc123.r2.cloudflarestorage.com/vivijure/clip.mp4?X-Amz-Signature=deadbeef", True),
    ("https://r2.cloudflarestorage.com/bucket/key.wav", True),
    # SSRF targets: all rejected.
    ("http://169.254.169.254/latest/meta-data/iam/security-credentials/", False),  # metadata IP
    ("https://169.254.169.254/latest/meta-data/", False),                          # metadata, https
    ("http://127.0.0.1:8783/mix", False),                                          # loopback
    ("https://127.0.0.1/x", False),                                                # loopback, https
    ("http://10.0.0.5/secret", False),                                             # private
    ("https://192.168.1.1/admin", False),                                          # private
    ("https://[::1]/x", False),                                                    # IPv6 loopback
    ("http://abc123.r2.cloudflarestorage.com/x", False),                           # right host, http
    ("https://evil.com/x", False),                                                 # off-allowlist host
    ("https://evil-r2.cloudflarestorage.com/x", False),                            # lookalike (no dot boundary)
    ("https://r2.cloudflarestorage.com.evil.com/x", False),                        # suffix-spoof
    ("ftp://r2.cloudflarestorage.com/x", False),                                   # wrong scheme
    ("file:///etc/passwd", False),                                                 # local file
    ("", False),                                                                   # empty
]


def main():
    failures = []
    for url, expected in CASES:
        ok, reason = validate_fetch_url(url)
        if ok != expected:
            failures.append(f"{url!r}: expected ok={expected}, got ok={ok} ({reason})")
        else:
            verdict = "ALLOW" if ok else f"BLOCK ({reason})"
            print(f"[PASS] {verdict:<45} {url[:60]}")

    # Env override: a custom R2 domain is allowlisted; the default is replaced.
    os.environ["ALLOWED_FETCH_HOSTS"] = "media.example.com"
    try:
        ok_custom, _ = validate_fetch_url("https://cdn.media.example.com/x")
        ok_default, _ = validate_fetch_url("https://abc.r2.cloudflarestorage.com/x")
        if not ok_custom:
            failures.append("ALLOWED_FETCH_HOSTS override should allow cdn.media.example.com")
        if ok_default:
            failures.append("ALLOWED_FETCH_HOSTS override should replace the default allowlist")
        if ok_custom and not ok_default:
            print("[PASS] ALLOW/BLOCK respects ALLOWED_FETCH_HOSTS override")
    finally:
        del os.environ["ALLOWED_FETCH_HOSTS"]

    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()
