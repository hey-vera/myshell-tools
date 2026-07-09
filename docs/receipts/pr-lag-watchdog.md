# Receipt — Harden lag/stale UI watchdog relaunch

**Branch:** `actualize/pr-lag-watchdog`  
**Base:** `origin/main`  
**Scope:** Minimal real hardening of phase6 lag watchdog already on main. Not a rewrite of Ink.

## Already on main (phase6 merge `b587030`)

- `src/infra/active-conversation.ts` — active conversation marker
- `src/infra/relaunch-recovery.ts` — attempt guard (2/10min per-conv, 3/30min global)
- `src/infra/state-layout.ts` — marker paths
- `src/interface/ui/mount.tsx` — `createWatchdog` event-loop sampler + thresholds
- `src/interface/menu.ts` — `onUnresponsive` → `ctx.relaunch`, marker write/clear, startup auto-resume
- Unit tests: `watchdog`, `relaunch-recovery`, `active-conversation`

## Gaps found / fixed this PR

| Gap | Fix |
|-----|-----|
| `recordInput` only on `readKey` — chat submit never armed watched-active | `createInkLineReader` `onUserActivity` → `recordInput` on `onSubmit` |
| Long agentic turns lost watched-active after 60s (turn activity only on `beginTurn`) | Store observer records turn activity on stream/tier/final/turn actions while turnActive |
| Recovery relaunch success left parent in `startMenu` (child owns TTY, parent races menu) | `recoveryDone` latch; `runChatLoopWithMarker` awaits handoff and returns `'exit'` |
| No honest pre-relaunch notice | `[recovering] terminal UI stopped responding; restarting…` before unmount |
| Recovery notice always printed for any leftover marker | `[recovered]…` only when `reason === 'auto-recovered'` or `MYSHELL_RECOVERY_RELAUNCH=1` |
| Recovery did not arm startup-input carrier | Mirror update-flow `arm` + env carrier on handoff |
| Detection logic only tested via timers | Pure helpers: `evaluateWatchdogSample`, `isBadWatchdogSample`, `isWatchdogWatchedActive`, `isWatchdogTurnProgressAction` |

## Files touched

- `src/interface/ui/mount.tsx` — pure detection helpers; submit/turn heartbeats; `createInkLineReader` activity hook
- `src/interface/menu.ts` — handoff latch/exit; honest messages; startup-input arm
- `test/unit/watchdog.test.ts` — pure helper + turn-activity arming cases
- `docs/receipts/pr-lag-watchdog.md` — this receipt

## Verify

```text
npm run typecheck
# tsc --noEmit → exit 0

npm run knip
# exit 0

npx vitest run test/unit/watchdog.test.ts test/unit/relaunch-recovery.test.ts test/unit/active-conversation.test.ts
# Test Files  3 passed (3)
# Tests  50 passed (50)
```

## Non-goals (unchanged)

- No Ink rewrite / no React throw into ErrorBoundary for watchdog
- No composer text / scroll / in-flight stream snapshotting
- Cannot recover a process permanently stuck in a native sync call (JS timers never fire)

## Commit message

`fix(ui): harden lag/stale UI watchdog relaunch`
