# Receipt — release 3.171.0 (actualization wave R0–R9.1)

**Date:** 2026-07-15  
**Branch:** `release/3.171.0`  
**Base:** `origin/main@58f766c` (R9.1 `#207`; docs status PR may land separately)  
**npm publish:** **owner-only** — agents must not `npm publish`

## What this release is

Metadata release for the actualization wave production slices already on main:

| Wave | PRs (approx) | Notes |
|------|----------------|-------|
| R-1 / authority | `#177` | Plan reconciliation (docs) |
| R0 | `#178`–`#189` | Quality gate, fake providers, UI in CI, Node 20 |
| R1 | `#191`–`#197` | Atomic lanes, inventory gen, admission, per-account inventory |
| R2 | `#198`–`#199` | Turn-lane freeze; native session lineage |
| R3 | `#200` | No silent cooling-account pick |
| R4 | `#201`–`#203` | Claude auth default; child env allowlist; Grok auth |
| R5 | `#204` | Live `TurnCallBudget` |
| R7 | `#205` | Progress invariant stops auto-continue |
| R8 | `#206` | Honest Mode + Intensity claims |
| R9.1 | `#207` | Real packed tarball install smoke |

Package bump: **3.170.1 → 3.171.0**. Changelog + README status line updated.

## Honest residuals (do not claim fixed in 3.171.0)

- **R6** detached / shared executor — skeleton / not fully production-actualized.
- R1 live per-account CLI probe E2E; multi-account OS isolation proofs.
- R9 multi-OS golden journey beyond package-check ubuntu.
- Two-dial orchestration-profile branch not merged wholesale.
- Docs actualization status PR may merge independently.

## Verification (orchestrator / CI evidence)

Placeholders for orchestrator to fill with command evidence before merge auto:

| Check | Command | Evidence |
|-------|---------|----------|
| typecheck | `npm run typecheck` | _orchestrator: paste exit 0 + tail_ |
| knip | `npm run knip` | _orchestrator: paste exit 0 + tail_ |
| unit/arch | `npm test` | _orchestrator / CI_ |
| smoke:packed | `npm run smoke:packed` (needs build; `MYSHELL_PACKED_SMOKE=1` where required) | _orchestrator: paste exit 0 + tail_ |
| CI | GitHub Actions on this PR | _green required lanes_ |

**Definition of Done:** green CI lanes + receipt-verified command evidence + vision-aligned (actualization slices already on main; this PR is version/metadata only).

## Out of scope

- No product `src/` behavior change in this PR.
- No `npm publish` by agents.
- No residual R6/R9 golden implementation in this PR.
