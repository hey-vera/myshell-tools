# Receipt — M2 Exit handoff honesty for multi-chat goals

**Date:** 2026-07-15  
**Branch:** `product/m2-exit-handoff`  
**Baseline:** `origin/main` (3.171.0 / actualization wave)  
**Scope:** Ownership release + worker ensure on Esc/process exit; reopen messaging honesty. **Not** full shared executor (M3).

## User-visible

When the user Esc/exits with active goals:

1. Detached worker process is ensured if active jobs remain.
2. TUI releases job ownership (`owner:tui` + `claimedBy`) → `pending` so the worker can claim without waiting on dead-PID reclaim (avoids stuck claims if PIDs recycle).
3. On reopen chat: distinct dim lines for healed orphans vs detached-worker-running vs pending-handoff queue vs parked/resume.

## Production path

| Site | Behavior |
| --- | --- |
| `runChatLoop` `finally` when `control.result === 'exit'` | `beginTuiExitHandoff` → `abortAllGoalWorkers` → `releaseTuiOwnership` → `ensureWorkerProcess` + dim line |
| `startMenu` `finally` | Same handoff if not already armed (home Esc / q after leave-chat with live registry) |
| `spawnBackgroundGoal` `finally` | Skips `markTerminal(parked)` when handoff active or job no longer TUI-owned |
| Chat enter heal | `classifyGoalJobForReopen` + `formatExitHandoffReopenMessages` |

## Files

| Path | Role |
| --- | --- |
| `src/infra/goal-job.ts` | `applyReleaseForHandoff`, `isOwnedByPid`, reopen classifiers, exit-handoff latch |
| `src/infra/goal-job-store.ts` | `releaseTuiOwnership` |
| `src/infra/detached-worker-spawn.ts` | unchanged API; called from exit paths |
| `src/interface/goal-worker-registry.ts` | `abortAllGoalWorkers` |
| `src/interface/menu.ts` | exit finally + reopen messaging + spawn finally guard |
| `test/unit/goal-job.test.ts` | pure handoff + messaging |
| `test/unit/goal-job-store.test.ts` | release → worker claim; no strip worker |

## Non-goals (honest residual)

- Full adaptive `runGoalLoop` in detached worker (M3 / R6 residual) — worker may still park after claim.
- Fenced leases beyond PID + explicit release.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (3 pre-existing `no-console` warnings in `p0-pty-benchmark.test.ts` only) |
| `npm run knip` | exit 0 |
| `npm test` (`test/unit` + `test/arch`) | **9276 passed**, 15 skipped, 0 failed |

Focused: `test/unit/goal-job.test.ts` (22) + `test/unit/goal-job-store.test.ts` (15) green.
