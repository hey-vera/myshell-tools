# R0 receipt: deterministic quality command

## Behavior and release path

`npm run quality` is the local deterministic release gate. It runs typecheck,
lint, knip, build, unit/architecture tests, UI tests, parser contract tests, and
deterministic integration tests in dependency-safe order. The publication hook is
`npm publish` -> `prepublishOnly` -> `clean` -> `quality` -> built artifact.

The production-path guard is `test/arch/release-quality-command.test.ts`. It reads
the package scripts and requires the exact quality sequence plus prepublish
delegation after clean; changing either release behavior fails the architecture test.

## Baseline and scope

- Branch: `actualize/r0-quality-command`
- Baseline: `6db939b537c9e890c99a906d5fe5c00baef42899`
- Changed only: `package.json`, this receipt, and the new architecture test.
- No source, provider, credential, account, lockfile, CI workflow, or existing test
  behavior changed.

## Semantics

This is an additive command migration. Existing individual scripts remain valid;
automation can migrate to `npm run quality` immediately. Roll back by reverting this
slice, restoring the former prepublish sequence. The gate does not enable live provider
tests: native-session integration remains skipped unless
`MYSHELL_NATIVE_SESSION_E2E=1` is deliberately supplied. It does not prove the later
fake-provider harness, Node 20 CI, or packed-tarball journey.

## Command evidence

Commands to run from the repository root are `npx vitest run
test/arch/release-quality-command.test.ts`, `npm run quality`, `npm run
prepublishOnly`, and `git diff --check`.

Initial focused-test attempt before the package change was blocked by the local sandbox:
Vite failed while loading `vitest.config.ts` with `Error: spawn EPERM`; duration was
1.928 seconds. This is an environment process-spawn restriction, not an asserted test
failure. Re-run all commands in a normal Windows CI/local environment before merge.


After wiring, the focused architecture test repeated the same Vite startup failure in
1.813 seconds. `npm run quality` completed typecheck, lint (three existing warnings),
knip, and build, then failed at `npm test` under the same sandbox restriction after
31.582 seconds. `npm run prepublishOnly` reached clean, typecheck, lint, knip, build,
and `npm test` before the outer 70.736-second command limit interrupted it; it is not
green evidence. `git diff --check` passed. A Node static release-path assertion passed
for the exact `quality` and `prepublishOnly` script strings.

## Final local gate evidence

With the required unsandboxed child-process permission, `npx vitest run
test/arch/release-quality-command.test.ts` passed: one file and one test in 381 ms.
`npm run quality` exited 0 in 247.8 seconds: 9,077 unit/architecture tests passed
(14 skipped), 272 UI tests passed (one skipped), 76 contract tests passed, and nine
deterministic integration tests passed (six opt-in/live tests skipped). `npm run
prepublishOnly` exited 0 in 254.6 seconds through clean then quality. Lint emitted
three pre-existing no-console warnings in the PTY benchmark test but no errors.
`git diff --check` passed.
