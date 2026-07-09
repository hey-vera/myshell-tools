# Receipt — Shift+Tab cycles conversation Effort Mode (P0.8)

**Branch:** `actualize/pr-shift-tab-mode`  
**Base:** `origin/main`  
**Scope:** Per-conversation Effort Mode cycle via Shift+Tab; does not change global `config.mode`.

## Change

- `src/core/mode-levels.ts`
  - Added pure `nextLevel(current)` — Budget → Balanced → High → Max → Auto → Budget…
- `src/interface/ui/InputBox.tsx`
  - Shift+Tab (`key.tab && key.shift`) calls `onShiftTab` (any buffer state); plain Tab still autocompletes
- `src/interface/ui/App.tsx` + `mount.tsx`
  - Bridge seams `setCycleMode` / `cycleMode` (mirror interrupt)
  - InputBox `onShiftTab` → `bridge.cycleMode()`
  - Control Panel still owns Shift+Tab when open (`InputBox` inactive)
- `src/interface/menu.ts` + `menu-conversations.ts`
  - Mutable `convLevel` + `effectiveMode` for mid-session cycle
  - Handler: `nextLevel` → `store.setMode(convId, …)` → `inkSetInputInfo` with `levelLabel`
  - **Never** writes `mutableCtx.config.mode`
  - Armed at chat entry; cleared in `finally`
  - Input chrome shows level labels (Budget/…/Auto)
- Tests
  - `test/unit/mode-levels.test.ts` — cycle + full ring
  - `test/ui/input-box.test.tsx` — Shift+Tab fires; plain Tab does not; draft preserved
  - `test/unit/menu-mode-scope.test.ts` — setMode walk via nextLevel (no global config)

## Verify

```text
npm run typecheck
# tsc --noEmit → exit 0

npm run knip
# exit 0

npx vitest run test/ui test/unit/menu-flow.test.ts test/unit/mode-levels.test.ts test/unit/menu-mode-scope.test.ts --reporter=dot
# Test Files  20 passed (20)
# Tests  682 passed | 2 skipped (684)
```

## Commit message

`feat(ui): Shift+Tab cycles conversation Effort Mode`
