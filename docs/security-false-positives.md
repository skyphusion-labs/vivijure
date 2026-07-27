# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Meta constellation map

`vivijure` is the constellation README; it has no runtime surface. Findings about the adversarial-audit workflow itself are org CI trust boundaries (pinned fleet-chezmoi SHA + org secrets).

## Scanning posture (2026-07-27)

**CodeQL default setup is deliberately OFF on this repo. Do not re-enable it for
`javascript-typescript` or `python`.**

It had been enabled for both on a repo whose only code is GitHub Actions workflows, so every run
failed at database finalize:

```
CodeQL detected code written in GitHub Actions, but not any written in JavaScript/TypeScript.
Confirm that there is some source code for JavaScript/TypeScript in the project.
```

Identically for Python. Both analyses failed on every push and every PR from setup until removal --
permanent red that told nobody anything. Combined with this repo having no required status checks at
the time, 6 of the last 20 PRs merged with failing checks (#795, #796, #797, #798, #799, #801).

If Actions-language scanning is wanted here later, enable **`actions` only**.

**The gate is now `audit`.** Repo-level ruleset `vivijure-required-checks` (id 19788245) requires
the `Adversarial audit` workflow's `audit` job on `main`, strict up-to-date, admin-only bypass. This
repo is excluded from org ruleset 18677665, so that repo-level ruleset is the *only* thing standing
between a red PR and `main` -- if it is removed, the repo is ungated again.

Doctrine and the estate-wide sweep: `fleet-chezmoi` `docs/runbooks/aviation-grade-main.md`,
`scripts/sweep-required-checks.sh`. Tracking: fleet-chezmoi fc#1129.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 verify ~18:04 | LLM-processed PR content posted to PR | Advisory audit; org-controlled script pin + secret scope |
| 2026-07-23 | K3 verify ~18:04 | Audit script from private repo with CF secrets | Org CI pattern; FLEET_CHEZMOI_READ_TOKEN + SHA pin |
