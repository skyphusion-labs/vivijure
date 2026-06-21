"""SSRF guard for the CPU containers: allowlist outbound fetch URLs (closed by
default). The Worker presigns short-lived R2 GET/PUT URLs and passes them in the
request body; CodeQL (py/full-ssrf) treats those as attacker-controllable. We
VALIDATE every request-supplied URL before fetching it and REJECT anything off
the allowlist -- https only, host on the R2 endpoint (*.r2.cloudflarestorage.com
by default, overridable via ALLOWED_FETCH_HOSTS). IP-literal hosts are rejected
outright, which blocks loopback / private / link-local ranges and the cloud
metadata endpoint 169.254.169.254.

Vendored byte-for-byte into each container dir (the four CPU containers do not
share a module today; the Docker build context is per-directory). Stdlib only --
keep it dependency-free so every container can import it with just Python.
"""
import ipaddress
import os
from urllib.parse import urlparse

# Default allowlist: the Cloudflare R2 S3 endpoint. A host matches an allowlist
# entry when it equals the entry or is a subdomain of it (on a dot boundary), so
# "<account>.r2.cloudflarestorage.com" matches "r2.cloudflarestorage.com" while
# "evil-r2.cloudflarestorage.com" does NOT.
DEFAULT_ALLOWED_HOST = "r2.cloudflarestorage.com"


def _allowed_hosts():
    """The configured allowlist. ALLOWED_FETCH_HOSTS (comma-separated) overrides
    the default for a custom R2 domain; a leading dot is tolerated and stripped.
    Falls back to the R2 endpoint so the guard is safe out of the box."""
    raw = os.environ.get("ALLOWED_FETCH_HOSTS", "").strip()
    if not raw:
        return (DEFAULT_ALLOWED_HOST,)
    hosts = tuple(h.strip().lower().lstrip(".") for h in raw.split(",") if h.strip())
    return hosts or (DEFAULT_ALLOWED_HOST,)


def _is_ip_literal(host):
    try:
        ipaddress.ip_address(host.strip("[]"))  # strip IPv6 brackets
        return True
    except ValueError:
        return False


def validate_fetch_url(url):
    """Return (True, None) if `url` is safe to fetch, else (False, reason).

    Closed-by-default allowlist: https scheme + a host on the R2 endpoint (or an
    ALLOWED_FETCH_HOSTS override). Everything else -- other schemes, IP-literal
    hosts (incl. 169.254.169.254 / loopback / private ranges), and any off-list
    host -- is rejected WITHOUT a network call.
    """
    if not isinstance(url, str) or not url:
        return False, "missing URL"
    try:
        parts = urlparse(url)
    except Exception:
        return False, "unparseable URL"
    if parts.scheme != "https":
        return False, "scheme not allowed (https only): " + (parts.scheme or "none")
    host = (parts.hostname or "").lower()
    if not host:
        return False, "missing host"
    if _is_ip_literal(host):
        return False, "IP-literal host not allowed: " + host
    for allowed in _allowed_hosts():
        if host == allowed or host.endswith("." + allowed):
            return True, None
    return False, "host not in fetch allowlist: " + host
