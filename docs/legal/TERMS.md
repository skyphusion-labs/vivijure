# Vivijure Terms of Use

> **Not legal advice.** This document was written by Ernst (Conrad's legal-affairs helper, who is
> named after a lawyer and is not one). It is the project's own terms, not legal advice, and reading
> it does not create an attorney-client relationship. If you are unsure how it applies to you, or you
> run your own instance, talk to a licensed attorney.

**Effective date:** 2026-06-26

---

## BLUF

Vivijure is free, AGPL-licensed software that you run yourself. The **software** is governed by its
license (AGPL-3.0-only, see `LICENSE`). These Terms are **not a hosted-service agreement**, because
Skyphusion Labs does not operate Vivijure as a service for the public. They are use terms for the
**software** and the **project**, plus the conditions under which Conrad runs his own private instance
at `vivijure.skyphusion.org` (which is for Conrad and the crew, not a service anyone signs up for).

Short version: the software is provided AS-IS with no warranty, you own what you make with it (and you
are responsible for it), do not break the law or the Acceptable Use Policy, and if you use Conrad's
private instance or take part in the project, that access can be ended. If you self-host, the AGPL and
your own setup govern your instance; you become the operator, not a customer of ours.

---

## 1. The software, the project, and Conrad's instance

- **The software** (the Vivijure code) is licensed to everyone under **AGPL-3.0-only**. Your rights to
  use, study, modify, and redistribute the code come from that license, not from these Terms. Nothing
  here narrows the AGPL grant. If anything here appears to conflict with the AGPL as applied to the
  software itself, the AGPL governs the software.
- **The project** is the open-source effort around that software (the repository, issues, discussions,
  and contributions). These Terms and the AUP set the conditions for taking part in it.
- **Conrad's instance** (`vivijure.skyphusion.org`) is Skyphusion Labs (Conrad) running the software
  for Conrad and the crew, for internal use and testing. It is not a public service, there is no
  account anyone creates with us, and we do not host anyone else's content. Skyphusion Labs does not
  host or manage Vivijure instances for other people and will not get into that business.
- **The public demo** (`demo.vivijure.com`) is Skyphusion Labs (Conrad) running the software as a
  public, read-only showcase: anyone may browse a seeded catalog and pre-made films, but it renders
  nothing, has no account or sign-in, and refuses every state-changing request. It is provided
  AS-IS on the same terms as the software (Sections 7 and 8), the Acceptable Use Policy applies to it
  (in particular Section 2.4: no attacking, scraping, evading rate limits on, or otherwise abusing an
  instance), and the showcase films are illustrative in-house work. It is not a hosted service that
  holds your content.

If you deploy Vivijure yourself, you are an operator, not a customer of ours, and these Terms are not
a service agreement between you and us. The AGPL applies to the code, including its requirement that
you offer your modified source to the users of your network service.

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

Nothing in these Terms is intended to add restrictions to the AGPL-licensed software beyond the AGPL
itself; if anything reads that way, the AGPL governs the software.

---

## 3. Access to Conrad's instance and the project

Conrad's instance is access-controlled; it is for Conrad and the crew, and only adults. It is not open
to public sign-up. If Conrad admits you to it, you may use it only as he allows, you will not share
your access, and you will not attempt to bypass the gate or rate limits. Participation in the project
(contributing, filing issues) is likewise conditioned on following these Terms and the AUP.

---

## 4. Acceptable use

Use of the software, the project, Conrad's instance, and the public demo (`demo.vivijure.com`) is subject to the **Acceptable Use Policy**
(`ACCEPTABLE-USE.md`), which is incorporated by reference. Violating it, especially the CSAM red line,
is a material breach and can end your access to Conrad's instance and your standing in the project
immediately.

---

## 5. Your content, your inputs, and your outputs (ownership)

Because you run Vivijure yourself, your inputs and outputs live on your infrastructure and are simply
yours; we never receive them. Stated for completeness, and for anyone Conrad admits to his own
instance:

- **Your inputs** (storyboards, prompts, images, audio, text) remain yours. Skyphusion Labs claims no
  ownership of them and, on Conrad's instance, uses them only to run that instance for the people on
  it. We do not use anyone's inputs to train our own models.
- **Your outputs** (generated images, video, audio, trained models) are yours. Skyphusion Labs claims
  no ownership of what you generate and asserts no license to your outputs.
- **You are responsible for your inputs and outputs.** You confirm you have the rights to your inputs
  and that your use of outputs complies with the AUP and the law.

(Honest caveat: the *copyright status of AI-generated outputs themselves* is unsettled law and varies
by jurisdiction. We can disclaim OUR ownership and confirm we do not claim yours, but we cannot
promise that a given AI output is copyrightable by you, or that it does not implicate a third party's
rights. That determination is between you, your facts, and your own legal advice.)

---

## 6. Third-party providers and pass-through terms

