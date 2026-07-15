# U1 receipt: detached/worker account brain parity

## Behavior

Detached goal `productionDeps` (`myshell-tools worker` /
`createDetachedGoalExecutor` default) now loads managed subscription accounts
and per-account model inventory the same way the menu enrich path does, so
Esc→worker does not ambient-route around managed accounts.

Rules:

1. When managed accounts exist → set `subscriptionAccounts` + legacy
   `opencodeAccounts` subset.
2. Prefer `probeAvailableModelsByAccount` real rows; else provisional
   `buildAvailableModelsByAccountDepsSlice` from provider-global models.
3. Pass `accountCooldownUntil` (empty `Map` when no session state) so R3 cooling
   can apply when cooldowns are provided later.
4. Never invent models on empty probe (omit row → global fallback).
5. Fail-soft: subscription read / probe failure → base deps without crash.

## Scope

- Branch: `agent/u1-detached-account-parity`
- Shared helper: `src/interface/enrich-orchestrate-accounts.ts`
  - `enrichOrchestrateDepsWithAccounts(base, opts)` with injectable
    `readSubscriptions` / `probeAvailableModelsByAccount`
- Production wire: `src/commands/detached-goal-execution.ts` — `productionDeps`
  ends with enrich after `buildSharedOrchestrateCore`
- Tests: `test/unit/enrich-orchestrate-accounts.test.ts`,
  production composition case in `test/unit/detached-goal-execution.test.ts`
- Receipt: this file
- Menu: left as local `enrichDepsWithAccounts` (same rules; extras for session
  tokens / parallelism / lastUsedAt remain menu-owned). Optional later switch
  to shared helper is low-risk but out of this blast radius.
- Non-goals held: version bump, npm publish, full FG free-loop chrome, default-on
  native `--effort`, live paid CLI calls in tests

## Production path

```
detectEnvironment (caller)
  → buildAuthenticatedProviders
  → base OrchestrateDeps + buildSharedOrchestrateCore(env)
  → enrichOrchestrateDepsWithAccounts(base, { cwd: job.cwd })
       → readSubscriptions
       → probeAvailableModelsByAccount (prefer real rows)
       → else provisional buildAvailableModelsByAccountDepsSlice
       → subscriptionAccounts + opencodeAccounts + accountCooldownUntil
  → runDurableGoal / runDetachedFreeGoal → runTask
```

## Command evidence

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| `npx vitest run test/unit/enrich-orchestrate-accounts.test.ts test/unit/detached-goal-execution.test.ts test/unit/subscription-detect-probe.test.ts` | 26 passed (3 files) |
| `npm run lint -- --max-warnings=999` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |

## Limitations

- Detached still has no interactive session cooldown state — always starts with
  empty `accountCooldownUntil` (R3 rules apply only when a non-empty map is
  supplied later).
- Menu not refactored onto the shared helper yet (behavior parity for the core
  account fields; menu keeps local extras).
- `productionDeps` itself still needs real authenticated providers to return
  non-null; unit tests prove the enrich seam with injectables + the same base
  assembly productionDeps uses after providers exist (no live network).
- CLI `run` path (U1b) not in scope.
