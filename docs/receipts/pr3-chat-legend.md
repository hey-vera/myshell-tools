# Receipt — PR3 Chat BottomLegend cluster

**Branch:** `actualize/pr3-chat-legend`  
**Base:** `actualize/10of10-foundation`  
**Scope:** Cluster chat bottom legend keys for discoverability (P0.7 legend text only).

## Change

- `src/interface/ui/BottomLegend.tsx`
  - Removed max-padding that pushed `control panel →` to the far right.
  - Clustered legend (wide): `← menu  ·  Shift+Tab mode  ·  → panel  ·  Esc interrupt`
  - Narrow (`columns < 60`): `← menu  ·  → panel` (keeps back + panel)
  - Exported `buildBottomLegendText(columns)` for pure legend selection.
- `test/ui/app.test.tsx`
  - Assertions updated to clustered copy.
  - Added narrow-terminal case (omits mode + interrupt).

## Out of scope

- Full Shift+Tab mode cycling implementation (legend text only).

## Verify

```text
npm run typecheck
# tsc --noEmit → exit 0

npx vitest run test/ui
# Test Files  17 passed (17)
# Tests  233 passed | 1 skipped (234)
```

## Commit message

`fix(ui): cluster chat bottom legend keys for discoverability`
