# Receipt — R8.1 honest dial claims

**Date:** 2026-07-14  
**Branch:** `actualize/r8-dial-honesty`  
**Base:** `origin/main`  
**Scope:** Narrow product claims to shipped Mode + Intensity. No new orchestration-profile architecture. No Effort/Speed two-dial fantasy on main.

## Product truth (narrowed)

| Dial | What it is | What it is not |
|------|------------|----------------|
| **Mode** | Budget / Balanced / High / Max / Auto — model lane + verification posture (`config.mode` / conversation mode; `m`, Shift+Tab, `/mode`, Settings) | Not provider-native Claude/Grok `--effort` by default; not a Speed dial |
| **Intensity** | 1–5 concurrency regime (`config.intensity` / conversation intensity; else derived from Mode via `legacyModeToIntensity`) | Not topology/worker fan-out; not a separate "Speed" control-panel row on main |
| **Claude/Grok native effort** | Experimental; **OFF by default** (`MYSHELL_PROVIDER_EFFORT=1` or `experimentalProviderEffort: true`) | Not implied by Mode labels |

Unshipped on main: Effort/Speed two-dial orchestration profile (`feature/two-dial-orchestration-profile` remains historical).

## Changes

1. **User-facing copy**
   - Home/New Conversation box header: `Mode:` (was `Effort Mode:`)
   - `LEVEL_DESC` describes lane + verification only (no always-on "reasoning effort" claim)
   - Settings Mode picker + Settings row [1] wording
   - Chat `/help`: `/mode` documents Mode; new **Dials (honest product truth)** block for Mode + Intensity + experimental native effort

2. **Production proof test** (`test/unit/capacity-allocator.test.ts`)
   - Intensity 1–2 → `concurrencyCeilingForRegime` = 1 → `crossGoalCap` = 1 (even with other headroom)
   - Intensity 3–5 → ceiling 2 → `crossGoalCap` = 2 when other ceilings allow
   - Raising intensity 1→3 raises `crossGoalCap` when only tuning differs (same composition path as `menu.ts` multi-goal scheduling)
   - Mode→Intensity bridge still projects concurrency ceilings (not a Speed dial)

3. **Receipt** — this file

## Files touched

- `src/core/mode-levels.ts`
- `src/interface/menu-render.ts`
- `src/interface/menu-settings.ts`
- `src/interface/menu.ts`
- `test/unit/capacity-allocator.test.ts`
- `test/unit/menu-render.test.ts`
- `test/unit/menu-flow.test.ts`
- `docs/receipts/r8-dial-honesty.md`

## Verify (command evidence)

```text
npm run typecheck
# tsc --noEmit → exit 0

npm run lint
# 0 errors, 3 pre-existing warnings in test/integration/p0-pty-benchmark.test.ts

npm run knip
# exit 0

npx vitest run test/unit/capacity-allocator.test.ts test/unit/menu-render.test.ts \
  test/unit/mode-levels.test.ts test/unit/menu-flow.test.ts --reporter=dot
# Test Files  4 passed (4)
# Tests  489 passed | 1 skipped (490)
```

## Commit message

`docs(ui): R8.1 honest Mode + Intensity dial claims`
