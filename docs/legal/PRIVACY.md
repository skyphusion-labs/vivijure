# Vivijure Privacy Policy

> **STATUS: DRAFT for review. Not legal advice. Not yet in force.**
> This draft was written by Ernst (Conrad's legal-affairs helper, not a lawyer) and is grounded in
> the studio's actual code as of this writing. Conrad signs off before it goes live. Items that need
> a licensed attorney are flagged inline and collected at the end.

**Last updated:** DRAFT (unpublished)

---

## BLUF (bottom line up front)

We do not want your data. With Vivijure that is not a slogan, it is a literal fact: **there is no
Vivijure service that we operate for you, so there is nothing for us to collect.**

- **Vivijure is free software (AGPL-3.0-only) that you run yourself.** You deploy it on your own
  infrastructure (your own Cloudflare account, your own GPU/RunPod), and your storyboards, prompts,
  cast images, trained models, and finished films live entirely on infrastructure YOU control.
  Skyphusion Labs never sees a byte of it, because your instance never talks to us.
- **Skyphusion Labs does not run a hosted, multi-tenant, sign-up service.** There is no Vivijure
  account you create with us, no platform we host your content on, and no pool of user data we hold.
  We maintain the software; we do not operate it for the public.
- **The only Vivijure instance Skyphusion Labs runs is Conrad's own private instance at
  `vivijure.skyphusion.org`.** It is gated, used by Conrad and the crew (plus the Slate Discord bot
  via an access service token), and is not a service anyone signs up for. It processes Conrad's own
  creative content, not data collected from outside users.

If you want a privacy policy for your Vivijure instance, you write it, because you are the operator
and the only person who can see that data. This document explains why the software collects so
little, and what Conrad's own private instance does, so you have an honest baseline to start from.

---

## 1. Who runs an instance, and whose data it is

Vivijure runs in exactly one shape: **somebody self-hosts it.** "Who is responsible for the data"
is always "whoever runs that instance," never Skyphusion Labs as some central operator.

| Mode | Who operates it | Whose data it is |
|---|---|---|
| **You self-host** | You (or whoever deployed that instance) | Yours, on your infrastructure. Skyphusion Labs never receives it. |
| **Conrad's private instance (`vivijure.skyphusion.org`)** | Skyphusion Labs (Conrad), for Conrad and the crew only | Conrad's own creative content on Conrad's infrastructure. Not data collected from outside users; there are no outside users. |

There is no third row. We do not host instances for other people and will not get into hosting or
managing them. If you reach a Vivijure instance, whoever deployed it is the operator; the AGPL
requires them to make their source available, but it does NOT make them adopt this privacy stance,
and they may collect or handle data however their own instance is configured. Ask that operator.

The rest of this document describes (a) why the software is built to need almost no data, and (b)
what Conrad's own private instance does, as a worked, honest example.

---

## 2. How the system is built (why there is so little data)

This matters, so we state it plainly: Vivijure is **single-operator by design**. The code has no
account system, no per-user identity column, and no multi-tenant model. An earlier identity/tenancy
field was deliberately removed from the database so the software cannot easily be turned into a
data-harvesting SaaS. "Who are you" is answered exactly once, at the front door, by an access gate
(Cloudflare Access). Everything behind that gate belongs to the one operator who runs the instance.

What this means in practice, on any instance:

- The studio does not build a profile of anyone. There is no per-user row to build one in.
- Creative content (storyboards, prompts, cast images, models, films) is stored as the operator's
  content, scoped to the instance, not tagged to a per-user account.
- Access control (who is allowed in) is handled at the edge by the operator's own access gate.

Because there is no multi-tenant user model, the software has no mechanism to collect, aggregate, or
sell end-user data, by design.

---

## 3. What an instance stores and processes (the honest, complete list)

This is what the software stores on the operator's own infrastructure when it runs. On a self-hosted
instance, all of this is yours, on your Cloudflare account, and we never see it. On Conrad's private
instance, all of this is Conrad's. We list it so the picture is complete, not because we receive it.

### 3.1 Creative content the operator provides
- **Storyboards and projects:** the project name, planning preferences, and storyboard text
  (scene/shot descriptions, dialogue, prompts).
- **Cast:** character names, character "bibles" (text descriptions), portrait and reference images,
  derived source images, and any LoRA models trained from them. Voice selections.
- **Uploads:** images and audio uploaded for a render.

This is stored in the operator's Cloudflare D1 database (text and metadata) and the operator's
Cloudflare R2 bucket (the actual image, audio, model, and video files). It is stored so the studio
can render the work and so the operator can come back to it. It is **not** mined, analyzed for
advertising, or shared.

### 3.2 Render job state
For each render the software stores job records: a random job id, the project it belongs to, quality
settings, status and timestamps, the storage key of the output, and any error message. This is the
bookkeeping that lets a long render survive a restart and lets the operator see render history.

### 3.3 Generated outputs
Keyframes, video clips, finished MP4s, generated audio beds and narration, and trained models are
written to the operator's R2 storage and kept so the operator can retrieve them.

### 3.4 Operational logs
The Worker emits **render-state logs** (which job is in which phase, warnings, and errors) to a
logging system (Grafana/Loki) that the operator runs on their own servers, NOT a third-party log
vendor. These logs are designed to capture pipeline STATE, not creative payload: they record things
like "film &lt;job-id&gt;: keyframe phase started", the request method/path/status, the job id, and
exception messages. They are for debugging and reliability. (**Note:** logs can incidentally contain
a project slug or an error string that echoes input; the operator treats logs as operational data on
their own infrastructure and does not use them for profiling.)

### 3.5 Notifications (opt-in only)
If render-completion email is enabled, the operator configures a single recipient address and the
studio sends a "your render is done" email. This is **off by default** and is the operator's own
address, not a mailing list.

### 3.6 What the software does NOT do
- No advertising or marketing trackers, no third-party analytics SDKs, no social pixels.
- No behavioral profiling, no cross-site tracking, no fingerprinting.
- No sale, rental, or brokering of any data. Ever. (There is no central data to sell.)
- No persistent tracking cookies (see Section 6).

---

## 4. Access and the front-door gate

To reach an instance you authenticate through the operator's access gate (Cloudflare Access on
Conrad's instance). The gate verifies an identity the operator has allowed (an email/identity in the
operator's policy, or, for the Slate Discord bot on Conrad's instance, a service token). The gate
logs authentication events (who authenticated, when) as part of running that gate, on the operator's
own Zero Trust organization. That is how the gate works; it is the minimum needed to keep an un-gated
instance from becoming an open denial-of-wallet target.

