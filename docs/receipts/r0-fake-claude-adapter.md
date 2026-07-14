# R0 receipt: fake Claude adapter harness

## Behavior and call path

The built Claude adapter can now be tested against a deterministic local child process
without provider credentials, network access, or quota. The test imports
`dist/providers/claude.js`, creates the production adapter with its supported binary
override, and exercises `Provider.run` through `runClaudeRaw`, `spawnGuarded`, the
subprocess streams (prompt on stdin), the stream-json parser (`parseClaudeLine`), and
terminal events.

The fake executable accepts only the synthetic `MYSHELL_FAKE_SCENARIO` selector (plus
optional `MYSHELL_FAKE_SENTINEL` for hang/cancel PID proof). It does not read credentials
or access a network. Covered scenarios:

| Scenario | Behavior |
| --- | --- |
| default / `happy` | stream-json: `text_delta` (`pong v1`), assistant `tool_use` (Read), `result/success` → usage + done |
| `error` | stderr with auth-like text + nonzero exit → one typed `auth` error, never `done` |
| `timeout` | hang forever after writing sentinel PID; adapter `timeoutMs` → one typed `timeout` error; child dead |
| `cancel` | hang forever after sentinel; AbortSignal → error, no `done`; child dead |

## Adapter change

Optional `binArgs?: readonly string[]` on `createClaudeProvider`, threaded into
`runClaudeRaw` as `spawnGuarded(bin, [...binArgs, ...args], …)` — same pattern as Codex
and OpenCode. Default is `[]`, so production (`bin: 'claude'`, no prefix) remains
byte-identical.

## Limits and safety

This is Claude stream-json adapter composition only. It does **not** prove:

- full menu routing or chat orchestration
- live Claude auth probing (`claude auth status`)
- catalog drift / model inventory
- other provider protocols (Grok harness is a later slice)
- packed-tarball installation
- real partial-message timing under load
- session resume (`--resume` / `--session-id`) end-to-end against a real CLI

The harness uses `process.execPath` plus the fixture path as an argument array, avoiding
Windows command-wrapper process trees and shell interpolation. No prompt is interpolated
into a shell command. Rollback is a simple fixture/adapter-opts revert; no migration.

Windows cancellation relies on the existing `spawnGuarded` tree-kill path (same as Codex).
Windows PID reuse remains a residual platform risk; the test proves the ready fake child
is gone before completion is accepted.

## Verification

```
npm run build
npx vitest run test/integration/fake-claude-adapter.test.ts
npm run test:integration
npx tsc --noEmit
npm run lint
npm run knip
git diff --check
```

Record actual durations and gate outcome before merge.
