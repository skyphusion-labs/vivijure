# Vivijure Terms of Service

> **STATUS: DRAFT for review. Not legal advice. Not yet in force.**
> Written by Ernst (Conrad's legal-affairs helper, not a lawyer). Conrad signs off, and a licensed
> attorney sets the load-bearing liability/jurisdiction terms, before this goes live. Attorney-flagged
> items are collected at the end.

**Last updated:** DRAFT (unpublished)

---

## BLUF

Vivijure is free, AGPL-licensed software. The **software** is governed by its license (AGPL-3.0-only,
see `LICENSE`). These Terms govern using the **hosted service** at `vivijure.skyphusion.org`. Short
version: the service is provided AS-IS with no warranty, you own what you make with it (and you are
responsible for it), do not break the law or the Acceptable Use Policy, and either side can end the
arrangement. If you self-host, these service Terms mostly do not apply; the AGPL and your own setup do.

---

## 1. The software vs. the hosted service

- **The software** (the Vivijure code) is licensed to everyone under **AGPL-3.0-only**. Your rights to
  use, study, modify, and redistribute the code come from that license, not from these Terms. Nothing
  here narrows the AGPL grant. If anything here appears to conflict with the AGPL as applied to the
  software itself, the AGPL governs the software.
- **The hosted service** is one operator (Skyphusion Labs) running that software for you as a
  convenience. These Terms govern that service relationship: availability, acceptable use, ownership
  of your content, and the disclaimers below.

If you deploy Vivijure yourself, you are an operator, not a user of our service, and these service
Terms are not your agreement with us. (The AGPL still applies to the code, including its requirement
that you offer your modified source to the users of your network service.)

---

## 2. The AGPL interplay (important and intentional)

Vivijure is AGPL-3.0-only on purpose. Two consequences worth stating plainly:

- **Running it as a network service triggers the AGPL's source-sharing requirement.** If you run a
  modified Vivijure as a service that others interact with over a network, the AGPL requires you to
  offer those users the corresponding source of your modified version. We do this; you must too.
- **It is not for resale as a closed SaaS.** The license (and the project's intent, see `NOTICE`) is
  to keep Vivijure a commons. The software is deliberately built single-operator with no multi-tenant
  identity layer, partly so it resists being repackaged as a proprietary hosted product. You are free
  to host it; you are not free to strip the freedoms out of it.

(**Attorney flag:** these Terms must not, and are not intended to, add restrictions to the
AGPL-licensed software beyond the AGPL. Counsel should confirm the service Terms and the AGPL sit
cleanly side by side without the Terms being read as further restrictions on the code.)

---

## 3. Eligibility and access

The hosted instance is access-controlled; you may use it only if the operator has admitted you
through the access gate, and only as an adult. Access may be granted or revoked by the operator. You
will not share your access or attempt to bypass the gate or rate limits.

---

## 4. Acceptable use

Your use is subject to the **Acceptable Use Policy** (`ACCEPTABLE-USE.md`), which is incorporated by
reference. Violating it, especially the CSAM red line, is a material breach and can end your access
immediately.

---

## 5. Your content, your inputs, and your outputs (ownership)

- **Your inputs** (storyboards, prompts, images, audio, text) remain yours. You grant the operator
  only the limited permission to store and process them as needed to run the service for you (render
  your work, show you your history). We claim no ownership of your inputs and do not use them to train
  our own models or for any purpose beyond operating the service for you.
- **Your outputs** (generated images, video, audio, trained models) are yours as between you and the
  operator. We claim no ownership of what you generate. We do not assert a license to your outputs
  beyond what is needed to store and deliver them back to you.
- **You are responsible for your inputs and outputs.** You confirm you have the rights to your inputs
  and that your use of outputs complies with the AUP and the law.

(**Attorney flag and honest caveat:** the *copyright status of AI-generated outputs themselves* is
unsettled law and varies by jurisdiction. We can disclaim OUR ownership and confirm we do not claim
yours, but we cannot promise that a given AI output is copyrightable by you, or that it does not
implicate a third party's rights. That determination is between you, your facts, and your own legal
advice. Counsel should set the precise ownership/indemnity language.)

---

## 6. Third-party providers and pass-through terms

Rendering routes your work through third-party infrastructure (the Privacy Policy lists them:
Cloudflare, RunPod, and AI model providers reached via Cloudflare AI Gateway). When you use the
hosted service, your use of those underlying providers is also subject to THEIR terms and acceptable-
use policies, which we pass through to you. We are not responsible for those providers' acts,
outages, or model behavior, and a provider's content rules may restrict what you can generate
independently of this document. (**Attorney/operator flag:** confirm the specific provider terms that
must be passed through for the exact providers the instance calls at launch.)

---

## 7. Service is provided AS-IS (warranty disclaimer)

THE HOSTED SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. We do not warrant that the service will be
uninterrupted, error-free, secure, or that any output will be accurate, lawful to use, original, or
fit for any purpose. You use it at your own risk. This is a free, best-effort, labor-of-love service;
it may change, break, or shut down at any time without notice.

(This mirrors the "no warranty" stance of the AGPL itself, applied to the hosted service.)

---

## 8. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE OPERATOR (AND ANYONE INVOLVED IN MAKING THE SERVICE
AVAILABLE) WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR
PUNITIVE DAMAGES, OR FOR LOST PROFITS, DATA, OR GOODWILL, ARISING OUT OF OR RELATED TO YOUR USE OF (OR
INABILITY TO USE) THE SERVICE, EVEN IF ADVISED OF THE POSSIBILITY. BECAUSE THE SERVICE IS PROVIDED FREE
OF CHARGE, THE OPERATOR'S TOTAL AGGREGATE LIABILITY WILL NOT EXCEED **`PLACEHOLDER`** (e.g. the
greater of the amount you paid for the service, which is zero, or a small fixed cap).

