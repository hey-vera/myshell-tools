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
