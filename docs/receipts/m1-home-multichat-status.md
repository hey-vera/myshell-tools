# Receipt: M1 — Home multi-conversation live goal/worker status

**Branch:** `product/m1-home-multichat-status`  
**Date:** 2026-07-15  
**Base:** origin/main @ 3.171.0 (`ca38508`)

## Intent

Home **Recent** rows show glanceable live work state per conversation so the user can manage multiple chats without opening each. Status is derived only from real sources — never fabricated.

## Sources (honest)

| Signal | Source |
|--------|--------|
| `N working` | In-process `conversationWorkerCount` / goal-worker-registry |
| `N running` | Durable goal store `state === 'running'` when no live workers |
| `N parked` | Durable goal store `state === 'parked'` for that conversationId |
| `job alive` / `N jobs` | `goalJobStore.listActive()` for that conversation |

## What changed

1. **Pure helpers** (`menu-render.ts`):
   - `formatConversationWorkStatus` — chips from counts
   - `buildConversationWorkStatusById` — aggregate goals + jobs + live workers
   - `resolveConversationWorkStatus` — map hit or live-only fallback
   - `formatRecentRow` — optional trailing work-status field (dim when color on)

2. **Home render** — `renderMainScreen` uses `allGoals` + `activeJobs` + registry to append status on Recent rows. Fail-soft: store/map errors → empty chips (golden idle home unchanged).

3. **menu.ts (thin)** — menu loop loads `menuGoalJobStore.listActive()` alongside goals/conversations and passes `activeJobs` into `renderMainScreen`. All reads `.catch(() => [])`.

## Verify (command evidence)

```
npx vitest run test/unit/menu-render.test.ts --reporter=dot
# Test Files  1 passed (1)
# Tests  43 passed (43)

npm run typecheck   # exit 0
npm run lint        # exit 0
npm run knip        # exit 0
git diff --check    # exit 0
```

## Files

- `src/interface/menu-render.ts` — pure status + Recent row wiring
- `src/interface/menu.ts` — load active jobs; pass into render
- `test/unit/menu-render.test.ts` — pure formatter + render snapshot
- `docs/receipts/m1-home-multichat-status.md` — this receipt

## Non-goals / not in this PR

- Full detached executor reliability (M3)
- Accounts UI / dials
- Compact header total (optional; rows are the glance surface)

## Vision

Advances multi-chat orchestration: leave chat ≠ lose sight of work; home is the control plane for concurrent conversations.
