# menu-s11b-provider-label

## Files changed
- `src/infra/conversation-store.ts`
- `src/infra/conversations.ts`
- `src/interface/menu.ts`
- `src/interface/menu-render.ts`
- `test/unit/conversations.test.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/menu-render.test.ts`
- `docs/receipts/menu-s11b-provider-label.md`

## What changed
- Added `ConversationMeta.lastProvider?: ProviderId` plus `ConversationStore.setLastProvider(...)`.
- Persisted `lastProvider` in the file-backed store and preserved it across unrelated index mutations.
- Captured the real completed-turn provider in `runChatLoop` from the accepted assistant append path and persisted it on successful turn completion, including the one-shot auth-retry success path.
- Rendered `lastProvider · effort` in Recent rows and `provider · title · age` in `[c] Continue last` when real provider data exists; legacy rows stay effort-only.
- Added store, render, and chat-loop coverage for the new field.

## Judgment call: what counts as "this turn's provider"
- `lastProvider` is taken from the assistant `SessionEntry.provider` on the accepted assistant append, not from a failing `final.provider`, not from a merely attempted provider, and not from generic receipt/ledger rows.
- Reason: the accepted assistant append is the exact provider whose output became part of the persisted conversation history for that settled turn.
- This correctly handles partial-failure-then-success retry/failover cases:
  - providers that failed or were rate-limited but did not produce the kept conversation turn are not recorded;
  - the provider from the successful retry/failover that actually appended the accepted assistant message is recorded.

## Verification

### `npm run typecheck`
Command:
```powershell
npm run typecheck
```
Tail:
```text
> myshell-tools@3.162.0 typecheck
> tsc --noEmit
```
Result: pass

### `npm run lint`
Command:
```powershell
npm run lint
```
Tail:
```text
> myshell-tools@3.162.0 lint
> eslint src test

C:\Users\Josh\Desktop\Github\Repositories\myshell-tools-slice11\test\integration\p0-pty-benchmark.test.ts
  163:3  warning  Unexpected console statement  no-console
  165:3  warning  Unexpected console statement  no-console
  296:5  warning  Unexpected console statement  no-console

✖ 3 problems (0 errors, 3 warnings)
```
Result: pass (`0` errors; the existing `p0-pty-benchmark` warnings are the known-fine baseline)

### `npm test -- --run test/unit test/arch`
Command attempted exactly as requested:
```powershell
npm test -- --run test/unit test/arch
```
Tail:
```text
failed to load config from C:\Users\Josh\Desktop\Github\Repositories\myshell-tools-slice11\vitest.config.ts
Startup Error
Error: Build failed with 1 error:
[plugin externalize-deps]
Error: spawn EPERM
```
Result: blocked by the sandbox during Vite/Vitest config loading before any tests executed.

### Harness-safe targeted verification for this slice
To verify the actual changed surface inside the sandbox, I used a temporary local Node preload shim to neutralize Vite's Windows `net use` probe, then ran only the affected tests in single-thread thread-pool mode:
```powershell
$env:NODE_OPTIONS='--require ./.tmp-vitest-net-use-shim.cjs'; npx vitest run --pool threads --maxWorkers 1 --no-file-parallelism test/unit/conversations.test.ts test/unit/menu-render.test.ts test/unit/menu-flow.test.ts --testNamePattern "setLastProvider|provider label|lastProvider persistence"
```
Tail:
```text
Test Files  3 passed (3)
     Tests  5 passed | 465 skipped (470)
  Duration  3.65s
```
Result: pass

Notes:
- The temporary shim file was removed after verification; it is not part of the worktree.
- A broader thread-pool fallback run showed many unrelated baseline sandbox failures (`spawn EPERM`, temp-state-dir `EPERM`, git/process spawn failures) outside this slice.

## Forbidden-file check
`git diff --name-only` after the code changes showed:
```text
src/infra/conversation-store.ts
src/infra/conversations.ts
src/interface/menu-render.ts
src/interface/menu.ts
test/unit/conversations.test.ts
test/unit/menu-flow.test.ts
test/unit/menu-render.test.ts
```

That stays within the allowed code/test files. The only additional file created for this task is this requested receipt:
- `docs/receipts/menu-s11b-provider-label.md`
