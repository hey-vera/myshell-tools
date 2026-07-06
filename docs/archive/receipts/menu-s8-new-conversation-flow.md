# Slice 8 Receipt — New Conversation Flow + Picker

## Scope

Verified the existing Slice 8 implementation against `docs/menu-build-spec-final.md`:

- `Locked Mockups`
  - `New Conversation Choice`
  - `Workspace Picker`
- `Slice 8 - New Conversation Flow + Picker (Hidden Until CWD Threading)`

## Files Changed

Prior worker implementation already present and verified:

- `src/interface/menu.ts`
  - Added `repoScanPort` to `MenuContext`.
  - Replaced the old direct `[n]` create path with `runNewConversationScreen(...)` and `ctx.store.create('', { mode, workspaceRoot })`.
  - I verified this matched the Slice 8 spec and did not need further code changes.
- `src/interface/menu-new-conversation.ts`
  - New New Conversation screen implementation.
  - I verified it matched the locked mockup and required no code changes.

Files I added or fixed:

- `src/interface/workspace-picker.ts`
  - Removed an unused intermediate `tagged` array.
  - Replaced a forbidden non-null assertion in the filtered-row remap.
  - Fixed Ink-path filter behavior so successive printable keys refine the query instead of replacing it each loop.
- `test/unit/menu-flow.test.ts`
  - Extended Slice 8 coverage for:
    - `[n]` then `Enter` creates with current resolved root.
    - `[n]` then `2` opens picker and selection creates with chosen root.
    - left-arrow from the New Conversation screen returns home.
    - ESC exits.
  - Updated legacy `[n]` chat-driving tests that now pass through the New Conversation screen first, inserting the `Enter = [1] Current` step where needed.
  - Normalized new workspace-root assertions to the persisted forward-slash form.
- `test/unit/workspace-picker.test.ts`
  - New unit coverage for rank wiring, digit selection, Enter selection, filter re-rendering, left/back, ESC exit, and no-match rendering.
- `docs/receipts/menu-s8-new-conversation-flow.md`
  - This receipt.

## Bug Found And Fixed

- `src/interface/workspace-picker.ts` had an unused local plus a `!` remap that failed lint policy.
- The picker’s Ink-path filter logic reset the query on each printable key, despite the implementation comment claiming a usable typed filter. I changed it to accumulate printable characters on the Ink path so filtering refines immediately.

## Judgment Calls

- I treated persisted `workspaceRoot` assertions as normalized paths (`/` separators) because `resolveWorkspaceRoot` and `rankWorkspaceCandidates` normalize before storage/selection.
- I kept the picker’s non-Ink path line-buffered and made the Ink path incrementally append printable chars, which is the smallest fix that preserves the single input owner and stays within Slice 8.
- I did not change `menu.ts` or `menu-new-conversation.ts` after verification because their existing Slice 8 wiring already matched the spec.

## Forbidden-File Check

Checked and confirmed no diffs in these forbidden/read-only files:

- `src/interface/workspace.ts`
- `src/infra/conversation-store.ts`
- `src/infra/conversations.ts`
- `src/interface/menu-render.ts`
- `src/interface/menu-display.ts`

Command:

```powershell
git diff --name-only -- src/interface/workspace.ts src/infra/conversation-store.ts src/infra/conversations.ts src/interface/menu-render.ts src/interface/menu-display.ts
```

Output:

```text
(no output)
```

## Verification

### 1. `npm run typecheck`

Status: pass

Tail:

```text
> myshell-tools@3.162.0 typecheck
> tsc --noEmit
```

### 2. `npm run lint`

Status: pass (`0` errors, known `3` warnings only)

Tail:

```text
> myshell-tools@3.162.0 lint
> eslint src test

C:\Users\Josh\Desktop\Github\Repositories\myshell-tools-slice8\test\integration\p0-pty-benchmark.test.ts
  163:3  warning  Unexpected console statement  no-console
  165:3  warning  Unexpected console statement  no-console
  296:5  warning  Unexpected console statement  no-console

✖ 3 problems (0 errors, 3 warnings)
```

### 3. `npm test`

Status: blocked by sandbox/runtime environment before test execution

Tail:

```text
> myshell-tools@3.162.0 test
> vitest run test/unit test/arch

failed to load config from C:\Users\Josh\Desktop\Github\Repositories\myshell-tools-slice8\vitest.config.ts

Startup Error
Error: Build failed with 1 error:

[plugin externalize-deps]
Error: spawn EPERM
```

### 4. Slice 8 fallback verification inside this sandbox

Because the exact `npm test` command cannot get past Vitest config bundling here, I ran the changed Slice 8 tests through Vitest’s native config loader and thread pool, which avoids the blocked config-bundling spawn path:

```powershell
node .\node_modules\vitest\vitest.mjs run test/unit/menu-flow.test.ts test/unit/workspace-picker.test.ts --configLoader native --pool threads --no-file-parallelism -t "Slice 8|runWorkspacePicker"
```

Status: pass

Tail:

```text
RUN  v4.1.9 C:/Users/Josh/Desktop/Github/Repositories/myshell-tools-slice8

Test Files  2 passed (2)
     Tests  12 passed | 379 skipped (391)
  Start at  14:15:35
  Duration  2.95s (transform 1.80s, setup 32ms, import 2.43s, tests 59ms, environment 0ms)
```

Additional note:

- A full-suite native/thread fallback is also blocked in this sandbox by broader environment restrictions:
  - some tests spawn `git`, which fails with `spawnSync git EPERM`
  - some tests write under `%APPDATA%` / `%LOCALAPPDATA%`, which fails with `Atomic write failed ... EPERM`

## Current Changed Files

- `src/interface/menu.ts`
- `src/interface/menu-new-conversation.ts`
- `src/interface/workspace-picker.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/workspace-picker.test.ts`
- `docs/receipts/menu-s8-new-conversation-flow.md`
