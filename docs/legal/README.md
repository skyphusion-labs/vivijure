# Vivijure legal documents

> **Not legal advice.** These documents were written by Ernst (Conrad's legal-affairs helper, who is
> named after a lawyer and is not one). They are the project's own scaffolding, not legal advice, and
> reading them does not create an attorney-client relationship. If you are unsure how they apply to
> you, or you run your own instance, talk to a licensed attorney.

This directory holds the public/project-facing legal scaffolding for Vivijure. As of the effective
date on each document, these are **in force** as the project's own terms (and the terms Conrad applies
to his own instance), grounded in the studio's actual code (data handling, architecture, security
posture).

**Important framing:** Vivijure is **self-hosted AGPL software**, not a service Skyphusion Labs
operates for the public. People run Vivijure themselves, on their own infrastructure (their own
Cloudflare account, their own GPU/RunPod). Skyphusion Labs maintains the software and does not run a
hosted, multi-tenant, sign-up service. The only instance Skyphusion Labs runs is Conrad's own private,
gated instance at `vivijure.skyphusion.org` (for Conrad and the crew, plus the Slate Discord bot via
an access service token), which is not a public offering anyone signs up for. These documents are
written accordingly: use terms for the software and the project, an honest privacy baseline (you
self-host, so we never see your data), and an acceptable-use policy for the project and Conrad's
instance.

## The documents

| File | What it is |
|---|---|
| [`PRIVACY.md`](PRIVACY.md) | Privacy policy. Lead promise made literal: you self-host, so Skyphusion Labs never sees a byte; there is no hosted service collecting user data. Describes what the software stores on the operator's own infrastructure, and what Conrad's own private instance does, grounded in the real schema, storage, logging, and processing path. |
| [`ACCEPTABLE-USE.md`](ACCEPTABLE-USE.md) | Acceptable Use Policy. Conditions of use for the software and the project, and the policy Conrad applies to his instance. CSAM is the zero-tolerance red line (synthetic/AI-generated included, and the one exception to the hands-off privacy posture); also NCII, non-consensual deepfakes/likeness, hate/harassment, and other illegal use. Plus enforcement and reporting. |
| [`TERMS.md`](TERMS.md) | Terms of Use for the software and the project (not a SaaS agreement), plus the conditions for Conrad's own instance. AS-IS disclaimer, liability, input/output ownership, the AGPL interplay, copyright/IP terms, termination, and passed-through provider terms. |

## Scope

- **The software** is governed by the **AGPL-3.0-only** license (see the repository `LICENSE` and
  `NOTICE`). These documents do not change that.
- **The project and Conrad's own instance** at `vivijure.skyphusion.org` are what the Privacy Policy
  and Terms describe. The studio is single-operator by design (see `../SECURITY.md`); there are no
  public accounts, which is why the privacy story is as small as it is. Skyphusion Labs does not host
  Vivijure for the public.
- **Self-hosters** operate their own instances and take on their own legal posture; these documents are
  a model they can adopt, not a service agreement that binds them.

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

## Canonical home and serving

- **Canonical home: this directory (`docs/legal/*.md`).** Markdown, version-controlled, reviewable in
  PRs, the single source of truth.
- **Linking them:** the `vivijure.com` storefront footer links to all three documents (their GitHub
  pages -- this directory IS the canonical home). Serving worker-local human-readable pages (e.g.
  `/legal/privacy`, `/legal/terms`, `/legal/acceptable-use`) is still a follow-up; when it lands,
  keep the markdown here as the source and render/copy to served pages so there is one source of
  truth.

## Not legal advice

Ernst (the author) is named after a lawyer and is not one. These documents structure and research the
project's legal scaffolding; they do not constitute legal advice or create an attorney-client
relationship. If you are unsure how they apply to you, consult a licensed attorney.
