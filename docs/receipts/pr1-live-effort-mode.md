# Receipt — PR1 Live Effort Mode box + correct keys

**Date:** 2026-07-09  
**Branch:** `actualize/pr1-live-effort-mode`  
**Base:** `actualize/10of10-foundation`  
**Checklist:** Wave 1 P0.1–P0.6 (`docs/actualization-checklist-10of10-2026-07-09.md`)

## What shipped

1. **Live Effort Mode box** — home (`menu-render.ts`) and New Conversation (`menu-new-conversation.ts`) share pure helpers:
   - `effortModeShortLabel(mode)` — undefined→`Auto (smart)`; cost-saver→Budget; balanced→Balanced; quality-first→Max (`migrateMode`)
   - `buildEffortModeSections(mode)` — header + `LEVEL_DESC` wrap (width 48) + footer `m = switch modes` + short label
   - `renderEffortModeBox(mode, color)` — 48-wide `sectionBox`
2. **runModeSelect keys** map via `ALL_LEVELS` index + `levelToMode()`:
   - 1→cost-saver (Budget), 2→balanced, 3→quality-first (High), 4→quality-first (Max), 5→undefined (Auto)
3. **Removed** `renderAutoDetected` call from mode picker (P0.3)
4. **Removed** redundant `out.write('Effort Mode: …')` confirmation after save (P0.4)
5. **Spacing** — blank lines retained between Effort / Recent / Session Manager (`\n\n` after effort box)
6. **Tests** — `menu-render.test.ts` live modes; `menu-flow.test.ts` key 1=Budget, no Auto-detected

## Commands run

```
npm run typecheck                          # green (tsc --noEmit)
npx vitest run test/unit/menu-render.test.ts test/unit/menu-flow.test.ts test/unit/mode-levels.test.ts
```

### Results

| Suite | Result |
|-------|--------|
| `mode-levels.test.ts` | 40/40 pass |
| `menu-render.test.ts` | 31/31 pass |
| `menu-flow.test.ts` | 375 pass, 1 skip, **2 fail** (unrelated) |

### Unrelated failures (pre-existing / not PR1 surface)

- `startMenu — auto-goal smart autonomy > a warm SystemModel is reused…` (planner count 1≠2)
- `startMenu — auto-goal smart autonomy > understanding failure in post-turn planning…`

Effort Mode tests in menu-flow all green (Budget key map, Auto-detected absence, live Balanced/Auto boxes).

## Files touched

- `src/interface/menu-render.ts`
- `src/interface/menu-new-conversation.ts`
- `src/interface/menu-settings.ts`
- `test/unit/menu-render.test.ts`
- `test/unit/menu-flow.test.ts`
- `docs/receipts/pr1-live-effort-mode.md`

## Acceptance (P0.1–P0.6)

- [x] Budget selection updates home box label/desc/footer
- [x] Keys 1–5 match ALL_LEVELS labels
- [x] No Auto-detected dump on mode screen
- [x] No redundant confirmation line after mode save
- [x] Section spacing preserved
- [x] Unit tests updated for live box + inverted-key fix
