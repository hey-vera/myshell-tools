# Receipt — PR resume partner goals (P0.16)

**Branch:** `actualize/pr-resume-partner-goals`  
**Base:** `origin/main`  
**Scope:** Resume partnering — first orientation addresses parked/inactive goals.

## Change

On conversation resume (existing concurrent recap path in `runChatLoop`):

1. Load real goals from the goal store (fail-soft).
2. Pure helper `buildResumeGoalOrientation` selects conversation- or workspace-scoped live goals (`parked` / `blocked` / `running` / `queued`).
3. Emits **one natural prose line** (status + next open step or resume/drop/adjust) — not a second board.
4. Once per resume session (same async block as recap); no spam, no invented goals.

### Files

| File | Role |
|------|------|
| `src/core/resume-goal-orientation.ts` | Pure select + format helper |
| `src/interface/menu.ts` | Wire into resume/recap path |
| `test/unit/resume-goal-orientation.test.ts` | Unit coverage (selection, copy, caps, no invent) |

### Example orientation

- `Parked: “Auth JWT migration” (1/4 to-dos) — next: Write expiry tests. Resume, drop, or adjust?`
- `2 open goals: parked “Auth JWT”; parked “Docs pass”. Resume one, drop, or adjust?`

## Out of scope

- Goal Steward interactive key prompts (flag-gated, 30d stale window) — unchanged
- Goal board / bottom recap dock layout (P0.13–P0.15)
- Auto-executing parked goals

## Verify

```text
npm run typecheck
# tsc --noEmit → exit 0

npm run knip
# knip → exit 0

npx vitest run test/unit/resume-goal-orientation.test.ts --reporter=dot
# Test Files  1 passed (1)
# Tests  14 passed (14)

npx vitest run test/unit --reporter=dot
# Test Files  269 passed | 1 skipped (270)
# Tests  7180 passed | 14 skipped (7194)
```

## Commit message

`feat(chat): resume orientation addresses parked goals`
