# Receipt — Accounts as Auto truth (P1.2)

**Date:** 2026-07-09  
**Branch:** `actualize/pr-accounts-auto-truth`  
**Base:** `origin/main`  
**Checklist:** Wave P1.2 / PR 8 (`docs/actualization-checklist-10of10-2026-07-09.md`)

## Product rule

Auto defaults and posture marketing come from the **myshell Accounts inventory** (`subscriptions.json`), not ambient host CLI detect. Empty Accounts → honest **balanced** Auto (no “Pro observed” theater for CLIs the user never added to myshell-tools). Ambient detect remains for install/doctor.

## What shipped

1. **`menu-auto-mode.ts`** — Accounts-first helpers:
   - `usableAccountsForAuto` / `planInfosFromAccounts` / `accountPlanStrings`
   - `resolveAutoModeFromAccounts` — sole product Auto posture source
   - `resolveAutoModeFromEnvironment` — ambient only (doctor/internal)
   - `resolveAutoMode(env, accounts?)` — when accounts provided (incl. empty), inventory is sole truth; when omitted → **balanced** (never ambient Max/Pro theater)
   - `planBudgetCeiling` / `autoModeReason` accept Accounts; reason strings never market ambient plans
2. **Call sites wired to load + pass Accounts:**
   - `menu.ts` (chat Auto ceiling, `/mode`, `/style`, home `[m]`, Max-subtier tune)
   - `menu-settings.ts`, `menu-new-conversation.ts`, `auto-stage.ts`
   - `cli.ts` (`run` / eval / `repl` mode resolution + Max 5x tune)
3. **Mode picker** still omits the Auto-detected block (P0.3); comments updated to name Accounts as truth.
4. **Tests:** `menu-auto-mode.test.ts` P1.2 suite; `auto-smart-canary.test.ts` updated for Accounts inventory.

## Commands run

```
npx tsc --noEmit                          # green
npm run knip                              # green
npx vitest run test/unit/menu-auto-mode.test.ts \
  test/unit/auto-smart-canary.test.ts \
  test/unit/auto-mode.test.ts             # 100/100 pass
npx vitest run test/unit/menu-flow.test.ts -t "Auto detected|Effort Mode|mode list|accounts"
                                          # 5 pass / 373 skip
```

## Acceptance

- [x] 0 accounts → no fake Pro/Max marketing on Auto posture (`resolveAutoMode(env, [])` / omitted → balanced)
- [x] Accounts Max → quality-first + governor ceiling 3
- [x] Accounts free-only → cost-saver + ceiling 1
- [x] Disabled/expired/auth-failed accounts do not raise posture
- [x] Ambient detect helpers retained (`resolveAutoModeFromEnvironment`) for internal use
- [x] typecheck + knip green; unit tests for auto-mode / accounts green

## Files touched

- `src/interface/menu-auto-mode.ts`
- `src/interface/menu.ts`
- `src/interface/menu-settings.ts`
- `src/interface/menu-new-conversation.ts`
- `src/interface/auto-stage.ts`
- `src/cli.ts`
- `test/unit/menu-auto-mode.test.ts`
- `test/unit/auto-smart-canary.test.ts`
- `docs/actualization-checklist-10of10-2026-07-09.md`
- `docs/receipts/pr-accounts-auto-truth.md`
