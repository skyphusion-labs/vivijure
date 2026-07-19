# Constellation release-tag standard

Contract for every Vivijure constellation repo (plus `slate`). Ratified against
[vivijure#789](https://github.com/skyphusion-labs/vivijure/issues/789) after the
tag-gated-deploy sweep made the git tag the only publish / deploy trigger.

Policy already settled (Conrad): **every constellation repo requires a tag to
deploy, except `vivijure-com` (website) and `vivijure` (this pointer repo).**

## Rules

1. **Git tag: `vX.Y.Z` by default.** SemVer, `v`-prefixed, annotated
   (`git tag -a vX.Y.Z -m "..."` then `git push origin vX.Y.Z`).
2. **Prefix `<component>-vX.Y.Z` only when one repo publishes more than one
   artifact on independent version lines.** Today that is only
   `vivijure-backend` (`backend-v*`), which also has its own tag-protection
   ruleset. Do not rename that track casually (see #789).
3. **Published image tag: clean `X.Y.Z`, no `v`.** Strip the git-tag prefix at
   publish time (`${GITHUB_REF_NAME#v}`, or
   `docker/metadata-action` `type=semver,pattern={{version}}`). This matches
   what every live RunPod endpoint already pins.
4. **No `:latest` on any RunPod-consumed image.** Nothing pins it; a moving tag
   on a determinism-critical artifact is a footgun. Compose images
   (`vivijure-local`) keep `:latest` as the self-host default, and it moves
   **only** when a release tag is cut (not on merge to `main`).
5. **Pin prod by `:<version>@sha256:<digest>` when re-pinning.** The tag names
   the release; the digest survives a force-moved tag. musetalk already does
   this; adopt on the next deliberate (spend-gated) endpoint re-pin for the
   other RunPod images.
6. **A short `:sha-<short>` trace tag is fine; full-sha tags are not.**

## Tag protection

Release tags are the release interface. They must not be deletable or
force-moved by ordinary write access. Org ruleset
`aviation-grade-release-tags-org` targets `refs/tags/v*` across the org
(excluding this hub and `vivijure-com`). `vivijure-backend` keeps its existing
`backend-release-tags` ruleset on `refs/tags/backend-v*`.

## New repos

Born conformant: `v*` git tags, clean `X.Y.Z` image tags, no RunPod `:latest`,
tag-gated deploy / publish, covered by the org tag ruleset.
