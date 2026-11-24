# Vivijure

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

This repo is the Vivijure hub. It holds docs, legal text, and monolith history. It is not the deployed studio.

The live studio is a sibling repo. File studio issues in [vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf).

Start with [README.md](README.md) and [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

## Where the work lives

- [vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf) is the Cloudflare studio panel. A `v*` tag deploys it. It depends on published `@skyphusion-labs/vivijure-core`. See that repo `package.json` and the latest `v*` tag.
- [vivijure-local](https://github.com/skyphusion-labs/vivijure-local) is the local panel. It uses Node, SQLite, and MinIO. Core is a published dependency. Pins may lag the Cloudflare panel.
- [vivijure-core](https://github.com/skyphusion-labs/vivijure-core) is shared orchestration and the module contract. The epoch is `vivijure-module/2`.
- [vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane) is a reference multi-tenant control plane. It is maintained. It is not operated as the Skyphusion studio. It is not the studio UI. New tenants use `STUDIO_RELEASE`. It has its own `v*` line.
- [vivijure-mcp](https://github.com/skyphusion-labs/vivijure-mcp) is the agent MCP package and Worker. Tools call the studio HTTP API.
- [vivijure-android](https://github.com/skyphusion-labs/vivijure-android) and [vivijure-ios](https://github.com/skyphusion-labs/vivijure-ios) are native clients (`org.skyphusion.vivijure`). They call the studio API. Each one sends a Bearer token the user pasted. Android stores it in `EncryptedSharedPreferences`. iOS stores it in the Keychain.
- [vivijure-backend](https://github.com/skyphusion-labs/vivijure-backend) is the clean-room RunPod GPU render engine. Image tags use the `backend-v*` line.
- Satellites: [vivijure-upscale](https://github.com/skyphusion-labs/vivijure-upscale), [vivijure-blender](https://github.com/skyphusion-labs/vivijure-blender) (headless Blender grade, the `finish-blender` door), [vivijure-local-12gb](https://github.com/skyphusion-labs/vivijure-local-12gb), and [vivijure-local-16gb](https://github.com/skyphusion-labs/vivijure-local-16gb) (homelab image-to-video).
- The studio dispatches work to a satellite. A satellite does not call the studio API.
- [slate](https://github.com/skyphusion-labs/slate) is the Discord front door. It is not a multi-tenant host.
- [vivijure-com](https://github.com/skyphusion-labs/vivijure-com) is the marketing site (vivijure.dev). It is not the app.

Retired doors stay listed in [docs/CAPABILITIES.md](docs/CAPABILITIES.md). Read that list before you treat a satellite as live.

## Two version lines

`backend-v*` tags are RunPod GPU images. `v*` tags on a panel repo are studio, control-plane, or local deploys. Name the line you mean.

Pin a panel endpoint to a proven backend release. Do not freeze an endpoint id in docs.

## How to work

This repo has no `package.json` and no `go.mod`. Workflows emit `coverage` and CodeQL. There is no job named `ci`. The coverage job echoes. A green coverage check is not a test result.

Open a pull request to `main`. Use a Conventional Commit. The body says why.

Read [README.md](README.md), [SECURITY.md](SECURITY.md), and [docs/](docs/) before you change a public claim.

## Product rules

The CSAM ban includes synthetic and AI-generated images. Refuse that request. Do not weaken the check. Public legal text in this repo is the wording.

`vivijure-backend` shares no code with the deleted wavevryn fork. Do not add credit for that fork.

There are two panels. Product parity is required. Pins may lag.

The `demo.vivijure.com` demo is gone. Do not link it.

A panel or control-plane merge to `main` runs CI only. A SemVer tag deploys. Verify the deployed artifact.

Hosted and self-host ship the same product at the same time. There is no community edition. There is no pay gate on a capability.

A tenant reaches RunPod through the product, or brings their own RunPod account (BYOK). Do not give a tenant a key on the operator account.

On a TypeScript repo, `npm run typecheck` is the CI gate.

## Docs

Write Simplified Technical English. Use short sentences. Put one idea in each sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

## Safety

Do not put a secret in a tracked file. Do not put a secret in a log. Do not put a secret in an issue. Presence-check with `${var:+SET}` only.

Panel frontends use vanilla JS, HTML, and CSS. There is no framework and no build step.

The frontend is a projection of `GET /api/modules`. A feature the UI must know is a module.

The license is AGPL. The public handle is `skyphusion`.
