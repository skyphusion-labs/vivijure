# What Vivijure can do today

This is the **capability matrix**: the one place that says what the studio offers, whether it
works right now, and what provides it. Every other doc links here instead of repeating it.

> **Read the Status and Hosted columns before you plan a film.** Some of this is finished and
> some is not, and some works only if you run the studio yourself. This table says which in the
> same breath as the promise.

## How to read this, and the rules that keep it true

**The promise is the subject; the provider is an implementation detail.** The second column says
what YOU can do. The provider columns say how it currently happens. Those change at different
speeds, and confusing them is how this project once advertised a paid capability it had already
removed.

**Provider names live in exactly one column of exactly one file, and this is it.** If you are
writing any other doc and you are about to type a module name, link a row here instead. That
constraint is the whole point: retiring a provider becomes a one-row edit that cannot leave a
false promise stranded in a paragraph nobody thought to open.

**Retirement is not deletion.** When a capability goes away its row moves to
[Retired](#retired), it does not vanish. Infrastructure provisioned under a retired name outlives
the capability, and an operator chasing orphaned resources needs the name to still mean
something. The control plane makes the same call in code, deliberately, in
`RETIRED_ENDPOINT_KEYS`.

### Status

| Status | Means |
| --- | --- |
| `WORKS` | Reachable today on a correctly configured studio, end to end. |
| `CAVEATS` | Works, with a named limit or a live defect. The caveat is linked, never implied. |
| `NOT YET` | Code exists; there is no working deployment behind it. Do not plan around it. |

### Hosted

Whether the module ships to a tenant on the **hosted** tier. `no` does not mean broken: it means
that capability is currently **self-host only**, and you get it by running your own studio and
binding the module yourself.

Measured, not asserted: the hosted set is the 17 modules in
`vivijure-cf/scripts/tenant-module-catalog.txt`, which is already CI-checked against the control
plane's own `TENANT_MODULE_CATALOG`.

### Modules column format is load-bearing

Each entry is a backticked module name spelled exactly as the directory is spelled in
`vivijure-cf/modules/`, comma separated, or `--` when no module provides it.
`vivijure-cf/scripts/check-capability-matrix.mjs` parses that column on every CI run and fails if
it and the real module set disagree. Keep the formatting boring.

A module may appear in one row per hook it declares, and no more: `local-gpu` serves both
`motion.backend` and `keyframe`, so it belongs in both of those rows. The ceiling comes from the
module's own manifest rather than from a rule of thumb.

---

## The film path

The steps of making a film, in the order you meet them.

| # | What you can do | Status | Hosted | Modules |
| --- | --- | --- | --- | --- |
| 1 | Turn an idea into a storyboard, then sharpen the shot list | `WORKS` | yes | `plan-enhance` |
| 2 | Cast characters who look the same in every shot | `WORKS` | **no** | `cast-image` |
| 3 | Get a still for every shot before you spend on motion | `WORKS` | yes | `keyframe`, `cloud-keyframe`, `local-gpu` |
| 4 | Turn each still into a moving clip | `WORKS` | yes | `alibaba-wan`, `alibaba-wan-lora`, `cf-flux-3-video`, `cf-grok-video`, `cf-hailuo`, `cf-hh1-r2v`, `cf-seedance`, `cf-veo`, `google-veo`, `kling`, `kling-o1-r2v`, `local-gpu`, `minimax-hailuo`, `own-gpu`, `seedance`, `vidu-q3` |
| 5 | Give a character a voice, per shot | `WORKS` | **no** | `dialogue-gen`, `chatterbox` |
| 6 | Make a character's mouth match the line they speak | `WORKS` | **no** [^talk] | `infinitetalk` |
| 7 | Score the film: music, narration, cuts on the beat | `CAVEATS` [^bed] | partial [^score] | `music-gen`, `narration-gen`, `beat-sync` |
| 8 | Polish each clip: smoother motion, sharper picture, a colour grade | `CAVEATS` [^finish] | partial [^polish] | `finish-rife`, `finish-upscale`, `finish-blender` |
| 9 | Master the film's audio | `NOT YET` [^tier] | no | `audio-master` |
| 10 | **Join the clips into one film** | `NOT YET` [^assemble] | no | `--` |
| 11 | Put titles, credits and subtitles on the finished film | `NOT YET` [^tier] | no | `film-titles`, `subtitle` |
| 12 | Download what you made | `WORKS` | yes | `--` |
| 13 | Be emailed when a render is done | `WORKS` | **no** | `notify-email` |

## Beside the film path

| What you can do | Status | Hosted | Modules |
| --- | --- | --- | --- |
| Generate a standalone image | `WORKS` | **no** | `image-generate` |
| Write screenplays in Discord and hand off to the studio | `WORKS` | yes | `--` |
| Drive the studio from an AI agent | `WORKS` | yes | `--` |

[^talk]: The capability is real and the module ships in the repo, but the hosted plane provisions
no endpoint for it, and says so in its own code. Talking characters are **self-host only** today.

[^score]: `narration-gen` is hosted. `music-gen` and `beat-sync` are not, so a hosted tenant can
have narration but not a music bed or beat-synced cuts.

[^polish]: `finish-rife` and `finish-upscale` are hosted. `finish-blender`, the colour grade, is
not.

[^bed]: Generating a music bed or narration works. **Attaching** it to a finished film does not,
because that is a mux and the mux is part of the finishing tier in note [^assemble].

[^finish]: These run on dedicated RunPod endpoints.
[vivijure-cf#757](https://github.com/skyphusion-labs/vivijure-cf/issues/757) reports that the
endpoints behind them no longer exist and that the failure is currently booked as a success.
Treat the picture polish as unproven until that issue closes.

[^tier]: Blocked on the same finishing tier as note [^assemble]. Without it these steps return
the input unchanged, tagged as degraded rather than silently.

[^assemble]: **This is the honest gap.** Joining clips into one film is real, working ffmpeg code
in a container, but the tier that container ran on was decommissioned on 2026-09-24 and all four
hostnames the code addresses now return NXDOMAIN. A studio without `VIDEO_FINISH_URL` set
delivers your per-shot clips and says so; it does not pretend to have made a film. Chunked
assemble is being built in
[vivijure-cf#784](https://github.com/skyphusion-labs/vivijure-cf/issues/784); the hosting
decision is [fleet-chezmoi#2234](https://github.com/skyphusion-labs/fleet-chezmoi/issues/2234);
background is [vivijure-cf#780](https://github.com/skyphusion-labs/vivijure-cf/issues/780).

---

## Retired

Kept deliberately. A name here still means something: infrastructure provisioned under it can
outlive the capability, and an operator needs to be able to attribute it.

| Capability | Retired | What replaced it |
| --- | --- | --- |
| Mouth replacement as a post-process (MuseTalk) | 2026-09-26 | Nothing, as a finish step. The promise moved rather than died: row 6 above does it at motion time instead, from the Cast audio. Ruled out permanently as a provider. |
| Speech cleanup before mouth replacement (resemble-enhance) | 2026-09-26 | Nothing. It existed to feed the step above. Note the naming: the module was `speech-upscale` while the endpoint key, the image and the repo were `audio-upscale`, so a sweep for one silently misses the other. The `speech` hook now has no implementation and is an open slot. |

Some films in the [showcase](../README.md) were made while a retired capability was live. That
record stays as written; it describes how the film was actually made at the time. Nothing here
offers those providers today.

---

## What this table cannot tell you

Said plainly, because a matrix that looks authoritative about everything is worse than one with a
stated edge.

- **The CI check covers the Modules column only.** It proves every module in
  `vivijure-cf/modules/` appears here, that no row names a module that does not exist, and that no
  module is credited to more capability rows than it declares hooks. It cannot check Status, which
  is a judgment; it cannot check the promise wording; and it cannot tell you whether a provider's
  endpoint is actually alive. A green check means the population matches, not that the film
  renders.
- **Status is as of the last person to touch the row.** Where a status depends on a live defect
  the row links the issue rather than restating it, so the issue closing is the signal.
- **`vivijure-local` is out of scope.** It is a separate host and is not covered here.
