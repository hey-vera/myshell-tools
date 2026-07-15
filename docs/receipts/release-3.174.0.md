# Receipt — release 3.174.0 (external readiness code gate)

**Date:** 2026-07-15  
**Branch:** `release/3.174.0`  
**Base:** `origin/main` after `#224`–`#226`  
**npm publish:** **owner-only** — agents must not `npm publish`

## What this release is

Metadata + version for the external-readiness code wave already on main:

| Slice | PR | Notes |
|-------|-----|-------|
| U1 detached account enrich | `#224` | Worker shares managed-account + probe inventory with menu |
| U5 hermetic multichat smoke | `#225` | `npm run smoke:multichat` (18 checks) |
| U7/U8 accounts status + chips | `#226` | OpenCode list honesty; chip reopen regression |
| U0/U2/U3 plan + support matrix | `#224` | EXTERNAL-READINESS-PLAN + SUPPORT-MATRIX |

Package bump: **3.173.0 → 3.174.0**.

## Local verification (orchestrator)

| Check | Result |
|-------|--------|
| `npm run typecheck` | exit 0 |
| `npm run smoke:multichat` | PASS 18 checks |
| `npm run smoke:packed` | ALL CHECKS PASSED (version will read 3.174.0 after bump) |
| CI | required green on this PR |

## Still owner-gated

- **U12** human smoke H1–H9 (`docs/EXTERNAL-READINESS-PLAN.md`)
- **U13** `npm publish`
- **U14** `npm view myshell-tools version` == 3.174.0

## Out of scope

- No further product `src/` behavior in this metadata PR beyond version/docs.
- Agents do not publish.
