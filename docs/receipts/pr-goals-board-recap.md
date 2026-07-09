# Receipt: single goals board + bottom recap (P0.13–15)

**Branch:** `actualize/pr-goals-board-recap`  
**Date:** 2026-07-09  
**Scope:** Kill dual goal chrome in chat; dock ※ recap at bottom; keep better board quality.

## Intent

User complaint: two mini goal boards in chat felt redundant; recap should live at the bottom dock (where the lesser strip sat); keep the higher-quality bordered BOARD.

## What changed

1. **Single goals surface**
   - Chat no longer mounts `GoalQuickStrip` above the composer.
   - The bordered `BOARD` in `StatusBlock` remains the only goals list on the chat surface.
   - Live per-turn `GOALS` agent tree during active turns is unchanged (agent telemetry, not a second goal board).
   - `GoalQuickStrip` component + pure selectors retained for unit coverage / layout helpers; not rendered in `App`.

2. **Bottom recap dock**
   - New `UiState.recap` + `recap/set` action + `OutputSink.setRecap`.
   - New `RecapDock` above the input (where the strip lived).
   - Resume + `/recap` prefer `out.setRecap` on Ink; legacy sinks still `formatRecapLine` to transcript.
   - Conversation exit clears the dock (`setRecap(null)`).
   - Layout reserves `RECAP_DOCK_ROWS` only when recap text is present.

3. **Board quality (no fake data)**
   - Board rows now: `{glyph} {title} {done}/{total} · {state}[ · N workers][ · tools][ · verdict]`.
   - Parked/queued/etc. show real `next:` from active/pending todos when present.
   - Running goals expand the checklist (no duplicate `next:` line).
   - Height plan counts next-action lines so the board cannot overflow the viewport.

## Verify (command evidence)

```
npm run typecheck   # exit 0
npm run knip        # exit 0 (clean)
npx vitest run test/ui --reporter=dot
# Test Files  17 passed (17)
# Tests  236 passed | 1 skipped (237)
```

## Files

- `src/interface/ui/App.tsx` — strip out; recap dock in
- `src/interface/ui/RecapDock.tsx` — new
- `src/interface/ui/StatusBlock.tsx` — BoardRow quality
- `src/interface/ui/layout.ts` — RECAP_DOCK_ROWS, next-action height
- `src/interface/ui/state.ts` / `reduce.ts` / `mount.tsx` / `stream-filter.ts` — recap plumbing
- `src/interface/menu.ts` — setRecap on resume / `/recap` / exit
- `test/ui/*` — single-board + dock + golden refresh

## Non-goals / not in this PR

- Resume partner messaging for inactive goals (separate P0 resume partner PR).
- Deleting `GoalQuickStrip.tsx` entirely (kept for pure-helper tests; not dual chrome).
- Fabricated goal/recap content — only real store / generator text.

## Vision

Moves toward "one chat" calm surface: one goals glance, orientation at the dock, less redundant chrome.
