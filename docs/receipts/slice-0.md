# Slice 0 — TUI Box Primitives receipt

**Date:** 2026-07-03
**Branch:** `feat/menu-slice-0-tui-box-primitives`

## Changes
- **`src/ui/tui.ts`** — Added `sectionBox()` and `titleBox()` exports (lines 161–260).
- **`test/unit/tui.test.ts`** — Added 19 tests covering both new functions. Updated imports.

## Details
Both new functions reuse the existing helpers `visibleLength`, `truncateToWidth`, and `pad`. They follow the same row-alignment pattern as the existing `box()` function: all rendered rows have equal `visibleLength`.

### `sectionBox(sections, opts?)`
- Rounded box with `├───┤` dividers between sections.
- Default inner width 56 (matches `box()` default).
- Uses 2-space left indent (matches `box()` style).
- Uses `ansiDim` for border characters when `opts.color` is true.
- Returns empty string for zero sections.
- Uses `truncateToWidth` to prevent over-long content from breaking the border.

### `titleBox(title, opts?)`
- Compact rounded box sized to fit the title text.
- Title centered inside (equal leading/trailing padding).
- Default padding 2 spaces per side.
- Uses `ansiDim` for border characters when `opts.color` is true.

## Verification
- `npx tsc --noEmit` — **PASS** (zero errors)
- `npx vitest run test/unit/tui.test.ts` — **PASS** (95 tests, 0 failures)

## Notes
- Build spec file `docs/menu-build-spec-final.md` was not found on this branch. Implementation based on the executor's STEP 2 instructions.
- Existing `box()` function is unchanged (double-line, no color parameter).
- No other files touched.
