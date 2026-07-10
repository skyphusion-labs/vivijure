# Vivijure Privacy Policy

> **Not legal advice.** This document was written by Ernst (Conrad's legal-affairs helper, who is
> named after a lawyer and is not one). It is grounded in the studio's actual code. It is not legal
> advice and reading it does not create an attorney-client relationship. If you are unsure how it
> applies to you, or you run your own instance, talk to a licensed attorney.

**Effective date:** 2026-07-03

---

## BLUF (bottom line up front)

We do not want your data. With Vivijure that is not a slogan, it is a literal fact: **there is no
Vivijure service that we operate to hold your content, so there is almost nothing for us to
collect (the one public thing we run, the read-only demo, is built to collect nothing about you --
Section 1a).**

- **Vivijure is free software (AGPL-3.0-only) that you run yourself.** You deploy it on your own
  infrastructure (your own Cloudflare account, your own GPU/RunPod), and your storyboards, prompts,
  cast images, trained models, and finished films live entirely on infrastructure YOU control.
  Skyphusion Labs never sees a byte of it, because your instance never talks to us.
- **Skyphusion Labs does not run a hosted, multi-tenant, sign-up service.** There is no Vivijure
  account you create with us, no platform we host your content on, and no pool of user data we hold.
  We maintain the software; we do not operate it for the public.
- **Skyphusion Labs runs exactly two Vivijure instances, and only two.** (1) Conrad's own private
  instance at `vivijure.skyphusion.org`: gated, used by Conrad and the crew (plus the Slate Discord
  bot via its own named API token), not a service anyone signs up for; it processes Conrad's own
  creative content, not data collected from outside users. (2) A public, read-only **demo** at
  `demo.vivijure.com`: open to anonymous visitors to browse a seeded catalog and pre-made showcase
  films, it renders nothing, has no account or sign-in, and collects no visitor data beyond the
  standard edge request logs any website receives. Neither is a hosted, multi-tenant service that
  holds your content. See Section 1a for exactly what the demo does and does not process.

If you want a privacy policy for your Vivijure instance, you write it, because you are the operator
and the only person who can see that data. This document explains why the software collects so
little, and what Conrad's own private instance does, so you have an honest baseline to start from.

(One bright-line exception to this hands-off posture exists, and only one: child sexual abuse
material. See Section 9 and the Acceptable Use Policy, Section 1.)

---

## 1. Who runs an instance, and whose data it is

Vivijure runs in exactly one shape: **somebody self-hosts it.** "Who is responsible for the data"
is always "whoever runs that instance," never Skyphusion Labs as some central operator.

| Mode | Who operates it | Whose data it is |
|---|---|---|
| **You self-host** | You (or whoever deployed that instance) | Yours, on your infrastructure. Skyphusion Labs never receives it. |
| **Conrad's private instance (`vivijure.skyphusion.org`)** | Skyphusion Labs (Conrad), for Conrad and the crew only | Conrad's own creative content on Conrad's infrastructure. Not data collected from outside users; there are no outside users. |
| **The public demo (`demo.vivijure.com`)** | Skyphusion Labs (Conrad), for anyone to browse | No visitor data. It is read-only, renders nothing, has no account, and collects nothing a visitor submits. Only standard edge request logs (Section 1a). |

We still do not host instances that hold OTHER people's content, and will not get into hosting or
managing them for anyone. If you reach a Vivijure instance, whoever deployed it is the operator; the AGPL
requires them to make their source available, but it does NOT make them adopt this privacy stance,
and they may collect or handle data however their own instance is configured. Ask that operator.

The rest of this document describes (a) why the software is built to need almost no data, and (b)
what Conrad's own private instance does, as a worked, honest example.

---

## 1a. The public demo studio (`demo.vivijure.com`)

Separate from Conrad's private instance, Skyphusion Labs runs a public, read-only **demo** so anyone
can see what the studio is without deploying it. It is built to collect nothing about you:

- **No account, no sign-in, no token.** You browse anonymously. There is nothing to register and no
  profile to create.
- **It renders nothing and stores nothing you submit.** Every state-changing request (anything that
  would create, edit, or render) is refused. The money/compute integrations (AI, GPU/RunPod, file
  storage) are simply not connected to the demo, so there is no pipeline for your input to enter. The
  projects, cast, and finished films you see are a fixed, in-house seeded catalog; the films stream
  from Skyphusion's own asset host (`assets.skyphusion.net`).
- **No identity cookie and no tracking.** The demo sets no cookie that identifies you (the studio's
  functional token cookie is never populated because no token is ever entered), and the demo ships no
  analytics beacon, tracker, or advertising pixel.
- **What is processed:** only the ordinary server request logs that Cloudflare (and the asset host)
  keep for any website -- your IP address, user agent, and the paths you request -- used for
  security, abuse prevention, and rate limiting, on Skyphusion's own infrastructure, never sold or
  used to profile you. To render your own work with your own data, you self-host (the rest of this
  policy explains why that keeps the data yours).

## 2. How the system is built (why there is so little data)

This matters, so we state it plainly: Vivijure is **single-operator by design**. The code has no
account system, no per-user identity column, and no multi-tenant model. An earlier identity/tenancy
field was deliberately removed from the database so the software cannot easily be turned into a
data-harvesting SaaS. "Who are you" is answered exactly once, at the front door, by an API-token
gate: the Worker itself checks a bearer token on every `/api/*` request. Everything behind that gate
belongs to the one operator who runs the instance.

