# Vivijure legal documents

> **Not legal advice.** These documents were written by Ernst (Conrad's legal-affairs helper, who is
> named after a lawyer and is not one). They are the project's own scaffolding, not legal advice, and
> reading them does not create an attorney-client relationship. If you are unsure how they apply to
> you, or you run your own instance, talk to a licensed attorney.

This is the index for Vivijure's public legal layer. The documents are **in force** as of the
effective date carried on each one.

Vivijure is spread across a constellation of repos, so the legal layer has one rule: **every document
is canonical in exactly one place and linked from everywhere else.** Nothing is duplicated, so nothing
can drift.

## Where each document lives

| Document | Canonical home | What it is |
|---|---|---|
| [`ACCEPTABLE-USE.md`](ACCEPTABLE-USE.md) | **here (the hub)** | Acceptable Use Policy. Binds the whole constellation. CSAM is the absolute red line (synthetic and AI-generated included, and the one exception to the otherwise hands-off privacy posture); also NCII, non-consensual deepfakes and likeness, hate and harassment, other illegal use. Plus enforcement and reporting. |
| [`TERMS.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/TERMS.md) | [vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf) | Terms of Use for the software and the project (not a SaaS agreement). AS-IS disclaimer, liability, input and output ownership, the AGPL interplay, copyright and IP terms, termination, passed-through provider terms. |
| [`PRIVACY.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md) | [vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf) | Privacy policy. You self-host, so Skyphusion Labs never sees a byte. Describes what the software stores on the operator's own infrastructure, grounded in the real schema, storage, logging, and processing path. |
| [`SECURITY.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/SECURITY.md) | [vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf) | The technical security posture: the trust boundary, what a leaked value can reach, which surfaces are intentionally public. This repo's [`SECURITY.md`](../../SECURITY.md) is the reporting policy. |

The AUP is canonical here because it binds every repo in the constellation, not just the studio. The
studio repo carries a short pointer stub back to this copy.

## Scope

- **The software** is governed by the **AGPL-3.0-only** license (see the repository `LICENSE` and
  `NOTICE`). These documents do not change that.
- **Self-hosters** operate their own instances and take on their own legal posture. These documents
  are a model they can adopt, not a service agreement that binds them.
