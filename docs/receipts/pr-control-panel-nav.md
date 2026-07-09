# Receipt — PR Control Panel nav discoverability + escape (P0.10)

**Branch:** `actualize/pr-control-panel-nav`  
**Base:** `origin/main`  
**Scope:** Control panel always escapable; visible section/escape chrome; focus model docs; home footer via nav-footer (P0.11 light).

## Change

### Control Panel (`src/interface/ui/ControlPanel.tsx`)
- **Always escapable:** Esc, **Left**, and Ctrl+G call `onClose` (Left was a no-op; now closes per PANEL-NAV-SPEC).
- **Clustered chrome footer** (reserved in fixedRows, never buried in content):
  - Wide: `← chat  ·  Tab sections  ·  ↑↓ select  ·  Enter goal  ·  Esc close`
  - Narrow (`columns < 60`): `← chat  ·  Tab  ·  Esc close`
- Exported `buildControlPanelFooterText(columns)` for pure selection + tests.
- Focus-model comment block: single `useInput` owner; InputBox inactive while open.

### App / InputBox
- Comments document focus model: panel open → InputBox `active=false` + `visible=false`; empty-buffer Right opens panel; Esc/Left/Ctrl+G close.
- Empty-buffer Right → open / Left → menu already wired; comments expanded (P0.9).

### Home footer (P0.11 light)
- `menu-render.ts` root footer uses `navFooterText('exit-only', out.color)` (same `ESC to exit` glyphs; dim when color on).
- `nav-footer.ts`: back-and-exit spacing aligned with legend middot language.

## Tests
- `control-panel.test.tsx`: Left closes; Right no-op; footer Esc/Tab assertions.
- `control-panel-wiring.test.tsx`: Left closes via App bridge; open frame has Esc close.
- `app.test.tsx`: CP open shows panel footer, not chat legend.

## Verify

```text
npm run typecheck   # exit 0
npm run knip        # exit 0
npx vitest run test/ui --reporter=dot
# Test Files  17 passed (17)
# Tests  235 passed | 1 skipped (236)
```

Also: `test/unit/menu-render.test.ts` + `menu-flow.test.ts` → 408 passed | 1 skipped.

## Out of scope
- Mouse support (P1).
- Full Shift+Tab conversation mode cycle (other PR).
- Control panel content honesty / real quota (P1.4).

## Commit message
`fix(ui): control panel nav discoverability and escape`
