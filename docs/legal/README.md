# Vivijure legal documents

> **STATUS: DRAFTS for Conrad's review. Not in force. Not legal advice.**

This directory holds the public/project-facing legal scaffolding for Vivijure. These are **drafts**:
they are grounded in the studio's actual code (data handling, architecture, security posture), but
they are not adopted, not wired into the app, and not a substitute for a licensed attorney on the
load-bearing terms (liability caps, governing law, DMCA agent registration, jurisdiction-specific
compliance). Every document ends with an explicit "needs a licensed attorney" list.

## The documents

| File | What it is |
|---|---|
| [`PRIVACY.md`](PRIVACY.md) | Privacy policy. Lead promise: self-host and we never see a byte. Hosted-instance data handling is data-minimized to the bone and grounded in the real schema, storage, logging, and processing path. |
| [`ACCEPTABLE-USE.md`](ACCEPTABLE-USE.md) | Acceptable Use Policy. Prohibited content for a public generative image/video tool. CSAM is the zero-tolerance red line; also NCII, non-consensual deepfakes/likeness, hate/harassment, and other illegal use. Plus enforcement and reporting. |
| [`TERMS.md`](TERMS.md) | Terms of Service for the hosted instance. AS-IS disclaimer, liability, input/output ownership, the AGPL interplay, DMCA + designated-agent placeholder, termination, governing-law placeholder, and passed-through provider terms. |

## Scope

- **The software** is governed by the **AGPL-3.0-only** license (see the repository `LICENSE` and
  `NOTICE`). These documents do not change that.
- **The hosted service** at `vivijure.skyphusion.org` is what the Privacy Policy and Terms of Service
  govern. The studio is single-operator by design (see `../SECURITY.md`); there are no public
  accounts, which is why the privacy story is as small as it is.
- **Self-hosters** operate their own instances and take on their own legal posture; the hosted-service
  documents do not bind them.

## How these were grounded (so the Privacy policy is true, not vibes)

The Privacy policy was written after reading the actual data path:
- D1 schema (`../../migrations/`) -- including the identity-strip migration that removed the per-user
  tenancy column, leaving no per-user profile model.
- R2 usage and storage keys (`../../src/`).
- The access gate and in-Worker JWT backstop (`../../src/access-auth.ts`, `../SECURITY.md`).
- The tail/logging consumer (`../../tail/`) that ships render-state (not creative payloads) to the
  operator's own self-hosted Loki.
- The RunPod render submission and the AI-provider processing path (`../../src/runpod-submit.ts`,
  `../../src/env.ts`, `../../src/models.ts`).
- Frontend: cookieless Cloudflare Web Analytics on the marketing page only; local-storage UI
  conveniences; no third-party trackers.

## Recommendation on where these live and how to serve them

- **Canonical home: this directory (`docs/legal/*.md`).** Markdown, version-controlled, reviewable in
  PRs, the single source of truth.
- **Serving them (a later, separate change, NOT done here):** when adopted, link them from the public
  `/welcome` page and serve human-readable pages (e.g. `/legal/privacy`, `/legal/terms`,
  `/legal/acceptable-use`). Keep the markdown here as the source and render/copy to served pages so
  there is one source of truth. This PR deliberately does **not** wire anything live; that is a
  follow-up after Conrad and counsel sign off.

## These are drafts, not advice

Ernst (the author) is named after a lawyer and is not one. These documents structure and research the
project's legal scaffolding; they do not constitute legal advice or create an attorney-client
relationship. Before launch, a licensed attorney must set the liability limits, governing law/venue,
DMCA agent registration, and any jurisdiction-specific compliance, per the open-items list at the
bottom of each document.