The studio application behind the gate does not store identity in its own database (there is no
per-user table). It trusts that the gate let the caller in.

---

## 5. Who else touches the data (processors and the processing path)

Rendering is GPU work, and some of it necessarily happens on infrastructure the operator connects
the instance to. On a self-hosted instance these are the operator's OWN accounts with these
providers, not ours. We list them so the path is transparent.

- **Cloudflare** -- the platform Vivijure runs on: Workers (compute), D1 (database), R2 (file
  storage), AI Gateway (routes AI calls), Access (the gate), Rate Limiting, and Cloudflare Web
  Analytics on the public marketing page only (Section 6). Stored content lives in the operator's
  Cloudflare D1/R2.
- **RunPod** -- the serverless GPU render backend. To render, the studio hands RunPod a job and
  RunPod pulls the render bundle (storyboard, prompts, cast images, models) from R2, does the GPU
  work (keyframes, image-to-video, model training), and writes the results back to R2. Creative
  content passes through RunPod's GPUs during a render. For some optional modules, notably the
  image-to-video (i2v) modules and the cast module, the RunPod backend also reaches out to external
  AI model providers as part of doing that work, so for those modules your content reaches those
  providers through the RunPod path (see the next entry).
- **AI model providers (reached two ways: Cloudflare AI Gateway and RunPod)** -- for storyboard
  planning, image generation, text-to-speech, and cloud motion, the studio (and opt-in modules) send
  prompts/text to AI providers. Most are reached through the **Cloudflare AI Gateway**; some,
  specifically the providers behind the image-to-video (i2v) modules and the cast module, are reached
  from the **RunPod** backend during a render (see the RunPod entry above). Depending on what is run,
  this can include providers such as xAI, OpenAI, Deepgram, MiniMax, and cloud image-to-video services
  (e.g. Seedance, Kling). Each provider receives only what that specific feature sends it (e.g. prompt
  text, or an image to animate). Each provider has its own terms and data practices, and the set of
  providers depends on which optional modules an instance installs.
