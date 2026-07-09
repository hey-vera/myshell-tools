# Receipt — PR5 Thinking state machine

**Branch:** `actualize/pr5-thinking-state-machine`  
**Base:** `origin/main` (includes #118–#120)  
**Scope:** P0.12 — honest turn phases; stop eternal optimistic "Thinking" on submit.

## Change

Honest workLabel phase machine:

| Phase | When | Label |
|-------|------|-------|
| Preflight | `turn/start` / optimistic `beginTurn` | **Preparing** |
| Model composing | `tier-start` (non-verbose) | **Thinking** |
| Answer tokens | first `stream/prose` (phase verbs only) | **Responding** |
| Verbose | `tier-start` verbose | tier `(provider/model)` (preserved across prose) |

### Files

- `src/interface/ui/state.ts` — `initialStreamView.workLabel = 'Preparing'`
- `src/interface/ui/reduce.ts` — turn/start comments; `stream/prose` → Responding
- `src/interface/render.ts` — default spinner label Preparing until tier-start
- `src/interface/ui/StatusBlock.tsx` — comment alignment
- `src/interface/menu.ts` — comments; `inkResetTurn` wired on model-turn failure after begin; local divert paths (repo-chat / slash) still run **before** begin so optimistic state is never stuck
- Tests: app, mount, status-block, render, ui-reduce (phase machine coverage)

## Out of scope

- Moving beginTurn earlier into dep-building (still after enrich; Preparing covers post-begin → first model event)
- Goal board / recap work (P0.13+)

## Verify

```text
npm run typecheck
# tsc --noEmit → exit 0

npm run knip
# knip → exit 0

npx vitest run test/unit/ui-reduce.test.ts test/unit/render.test.ts \
  test/unit/run-stream-parity.test.ts test/ui --reporter=dot
# Test Files  20 passed (20)
# Tests  462 passed | 1 skipped (463)
```

## Commit message

`fix(ui): honest turn phases — Preparing then Thinking`
