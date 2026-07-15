# Receipt — A2: Accounts edit polish (rename label)

**Branch:** `product/a2-accounts-edit-polish`  
**Base:** `origin/main` (after A1 accounts list nav `#211`)  
**Scope:** Per-provider account edit — rename label (`[l]`); keyboard remains primary.

## Change

### Edit screens (all four providers)
- `menu-claude-accounts.ts`, `menu-codex-accounts.ts`, `menu-grok-accounts.ts`, `menu-opencode-accounts.ts`
- New action **`[l] label`** on the edit menu (design: `docs/subscription-management-design.md` edit submenu).
- Prompt: `Label (Enter keep "<current>"):` — empty/cancel leaves label unchanged; non-empty trims and caps at 64 chars for list scannability.
- Persists via existing `applyAccountUpdate` / `updateSubscriptions`; account `id` is stable (routing identity).

### Mouse (deferred follow-up)
Account lists use ephemeral `beginFrame`/`endFrame` + `readMenuKey`, not Ink row hit-targets. Wiring SGR click → activate highlighted row would need frame-relative row maps and mouse reports through the non-Ink key path — heavier than this slice. **Keyboard remains primary** (A1: ↑↓ / Enter / 1–9 / `[e]`). Optional click-to-edit is a follow-up if/when account menus share a stable mouse hit layer with Control Panel / legend.

## Tests
- `test/unit/menu-claude-accounts.test.ts` — renames label in subscriptions store; id unchanged.

## Non-goals
- Mouse row click on account lists (documented follow-up above).
- Changing priority key from `[p]` to design’s `[w]` (existing UX kept).
- Shared label helper extraction across the four near-identical menus (left local to match file structure).

## Verify

```text
npm run typecheck
npx vitest run test/unit/menu-claude-accounts.test.ts test/unit/menu-list-nav.test.ts --reporter=dot
npm run lint
npm run knip
```
