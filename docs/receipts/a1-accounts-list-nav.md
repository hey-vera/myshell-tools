# Receipt — A1: Accounts list navigation + hub glance

**Branch:** `product/a1-accounts-list-nav`  
**Base:** `origin/main`  
**Scope:** Arrow/Enter/digit list selection on per-provider account menus; accounts hub glance; shared pure helpers.

## Change

### Key classification (`src/interface/menu-key-confirm.ts`)
- `classifyMenuKey` now returns `NAV_UP` (`\x1b[A`) / `NAV_DOWN` (`\x1b[B`) instead of collapsing them to `''`.
- Enter stays `''` so root menu and non-list screens keep re-render / existing Enter semantics.
- `readMenuKey` echoes **only** single printable chars (never arrow/ESC sentinels).
- Pure helpers: `moveListHighlight`, `listIndexFromDigit`, `interpretListKey` (highlight / activate / create-empty / other).

### Per-provider account lists
- `menu-claude-accounts.ts`, `menu-codex-accounts.ts`, `menu-grok-accounts.ts`, `menu-opencode-accounts.ts`
- Highlight row with `▸` + bold; ↑/↓ move selection; Enter opens edit (or create when empty); digits 1–9 jump+open.
- Letter shortcuts preserved: `[c]` create, `[e]` edit (number prompt when multi), `[b]`/← back, ESC exit.

### Accounts hub (`menu.ts` `[a]`)
- Glance: total active; providers needing attention called out when `needsAttention`.
- Per provider: `no accounts` | `N active[, M disabled] · plans` | `needs attention (total, disabled)`.

## Tests
- `test/unit/menu-list-nav.test.ts` — classification, clamp, digits, interpretListKey matrix.

## Non-goals
- Mouse (A2), label rename (A2), Effort/Speed dials.

## Verify

```text
npm run typecheck
npx vitest run test/unit/menu-list-nav.test.ts test/unit/menu-claude-accounts.test.ts --reporter=dot
npm run lint
npm run knip
```
