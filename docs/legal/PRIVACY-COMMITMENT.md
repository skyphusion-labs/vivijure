# The privacy commitment

> **This is the canonical copy.** The privacy commitment covers every product Skyphusion Labs
> makes, so it lives here at the hub in ONE place. Other repositories carry pointer stubs, never
> the text. A commitment that exists in five places will eventually say five different things.
>
> **Status: the COMMITMENT is permanent and in force. The per-product facts below describe the
> estate as of the effective date** and are maintained against the code, not against intentions.

> **Not legal advice.** Written by Ernst, who is named after a lawyer and is not one. This is the
> project's own commitment, not legal advice, and reading it does not create an attorney-client
> relationship.

**Effective date:** 2026-07-19

**Scope:** the Vivijure constellation, Postern, Prism, and Slate. Everything we ship.

---

## 1. What is being committed to

Conrad's ruling, in his own words:

> "We are promising their privacy, we won't break that vow. Privacy, autonomy, and agency is the
> primary goal of what we do, and if we can't offer something because it crosses that line, we
> never cross that line, we just don't offer it."

> "We will never cross that line. Other providers cross that line, but I will not, I absolutely
> refuse. That's actually been the core of all of the products we design, and that's why we leave
> all of the source code publicly available so people can actually audit our promises."

Three things follow, and all three are load-bearing.

### 1.1 Privacy, autonomy, and agency is the PRIMARY goal

Not a constraint we balance against features. The primary goal, ranked above feature completeness.
A feature that would compromise it does not get to argue that it is useful enough to be worth it.
Usefulness was never the thing being weighed.

### 1.2 The line is never the variable. The FEATURE is.

When a capability cannot be built without crossing the line, the correct output is **a smaller
honest product, plus a plain statement of what we do not do and why.**

**"We simply do not offer it" is a successful engineering outcome, not a failure.** This has to be
said out loud, because the alternative is that a well-meaning engineer quietly finds a way to make
it work. A boundary argued fresh each time erodes by increments, since every individual increment
looks reasonable next to a concrete feature somebody wants. Deciding once, in advance, in public,
is what stops that.

We have already taken this trade at least once and will take it again. See Section 4.3.

### 1.3 Auditability is the enforcement mechanism

Every other company's privacy promise is worth exactly what their intentions are worth, because the
user has no way to check. Ours is different, and the difference is structural rather than moral:

- **Every product named in the scope line is public source, licensed AGPL-3.0-only.** Verified
  repository by repository as of the effective date.
- So the claims in this document are not assertions you have to trust. They are **statements about
  code you can go read**, and if we ever broke one, the break would be in the commit history.
- This is why the source is public. Not as a growth channel: as the receipt.

**A promise you have to trust is worth less than a source tree you can check.** That is the whole
design, and it is the same argument the [parity commitment](PARITY-COMMITMENT.md) makes about the
licence.

---

## 2. What we commit to, specifically

Across every product, and for as long as we operate them:

1. **We do not sell, rent, broker, or trade your data.** To anyone, for any purpose, ever.
2. **We do not profile you.** No behavioural profiling, no cross-site tracking, no fingerprinting,
   no advertising or marketing trackers, no third-party analytics SDKs, no social pixels.
3. **We do not train models on your content.**
4. **We do not read, scan, or review what you create.** No proactive monitoring of content, no
   automated content review. The single exception is CSAM, in Section 5, and it is stated as an
   exception rather than buried.
5. **Self-hosting is always a real option, fully featured.** Where we run a service, we also ship
   the software to run it yourself, at feature parity, under the AGPL. If you want an instance we
   are not capable of seeing, that route exists, is free, and we point at it rather than bury it.
6. **We collect what is mechanically necessary to make the thing work, and nothing opportunistic.**
   Where a product holds data, Section 4 says which, and why, and links to the policy that details
   it.

---

## 3. What this commitment is NOT

Stated plainly, because a commitment that quietly overclaims is worse than none. The source is
public and anyone can check, so overclaiming is not merely dishonest, it is trivially catchable.

- **It is not a claim that we hold no data.** Some of our products are services we operate, and
  they hold what they need to function. Section 4 is the honest inventory.
- **It is not a claim that we are never technically capable of reading data on infrastructure we
  administer.** Where we run the box, we can reach the disk. We say so rather than implying a
  cryptographic guarantee we have not built.
