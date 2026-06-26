# Vivijure Acceptable Use Policy (AUP)

> **STATUS: DRAFT for review. Not legal advice. Not yet in force.**
> Written by Ernst (Conrad's legal-affairs helper, not a lawyer). Conrad signs off before it goes
> live. Attorney-flagged items are collected at the end.

**Last updated:** DRAFT (unpublished)

---

## BLUF

Vivijure is a generative image and video tool. Powerful creative tools get abused, so the lines have
to be bright. The hardest line is at the top: **no sexual content involving minors, ever, full
stop.** Everything else flows from "do not use this tool to make illegal content or to hurt real
people."

Vivijure is self-hosted AGPL software, not a service Skyphusion Labs operates for the public. So this
document is two things at once:

- **Conditions of use for the software and the project.** These prohibitions are a condition of using
  Vivijure and of taking part in the project and its community. They are also the use policy Conrad
  applies to his own private instance at `vivijure.skyphusion.org` (which is restricted to Conrad and
  the crew).
- **A model policy any operator can adopt.** If you self-host, you set and enforce your own use
  policy on your own instance, and you take on the legal responsibility for what your instance
  produces and hosts. This document is a conservative starting point you are free to use. (The AGPL
  gives you the software; it does not give you a pass on the law.)

Skyphusion Labs maintains the software and does not host or manage instances for other people. There
is no central platform here; there is software people run themselves.

---

## 1. The absolute red line: child sexual abuse material (CSAM)

You may not use Vivijure to generate, request, store, or distribute any sexual or sexualized content
depicting minors, real or synthetic. This includes any depiction of a real or fictional person who is
or appears to be a minor in sexual or sexualized content, and any attempt to "age down" a person into
such content.

This is zero-tolerance. There is no artistic, satirical, fictional, or "it is AI so no real child was
involved" exception. This prohibition is an absolute condition of using the software and of any
participation in the project.

Because Vivijure is self-hosted, the operator of each instance is the party that removes apparent
CSAM, terminates the offender's access, and makes any required report to the appropriate authorities,
including the National Center for Missing & Exploited Children (NCMEC) and/or law enforcement. On
Conrad's own private instance, Conrad is that operator. Skyphusion Labs maintains the software and
does not run instances for others, so the reporting and preservation duties for any given instance
fall on that instance's operator. (Note: US operators may have specific reporting and preservation
duties under 18 U.S.C. 2258A; each operator should confirm the exact workflow for their own instance
and jurisdiction.)

---

## 2. Other prohibited content and uses

You may not use Vivijure to create, train models for, or distribute:

### 2.1 Non-consensual intimate imagery (NCII)
Sexual or nude depictions of a real, identifiable person created or shared without that person's
consent. This includes "undressing" or sexualizing images of real people, and intimate content
generated to look like a specific real person without their consent.

### 2.2 Non-consensual deepfakes and likeness / publicity-rights abuse
Realistic depictions of a real, identifiable person without their consent, especially where the
result is intended or likely to deceive, defame, defraud, harass, or exploit. This includes:
- Putting words or actions onto a real person they did not say or do, presented as real.
- Using a person's face, voice, or likeness (including via a trained model/LoRA built from images of
  them) without consent, including for commercial gain (publicity-rights / right-of-publicity abuse).
- Impersonating a real person or organization to deceive.

(Consensual creative work involving a person who has actually agreed, and clearly-labeled satire or
commentary that does not deceive, are different; but the burden is on you to have that consent and to
not cross into the harms above. Likeness, publicity, and deepfake law is fast-moving and varies by
state and country; this section states a conservative floor, and it is your responsibility, as the
person using Vivijure, to comply with the laws that apply to you.)

### 2.3 Hateful, harassing, and violent content
- Content that demeans, dehumanizes, or incites hatred or violence against people based on a protected
  characteristic (race, ethnicity, national origin, religion, sex, gender identity, sexual
  orientation, disability, and the like).
