# R7.1 — Progress invariant (auto-continue stop)

Date: 2026-07-14  
Branch: `actualize/r7-progress-invariant`  
Authority: `CLAUDEPLAN.md` § Terra Loop Failure / R7 durable truth and stall recovery  
Baseline: `origin/main` at implementation start

## User-visible behavior

When the per-goal **manager cycle** auto-continues through to-dos, the loop must stop honestly after a bounded window of **no meaningful progress**. Reworded status / heartbeat text never counts. Meaningful signals only:

- verdict write
- evidence
- blocker / code change (park, fix-it spawn, durable roadmap mutation)
- file / diff receipt

After `DEFAULT_NO_PROGRESS_LIMIT` (3) consecutive no-progress cycles — including **identical** meaningful fingerprints (stuck on the same receipt) — the cycle sets `stoppedEarly`, prints a typed blocked reason, and keeps the goal open (no fake green).

## Production call path

```
menu.ts runGoalLoop (manager branch)
  → createProgressInvariantState()
  → each to-do iteration:
       fingerprintRoadmap(before)
       worker turn + verify + setRoadmapItemVerdict / park / fix-it
       fingerprintRoadmap(after)
       classifyManagerCycleProgress({ verdict, paths, blocked, fixIt, fps })
       observeProgressCycle(state, obs, { nowTick: usedTurns, noProgressLimit })
       if decision.shouldStopAutoContinue → break (goal stays open)
```

Entry: activated goal with roadmap + manager flag (default on). Composition: pure core + existing menu manager loop. No new dark flag.

## Files

| Path | Role |
| --- | --- |
| `src/core/progress-invariant.ts` | Pure state machine + classifiers + blocked record builder |
| `src/interface/menu.ts` | Minimal wire in manager cycle |
| `test/unit/progress-invariant.test.ts` | Pure + production-path simulation |
| `docs/receipts/r7-progress-invariant.md` | This receipt |

## Failure / rollback

- Fail-soft: invariant only **stops** auto-continue; it never fabricates verdicts or marks goals done.
- Rollback: revert this branch; manager cycle returns to turn-ceiling / fix-it-cap bounds only.
- No schema migration; state is in-memory per activation.

## Verification (run on branch)

| Command | Result |
| --- | --- |
| `npx vitest run test/unit/progress-invariant.test.ts` | 17 passed |
| `npx vitest run test/unit/progress-invariant.test.ts test/arch/guards.test.ts` | 1518 passed (incl. core purity / orphan guards) |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors (3 pre-existing `no-console` warnings in `test/integration/p0-pty-benchmark.test.ts`) |
| `npx knip` | exit 0 |

## Deliberate non-goals (this slice)

- Free `GOAL_CONTINUE` loop progress invariant (manager cycle only).
- Recovery actions (cancel hung child, checkpoint restore, provider switch) — R7 later.
- Extending shared `BlockedReasonCode` with `no_meaningful_progress` (local code + `verification_failed` on `BlockedRecord` for now).
- Heartbeat UI redesign.

## Actualization note

Pure helper alone does not count: production path is the **menu manager cycle** call sites above. Tests cover pure helpers and a menu-shaped classify→observe sequence without spinning the full Ink/menu harness.
