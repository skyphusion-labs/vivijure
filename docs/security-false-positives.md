# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Meta constellation map

`vivijure` is the constellation README; it has no runtime surface. Findings about the adversarial-audit workflow itself are org CI trust boundaries (pinned fleet-chezmoi SHA + org secrets).

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 verify ~18:04 | LLM-processed PR content posted to PR | Advisory audit; org-controlled script pin + secret scope |
| 2026-07-23 | K3 verify ~18:04 | Audit script from private repo with CF secrets | Org CI pattern; FLEET_CHEZMOI_READ_TOKEN + SHA pin |
