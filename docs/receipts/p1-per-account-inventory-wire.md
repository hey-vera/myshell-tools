# P1 receipt: wire `availableModelsByAccount` on managed-account deps

## Behavior

When the menu account-enrich path loads managed subscription accounts, it now
sets `OrchestrateDeps.availableModelsByAccount` so work-call / hedge /
strong-meta turn freeze and `selectExecutionLane` receive account-keyed model
rows (R1.5 structure was already on main; the interface never populated it).

**Provisional inventory (this PR):** for each managed account, copy the current
provider-global `availableModels` list onto that account’s key. Detect still
runs once against ambient credentials; true per-account entitlement isolation
requires a future per-account CLI probe (accountEnv / isolated `homeDir`).

If `base.availableModelsByAccount` is already set (future probe), enrich keeps it.

## Scope

- Branch: `product/p1-per-account-inventory-wire`
- Core pure: `src/core/live-model-inventory.ts` — `provisionalAvailableModelsByAccount`
- Shared deps slice: `src/interface/build-orchestrate-deps.ts` —
  `buildAvailableModelsByAccountDepsSlice`
- Production path: `src/interface/menu.ts` — `enrichDepsWithAccounts`
- Docs/types: `src/core/types.ts` (OrchestrateDeps comment)
- Tests: `test/unit/live-model-inventory.test.ts`,
  `test/unit/build-orchestrate-deps.test.ts`
- Receipt: this file
- Non-goals held: full OS multi-account isolation matrix; accounts mouse UI;
  true per-account CLI model probe

## Production path

`readSubscriptions` → `enrichDepsWithAccounts` →
`buildAvailableModelsByAccountDepsSlice(base.availableModels, allAccounts)` →
`deps.availableModelsByAccount` → turn-lane snapshot freeze →
`selectExecutionLane` (account-keyed rows present; content still provisional)

## Command evidence

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run test/unit/live-model-inventory.test.ts test/unit/build-orchestrate-deps.test.ts` | 25 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
| `git diff --check` | exit 0 |
