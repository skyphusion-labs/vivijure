# Security policy

This repository is the **Vivijure constellation hub**: documentation only. It contains no code, no
Worker, and no runtime. What lives here is the README map, the Acceptable Use Policy, and the
pointers to everything else.

**If you found a vulnerability in the studio itself** (the control-plane Worker, its runtime, or its
deployment), that belongs to the studio repo:
**[vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf)**, whose
[SECURITY.md](https://github.com/skyphusion-labs/vivijure-cf/blob/main/SECURITY.md) is the policy for
it, and whose
[docs/SECURITY.md](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/SECURITY.md) is the
authoritative trust model (the trust boundary, what a leaked value can reach, and which surfaces are
intentionally public). That model is not repeated here.

**You do not need to work out which repo is right before telling us.** If you are already here, report
it here and we will route it. Nothing gets dropped for landing at the wrong door.

## Supported versions

The version tags in this repository are the **frozen pre-split history of Vivijure Studio** (through
`v1.0.0`), kept for the record; see the [CHANGELOG](CHANGELOG.md). Nothing here is a release you
deploy, so there is no version to upgrade for a fix. Supported versions for the studio are covered by
[vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf).

## Reporting a vulnerability

Please do not open a public GitHub issue for a security problem. Report it privately to
**security@skyphusion.org**. If you would rather use GitHub, open the repository's **Security** tab and
click **"Report a vulnerability"** to file a private advisory that only you and the maintainers can
see.

Please include:

- A description of the issue and its impact
- Steps to reproduce, with a minimal example if possible
- The affected version (release tag or commit SHA if known), and which repo it is in if you know
- Any suggestions for a fix

What to expect:

- **Acknowledgment** within a reasonable window (target: 5 business days).
- A **fix** in the latest release once we confirm the issue; time-sensitive reports should say so.
- **Credit** for your report when the fix ships, unless you would rather stay anonymous.
- If the issue belongs to another repo in the constellation, we route it and tell you where it went.

Please give us a chance to ship a fix before any public disclosure (target: up to 90 days for a
coordinated fix).

## Scope

In scope **in this repository** is the integrity of these documents and the links in them: a policy
that misstates the project's position, a pointer that sends a reader somewhere wrong or hostile, a
tampered or forged document, or a link that no longer resolves to what it claims.

The studio control-plane Worker, its runtime, and the downstream-deployer requirements are **in scope
for the project** but are reported and tracked in
[vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf); the trust model and the intentionally
public surfaces are documented in
[docs/SECURITY.md](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/SECURITY.md) there.
This section says where each thing is handled. It does not narrow what we accept reports about.

Please do not send code, diffs, or excerpts you do not have the rights to share.
