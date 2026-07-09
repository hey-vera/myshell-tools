# Receipt — Wire board goalHints into empty-prompt ghost text

**Branch:** `actualize/pr-goal-hints-wire`  
**Base:** `origin/main`  
**Scope:** Live empty-prompt ghost hints from `UiState.board` → `InputBox.goalHints`. Local-only. No model ghost (P1.5).

## Change

- `src/interface/ui/layout.ts`
  - Pure `goalHintsFromBoard(board)` — fail-soft `[]` on null/empty
  - Prefer real next-step todos (`boardNextActionText`: active → pending)
  - Fall back to goal title when no todos
  - Order: running → queued → parked; skip terminal states
  - Dedup identical hint strings
- `src/interface/ui/App.tsx`
  - `useMemo` over `uiState?.board` → pass `goalHints` into both chat `InputBox` mounts
- `src/interface/ui/index.ts` — re-export `goalHintsFromBoard`
- `test/unit/ghost-text.test.ts` — pure helper + end-to-end with `proposeGhost`

## Verify

```text
npm run typecheck
# tsc --noEmit → exit 0

npm run knip
# exit 0

npx vitest run test/ui test/unit/ghost-text.test.ts --reporter=dot
# Test Files  18 passed (18)
# Tests  262 passed | 1 skipped (263)

npx vitest run test/unit/ghost-text.test.ts --reporter=verbose
# Tests  17 passed (17)  — includes 4 new goalHintsFromBoard cases
```

## Out of scope (P1.5)

- Model ghost fallback / budgeted ghost role
- Settings toggle for model ghost

## Commit message

`feat(ui): wire board goalHints into empty-prompt ghost text`
