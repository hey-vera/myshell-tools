# Residual: true per-account model probe

## Behavior

When the menu account-enrich path loads managed subscription accounts, it now
runs an **env-scoped per-account detect** so `OrchestrateDeps.availableModelsByAccount`
can carry real entitlement differences (not only a provisional copy of the
provider-global list).

Rules (approved defaults):

- Isolation via `accountEnvFor` + `detectProvider` (same pattern as auth detect).
- Probe runs when enriching deps / loading accounts — not every keystroke.
- Empty / auth-fail → **omit that account row** (global fallback); never invent models.
- Prefer real probe rows over `provisionalAvailableModelsByAccount` when any real
  rows exist; if the probe yields nothing, keep the provisional fallback.

## Scope

- Branch: `product/residual-per-account-probe`
- `src/infra/subscription-detect.ts`
  - `detectSubscriptionAccount` returns `availableModels` from env-scoped detect
  - OpenCode branch with `accountEnv` (`XDG_DATA_HOME`)
  - `probeAvailableModelsByAccount(accounts, cwd)` fail-soft parallel
  - Injectable `detect` for unit tests
- `src/interface/menu.ts` — `enrichDepsWithAccounts` prefers probe → provisional
- Comments: `types.ts`, `build-orchestrate-deps.ts`, `live-model-inventory.ts`
- Tests: `test/unit/subscription-detect-probe.test.ts`
- Receipt: this file
- Non-goals held: version bump; OS multi-account isolation matrix; mid-keystroke
  re-probe

## Production path

`readSubscriptions` → `enrichDepsWithAccounts` →
`probeAvailableModelsByAccount` (parallel `detectSubscriptionAccount` +
accountEnv) → if any real rows → `deps.availableModelsByAccount` → else
`provisionalAvailableModelsByAccount` → turn-lane freeze → `selectExecutionLane`

## Command evidence

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| `npx vitest run test/unit/subscription-detect-probe.test.ts` | 8 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
