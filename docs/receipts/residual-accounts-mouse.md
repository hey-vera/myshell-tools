# Receipt — residual: Accounts list mouse click-to-open

**Branch:** `product/residual-accounts-mouse`  
**Base:** `origin/main`  
**Scope:** Optional SGR mouse click on per-provider account list rows opens edit (same as Enter on that row). Keyboard remains primary; geometry is fail-soft.

## Change

### Pure hit math (`src/interface/ui/mouse.ts`)
- `listIndexFromMouseRow(mouseRow, firstDataRow, length)` — pure row → index (null outside band).
- `listIndexFromMouseKey(raw, firstDataRow, length)` — primary left-press only via existing SGR parse.
- `ACCOUNTS_LIST_FIRST_DATA_ROW = 4` — shared chrome offset for all four provider lists  
  (blank, title, blank, header, then data rows).

### Input plumbing
- **InputBox:** when `readPending` (menu `readKey`), forward SGR mouse to `onReadKey` instead of swallowing (still never types into the editor buffer).
- **`classifyMenuKey`:** preserve SGR mouse strings (do not collapse multi-byte mouse CSI to `''` / Enter).

### Per-provider account lists
- `menu-claude-accounts.ts`, `menu-codex-accounts.ts`, `menu-grok-accounts.ts`, `menu-opencode-accounts.ts`
- After Esc/back handling: hit-test mouse → activate that row (edit); non-hit mouse reports ignored; keyboard path unchanged.

## Tests
- `test/unit/menu-list-mouse.test.ts` — pure hit math + classify preserves mouse.

## Non-goals
- Home-menu row mouse; wheel scroll; motion/hover.
- Perfect absolute geometry when Static scrollback shifts chrome (fail-soft miss).
- Version bump / release.

## Verify

```text
npm run typecheck
npx vitest run test/unit/menu-list-mouse.test.ts test/unit/menu-list-nav.test.ts test/ui/mouse.test.tsx --reporter=dot
npm run lint
npm run knip
```