(**Attorney flag:** the enforceable shape and dollar cap of this clause, and whether certain
liabilities cannot be disclaimed in the governing jurisdiction, MUST be set by a licensed attorney.
The placeholder is a stand-in, not a decision.)

---

## 9. Indemnification

You agree to defend, indemnify, and hold the operator harmless from claims, damages, and costs
arising out of content you generate or upload, your breach of these Terms or the AUP, or your
violation of the law or a third party's rights. (**Attorney flag:** confirm scope and mutuality for a
free service.)

---

## 10. Copyright complaints (DMCA) and takedowns

If you believe content on the hosted service infringes your copyright, send a notice to the operator's
designated agent with: (a) your signature (physical or electronic); (b) identification of the
copyrighted work; (c) identification of the allegedly infringing material and where it is; (d) your
contact information; (e) a statement of good-faith belief that the use is not authorized; and (f) a
statement, under penalty of perjury, that the notice is accurate and you are authorized to act.

**Designated DMCA agent:** `PLACEHOLDER -- name + address + email`.
(**Attorney/operator flag:** to get DMCA safe-harbor protection, the operator must REGISTER a
designated agent with the U.S. Copyright Office and publish the agent's contact details. This
placeholder is not a registered agent; register before relying on safe harbor.)

We will respond to valid notices by removing or disabling access to the identified material, and we
honor counter-notices per the DMCA process. Repeat infringers lose access.

Note: because the hosted instance is single-operator and gated (not user-generated-content open to the
public), the DMCA host-liability posture is different from a typical UGC platform; counsel should
confirm what safe-harbor registration is actually warranted here.

---

## 11. Suspension and termination

- **By you:** stop using the service any time; ask the operator to delete your content (see the
  Privacy Policy).
- **By the operator:** the operator may suspend or terminate your access at any time, with or without
  notice, including for an AUP violation, a legal requirement, abuse of the service, or because the
  operator decides to stop running the service.
- **On termination:** your right to use the service ends. The operator may delete your content. The
  AS-IS, liability, indemnity, and governing-law sections survive termination.

---

## 12. Changes to these Terms

This is a draft and will change before adoption. Once live, material changes will be reflected by
updating the "Last updated" line and, where appropriate, an in-app or repository notice. Continued use
after a change means you accept it.

---

## 13. Governing law and disputes

These Terms are governed by the laws of **`PLACEHOLDER -- jurisdiction`**, without regard to conflict-
of-laws rules, and disputes will be resolved in **`PLACEHOLDER -- venue`**.

(**Attorney flag:** governing-law and venue (and any arbitration / class-action-waiver choice) are
load-bearing decisions that depend on where the operator is and must be set by a licensed attorney.
This draft does not pick them.)

---

## 14. Miscellaneous

- **Entire agreement:** these Terms, plus the AUP and Privacy Policy, are the agreement for the hosted
  service. The AGPL governs the software.
- **Severability:** if a provision is unenforceable, the rest stays in effect.
- **No waiver:** not enforcing a term once is not a waiver of it.
- **Assignment:** you may not assign these Terms; the operator may, in connection with running or
  transferring the service.

---

## Contact

Questions about these Terms: **`PLACEHOLDER -- legal/contact address`** (set before launch).

---

## Open items that need a licensed attorney before launch

1. **Limitation of liability** -- the enforceable form and the dollar cap (Section 8), and which
   liabilities cannot be disclaimed in the chosen jurisdiction.
2. **Governing law, venue, and any arbitration/class-waiver** (Section 13).
3. **DMCA designated-agent registration** with the U.S. Copyright Office, plus confirmation of what
   safe-harbor posture actually fits a single-operator gated service (Section 10).
4. **AI-output ownership and indemnity** language (Sections 5 and 9), given unsettled copyright law.
5. **AGPL-vs-Terms interplay** review, to ensure the service Terms add no restriction to the
   AGPL-licensed software (Section 2).
6. **Provider pass-through terms** for the exact third parties the instance calls (Section 6).
