# R0 receipt: fake Grok adapter harness

## Behavior and call path

The built Grok adapter can now be tested against a deterministic local child process
without provider credentials, network access, or quota. The test imports
`dist/providers/grok.js`, creates the production adapter with its supported binary
override, and exercises `Provider.run` through `runGrokRaw`, `spawnGuarded`, the
subprocess streams, the streaming-json parser (`createGrokParser`), and terminal events.

The fake executable accepts the argv shape the real adapter builds
(`--output-format streaming-json -m … --prompt-file <path> …`) and selects behavior only
via `MYSHELL_FAKE_SCENARIO`. It does not read credentials, access a network, or leak
prompt-file contents. Covered scenarios are thought + text + end/done with versioned
token `hello v1`, stderr with nonzero exit → one typed auth error never done, and
cancel/timeout hang with optional `MYSHELL_FAKE_SENTINEL` PID file proving child
termination and no post-cancel/timeout done event.

## Limits and safety

This is Grok streaming-json adapter composition only. It does not prove full menu
routing, auth probing, catalog drift, other provider protocols, live accounts, or
packed-tarball installation. The harness uses `process.execPath` plus the fixture path
as an argument array (`binArgs`), avoiding Windows command-wrapper process trees and
shell interpolation. Rollback is a simple adapter + test-fixture revert; there is no
runtime migration or compatibility change.

The adapter exposes an optional `binArgs` prefix solely for controlled executable
launches; its default remains the existing `grok` binary with no prefix. Production
spawns stay byte-identical when `binArgs` is omitted.

## Verification

Run `npm run build`, then `npx vitest run test/integration/fake-grok-adapter.test.ts`,
`npm run test:integration`, `npx tsc --noEmit`, `npm run lint`, `npm run knip`, and
`git diff --check`. Record actual durations and gate outcome before merge.
