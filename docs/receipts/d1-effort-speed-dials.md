# Receipt — D1 Effort + Speed dials (honest mapping)

**Date:** 2026-07-15  
**Branch:** `product/d1-effort-speed-dials`  
**Base:** `origin/main`  
**Scope:** User-facing **Effort** + **Speed** labels over existing `mode` / `intensity` storage. No merge of `feature/two-dial-orchestration-profile`. No topology/fan-out fantasy.

## Product truth

| Dial (UI) | Storage | What it does | What it is not |
|-----------|---------|--------------|----------------|
| **Effort** | `config.mode` / conversation `mode` | Budget…Auto — model lane + verification (`m`, Shift+Tab, `/mode`, Settings [1], Control Panel) | Not Claude/Grok provider-native `--effort` by default |
| **Speed** | `config.intensity` / conversation `intensity` | Auto / 1–5 multi-goal concurrency ceiling (`crossGoalCap` via capacity-allocator); Settings [2], `/speed`, Control Panel | Not topology, worker fan-out, or early termination |

Claude/Grok native `--effort` remains experimental and OFF by default (`MYSHELL_PROVIDER_EFFORT=1` / `experimentalProviderEffort`).

## Changes

1. **Home / New Conversation box** — header shows `Effort:` + `Speed:` (with multi-goal concurrency honesty note); footer `m = Effort · Settings = Speed`.
2. **Settings** — [1] Effort, [2] Speed (`runSpeedSelect`), then Oversight…Setup renumbered 3–7.
3. **Chat** — Shift+Tab still cycles conversation Effort; `/speed` sets conversation `intensity` via `setIntensity`; `/help` documents Effort + Speed honestly; composer chrome `Effort:` + hints include `/speed`.
4. **Control Panel** — Effort + Speed segmented rows; `UiSettingsSnapshot.intensity` synced from config.
5. **mode-levels** — `speedLabel` / `ALL_SPEEDS` / `nextSpeed` + LEVEL_DESC honesty comments (D1 product labels).
6. **Completion** — `/speed` slash + Effort level args for `/mode`.
7. **Tests** — menu-render, menu-flow settings keys, control-panel, mode-levels Speed, input-box chrome.

## Files touched

- `src/core/mode-levels.ts`
- `src/interface/menu-render.ts`
- `src/interface/menu-settings.ts`
- `src/interface/menu.ts`
- `src/interface/menu-new-conversation.ts`
- `src/interface/menu-completion.ts`
- `src/interface/ui/control-panel-model.ts`
- `src/interface/ui/state.ts`
- `src/interface/ui/App.tsx`
- `src/interface/ui/InputBox.tsx`
- `test/unit/menu-render.test.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/mode-levels.test.ts`
- `test/unit/control-panel-model.test.ts`
- `test/unit/control-panel-reduce.test.ts`
- `test/unit/capacity-allocator.test.ts`
- `test/ui/input-box.test.tsx`
- `docs/receipts/d1-effort-speed-dials.md`

## Verify (command evidence)

```text
npm run typecheck
# tsc --noEmit → exit 0

npm run lint
# 0 errors, 3 pre-existing warnings in test/integration/p0-pty-benchmark.test.ts

npm run knip
# exit 0

npx vitest run test/ui/input-box.test.tsx test/unit/menu-flow.test.ts \
  test/unit/menu-render.test.ts test/unit/mode-levels.test.ts \
  test/unit/control-panel-model.test.ts test/unit/capacity-allocator.test.ts --reporter=dot
# Test Files  6 passed (6)
# Tests  609 passed | 1 skipped (610)
```

## Commit message

`feat(ui): D1 Effort + Speed dials (mode/intensity storage)`
