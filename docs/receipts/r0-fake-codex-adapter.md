# R0 receipt: fake Codex adapter harness

## Behavior and call path

The built Codex adapter can now be tested against a deterministic local child process
without provider credentials, network access, or quota. The test imports
`dist/providers/codex.js`, creates the production adapter with its supported binary
override, and exercises `Provider.run` through `runCodexRaw`, `spawnGuarded`, the
subprocess streams, the JSONL parser, and terminal events.

The fake executable accepts only the synthetic `MYSHELL_FAKE_SCENARIO` selector. It
does not read credentials or access a network. Covered scenarios are JSONL thread/session
start, partial text, tool completion, final done, stderr with nonzero exit, and abort
with a sentinel proving child termination and no post-cancel done event.

## Limits and safety

This is Codex JSONL adapter composition only. It does not prove full menu routing,
auth probing, catalog drift, other provider protocols, live accounts, or packed-tarball
installation. The temporary wrapper uses Node argument forwarding; no prompt or test
data is interpolated into a shell command. Rollback is a simple test-fixture revert;
there is no runtime migration or compatibility change.

The adapter exposes an optional `binArgs` prefix solely for controlled executable
launches; its default remains the existing `codex` binary with no prefix. The harness
uses `process.execPath` plus the fixture path as an argument array, avoiding Windows
command-wrapper process trees and shell interpolation.

Windows cancellation is repaired in `spawnGuarded`: ordinary AbortSignal cancellation
uses the same latched tree-kill path as the hang cap, and `taskkill /PID <pid> /T /F`
is invoked with an argument array, hidden window, and no shell. The captured immediate
subprocess PID limits exposure, but Windows PID reuse remains a residual platform risk;
the test proves the ready fake child is gone before completion is accepted.

## Verification

Run `npm run build`, then `npx vitest run test/integration/fake-codex-adapter.test.ts`,
`npm run test:integration`, `npm run quality`, and `git diff --check`. Record actual
durations and gate outcome before merge.
