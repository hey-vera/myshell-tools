# Receipt: residual detached free-loop multi-turn

**Branch:** `product/residual-detached-freeloop`  
**Commit:** `e524ade`  
**Date:** 2026-07-15  
**Scope:** Detached worker free-loop goals run multi-turn (not one-turn-then-park), using `core/goal.ts` pure helpers + `runTask`, with honest park/fail outcomes.

## User-visible

- Free-loop / empty-roadmap detached jobs loop up to `DEFAULT_MAX_GOAL_ITERATIONS` (8):
  - `GOAL_CONTINUE` → next turn; next-step folded via `appendCheckpointFromContinue` (menu parity).
  - `GOAL_COMPLETE` without roadmap + acceptance evidence → **parked** (not silent `done`).
  - Structured `ask_user` / `final.questions` → **parked** for reattach.
  - Abort → **parked**.
  - Provider fail / `decideGoalNext` stop-error → **failed**.
  - Missing signal / turn ceiling → **parked**.
- Roadmap goals still use `runDurableGoal` (unchanged evidence gate).
- No package version bump.

## Files

| Path | Role |
| --- | --- |
| `src/commands/detached-goal-execution.ts` | `runDetachedFreeGoal` multi-turn free path; wire from executor |
| `src/commands/worker.ts` | Comment: free-loop multi-turn policy |
| `test/unit/detached-goal-execution.test.ts` | continue→complete ≥2 calls; questions; abort; fail |
| `docs/ROADMAP-STATUS.md` | Residual marked done |
| `CHANGELOG.md` | Post-release note |
| `docs/receipts/residual-detached-freeloop-multiturn.md` | This receipt |

## Non-goals (held)

- Fenced leases (M4)
- Full extraction of menu scheduler/manager chrome into worker
- Version bump / npm publish
- Verified-done gate for free-loop without roadmap (explicitly parks on COMPLETE)

## Honest remaining gaps

1. **FG chrome parity:** menu still owns concurrent scheduler, manager cycle UI, live progress panel formatting; worker uses quiet `runTask`.
2. **Fenced leases:** claim still PID-liveness based.
3. **Free-loop GOAL_COMPLETE:** still parks (honest — no roadmap/acceptance evidence path on free-loop).
4. **Session/history continuity across detached free turns:** each turn uses job session writer via production deps; no extra menu-style memory enrichment beyond OrchestrateDeps composition.

## Verification (local)

```text
npm run typecheck
npm run lint
npm run knip
npx vitest run test/unit/detached-goal-execution.test.ts
```