- **It is not a warranty or a guarantee.** Those words carry specific legal weight that this
  document deliberately does not carry. It is a commitment: a standing rule we hold ourselves to,
  and we publish the source so you can check it.
- **It does not bind self-hosters.** If you run your own instance, you set your own posture. The
  AGPL gives you the software; it does not make you adopt our stance, and it does not give you a
  pass on the law.

---

## 4. The honest inventory, product by product

The canonical privacy policy for each product carries the detail. This table exists so the
commitment cannot float free of the facts.

| Product | Do we operate it? | What we hold | Policy |
|---|---|---|---|
| **Vivijure (self-hosted)** | No | Nothing. Your instance never talks to us. | [PRIVACY.md](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md) |
| **Vivijure demo** (`demo.vivijure.com`) | Yes | Nothing you submit. Read-only, renders nothing, no account, no identity cookie, no analytics beacon. Standard edge request logs only. | [PRIVACY.md](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md) Section 1a |
| **Vivijure hosted tier** | **Not yet. Pre-launch.** | Nothing yet, because it has no tenants. What it WILL hold is specified in advance, in public, before launch. | [PRIVACY-DELTA.md](https://github.com/skyphusion-labs/vivijure-control-plane/blob/main/docs/legal/hosted/PRIVACY-DELTA.md) (draft, not in force) |
| **Postern** | No | Nothing. Self-hosted; your mail lives in your own Cloudflare account. | [PRIVACY.md](https://github.com/skyphusion-labs/postern/blob/main/PRIVACY.md) |
| **Prism** (`play.skyphusion.org`) | **Yes** | Account (username, password as a one-way hash; **no email collected**) and the content you create. Deletable by you at any time. | [INSTANCE-PRIVACY.md](https://github.com/skyphusion-labs/prism/blob/main/docs/legal/INSTANCE-PRIVACY.md) |
| **Slate** | **Yes** (the official Discord instance) | Message content in channels it listens in, Discord identifiers, derived storyboard state. Sent to named subprocessors to function. | [PRIVACY.md](https://github.com/skyphusion-labs/slate/blob/main/PRIVACY.md) |

**Prism and Slate are the two places where "we hold nothing" is not literally true**, and they are
called out here rather than left for a reader to discover. Both hold what the product mechanically
needs and nothing beyond it, both are documented against the code, and the self-host route for both
is real.

### 4.1 The operational-telemetry boundary

Running a service for other people means knowing whether it is up. That is a normal provider
responsibility and we do not pretend otherwise. The rule that governs it is pre-committed here so
that it cannot be argued into something larger later:

> **We monitor the machine. We never monitor the work.**

Concretely, for any service we operate:

- **Permitted:** operational fields only. Is it up, is it erroring, how long did it take, did the
  invocation succeed. The test is falsifiable: **a field set is acceptable only if every field is
  machine-generated and none is user-derived.**
- **Not permitted:** anything carrying customer content. Log lines and exception messages are the
  known content carriers, because a prompt, a filename, a cast name, or a project slug can end up
  inside one. They are excluded at the source rather than filtered downstream, and exception text
  gets scrutiny rather than an assumption that stack traces are content-free.
- **Written down per field.** Every field we collect has a recorded disposition saying why it is
  collected or excluded. Policy is drafted after the collection is defined, never before.
- **Disclosed, not buried.** Where we promise proactive monitoring as part of a service level, we
  say plainly what that monitoring sees.

### 4.2 Status of the telemetry boundary, stated precisely

**As of the effective date, the Vivijure hosted tier has not launched, has no tenants, and no
telemetry collection is wired.** The rule above is a design constraint adopted in advance of the
build, which is the entire point of it: it pre-commits the answer before the pressure arrives.

The per-field dispositions and the service-level disclosure are **owed at launch and do not exist
yet.** Saying we already collect and disclose hosted telemetry would be false in the other
direction, and a privacy document that overstates our collection is still a false privacy document.

### 4.3 The fallback is real, and it is authorised

If proactive monitoring of a hosted service cannot be done without ingesting customer work, **we do
not do it at all.** We tell you the truth instead: no proactive monitoring, open a ticket, and the
absence of that feature is the cost of maintaining your privacy on our platform.

Degrading the product is the acceptable outcome. Ingesting customer content to save the feature is
not. This is Section 1.2 with a concrete referent, and it is written down so that nobody can later
argue that a service-level promise forces the collection.

---

## 5. The one exception: the CSAM bright line

**This is absolute, it is the single exception to everything above, and it is not up for
discussion.** It is stated here rather than left to the Acceptable Use Policy, because an
absolutist privacy document that omitted it would be a privacy document that lied by silence.

**It is not a weakening of the commitment. It is a bright line that sits above it.** The privacy
stance is not, and will never be, a shield for the sexual abuse of children.

- **Zero tolerance, no exceptions, including synthetic.** Any sexual or sexualised depiction of a
  minor, or of anyone who is or appears to be a minor. **AI-generated, "fake," fictional, cartoon,
  drawn, and virtual depictions are covered exactly as much as a photograph of a real child.**
  There is no "it isn't real" carve-out, and no artistic, satirical, fictional, or age-play
  exception.
- **This is also the law, not only our policy.** United States federal law reaches
  computer-generated and synthetic material even where no actual child was involved, including
  **18 U.S.C. 1466A** and **18 U.S.C. 2252A**. The absence of a real child is not a defence, and it
  is not one we recognise either.
- **What we do:** detect, refuse, preserve what the law requires, and report to the National Center
  for Missing and Exploited Children (NCMEC) via the CyberTipline and to law enforcement, on any
  infrastructure the project operates. Immediate and permanent termination of access, no warning.
- **What we do not claim.** We do not, and architecturally cannot, monitor self-hosted instances.
  We are not watching, and we built it so that we cannot. This exception reaches what we operate
  and what we are made aware of; it is not a surveillance programme, and it does not become one.

The full prohibition, the enforcement posture, and the reporting route are in the
[Acceptable Use Policy](ACCEPTABLE-USE.md), Section 1, which is canonical.

---

## 6. Recommended public wording

> **This block is the source.** Any privacy-commitment wording on a README, a front-door page, or a
> marketing surface anywhere in the estate is drawn from here and should match it. If a surface
> needs different words, change them here first, so the public statements cannot drift apart.

> ### We do not want your data
>
> Privacy, autonomy, and agency are the primary goal of what we build, not a feature we balance
> against other features. If we cannot offer something without crossing that line, we do not cross
> the line. We just do not offer it, and we tell you that is why.
>
> We do not sell your data, profile you, train models on your work, or read what you create. Where
> we run a service for you, we monitor the machine, never the work, and we tell you exactly what
> that means. Where we hold nothing at all, we say that too, and where we do hold something, we say
> what and why.
>
> **You do not have to take our word for any of it.** Every product we ship is public source under
> the AGPL. The promises above are statements about code you can go read. That is why the source is
> public: so that our promises are auditable rather than merely sincere.
>
> One exception, and only one: child sexual abuse material, including AI-generated. We detect,
> refuse, preserve, and report it to NCMEC and law enforcement. Our privacy stance is not a shield
> for that, and it never will be.

**Notes for whoever writes the public surface:**
- **Keep the third paragraph.** It is the load-bearing one. Paragraph two alone is a claim; the
  auditability paragraph is what converts it into something verifiable.
- **Keep the CSAM paragraph.** Omitting it from a public privacy statement would misrepresent the
  posture. It is short, plain, and stated as an exception on purpose.
- **Say "commitment," never "guarantee" or "warranty."**
- **Do not add "we reserve the right to change this."** It would gut the commitment. The per-product
  inventory already does the honest work that a reservation clause does dishonestly.
- **This is docs and marketing copy, not Terms.** If the Terms need to reference it, reference it as
  a statement of policy.

---

## 7. What would falsify this document

The commitment is permanent. These facts are not, so whoever changes one owns changing this page in
the same PR.

- **A product stops being public source, or leaves the AGPL.** Section 1.3 is the enforcement
  mechanism; without it this document is just an assertion. This is the tripwire that matters most.
- **A service we operate starts holding something not in the Section 4 table.**
- **Telemetry collection ships without written per-field dispositions**, or a collected field turns
  out to be user-derived rather than machine-generated (Section 4.1).
- **The Vivijure hosted tier launches.** Section 4.2 stops being true the day it opens, and the
  launch-gate procedure has to flip it. That procedure spans three repositories and is documented at
  [LAUNCH-GATE-PROCEDURE.md](https://github.com/skyphusion-labs/vivijure-control-plane/blob/main/docs/legal/hosted/LAUNCH-GATE-PROCEDURE.md).
  **This document is now part of that flip and is not currently listed in it.**
- **Any claim in Section 4 drifts from the product's canonical privacy policy.** This table is a
  summary with links, never a second source of truth.
