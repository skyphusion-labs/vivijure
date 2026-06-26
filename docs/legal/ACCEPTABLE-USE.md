# Vivijure Acceptable Use Policy (AUP)

> **Not legal advice.** This document was written by Ernst (Conrad's legal-affairs helper, who is
> named after a lawyer and is not one). It is the project's own use policy, not legal advice, and
> reading it does not create an attorney-client relationship. If you are unsure how it applies to
> you, or you run your own instance, talk to a licensed attorney.

**Effective date:** 2026-06-26

---

**Skyphusion Labs stands with victims.** You do not use our products to create CSAM or nonconsensual intimate images. Even though we have no way of obtaining data from your self-hosted instances, we will cooperate if we find out that someone is using our software to generate such content, because people who victimize people in such a harmful way, especially children, are the *ONE* exception to a blanket privacy policy, you sick fuck.

That is the line, in plain words. Section 1 makes the prohibition on child sexual abuse material absolute; Sections 2.1 and 2.2 do the same for non-consensual intimate imagery and deepfakes. Everything below formalizes what that statement already says.

---

## BLUF

Vivijure is a generative image and video tool. Powerful creative tools get abused, so the lines have
to be bright. The hardest line is at the top and it is absolute: **no sexual content involving minors,
real or synthetic, ever, full stop.** Everything else flows from "do not use this tool to make illegal
content or to hurt real people."

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

**Where we stand.** This is not just a rule, it is the line this whole project is built around. The
Vivijure project, and everyone in our collective, unequivocally condemns child sexual abuse material.
We do not condone it, in any form, for any reason, ever. We know that giving away a powerful
generative tool means some people will try to use it for exactly this; that is precisely why this
line is drawn as absolutely as it is. There is no version of this we tolerate and no excuse for it we
will hear.

**The prohibition.** You may not use Vivijure, or any Vivijure module, to create, generate, attempt
to generate, request, solicit, train a model for, store, or distribute any child sexual abuse
material (CSAM): any sexual or sexualized depiction of a minor, or of any person who is or appears to
be a minor. This is zero-tolerance, and it has no exceptions:

- It applies to **synthetic, AI-generated, "fake," fictional, cartoon, drawn, virtual, and "pretend"
  depictions** exactly as much as to a photograph of a real child. It does not matter that no real
  minor was photographed, involved, or harmed. It does not matter that the output is "just AI," a
  drawing, or a fictional character. Pretend does not make it acceptable. There is no artistic,
  satirical, fictional, "it is not real," or "age-play" exception.
- It covers **every generation path in the studio**: text-to-image and image keyframes,
  image-to-video (i2v) motion, model/LoRA training, and the finish-class modules, including
  audio-driven lip-sync and any face, voice, or likeness module (for example MuseTalk-style lip-sync,
  i2v, or any deepfake-capable path). "Aging down" any real or generated person into sexualized
  content is covered, and prohibited.

**This is also the law, not only our policy.** Using Vivijure for this is illegal, not merely against
the rules. United States federal law criminalizes computer-generated and synthetic child sexual abuse
material, and obscene visual depictions of minors, even where no actual child was involved, including
under **18 U.S.C. 1466A** (obscene visual representations of the sexual abuse of children, reaching
drawings, cartoons, and computer-generated images) and **18 U.S.C. 2252A** (offenses involving child
pornography). Many other countries prohibit the same conduct, often more broadly. The absence of a
real child is not a defense, and it is not one we recognize either.

**The one exception to our hands-off privacy posture.** Vivijure is self-hosted software, and our
privacy stance is deliberate and real: we do not want your data, your instance never talks to us, and
**we do not, and architecturally cannot, monitor, see, or surveil what anyone generates on their own
self-hosted instance.** We are not watching, and we built it so that we cannot. CSAM is the single,
absolute exception to that hands-off posture, the one thing that overrides everything else:

- Of all the things we deliberately stay out of, this is the one thing that gets reported. Our
  privacy stance is not a shield for it, and a private instance is not a safe place to do it.
- Anyone who becomes aware of CSAM, an operator, a user, or the project on any infrastructure the
  project itself operates, should and must report it to the National Center for Missing & Exploited
  Children (NCMEC), through its CyberTipline, and to law enforcement.
- On any touchpoint the Vivijure project itself operates (including Conrad's own instance and the
  project's own channels), we **will** report it, preserve what the law requires, and cooperate with
  the authorities. We do not look away from this.

**Consequences.** For any CSAM violation: immediate and permanent termination of access, with no
warning; preservation of the relevant material and records as required; and reporting to, and
cooperation with, NCMEC and law enforcement, consistent with applicable reporting law (in the United
States, the provider reporting regime under 18 U.S.C. 2258A). Because each instance is self-hosted and
operator-run, the operator of an instance is the party who carries out removal, termination,
preservation, and reporting on that instance. On Conrad's own instance, Conrad is that operator, and
will do exactly this.

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
now, at the operator's discretion and subject to change. Whatever an operator chooses, Section 1
(CSAM) and Sections 2.1-2.2 (NCII, non-consensual deepfakes and likeness abuse) remain absolute
regardless.

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

- **CSAM:** immediate removal, immediate and permanent termination, preservation, and reporting to
  NCMEC and law enforcement. No warning. (See Section 1.)
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

For suspected CSAM specifically, report it directly to NCMEC (CyberTipline, `report.cybertip.org`)
and/or law enforcement, in addition to any report to an instance operator. This is the one category
where reporting to the authorities is not optional in spirit: if you see it, report it.

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
  of it (you self-host), including that the CSAM reporting posture in Section 1 is the single
  exception to the otherwise hands-off privacy stance.
- Copyright and intellectual-property terms are in the Terms (Section 10); infringing use of others'
  work also violates Section 2.4 here.
