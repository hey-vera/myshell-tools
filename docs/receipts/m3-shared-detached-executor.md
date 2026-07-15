# Receipt: M3 — Shared detached goal executor

**Branch:** `product/m3-shared-detached-executor`  
**Date:** 2026-07-15  
**Scope:** After Esc/process death, claimed goal jobs continue **real** provider work via `myshell-tools worker`, not park-only skeleton.

## User-visible

- Detached worker default executor calls `createDetachedGoalExecutor()`:
  - Builds live `OrchestrateDeps` (detect + config + authenticated providers).
  - **Roadmap goals:** `runDurableGoal` — todo-at-a-time provider turns + test evidence before item/goal done.
  - **Free-loop / empty roadmap:** one real `runTask` turn on `job.work`, then honest park for reattach (no false verified-done).
  - **No providers:** park (not false done).
- TUI still claims jobs as `owner: tui` while alive and runs `runGoalLoop` in-process (no double-run). Worker reclaims when TUI PID is dead.

## Files

| Path | Role |
| --- | --- |
| `src/core/durable-goal-runner.ts` | Shared evidence-gated roadmap loop (injected ports) |
| `src/commands/detached-goal-execution.ts` | Production composition: providers + runTask + verify |
| `src/commands/worker.ts` | Default executor → real path (not park-only) |
| `src/interface/menu.ts` | Comment-only: claim-while-alive + worker real path |
| `test/unit/durable-goal-runner.test.ts` | Unit: done / wait / empty roadmap |
| `test/unit/detached-goal-execution.test.ts` | Fake provider free-loop + roadmap + default wire |

## Non-goals (held)

- Fenced leases (M4)
- Accounts UI / dials
- Full extraction of menu `runGoalLoop` multi-turn free adaptive loop into worker
- Control-plane event log / heartbeats from two-dial feature branch

## Honest remaining gaps

1. **Free-loop multi-turn:** detached free-loop does **one** provider turn then parks. Full adaptive multi-turn free loop still primarily lives in menu `runGoalLoop`.
2. **FG/detached parity:** menu still owns concurrent scheduler, manager cycle chrome, goal-progress UI formatting; worker uses `runTask` quiet path.
3. **Fenced leases (M4):** claim is still PID-liveness based (`canClaimGoalJob` / `isOwnerAlive`), not renewable leases.
4. **Control-plane / board events:** this slice does not append a durable control-plane event log (feature-branch control-plane not on main).
5. **Verification policy:** todo/goal evidence uses detectTestCommand + runTests only; no diff-scoped critic path on the detached free-loop step.
6. **waiting_on_auth as first-class job status:** no providers → job outcome `parked` (goal store parked); no dedicated `waiting_on_auth` job status enum.

## Verification (local)

Commands to re-run:

```text
npx tsc --noEmit
npx vitest run test/unit/durable-goal-runner.test.ts test/unit/detached-goal-execution.test.ts test/unit/goal-job-store.test.ts
npx eslint src/commands/worker.ts src/commands/detached-goal-execution.ts src/core/durable-goal-runner.ts
npx knip
```
