# The parity commitment: approved wording, and the over-promise review

> **This is the canonical copy.** The parity commitment is constellation-wide, so it lives here at
> the hub in ONE place. `vivijure-cf` and `vivijure-control-plane` carry pointer stubs, never the
> text. A commitment that exists in three places will eventually say three different things.
>
> **Status: the RULING is permanent and in force; the WORDING below is the approved draft** for the
> public docs. Those are two different things and the distinction is deliberate: the commitment is
> not up for discussion, only its phrasing is.

> **Not legal advice.** Written by Ernst, who is named after a lawyer and is not one.

---

## 1. What is being committed to

Conrad's ruling (2026-07-17, permanent) in his own words:

> "no feature will ever be released separately, EVER, none of that community edition bullshit, none
> of that limited features unless you pay me money, I don't give a fuck about the money unless it's
> enough just to pay the bills and pay some real lawyer to protect my ass."

He means it, it is a release gate, and it is not mine to soften. **My job here is narrow: make sure
the public wording says the true thing in a way that is a promise we keep rather than a contract we
accidentally signed.**

## 2. The review: is this an over-promise?

**The risk.** "No feature will EVER be gated on payment" is an unbounded, forward-looking,
absolute statement. Put in public docs next to Terms of Use, an unqualified forever-promise can be
read as a binding representation. Two ways that bites:

1. **A user relies on it and circumstances change.** Not because Conrad changed his mind, but
   because reality did: a legal requirement, a provider constraint, an acquisition, or Conrad simply
   stopping. A promise that cannot survive contact with any of those is a promise that should not be
   phrased as absolute in a legal document.
2. **It sits next to disclaimers that say the opposite.** [`vivijure-cf docs/legal/TERMS.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/TERMS.md) Section 7 says the software
   "may change, break, or be discontinued at any time without notice." A forever-parity guarantee
   two pages away is in tension with that, and inconsistency is what makes a document arguable.

**The finding, and it is the good news:** the fix is not to weaken the promise. It is to notice that
**the promise is already backed by something stronger than a contract term, and to say that instead.**

## 3. Why the AGPL makes this credible without a contract

Every other company's anti-rug-pull promise is worth exactly as much as their intentions, because
the user has no recourse when the intentions change. **Ours is different, and the difference is
structural, not moral:**

- The studio is **AGPL-3.0-only**, and so is **the hosted control plane itself** (signup,
  provisioner, routing, quotas). The whole thing.
- So if we ever did gate a feature on payment, **the code is still there and anyone can run it, or
  fork it, or host it for other people.** Conrad has said as much in as many words: someone else
  running a competing hosted vivijure has his blessing, and "maybe they can run it better than I
  will."
- **That is the actual guarantee.** Not our promise not to defect, but the fact that defecting would
  not work. A rug-pull requires the ability to take something away, and the AGPL means we do not
  have it.

This is a better story than the forever-promise, it is entirely true, and it carries no legal
exposure, because it describes a licence that already exists rather than a future we are
guaranteeing. **State the commitment sincerely, then point at the licence as the reason the user
does not have to take our word for it.**

## 4. Recommended public wording (the source of the public copy)

> **This block is the source.** Any parity wording in a README, a front-door page, or a marketing
> surface anywhere in the constellation is drawn from here and should match it. If a surface needs
> different words, change them here first, so the public statements cannot drift apart from each
> other.

> ### Hosted and self-host are the same studio
>
> Every feature ships to both at the same time, in the same release. There is no community edition,
> no paid tier that unlocks capability, and no feature held back to make the hosted version look
> better. What you pay for, if you ever pay us anything, is convenience: we run the infrastructure
> so you do not have to. Never capability.
>
> **You do not have to take our word for it.** Vivijure is AGPL-3.0-only, and that includes the
> hosted platform itself: the signup, the provisioner, the routing, the quotas. The code that runs
> the hosted studio is the code in the repository. If we ever broke this promise, you could take the
> whole thing and run it yourself, or run it for other people, and we would help you do it. That is
> not a hypothetical we are being generous about; it is the licence, and we cannot take it back.
>
> That is the point. A promise you have to trust is worth less than a licence you can act on.

**Notes for Joan:**
- **Keep the second paragraph.** It is the load-bearing one. The first paragraph alone is the
  over-promise; the second is what converts it into a verifiable statement.
- **Do not add "we reserve the right to change this."** It would gut the commitment, and it is
  unnecessary: the licence paragraph already does the honest work that a reservation clause does
  dishonestly.
- **Say "commitment," never "guarantee" or "warranty."** Those two words have specific legal weight
  and this should not carry it.
- **This is marketing/docs copy, not Terms.** Keep it in the public docs and out of [`vivijure-cf docs/legal/TERMS.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/TERMS.md).
  If it must be referenced from the Terms, reference it as a statement of policy.

## 5. The one thing to watch

The parity ruling has drift tripwires (hosted-first features with self-host "coming later";
self-host docs rotting while hosted docs stay fresh; hosted glue that structurally cannot exist in
self-host). **The architecture is what actually enforces parity here**: tenant studios run the
**published release, unmodified**, so there is no hosted fork that can drift. That is why the
promise is safe to make.

**If that architecture ever changes, this wording stops being true**, and whoever changes it owns
changing this page in the same PR.

**Live example, flagged rather than filed away:** if the EU AI Act analysis (T1-1) requires output
marking, it is parity-bound. It ships to hosted and self-host in the same release, or it does not
ship. A "hosted marks outputs, self-host gets it later" outcome would be the first violation of this
commitment, and it would be a compliance deadline that caused it. That is exactly the shape of
pressure the tripwires exist to catch.
