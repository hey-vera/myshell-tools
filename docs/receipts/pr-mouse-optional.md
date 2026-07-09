# Receipt — PR Mouse optional (P1.3)

**Branch:** `actualize/pr-mouse-optional`  
**Base:** `origin/main`  
**Scope:** Optional mouse clicks for Control Panel tabs + chat bottom legend. Keyboard remains primary.

## Change

### Pure helpers (`src/interface/ui/mouse.ts`)
- SGR mouse parse (`parseMouseInput` / `isMouseInput` / `isPrimaryClick`) — accepts raw CSI and Ink useInput form (ESC stripped).
- Fail-soft enable/disable: VT200 click tracking (`1000`) + SGR (`1006`); **only writes when `stream.isTTY === true`** (never pollutes golden frames).
- Hit-test: legend segments (menu / mode / panel / interrupt), panel tabs (status / goals / settings), panel footer close (`← chat` / `Esc close`).

### Wiring
- **App:** enable mouse tracking on real TTY while not suspended; disable on unmount.
- **BottomLegend:** optional `onLegendClick` via `useInput` mouse reports on the bottom terminal row.
- **ControlPanel:** left-click tabs to switch section; footer close hits call `onClose`.
- **InputBox:** ignore mouse sequences so they never type into the buffer.

### Out of scope
- Full menu-row mouse (home menu choices).
- Goal-list row clicks / wheel scroll.
- Motion/hover tracking (click-only to limit text-selection interference).

## Tests
- `test/ui/mouse.test.tsx` — parse, enable/disable fail-soft, hit zones, ControlPanel + BottomLegend stdin click wiring.

## Verify

```text
npm run typecheck   # exit 0
npm run knip        # exit 0
npx vitest run test/ui --reporter=dot
# Test Files  18 passed (18)
# Tests  263 passed | 1 skipped (264)
```

## Commit message
`feat(ui): optional mouse clicks for panel tabs and legend`
