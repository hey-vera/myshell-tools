# harden-99-cleanup

## Changes

1. `src/cli.ts`
   Removed the false `--help` claim that the default interactive mode ships "durable map context + CompletionResultV1".

2. `src/cli.ts`
   Removed the discarded `buildEnvironmentContextFromRecon(null, [])` no-op call from the one-shot run path.

3. `src/core/accept-stage.ts`
   Removed the fire-and-forget completion hook that captured patches, applied them, and committed them as a silent side effect of turn completion.

4. `test/unit/accept-finalize.test.ts`
   Updated the test description/comment so it reflects the remaining synchronous attachment behavior instead of the removed async patch-apply path.

5. `test/arch/guards.test.ts`
   Added `src/core/patch-apply.ts` to the staged orphan allowlist because PR #99 cleanup intentionally removed its completion-flow caller without deleting the file itself.

## Verification Tails

### `npm run typecheck`

```text
> myshell-tools@3.162.0 typecheck
> tsc --noEmit
```

Result: PASS

### `npm run lint`

```text
> myshell-tools@3.162.0 lint
> eslint src test


C:\Users\Josh\Desktop\Github\Repositories\myshell-tools\test\integration\p0-pty-benchmark.test.ts
  163:3  warning  Unexpected console statement  no-console
  165:3  warning  Unexpected console statement  no-console
  296:5  warning  Unexpected console statement  no-console

✖ 3 problems (0 errors, 3 warnings)
```

Result: PASS with existing warnings only

### `npx vitest run test/unit test/arch`

```text
RUN  v4.1.9 C:/Users/Josh/Desktop/Github/Repositories/myshell-tools


Test Files  261 passed | 1 skipped (262)
     Tests  8384 passed | 14 skipped (8398)
  Start at  21:40:19
  Duration  156.08s (transform 15.89s, setup 3.26s, import 52.88s, tests 194.79s, environment 53ms)
```

Result: PASS

### `npm run test:integration`

```text
> myshell-tools@3.162.0 test:integration
> vitest run test/integration


 RUN  v4.1.9 C:/Users/Josh/Desktop/Github/Repositories/myshell-tools


 Test Files  2 passed | 1 skipped (3)
      Tests  9 passed | 6 skipped (15)
   Start at  21:37:09
   Duration  80.14s (transform 147ms, setup 107ms, import 195ms, tests 80.30s, environment 1ms)
```

Result: PASS
