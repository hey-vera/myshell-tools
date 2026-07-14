# R0 receipt: required CI runs UI tests

## Gap closed

`npm run quality` already includes `npm run test:ui` (after unit/arch tests,
before contract). The GitHub Actions `test` matrix job in
`.github/workflows/ci.yml` ran typecheck, lint, knip, unit/arch, contract,
build, and integration — but not UI tests. R0 Done requires every deterministic
lane, including UI, to pass in CI with no unexplained handle.

## Change

- Branch: `actualize/r0-ci-ui-tests`
- Files: `.github/workflows/ci.yml`, this receipt only
- No `package.json` version, `src/`, or `test/` content changes

Added a matrix step **UI tests** (`npm run test:ui`) immediately after **Unit
and architecture tests** and before **Contract tests**, matching the relative
order in `quality` (`test` → `test:ui` → `test:contract`) without reordering
the existing CI build placement (build remains after contract).

## Verification

- Workflow YAML contains `npm run test:ui`
- `git diff --check` clean
- UI suite is `vitest run test/ui` (source-import path; no dist build required
  before this step)

## Semantics

Additive CI alignment only. Local `quality` behavior unchanged. Roll back by
reverting this slice. Does not prove coverage job inclusion of UI tests or
live/native-session lanes.

## Follow-up: suspend-resume raw-mode assertion

POSIX CI failed the win32-skipped test that expected `resume()` not to call
`setRawMode`. Production `createInkLineReader.resume()` intentionally eager
re-arms with `control.setRawMode(true)` (resume lag / first keystroke). The
test in `test/ui/suspend-resume.test.tsx` now expects `['raw:true']` to match
that behavior; production eager re-arm was left in place.

## Follow-up: Win+Node20 model-ghost flake

CI matrix failed only on **Windows + Node 20**:

`local history ghost wins over model even when modelGhost enabled` —
`modelCalls === 1` expected `0`.

**Root cause (test race, not local-wins bug):** with `modelGhostEnabled` +
`suggestGhost`, the ghost `useEffect` runs on mount for the empty line.
`shouldOfferModelGhost` allows empty prompts, so `setTimeout(0)` can invoke
the port before `stdin.write` cancels that timer. On slower Win+Node20 CI that
empty-prompt call lands and inflates `modelCalls`; faster lanes cancel first.

**Hardening** (`test/ui/input-box.test.tsx` only; production unchanged):

- After `render`, `await tick()` + `await ghostTick()` so mount + empty-prompt
  ghost drain complete, then `modelCalls = 0` before typing.
- Prefer frame behavior: local suffix `migration` shows; model text never in
  frame; then `modelCalls === 0` for the typed local-hit path.

### Verification

```
npx vitest run test/ui/input-box.test.tsx -t "ghost"
# 9 passed | 58 skipped

npm run test:ui
# 18 files, 272 passed | 1 skipped
```
