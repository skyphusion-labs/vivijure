# Security policy

This is the reporting policy for Vivijure Studio. For the technical security posture (the trust
boundary, what a leaked value can reach, and which surfaces are intentionally public) see
[docs/SECURITY.md](docs/SECURITY.md); that document is the authoritative model and is not repeated
here.

## Supported versions

This is a rolling, single-`main`-branch project released as `vX.Y.Z` tags. Only the latest release
receives security fixes; if you run an older revision, upgrade to the newest tag to pick them up.

## Reporting a vulnerability

Please do not open a public GitHub issue for a security problem. Report it privately to
**security@skyphusion.org**. If you would rather use GitHub, open the repository's **Security** tab and
click **"Report a vulnerability"** to file a private advisory that only you and the maintainers can
see.

Please include:

- A description of the issue and its impact
- Steps to reproduce, with a minimal example if possible
- The affected version (release tag or commit SHA if known)
- Any suggestions for a fix

What to expect:

- **Acknowledgment** within a reasonable window (target: 5 business days).
- A **fix** in the latest release once we confirm the issue; time-sensitive reports should say so.
- **Credit** for your report when the fix ships, unless you would rather stay anonymous.

Please give us a chance to ship a fix before any public disclosure (target: up to 90 days for a
coordinated fix).

## Scope

In scope is this repository (the studio control-plane Worker) and its runtime. The trust model, the
intentionally public surfaces, and the downstream-deployer requirements are documented in
[docs/SECURITY.md](docs/SECURITY.md). Please do not send code, diffs, or excerpts you do not have the
rights to share.
