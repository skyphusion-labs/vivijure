# Dependabot: aiohttp on containers/* (stale)

Open Dependabot alerts for `aiohttp` under:

- `containers/audio-beat-sync/requirements.txt`
- `containers/audio-master/requirements.txt`
- `containers/audio-mix/requirements.txt`
- `containers/image-prep/requirements.txt`
- `containers/video-finish/requirements.txt`

## Why this PR does not bump aiohttp

Those paths **do not exist on `main`** of `skyphusion-labs/vivijure` (recursive tree as of 2026-08-07). The studio monorepo no longer vendors those container requirement files here; finish/media containers live in sibling engine repos.

Dependabot is reporting a **stale dependency graph** for removed manifests. There is nothing to patch in this tree without resurrecting deleted files.

## Action

1. Dismiss the open alerts as `not_affected` / `tolerable_risk` with reason: manifests removed from default branch.
2. Or wait for the next dependency-graph rescan after this note lands (sometimes graph lags).

## If containers return

Pin `aiohttp>=3.14.3` (covers GHSA-cq5v-8q36-5273 high and the 3.14.2 medium websocket series).