- **The operator's own fleet** -- some non-GPU finishing steps (assembly, audio mixing, image prep)
  run on servers the operator operates directly.

On a self-hosted instance, all of these relationships are between YOU and those providers; Skyphusion
Labs is not in that path. None of these are advertising or data-broker relationships.

---

## 6. Cookies, analytics, and local storage (the honest version)

- **The studio app uses no tracking cookies.** The only cookie in play on the gated app is the
  authentication cookie set by the operator's access gate (Cloudflare Access) so the gate knows the
  caller already authenticated. It is a functional security cookie, not a tracking cookie.
- **The public marketing page (`/welcome`) uses Cloudflare Web Analytics**, which is cookieless,
  collects no personal data, and is not used for advertising or sold to anyone. It gives the operator
  basic aggregate page-view counts.
- **The browser's local storage** holds small UI conveniences (e.g. which character was last viewed,
  a remembered training style). This stays in the browser and is not transmitted as tracking.

For Conrad's own private instance, the operator (Conrad) has determined that it does not fall under
the GDPR; it is run from the United States for Conrad and the crew, not offered to the public. Any
operator running their own instance is responsible for determining which privacy and cookie-consent
laws apply to them and their own users, and configuring their instance accordingly.

---

## 7. Retention and deletion

- **The operator can delete content.** The studio has delete actions for cast members, projects, and
  renders, which remove the corresponding records and free their stored files. Because the instance
  is single-operator, the operator can also delete anything directly from the database and storage.
- **Content is kept while it is useful** (so projects and render history persist) and no longer than
  that. A storage-cleanup process reclaims orphaned files left behind by failed jobs.
- **On Conrad's private instance, operational logs and backups are retained for up to 90 days** on
  Conrad's own logging and backup systems, then aged out. Each operator sets their own retention for
  their own instance.
- **There is no central backup that anyone sells, mirrors to third parties, or retains for
  analytics.** Each instance's data stays on that operator's infrastructure.

To request deletion of content on Conrad's private instance, contact the operator (Section 10). For
any other instance, contact whoever runs it.

---

## 8. Security

The security posture is documented in the repository (`docs/SECURITY.md`) and summarized here:

- The entire studio API is behind the access gate and additionally verifies the access token inside
  the Worker itself (a fail-closed backstop), so the data plane never depends on a single edge
  setting.
- Stored-file access is bounded by strict key validation; upload endpoints reject scriptable file
  types.
- Each credential is narrowly scoped per function, so a single leaked key has a bounded blast radius.
- Spend-sensitive endpoints are rate-limited to bound denial-of-wallet abuse.

No system is perfectly secure, and we make no guarantee that it is. See the Terms for the warranty
disclaimer.

---

## 9. Children

Vivijure is not directed to children. Generating sexual content involving minors is absolutely
prohibited as a condition of using the software; see the Acceptable Use Policy.

---

## 10. Contact

Privacy questions about Conrad's private instance, or the project: **privacy@skyphusion.org** or
**legal@skyphusion.org**.

For any self-hosted instance, contact whoever operates that instance; Skyphusion Labs has no access
to it.

---

## 11. Changes

This is a draft and is expected to change before it is adopted. Once live, material changes will be
noted by updating the "Last updated" line and, where appropriate, an in-app or repository notice.

---

## Open items that need a licensed attorney before launch

1. **Jurisdiction-specific privacy law for any operator.** Because Vivijure is self-hosted, the
   operator of each instance is the only party that processes user data, and each operator must
   assess whether GDPR, UK GDPR, CCPA/CPRA, or another regime applies to them. Conrad has determined
   the GDPR does not apply to his own private instance (US-run, crew-only, not offered to the
   public); other operators must make their own determination.
2. **Cookie-consent obligations** for the access auth cookie and Cloudflare Web Analytics, per each
   operator's own jurisdiction and users.
3. **A precise processor list** for whichever AI providers and modules a given instance actually
   calls.
4. **Controller/processor framing** between an operator and their sub-processors (Cloudflare, RunPod,
   AI providers), and whether data-processing agreements are required for that operator.