- Targeted harassment, bullying, threats, or content created to intimidate or stalk a specific person.
- Content that promotes or instructs terrorism or mass violence.

### 2.4 Other illegal or harmful use
- Anything illegal under applicable law, or that facilitates an illegal act.
- Fraud, scams, phishing, or disinformation campaigns; forged documents, currency, or identity
  documents.
- Malware, or content designed to compromise systems.
- Infringing other people's copyright, trademark, or other intellectual-property rights (for example,
  training a model on, or reproducing, protected work you have no right to use).
- Attempts to break, evade, or abuse an instance: bypassing the access gate, evading rate limits,
  scraping, or burning the operator's compute budget (denial-of-wallet).

### 2.5 Sexual content generally (operator's call)
Adult sexual content involving consenting adults is a policy choice each operator makes for their own
instance. On Conrad's own private instance (`vivijure.skyphusion.org`), which is restricted to Conrad
and the crew with no outside users authorized, the generation of adult NSFW content is permitted for
now, at the operator's discretion and subject to change. Whatever an operator chooses, Sections 1 and
2.1-2.2 (CSAM, NCII, non-consensual deepfakes and likeness abuse) remain absolute regardless.

---

## 3. Your responsibilities

- You are responsible for what you generate, upload, train on, and download.
- You confirm you have the rights and any required consent for images, audio, and likenesses you feed
  into the studio (your own photos, properly licensed material, or material you otherwise have the
  right to use).
- You will not use outputs in a way that breaks the law or this policy after they leave the studio.
- It is your responsibility to comply with the laws that apply to you and the place you operate from.

---

## 4. Enforcement posture

Enforcement is whatever the operator of an instance applies, kept proportionate but firm. On Conrad's
own private instance, Conrad enforces it directly. A model posture:

- **CSAM:** immediate removal, immediate termination, and reporting to authorities. No warning.
- **Other serious violations** (NCII, non-consensual deepfakes used to harm, targeted harassment,
  clearly illegal use): content removal and access termination, with reporting where the law requires
  or the harm warrants.
- **Lesser or ambiguous violations:** the operator may remove content, warn, restrict, or suspend
  access at their discretion.

Because an instance is single-operator and access-gated, enforcement is the operator's direct action:
removing the offending content/files, revoking the violator's access, and preserving or reporting
evidence where required. The operator may act on a good-faith belief that a violation has occurred and
is not obligated to host content while investigating.

---

## 5. Reporting abuse

If you encounter content or use that violates this policy **on Conrad's private instance**, or that
involves the Vivijure project itself, report it to **abuse@skyphusion.org**. For any other instance,
report to whoever operates that instance; Skyphusion Labs does not run it and cannot act on it.

For suspected CSAM specifically, you may also report directly to NCMEC (CyberTipline) and/or law
enforcement.

When you report, include enough to locate the content (what, where, when) without yourself
downloading, copying, or redistributing illegal material.

Reports about Conrad's instance or the project are handled in good faith, with the most serious first
(CSAM and imminent-harm reports ahead of everything), acting on what can be verified, and without
retaliation against good-faith reporters.

---

## 6. Relationship to the other documents

- The **Terms** govern the overall agreement for using the software and the project, including that
  violating this AUP can end your access to Conrad's instance and your standing in the project.
- The **Privacy Policy** describes what data the software handles, and why Skyphusion Labs holds none
  of it (you self-host).
- Copyright and intellectual-property terms are in the Terms (Section 10); infringing use of others'
  work also violates Section 2.4 here.

---

## Open items that need a licensed attorney before launch

1. **CSAM reporting mechanics** under 18 U.S.C. 2258A (NCMEC reporting, evidence preservation, what an
   operator may and may not retain), confirmed for each operator's jurisdiction. Conrad should confirm
   the workflow for his own private instance.
2. **Deepfake / likeness / publicity-rights wording** against the operator's actual jurisdiction(s),
   which are changing quickly.
3. **Whether and how an operator preserves evidence** of violations consistent with privacy law and
   any legal-hold duty.
