# R2.1 receipt: freeze one lane snapshot per dispatched turn

## Behavior

Each work turn freezes **provider inventory + inventoryGeneration** at dispatch
and uses only that freeze for the turn’s `selectExecutionLane` / provider
request / ledger rows:

- New pure module `src/core/turn-lane-snapshot.ts`:
  - `TurnInventoryFreeze` — deep-copied `availableModels`,
    `availableModelsByAccount`, accounts, auth providers + resolved generation
  - `TurnLaneSnapshot` — provider + model + accountId + tier + generation +
    `frozenAt` reason
  - `freezeTurnInventory` / `freezeTurnInventoryFromDeps` /
    `turnLaneSnapshotFromLane`
- `runWorkCall` freezes once at entry (`work-call-dispatch`); every attempt
  routes from the freeze (not live deps). Mid-turn mutation of
  `deps.availableModels` / accounts does not change in-flight selection.
- Hedge: freeze once in `runHedged` (`hedge-primary-dispatch`); primary
  pre-select + all `runAttempt` arms consume the same freeze.
- Durable `LedgerEntry.inventoryGeneration` (optional) stamped on work-call and
  hedge work ledger rows for this turn’s freeze.

Next turn freezes a **fresh** bag from updated deps and may adopt a new model.

## Scope

- Branch: `actualize/r2-turn-lane-snapshot`
- Core: `src/core/turn-lane-snapshot.ts` (new)
- Plumb: `src/core/work-call.ts`, `src/core/hedge.ts`, `src/core/types.ts`
  (`LedgerEntry.inventoryGeneration`)
- Docs: `docs/ROADMAP-STATUS.md`, `docs/receipts/r1-complete.md`, this receipt
- Tests: `test/unit/turn-lane-snapshot.test.ts`,
  `test/unit/work-call-turn-lane-snapshot.test.ts`
- Non-goals held: full A→B→A continuity bridge (R2.2), mid-chat refresh redesign,
  native session resume lineage changes, live per-account CLI probe, semver

## Production path

`runWorkCall` / `runHedged` → `freezeTurnInventoryFromDeps(deps)` →
`selectExecutionLane({ …frozen inventory, inventoryGeneration })` →
provider request + `ledger.record({ inventoryGeneration })`.

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` / `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/turn-lane-snapshot.test.ts test/unit/work-call-turn-lane-snapshot.test.ts test/unit/execution-lane.test.ts test/unit/hedge.test.ts test/unit/work-call-failover.test.ts test/unit/work-call-prior-cost.test.ts` | 106 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
| `git diff --check` | exit 0 |
