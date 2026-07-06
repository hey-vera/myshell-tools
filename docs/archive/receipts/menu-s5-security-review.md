# BLOCKING ISSUES FOUND

## Finding 1 - fallback `runChatLoop` shell commands can run without required audit records

- Severity: High
- File: `src/interface/menu.ts:1814`
- Scenario: a caller invokes exported `runChatLoop()` without going through `startMenu()` and does not provide `ctx.commandGate`. The user enters `!touch audit-bypass.txt` or enters `!rm -rf build` and accepts the confirmation prompt. The inline fallback gate is wired to real policy via `gate: gateCommand`, but it does not provide `record`. For local-write/destructive commands, `gateCommand()` returns `mustRecord: true`; `runShellPassthrough()` still reaches `runner.run()` at `src/interface/shell-passthrough.ts:80`, then `recordGate()` returns early at `src/interface/shell-passthrough.ts:102` because `commandGate.record` is undefined.
- Impact: state-changing or destructive shell passthrough commands can execute without the audit record that the command policy explicitly requires on the non-`startMenu` fallback path.

## Finding 2 - high-risk `forbidBackground` policy is not enforced for shell background syntax

- Severity: High
- File: `src/interface/shell-passthrough.ts:72`
- Scenario: in the production `startMenu()` path, the user enters `!rm -rf build &` on POSIX and accepts the confirmation prompt. `gateCommand()` classifies the command as `destructive-filesystem` and returns `forbidBackground: true`, but `runShellPassthrough()` does not pass `requestedBackground` to the gate or block on `forbidBackground`. It then calls `runner.run()` at `src/interface/shell-passthrough.ts:80`; the production runner passes the raw command to `execaCommand(..., { shell: true })` at `src/interface/shell-passthrough.ts:27`, so the shell backgrounds the destructive command while the wrapper shell can exit.
- Impact: high-risk commands that policy says must run in the foreground can be detached from the app's foreground execution/streaming lifecycle.

Non-findings verified: the normal `!` path calls `commandGate.gate()` before the shell runner; `allowed: false` and declined confirmation both prevent execution; bare `!` returns usage before gate/runner; raw `shell: true` execution is otherwise consistent with the deliberate "run exactly what the user typed" design.
