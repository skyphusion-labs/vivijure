# Vivijure Privacy Policy

> **STATUS: DRAFT for review. Not legal advice. Not yet in force.**
> This draft was written by Ernst (Conrad's legal-affairs helper, not a lawyer) and is grounded in
> the studio's actual code as of this writing. Conrad signs off before it goes live. Items that need
> a licensed attorney are flagged inline and collected at the end.

**Last updated:** DRAFT (unpublished)

---

## BLUF (bottom line up front)

We do not want your data. That is not a slogan; it is the architecture.

- **Vivijure is free software (AGPL-3.0-only). The strongest privacy promise we can make is: run it
  yourself.** When you self-host, your storyboards, prompts, cast images, trained models, and
  finished films live on infrastructure YOU control. We never see a byte. This document's hosted-
  service sections simply do not apply to you; your instance's privacy posture is whatever YOU
  configure, and you become the operator described below.
- **The hosted instance at `vivijure.skyphusion.org` is single-operator and gated.** It is not a
  public sign-up service. There are no public accounts, no tenant model, and no per-user profiles,
  because the software deliberately has no identity or tenancy primitive at all (see "How the system
  is built" below). It is run by Skyphusion Labs for a small, access-controlled set of users.
- **We collect only what is mechanically required to render your work, and nothing else.** No
  tracking, no advertising, no behavioral profiling, no data brokers, no sale of anything, ever.

If you want the maximum-privacy version of Vivijure, self-host it. That option is real, it is
first-class, and it is the whole point of releasing this under the AGPL.

---

## 1. Who this applies to, and who runs the instance

Vivijure can run in two places, and "who is responsible for your data" differs:

| Mode | Who operates it | Who this policy binds |
|---|---|---|
| **Self-hosted** | You (or whoever deployed that instance) | The operator of that instance, not Skyphusion Labs. We never receive your data. |
| **Hosted (`vivijure.skyphusion.org`)** | Skyphusion Labs (Conrad) | This policy, for the data that instance processes. |

If you reached a Vivijure instance that is NOT `vivijure.skyphusion.org`, this policy may not govern
it. Ask whoever runs that instance. The AGPL requires them to make their source available; it does
NOT make them adopt our privacy stance. (**Attorney flag:** a self-hoster who collects end-user data
takes on their own privacy-law obligations; this policy does not and cannot cover them.)

The rest of this document describes the **hosted instance**.

---

## 2. How the system is built (why there is so little data)

This matters, so we state it plainly: Vivijure is **single-operator by design**. The code has no
account system, no per-user identity column, and no multi-tenant model. An earlier identity/tenancy
field was deliberately removed from the database so the software cannot easily be turned into a
data-harvesting SaaS. "Who are you" is answered exactly once, at the front door, by an access gate
(Cloudflare Access). Everything behind that gate belongs to the one operator who runs the instance.

What this means for you, as someone admitted to use the hosted instance:

- The studio does not build a profile of you. There is no per-user row to build one in.
- Your creative content (storyboards, prompts, cast images, models, films) is stored as the
  operator's content, scoped to the instance, not tagged to a per-user account.
- Access control (who is allowed in) is handled at the edge by Cloudflare Access, described in
  Section 4.

---

## 3. What we collect, store, and process (the honest, complete list)

We collect only what the studio mechanically needs to turn a storyboard into a film. Concretely:

### 3.1 Creative content you provide
- **Storyboards and projects:** the project name, your planning preferences, and the storyboard text
  (scene/shot descriptions, dialogue, prompts).
- **Cast:** character names, character "bibles" (your text descriptions), portrait and reference
  images you upload, derived source images, and any LoRA models trained from them. Voice selections.
- **Uploads:** images and audio you upload for a render.

This is stored in a Cloudflare D1 database (text and metadata) and a Cloudflare R2 bucket (the actual
image, audio, model, and video files). It is stored so the studio can render your work and so you can
come back to it. It is **not** mined, analyzed for advertising, or shared.

### 3.2 Render job state
For each render we store job records: a random job id, the project it belongs to, quality settings,
status and timestamps, the storage key of the output, and any error message. This is the bookkeeping
that lets a long render survive a restart and lets you see your render history.

### 3.3 Generated outputs
Keyframes, video clips, finished MP4s, generated audio beds and narration, and trained models are
written to R2 storage and kept so you can retrieve them.

### 3.4 Operational logs
The Worker emits **render-state logs** (which job is in which phase, warnings, and errors) to a
self-hosted logging system (Grafana/Loki) running on the operator's own servers, NOT a third-party
log vendor. These logs are designed to capture pipeline STATE, not your creative payload: they record
things like "film &lt;job-id&gt;: keyframe phase started", the request method/path/status, the job
id, and exception messages. They are for debugging and reliability. (**Note:** logs can incidentally
contain a project slug or an error string that echoes input; we treat logs as operational data, keep
them on our own infrastructure, and do not use them for any profiling.)

### 3.5 Notifications (opt-in only)
If render-completion email is enabled, the operator configures a single recipient address and the
studio sends a "your render is done" email through our own email service. This is **off by default**
and is the operator's own address, not a mailing list.

### 3.6 What we do NOT collect
- No advertising or marketing trackers, no third-party analytics SDKs, no social pixels.
- No behavioral profiling, no cross-site tracking, no fingerprinting.
- No sale, rental, or brokering of any data. Ever.
- No persistent tracking cookies (see Section 6).

---

## 4. Access, identity, and the front-door gate

To use the hosted instance you authenticate through **Cloudflare Access** (an identity gate at the
edge). To admit you, Cloudflare Access verifies an identity (an email/identity allowed by the
operator's policy, or, for the Slate Discord bot, a service token). Cloudflare, acting for the
operator's Zero Trust organization, logs authentication events (who authenticated, when) as part of
running that gate. That is how the gate works; it is the minimum needed to keep an un-gated public
service from becoming an open denial-of-wallet target.

The studio application behind the gate does not store your identity in its own database (there is no
per-user table). It trusts that the gate let you in.

---

## 5. Who else touches your data (processors and the processing path)

Rendering is GPU work, and some of it necessarily happens on infrastructure we do not own. We keep
this list short and purpose-limited. These are processors acting to render your work, not parties we
sell to.

- **Cloudflare** -- the platform Vivijure runs on: Workers (compute), D1 (database), R2 (file
  storage), AI Gateway (routes AI calls), Access (the gate), Rate Limiting, and Cloudflare Web
  Analytics on the public marketing page only (Section 6). Your stored content lives in Cloudflare
  D1/R2.
- **RunPod** -- the serverless GPU render backend. To render, the studio hands RunPod a job and
  RunPod pulls your render bundle (storyboard, prompts, cast images, models) from R2, does the GPU
  work (keyframes, image-to-video, model training), and writes the results back to R2. Your creative
  content passes through RunPod's GPUs during a render.
- **AI model providers, reached through Cloudflare AI Gateway** -- for storyboard planning, image
  generation, text-to-speech, and cloud motion, the studio (and opt-in modules) send prompts/text to
  AI providers via the gateway. Depending on what you run, this can include providers such as xAI,
  OpenAI, Deepgram, MiniMax, and cloud image-to-video services (e.g. Seedance, Kling). Each provider
  receives only what that specific feature sends it (e.g. your prompt text, or an image to animate).
  (**Attorney flag / operator note:** each provider has its own terms and data practices; the set of
  providers depends on which optional modules an instance installs. A launch checklist should name
  the exact providers the hosted instance actually calls so this list is precise.)
- **Our own fleet** -- some non-GPU finishing steps (assembly, audio mixing, image prep) run on
  servers we operate directly.

We do not share your data with anyone outside this processing path, and none of these are advertising
or data-broker relationships.

---

## 6. Cookies, analytics, and local storage (the honest version)

- **The hosted studio app uses no tracking cookies.** The only cookie in play on the gated app is the
  authentication cookie set by Cloudflare Access so the gate knows you already authenticated. It is a
  functional security cookie, not a tracking cookie.
- **The public marketing page (`/welcome`) uses Cloudflare Web Analytics**, which is cookieless,
  collects no personal data, and is not used for advertising or sold to anyone. It gives the operator
  basic aggregate page-view counts.
- **Your browser's local storage** holds small UI conveniences (e.g. which character you last viewed,
  a remembered training style). This stays in your browser and is not transmitted to us as tracking.

(**Attorney flag:** whether the Cloudflare Access auth cookie and Cloudflare Web Analytics trigger
any cookie-consent obligation in a given jurisdiction is a question for counsel. Both are
functional/privacy-preserving, but the consent-banner question is jurisdiction-specific.)

---

## 7. Retention and deletion

- **You can delete your content.** The studio has delete actions for cast members, projects, and
  renders, which remove the corresponding records and free their stored files. Because the instance
  is single-operator, the operator can also delete anything directly from the database and storage.
- **We keep content while it is useful to you** (so your projects and render history persist) and no
  longer than that. A storage-cleanup process reclaims orphaned files left behind by failed jobs.
- **Operational logs** are retained for a bounded operational window on our own logging system and
  then aged out. (**Attorney/operator flag:** set and state a concrete log-retention period before
  launch, e.g. "N days"; this draft does not invent a number.)
- **There is no backup we sell, mirror to third parties, or retain for analytics.**

To request deletion on the hosted instance, contact the operator (Section 10).

---

## 8. Security

The security posture is documented in the repository (`docs/SECURITY.md`) and summarized here:

- The entire studio API is behind the Cloudflare Access gate and additionally verifies the access
  token inside the Worker itself (a fail-closed backstop), so the data plane never depends on a single
  edge setting.
- Stored-file access is bounded by strict key validation; upload endpoints reject scriptable file
  types.
- Each credential is narrowly scoped per function, so a single leaked key has a bounded blast radius.
- Spend-sensitive endpoints are rate-limited to bound denial-of-wallet abuse.

No system is perfectly secure, and we make no guarantee that it is. See the Terms of Service for the
warranty disclaimer.

---

## 9. Children

Vivijure is not directed to children. The hosted instance is access-controlled to adults the operator
admits. Generating sexual content involving minors is absolutely prohibited and reported; see the
Acceptable Use Policy.

---

## 10. Contact

Privacy questions or deletion requests for the hosted instance:
**`PLACEHOLDER -- contact address`** (e.g. a `privacy@` or `legal@` address; set before launch).

For self-hosted instances, contact whoever operates that instance.

---

## 11. Changes

This is a draft and is expected to change before it is adopted. Once live, material changes will be
noted by updating the "Last updated" line and, where appropriate, an in-app or repository notice.

---

## Open items that need a licensed attorney before launch

1. **Jurisdiction-specific privacy law.** Whether GDPR, UK GDPR, CCPA/CPRA, or other regimes apply
   turns on where the operator and admitted users are. If any apply, this policy needs the
   corresponding disclosures (legal basis, data-subject rights, controller/processor roles,
   international-transfer mechanism for the EU-to-US RunPod/provider path).
2. **Cookie-consent obligations** for the Access auth cookie and Cloudflare Web Analytics.
3. **A precise, final processor list** matching exactly which AI providers and modules the hosted
   instance calls at launch.
4. **A concrete log-retention period** and content-retention statement.
5. **Controller/processor framing** between Skyphusion Labs and its sub-processors (Cloudflare,
   RunPod, AI providers), and whether data-processing agreements are required.
