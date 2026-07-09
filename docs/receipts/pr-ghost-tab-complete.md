# Receipt — Local-first ghost text with Tab accept (P0.17–P0.18)

**Branch:** `actualize/pr-ghost-tab-complete`  
**Base:** `origin/main`  
**Scope:** Claude Code–class ghost text in the Ink chat composer. Local-only (history / slash / path via completeChat / empty-prompt goal hints). No model calls. Shift+Tab Effort Mode (#124) unchanged.

## Change

- `src/interface/ghost-text.ts` (new)
  - Pure `proposeGhost` / `applyGhost`
  - Layers: empty goal-hint → slash name/arg → completionHits (path/@) → history → recent-accept cache
  - Fail-soft: never throws; only proposes strict prefix extensions
  - `GHOST_DEBOUNCE_MS = 300`
- `src/interface/ui/InputBox.tsx`
  - Debounced ghost (~300ms; test override `ghostDebounceMs`)
  - Dim ghost suffix after caret text when caret at end
  - **Tab** accepts ghost when present; otherwise existing slash/path multi-candidate Tab
  - **Esc** / typing dismisses ghost
  - Optional `goalHints` inject for empty-prompt next-action
  - Shift+Tab still only cycles Effort Mode
- Tests
  - `test/unit/ghost-text.test.ts` — pure engine contract
  - `test/ui/input-box.test.tsx` — history ghost Tab accept, Esc/typing dismiss, goal hint, slash ghost, Shift+Tab does not accept ghost

## Verify

```text
npm run typecheck
# tsc --noEmit → exit 0

npm run knip
# exit 0

npx vitest run test/ui test/unit/ghost-text.test.ts test/unit/menu-completion.test.ts --reporter=dot
# Test Files  19 passed (19)
# Tests  262 passed | 1 skipped (263)
```

## Out of scope (P1.5)

- Model ghost fallback / budgeted ghost role
- Settings toggle for model ghost
- App-level goalHints wiring from live board (inject prop is ready)

## Commit message

`feat(ui): local-first ghost text with Tab accept in chat composer`
