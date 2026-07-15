# Receipt — Esc ghost dismiss: line-scoped suppress + test harden

**Branch:** `fix/esc-ghost-dismiss-flake`  
**Base:** `origin/main`  
**Symptom:** Intermittent CI fail on macOS Node 20:  
`test/ui/input-box.test.tsx > Esc dismisses ghost without changing the buffer`  
(`AssertionError: Esc must dismiss ghost — frame still had "release notes"`).

## Root cause

1. **Paint race:** After Esc `setGhost(null)`, a single 50ms `tick()` could read a stale Ink frame on slow CI.
2. **Re-propose:** Esc nulls ghost without changing `value`. A later ghost-effect run (dep identity churn / late timer) could `setGhost` the same history match again.

## Fix

- `src/interface/ui/InputBox.tsx`
  - `ghostSuppressedForLineRef` set to current line on Esc (ghost and suggestions dismiss paths).
  - Cleared on `replace` / `submit`.
  - Ghost debounce timer + async model/completeChat paths: if `valueRef === suppressed`, force `setGhost(null)` and do not re-propose.
- `test/ui/input-box.test.tsx`
  - Poll up to ~8×50ms after Esc until ghost suffix leaves the frame (product suppress is the real fix; poll absorbs one slow paint).

## Verify

```text
npx vitest run test/ui/input-box.test.tsx
npm run typecheck
```

## Out of scope

- Version bump / publish
- Model-ghost product changes beyond suppress gating