What this means in practice, on any instance:

- The studio does not build a profile of anyone. There is no per-user row to build one in.
- Creative content (storyboards, prompts, cast images, models, films) is stored as the operator's
  content, scoped to the instance, not tagged to a per-user account.
- Access control (who is allowed in) is enforced by the instance's own auth gate, which on Conrad's
  instance is a bearer-token check inside the Worker.

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

## 4. Authentication and the front-door gate

To reach the studio API on an instance you present that instance's **API token**. On Conrad's
instance the gate runs in **token mode**: every `/api/*` request must carry a bearer token
(`Authorization: Bearer <token>`), which the Worker itself checks (fail-closed, in constant time)
before any data-plane code runs. Two kinds of token are accepted, and both are just secrets, not
identities:

- **The operator token** (`STUDIO_API_TOKEN`), a random 256-bit secret minted at deploy time and held
  as a Worker secret. It is never written to the database.
- **Named per-consumer tokens** (for example, one for the Slate Discord bot, one per render
  satellite), each a random token issued and revoked independently so a single credential can be
  rotated without touching the others. Only a **name and a SHA-256 hash** of each token live in the
  operator's D1 database (table `api_tokens`); the plaintext token is never stored. A request is
  authenticated by hashing the presented token and matching that hash.

That is the entire identity surface on the main API: a token name and a token hash. **No third-party
identity provider is in the path, and no email, account, or IdP profile is processed** to reach the
API, so the gate keeps no log of "who" authenticated beyond which named token (if any) matched. The
studio application behind the gate stores no per-user identity (there is no per-user table); it trusts
that the token check let the caller in.

The software also ships an optional **Access mode**, in which an operator can instead put the API
behind an external identity gate (Cloudflare Access) and have the Worker verify that gate's signed
assertion. **Conrad's instance does not run this mode.** An operator who turns it on takes on whatever
identity data their chosen identity provider processes (typically an email/identity and
authentication-event logs), on their own Zero Trust organization; that is their configuration to
document, not something the default token mode does.

---

## 5. Who else touches the data (processors and the processing path)

Rendering is GPU work, and some of it necessarily happens on infrastructure the operator connects
the instance to. On a self-hosted instance these are the operator's OWN accounts with these
providers, not ours. We list them so the path is transparent.

- **Cloudflare** -- the platform Vivijure runs on: Workers (compute, including the API-token gate),
  D1 (database, which also holds the named-token names and hashes from Section 4), R2 (file storage),
  AI Gateway (routes AI calls), Rate Limiting, and Cloudflare Web Analytics on the public marketing
  page only (Section 6). Stored content lives in the operator's Cloudflare D1/R2. (Cloudflare Access
  is in this path only for an operator running the optional Access mode of Section 4; Conrad's
  instance does not.)
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
  first-party **`vivijure_token`** cookie, which holds the same API token the caller already provided.
  It exists so media elements (image/video/audio tags on artifact URLs, which cannot send an
  `Authorization` header) can load; the Worker honors it for read-only GET/HEAD requests only, and it
  is set `Secure; SameSite=Strict` and scoped to `/api/`. It is a functional security cookie, not a
  tracking cookie, and it carries no identity beyond the token itself. (In the optional Access mode of
  Section 4, the cookie in play is instead Cloudflare Access's own edge cookie.)
- **The studio Worker ships no analytics or tracking beacon.** The public marketing page moved off
  the Worker to the separate `vivijure.com` storefront (#617); `/welcome` on the studio host is now a
  301 redirect there. That storefront uses cookieless, self-hosted analytics for aggregate page-view
  counts only -- a different origin that collects no personal data and is neither advertising nor sold.
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

- The entire studio API is gated inside the Worker itself: every `/api/*` request is checked (a bearer
  API token in token mode, or a verified Access assertion in the optional Access mode) before any
  data-plane code runs, and the check fails closed, so the data plane never depends on a single edge
  setting.
- Stored-file access is bounded by strict key validation; upload endpoints reject scriptable file
  types.
- Each credential is narrowly scoped per function, so a single leaked key has a bounded blast radius.
- Spend-sensitive endpoints are rate-limited to bound denial-of-wallet abuse.

No system is perfectly secure, and we make no guarantee that it is. See the Terms for the warranty
disclaimer.

---

## 9. Children

Vivijure is not directed to children. Generating sexual content involving minors, real or synthetic,
is absolutely prohibited as a condition of using the software; see the Acceptable Use Policy,
Section 1. That prohibition is also the single exception to the otherwise hands-off privacy posture
described here: child sexual abuse material is the one thing that, wherever the project becomes aware
of it on infrastructure it operates, is preserved and reported to NCMEC and law enforcement. The
privacy stance is not a shield for it.

---

## 10. Contact

Privacy questions about Conrad's private instance, or the project: **privacy@skyphusion.org** or
**legal@skyphusion.org**.

For any self-hosted instance, contact whoever operates that instance; Skyphusion Labs has no access
to it.

---

## 11. Changes

This policy describes how the software handles data, so it changes when the software's data handling
changes. Material changes will be noted by updating the **Effective date** line above and, where
appropriate, an in-app or repository notice.
