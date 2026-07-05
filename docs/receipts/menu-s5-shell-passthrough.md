# Slice 5 Receipt — `!` Shell Passthrough In Conversations

## Files changed

- `src/interface/menu.ts`
- `src/interface/shell-passthrough.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/shell-passthrough.test.ts`
- `docs/receipts/menu-s5-shell-passthrough.md`

## Verification commands run

### `npm run typecheck`

```text
> myshell-tools@3.162.0 typecheck
> tsc --noEmit
```

### `npm run lint`

```text
> myshell-tools@3.162.0 lint
> eslint src test

C:\Users\Josh\Desktop\Github\Repositories\myshell-tools-slice5\test\integration\p0-pty-benchmark.test.ts
  163:3  warning  Unexpected console statement  no-console
  165:3  warning  Unexpected console statement  no-console
  296:5  warning  Unexpected console statement  no-console

✖ 3 problems (0 errors, 3 warnings)
```

### Slice-specific regression check

Command:

```powershell
$env:HOME='C:\Users\Josh\Desktop\Github\Repositories\myshell-tools-slice5\.tmp-home'; $env:USERPROFILE=$env:HOME; $env:APPDATA=$env:HOME; $env:LOCALAPPDATA=$env:HOME; New-Item -ItemType Directory -Force -Path $env:HOME | Out-Null; @'
import { startVitest } from 'vitest/node';

const vitest = await startVitest(
  'test',
  ['test/unit/shell-passthrough.test.ts', 'test/unit/menu-flow.test.ts'],
  {
    config: false,
    globals: false,
    environment: 'node',
    setupFiles: ['./test/vitest.setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'threads',
    fileParallelism: false,
    testNamePattern: 'shell passthrough',
  },
);

if (vitest === undefined) {
  process.exitCode = 1;
} else {
  await vitest.close();
  process.exitCode = vitest.state.getCountOfFailedTests() > 0 ? 1 : 0;
}
'@ | node --input-type=module -
```

Tail:

```text
 RUN  v4.1.9 C:/Users/Josh/Desktop/Github/Repositories/myshell-tools-slice5

 Test Files  2 passed (2)
      Tests  9 passed | 368 skipped (377)
   Start at  11:34:20
   Duration  2.99s (transform 1.69s, setup 34ms, import 2.29s, tests 251ms, environment 0ms)
```

### Full `test/unit` + `test/arch` run used for branch verification

Command:

```powershell
$env:HOME='C:\Users\Josh\Desktop\Github\Repositories\myshell-tools-slice5\.tmp-home'; $env:USERPROFILE=$env:HOME; $env:APPDATA=$env:HOME; $env:LOCALAPPDATA=$env:HOME; New-Item -ItemType Directory -Force -Path $env:HOME | Out-Null; @'
import { startVitest } from 'vitest/node';

const vitest = await startVitest(
  'test',
  ['test/unit', 'test/arch'],
  {
    config: false,
    globals: false,
    environment: 'node',
    setupFiles: ['./test/vitest.setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'threads',
    fileParallelism: false,
  },
);

if (vitest === undefined) {
  process.exitCode = 1;
} else {
  await vitest.close();
  process.exitCode = vitest.state.getCountOfFailedTests() > 0 ? 1 : 0;
}
'@ | node --input-type=module -
```

Tail:

```text
 Test Files  8 failed | 248 passed | 1 skipped (257)
      Tests  22 failed | 8238 passed | 14 skipped (8274)
   Start at  11:31:48
   Duration  140.88s (transform 4.73s, setup 1.53s, import 16.68s, tests 71.24s, environment 30ms)

 FAIL  test/unit/login-stdin-handoff.test.ts > claude sign-in handoff — leftover-newline root cause > a leading newline (stray Enter) makes the child read an EMPTY first line
 Error: spawn EPERM

 FAIL  test/unit/menu-flow.test.ts > startMenu — auto-goal smart autonomy > rank-9: experimentalRequiredInvestigation=false ⇒ work prompt does NOT contain LOCAL INVESTIGATION
 Error: spawnSync git EPERM

 FAIL  test/unit/worktree.test.ts > nodeWorktreePort — real git, throwaway tmp repo > createWorktree makes an isolated worktree dir off HEAD
 AssertionError: a worktree should be created in a real git repo
```

## Forbidden-file check

Commands used:

```powershell
git diff --stat HEAD
git status --short
```

Result: only the allowed Slice 5 files plus this receipt are present in the worktree (`src/interface/menu.ts`, `src/interface/shell-passthrough.ts`, `test/unit/menu-flow.test.ts`, `test/unit/shell-passthrough.test.ts`, `docs/receipts/menu-s5-shell-passthrough.md`).

## Limitations and judgment calls

- `CommandGatePort` wiring: I added optional `commandGate` and `shellRunner` fields to `MenuContext`, then threaded the real gate from `startMenu` into `ctx` alongside the existing gated `verifyPort` / `worktreePort` seam. Inside `runOneChatInput`, the fallback path mirrors the existing `startMenu` confirm UX by printing the rationale and then calling the already-in-scope `confirm(false, { requireExplicit: true })`.
- CWD threading: Slice 9 conversation-specific cwd state does not exist yet, so shell passthrough currently runs in `ctx.cwd` (the menu/chat cwd already threaded through `runChatLoop`), not in a per-conversation mutable cwd.
- Streaming model: the production runner uses captured output forwarded through `OutputSink` chunk-by-chunk via `execaCommand(..., { shell: true, all: true })` instead of `stdio: 'inherit'`, so the chat surface keeps ownership of the terminal exactly as the spec required.
- Persistence: `!` commands and their output are intentionally not appended to the conversation/session log. The branch only writes directly to `out`.
- Verification environment: the full `test/unit` + `test/arch` run is not clean in this sandbox because multiple existing tests rely on child-process spawning from inside Node (`spawn`, `spawnSync`, `execFileSync('git', ...)`), which fails here with `EPERM`. The new slice-specific tests pass under the same redirected-home Vitest invocation.
