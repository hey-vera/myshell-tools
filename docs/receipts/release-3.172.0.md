# Receipt — release 3.172.0 (product wave M/A/D/OS)

**Date:** 2026-07-15  
**Branch:** `release/3.172.0`  
**Base:** `origin/main@9c02738` (OS1 multi-OS packed smoke `#216`; tip green)  
**npm publish:** **owner-only** — agents must not `npm publish`

## What this release is

Metadata release for the product wave already on main after actualization **3.171.0**:

| Slice | PR | Notes |
|-------|-----|-------|
| M1 home multi-chat live work status on Recent | `#210` | Multi-chat worker status |
| M2 exit handoff honesty | `#212` | Release TUI jobs; ensure worker |
| M3 shared detached goal executor | `#213` | Real work after shell exit (not park-only) |
| A1 accounts list arrow/Enter/digit nav | `#211` | Accounts UX |
| A2 accounts rename label `[l]` | `#214` | Accounts UX |
| D1 Effort + Speed dials | `#215` | Mode + intensity storage; user-facing Effort/Speed |
| OS1 multi-OS packed smoke (win/mac) | `#216` | Without renaming required ubuntu package-check |

Package bump: **3.171.0 → 3.172.0**. Changelog + README status line + ROADMAP baseline updated.

## Honest residuals (do not claim fixed in 3.172.0)

- Free-loop detached still one turn then park; full menu-parity multi-turn free loop.
- Mouse on accounts.
- Live per-account model probe.
- Fenced leases.
- **`npm publish` is owner-only.**

## Verification

| Check | Notes |
|-------|--------|
| Base tip | `main@9c02738` green (user-stated) |
| CI | GitHub Actions on this PR — green required lanes |
| This PR | Version/metadata only — no product `src/` change |

**Definition of Done:** green CI lanes + receipt-verified + vision-aligned (product wave already on main; this PR is version/metadata only).

## Out of scope

- No product `src/` behavior change in this PR.
- No `npm publish` by agents.
- No residual free-loop multi-turn / fenced leases / mouse accounts / live model probe in this PR.
