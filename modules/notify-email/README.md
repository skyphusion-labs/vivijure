# notify-email

A **`notify`** module (vivijure-module/1): the **email backend** of the notify hook. On a
`render.complete` event it mails the film owner a download link via the native **Cloudflare Email
Service**. It is **out-of-band** -- it hangs off render completion and is not in the render path, so
it never gates or delays a film.

## Where it fits

The `notify` hook fires **after** the render is done. notify-email is a side effect of completion,
not a stage in the chain: the keyframe -> clips -> dialogue -> speech -> finish -> assemble -> mux
pipeline reaches **done**, and only then does the core hand a `render.complete` event to notify. A
notify failure is best-effort data (`ok:false`), never a reason to fail the render.

```mermaid
flowchart LR
  kf["keyframe"]
  clips["clips · motion.backend"]
  dlg["dialogue"]
  sp["speech"]
  fin["finish"]
  asm["assemble"]
  mux["mux"]
  done["done"]
  note["notify-email<br/>(render.complete -> email)"]

  kf --> clips --> dlg --> sp --> fin --> asm --> mux --> done
  done -. "render.complete (out of band)" .-> note

  style note fill:#fe7,stroke:#c80,stroke-width:2px
```

## Contract

- **Hook**: `notify` (out-of-band; not in the render path). `provides: notify-email` ("Email
  notification (Cloudflare Email Service)"), `ui { section: "notify", order: 10 }`.
- **Input** (`NotifyInput`): `event` (`render.complete`), `film_id`, `project`, optional
  `download_url`, `seconds`, and `user_email` (the recipient).
- **Output** (`NotifyOutput`): `delivered` -- e.g. `["email:<to>"]` on a send, or `[]` for a no-op.
- **Synchronous**: an email send is fast, well within a Worker request. `POST /invoke` composes the
  render-complete email and sends it, then returns. No recipient or no `EMAIL` binding -> empty
  `delivered` (a no-op, not an error); a real send failure is returned as `ok:false` (best-effort).
- **Transport**: the native Cloudflare Email Service `send_email` binding (`EMAIL`). The from-domain
  (`render@skyphusion.org`) must be onboarded once for Email Sending
  (`wrangler email sending enable skyphusion.org`). In `wrangler dev` the send is simulated; prod
  sends for real. Bound into the core as `MODULE_NOTIFY_EMAIL`.

## Configuration

Operator settings to self-host this module.

**Secrets**: none. Email is sent through the native Cloudflare Email Service binding, not an API key.

**Bindings / env** (`wrangler.toml`):
- `EMAIL` -> the native Cloudflare Email Service `send_email` binding (`[[send_email]] name =
  "EMAIL"`). There is **no `remote` flag**, so prod sends for real and `wrangler dev` simulates (no
  send). The binding is optional in code: with no `EMAIL` bound, `/invoke` is a no-op (empty
  `delivered`), not an error.
- `account_id` is injected via the `CLOUDFLARE_ACCOUNT_ID` env var, never hardcoded.

**One-time domain onboarding**: the from-domain must be enabled for Email Sending before the first
real send (a prerequisite, not part of `wrangler.toml`):
`npx wrangler email sending enable skyphusion.org`.

**From-identity**: fixed in code -- `FROM = render@skyphusion.org` (display name "Vivijure") in
`src/notify.ts`. To send from a different domain, change `FROM` and onboard that domain.

**Render knobs**: none -- `config_schema` is omitted. The recipient comes from the `notify` input
`user_email` (the film owner); no recipient (or no `EMAIL` binding) -> no-op.
