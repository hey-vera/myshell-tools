# macOS Node 20 settings-key CI stabilization

Date: 2026-07-19

Scope: deterministic UI-test synchronization only. Production source, package behavior, configuration, migrations, credentials, provider accounts, and support claims are unchanged.

## User-visible behavior and production path

The protected behavior is that a user can open Settings and select Output detail with one key per screen, without pressing Enter:

`startMenu` → `runSettings` → `readMenuKey` → `InkAppBridge.readKey` → `InputBox.onReadKey` → `runVerbositySelect` → `saveConfig`.

The existing production-path Ink test drives that composition through `ink-testing-library` stdin and verifies that `[4]` followed by `[1]` persists `verbosity: quiet`.

## Failure and root cause

- Main CI run: <https://github.com/hey-vera/myshell-tools/actions/runs/29460204110>
- First attempt: only macOS / Node 20 failed. `test/ui/menu-submenu-single-key.test.tsx` timed out after 30.021 seconds in `runSettings: a single [4] keypress (no Enter) opens Output-detail under Ink`. The other 272 UI tests and the other displayed OS/Node lanes passed.
- Isolated rerun: every step passed, confirming that production behavior was not deterministically regressed.
- Root cause: the test wrote each key after an arbitrary 50 ms sleep. `runSettings` performs asynchronous setup before its first key read, and the Output-detail transition must arm a second one-shot resolver. On a slower or contended runner, a key could arrive before `InkAppBridge._keyResolver` was armed; pre-arming input is intentionally not delivered to a submenu read, so the test waited until the global timeout.

## Change

The UI harness now waits for the real Ink bridge resolver before injecting each submenu key. The wait is bounded at two seconds and fails with a focused diagnostic if the production path never arms a read. The same helper replaces fixed sleeps in the neighboring Enter and Manage single-key cases. No `src/` file changed.

## Verification

- Baseline focused test on local Node 24 before the change: `npm exec vitest -- run test/ui/menu-submenu-single-key.test.tsx -t "opens Output-detail" --reporter=verbose` → 1 passed in 273 ms.
- Focused stress after the change: the same production-path test executed 10 times → 10/10 passed; individual test times were 117–147 ms.
- Affected suite: `npm run test:ui` → 18 files passed; 272 tests passed, 1 skipped.
- `npm run typecheck` → passed.
- `npm run lint` → passed with 3 pre-existing `no-console` warnings in `test/integration/p0-pty-benchmark.test.ts` and no errors.
- `npm run build` → passed.
- `git diff --check` → passed.
- Full local `npm run quality` was not repeated because the main rerun already passed every required cross-platform step and this patch changes only UI-test synchronization; focused, affected, static, and build coverage were run locally.

## Failure, rollback, security, and compatibility semantics

- Failure: a bridge that does not arm now fails locally within two seconds with `Ink key reader did not arm before the test deadline`, rather than hanging for the 30-second suite timeout.
- Rollback: revert this test-and-receipt commit; runtime behavior is unaffected either way.
- Security and migration: no runtime state, credential, environment, persistence, or migration path changed.
- Compatibility: no production API, CLI, Node engine, OS behavior, package contents, or support claim changed.