Running Vivijure routes work through third-party infrastructure (the Privacy Policy lists them:
Cloudflare, RunPod, and AI model providers reached via the Cloudflare AI Gateway or, for the i2v and cast
modules, the RunPod backend). When you self-host,
these are YOUR own accounts with those providers, and your use of them is subject to THEIR terms and
acceptable-use policies. A provider's content rules may restrict what you can generate independently of
this document. Skyphusion Labs is not responsible for those providers' acts, outages, or model
behavior. (**Operator note:** confirm the specific provider terms that apply to the exact providers
your instance calls.)

---

## 7. Software is provided AS-IS (warranty disclaimer)

THE SOFTWARE (AND CONRAD'S INSTANCE FOR ANYONE HE ADMITS TO IT, AND THE PUBLIC DEMO AT `demo.vivijure.com`) IS PROVIDED "AS IS" AND "AS
AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY
IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.
We do not warrant that the software will be uninterrupted, error-free, secure, or that any output will
be accurate, lawful to use, original, or fit for any purpose. You use it at your own risk. This is
free, best-effort, labor-of-love software; it may change, break, or be discontinued at any time
without notice.

(This mirrors the "no warranty" stance of the AGPL itself.)

---

## 8. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, SKYPHUSION LABS AND CONRAD (AND ANYONE INVOLVED IN MAKING THE
SOFTWARE AVAILABLE) WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY,
OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, DATA, OR GOODWILL, ARISING OUT OF OR RELATED TO YOUR USE OF
(OR INABILITY TO USE) THE SOFTWARE, CONRAD'S INSTANCE, OR THE PUBLIC DEMO, EVEN IF ADVISED OF THE POSSIBILITY. BECAUSE
THE SOFTWARE IS PROVIDED FREE OF CHARGE, THE TOTAL AGGREGATE LIABILITY WILL NOT EXCEED $0 USD (THE
AMOUNT YOU PAID FOR THE SOFTWARE, WHICH IS ZERO).

Vivijure is free, AGPL-licensed software; there is no charge for it, so the liability cap is zero.

---

## 9. Indemnification

You agree to defend, indemnify, and hold Skyphusion Labs and Conrad harmless from claims, damages, and
costs arising out of content you generate or upload, your breach of these Terms or the AUP, or your
violation of the law or a third party's rights.

---

## 10. Copyright and intellectual property

- **The software** is licensed under AGPL-3.0-only (see `LICENSE` and Section 2). Your rights in the
  Vivijure code come from that license, and you must follow it when you use, modify, or redistribute
  the code.
- **Respect other people's intellectual property when you use the software.** Do not feed in, train a
  model on, or reproduce copyrighted, trademarked, or otherwise protected material that you have no
  right to use. You are responsible for the content you generate and upload, and for having the rights
  to your inputs (see Section 5). Infringing use also violates the Acceptable Use Policy (Section 2.4).
- **We claim no ownership of your outputs** and assert no license to them beyond what Section 5
  describes.

Because Vivijure is self-hosted software and Skyphusion Labs does not host anyone else's content, the
project is not an online hosting provider and there is no provider takedown role here. If you self-host
and choose to let other people put content on your own instance, the copyright obligations that come
with hosting others' content are yours to determine and meet.

---

## 11. Suspension and termination

- **By you:** stop using Conrad's instance any time; ask Conrad to delete your content there (see the
  Privacy Policy). Self-hosting is yours to start and stop as you like.
- **By Skyphusion Labs / Conrad:** access to Conrad's instance, or standing in the project, may be
  suspended or terminated at any time, with or without notice, including for an AUP violation, a legal
  requirement, abuse, or because Conrad decides to stop running the instance. None of this reaches
  your self-hosted instance, which is yours.
- **On termination:** your right to use Conrad's instance ends, and your content there may be deleted.
  The AS-IS, liability, indemnity, and governing-law sections survive termination.

---

## 12. Changes to these Terms

Material changes will be reflected by updating the **Effective date** line above and, where
appropriate, an in-app or repository notice. Continued use of Conrad's instance or participation in the
project after a change means you accept it.

---

## 13. Governing law and disputes

These Terms are governed by the laws of the **State of Texas**, without regard to its conflict-of-laws
rules. Any dispute arising out of or relating to these Terms, the software, the project, or Conrad's
instance will be brought and resolved exclusively in the state or federal courts located in Texas.

---

## 14. Miscellaneous

- **Entire agreement:** these Terms, plus the AUP and Privacy Policy, are the use agreement for the
  software, the project, and Conrad's instance. The AGPL governs the software.
- **Severability:** if a provision is unenforceable, the rest stays in effect.
- **No waiver:** not enforcing a term once is not a waiver of it.
- **Assignment:** you may not assign these Terms; Skyphusion Labs may, in connection with running or
  transferring the project.

---

## Contact

Questions about these Terms: **legal@skyphusion.org**.

