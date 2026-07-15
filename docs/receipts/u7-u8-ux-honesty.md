# Receipt: U7 + U8 UX honesty polish

**Branch:** `agent/u7-u8-ux-honesty`  
**Date:** 2026-07-15  
**Base:** `origin/main` @ `003c836` (3.173.0)

## Intent

Bounded honesty check only:

1. **U7** — Accounts list row status from real `enabled` + detect/subscription `status` (not hardcoded ok/active).
2. **U8** — Home Recent work chips honest after process restart (live worker registry = 0; durable goals/jobs still show).

No redesign, mouse work, version bump, or hub IA changes.

## U7 findings

| Surface | Verdict | Evidence |
| --- | --- | --- |
| Claude / Codex / Grok list rows | Already honest | Mapped `enabled` + `acc.status` → `disabled` / `expired` / `auth-failed` / `active` / `unknown` |
| **OpenCode list rows** | **Bug** | `acc.enabled ? 'active' : 'disabled'` ignored subscription `status` (auth-failed/expired/unknown painted as active) |
| Plan column | N/A on list rows | Plan stays on edit detail + hub `planLabels` from real `account.plan` |
| Cooldown label on list | Not in `AccountStatus` | No list-row cooling chip; cooldowns live in routing/capacity, not this column |

### Fix (U7)

- Shared pure `formatAccountListStatus` in `src/interface/accounts-priority-help.ts`
- All four provider account menus use it for the list status column
- OpenCode now matches Claude/Codex/Grok (no enabled→active hardcode)

### Residual (out of this slice; hub is `menu.ts`)

Accounts **hub** line uses `disabled = total - active` where `active = enabled && status === 'active'`. An enabled `auth-failed` seat can be summarized as “disabled”. List rows now show the real status; hub summary soft-mislabel is deferred (not allowed path for this polish).

## U8 findings

| Case | Chip | Honest? |
| --- | --- | --- |
| liveWorkers > 0 | `N working` | Yes — in-process only |
| liveWorkers = 0, runningGoals > 0 | `N running` | Yes — durable store after restart |
| parkedGoals > 0 | `N parked` | Yes |
| activeJobs > 0 | `job alive` / `N jobs` | Yes — durable jobs |
| all zeros | `''` | Yes — no fabrication |

`formatConversationWorkStatus` already never paints `working` without live workers. After restart, durable running/parked/jobs remain. **No code change** for U8; regression test added.

## Files

- `src/interface/accounts-priority-help.ts` — `formatAccountListStatus`
- `src/interface/menu-{claude,codex,grok,opencode}-accounts.ts` — shared list status
- `test/unit/accounts-priority-help.test.ts` — U7 cases
- `test/unit/menu-render.test.ts` — U8 reopen case
- `docs/receipts/u7-u8-ux-honesty.md` — this receipt

## Verify (command evidence)

```text
npm run typecheck
# exit 0

npx vitest run test/unit/accounts-priority-help.test.ts test/unit/menu-render.test.ts --reporter=dot
# Test Files  2 passed (2)
# Tests  50 passed (50)
```

## Non-goals

- New features / redesign / mouse / publish
- Hub summary reword in `menu.ts`
- OpenCode create-time detect to set `status: 'active'` (status may remain `unknown` until a future probe path writes it — honest unknown > fake active)
