# Module-bound local dev (the real module catalog, no GPU)

A plain `wrangler dev` for the studio core boots with `GET /api/modules` returning `modules:[]`,
because the `MODULE_*` service bindings point at module workers that are not running. With an empty
catalog the planner cannot drive any render / audio / module-dependent flow. This recipe runs the core
**and every in-tree module worker together** as one multi-worker local dev, so the registry discovers
the **real catalog** from each module static `GET /module.json` manifest.

## What you get

- `GET /api/modules` returns the real module catalog (full `config_schema` / `provides` / `ui` /
  `cancelable`), so the registry projection, render-config controls, and tier pickers render from real
  data instead of fixtures.
- Local D1 (migrated) + local R2, so history, projects, cast, prefs, persistence, uploads, and artifact
  serving work against a disposable local store. **Prod D1 / R2 are never touched.**

## Safety (by construction)

- **Fully local.** Local D1 + local R2, no remote bindings. Production is not reachable from this env.
- **Zero GPU / provider spend.** The generated module dev configs are binding-FREE: a module serves its
  real manifest but has no RunPod key / AI / R2, so any accidental `POST /invoke` is inert and fails
  safe. No job can reach a GPU from here.

## Run it

```
bash .dev-modbound/dev-modbound.sh [PORT]     # default port 8790
```

The script (idempotent) renders the core dev config from `wrangler.toml.example`, generates a minimal
binding-free dev config per module, applies the D1 migrations to the local database, and launches the
fleet. Open `http://127.0.0.1:PORT/planner`.

## Plan-validator flow without a live model

Workers AI is remote-only and a fully-local dev fleet has no AI binding, so the script sets
`PLANNER_AI_MOCK="true"`. With it on, `planStoryboard` / `refineStoryboard` return deterministic canned
completions (see `src/planner-ai-mock.ts`) that still run the **real** extract / parse / validate
pipeline, so you can drive the whole submit -> validate -> re-prompt -> resubmit state machine. Steer the
branch with a sentinel in the brief or refine instruction:

- (no sentinel) -> a valid storyboard (the pass branch).
- `#mock-fail` -> a storyboard that fails validation (the reject / re-prompt branch).
- `#mock-badjson` -> non-JSON output (the "model output was not valid JSON" branch).

`PLANNER_AI_MOCK` is unset in prod; the live provider path is unchanged. This mock is dev-only and is
NOT a Workers AI stand-in.

## What is stubbed, and why

Not needed to populate the catalog; dropped from the local render: module invoke backends (RunPod GPU,
provider APIs, module R2 writes), the 4 Workers-VPC finish services (`VIDEO_FINISH` / `IMAGE_PREP` /
`AUDIO_BEAT_SYNC` / `AUDIO_MIX`), the tail consumer, ratelimits, crons, and `MODULE_DISPATCH`. A real
render / audio / finish submit is therefore inert here; run those against a properly provisioned deploy,
never from this env.

## Seeding history / artifacts

The local D1 is fresh. Seed rows with `wrangler d1 execute DB --local --file=seed.sql` and put artifacts
in the local R2 bucket `vivijure` under an `ARTIFACT_PREFIXES` key (e.g. `renders/`; the artifact handler
404s other prefixes). The renders list endpoint is single-tenant locally, so any seeded row shows.
