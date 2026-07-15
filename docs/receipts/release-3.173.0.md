# Receipt — release 3.173.0 (residual completion wave)

**Date:** 2026-07-15  
**Branch:** `release/3.173.0`  
**Base:** `origin/main@9ec7c40` (fenced goal-job leases `#222`; tip)  
**npm publish:** **owner-only** — agents must not `npm publish`

## What this release is

Metadata release for the residual completion wave already on main after product wave **3.172.0**:

| Slice | PR | Notes |
|-------|-----|-------|
| Accounts list mouse click-to-open | `#219` | Optional mouse open on list rows |
| Live per-account model probe | `#220` | Env-scoped detect / `accountEnv` isolation |
| Detached free-loop multi-turn (up to 8) | `#221` | Continue checkpoints; honest park/fail |
| Fenced goal-job leases (3m TTL + generation) | `#222` | Reclaim without trusting PID alone |

Earlier product wave still in **3.172.0**: multi-chat workers (M1–M3), accounts UX (A1–A2), Effort/Speed dials (D1), multi-OS packed smoke (OS1).

Package bump: **3.172.0 → 3.173.0**. Changelog + README status line + ROADMAP baseline updated.

## Honest residuals (do not claim fixed in 3.173.0)

- Full FG menu-parity free-loop chrome (scheduler/manager UI) still menu-owned.
- Full multi-OS packed golden journey beyond current smoke.
- **`npm publish` is owner-only.**

## Verification

| Check | Notes |
|-------|--------|
| Base tip | `main@9ec7c40` residual wave `#219`–`#222` on main |
| CI | GitHub Actions on this PR — green required lanes |
| This PR | Version/metadata only — no product `src/` change |

**Definition of Done:** green CI lanes + receipt-verified + vision-aligned (residual wave already on main; this PR is version/metadata only).

## Out of scope

- No product `src/` behavior change in this PR.
- No `npm publish` by agents.
