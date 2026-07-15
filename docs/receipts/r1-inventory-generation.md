# R1.3b receipt: inventory generation on the lane snapshot

## Behavior

Every successful `selectExecutionLane` result tags the lane with
`inventoryGeneration` (string | number):

- Callers may pass an explicit generation (counter, probe token, or deps freeze)
  via `SelectExecutionLaneInput.inventoryGeneration` / `OrchestrateDeps.inventoryGeneration`.
- When absent, generation is **derived** from inventory contents: sorted
  provider → model ids and account `provider\tid` keys, hashed to a stable
  `ig-<8 hex>` token. **Not** wall-clock / `Date.now`.
- Same inventory (order-independent) → same generation; different models or
  accounts → different generation.

Plumbed without user-facing text changes:

- `work-call` → `selectExecutionLane` when `deps.inventoryGeneration` is set
- `hedge` (primary pre-select + `runAttempt`) same
- `strong-meta-lane` → `StrongMetaLane.inventoryGeneration` from the atomic lane

## Scope

- Branch: `actualize/r1-inventory-generation`
- SHA: `169df5d5b2f3f5f31d5199f523121a955bc0ea56`
- Core: `src/core/execution-lane.ts` (`deriveInventoryGeneration`,
  `resolveInventoryGeneration`, field on `ExecutionLane`)
- Plumb: `src/core/work-call.ts`, `src/core/hedge.ts`,
  `src/core/strong-meta-lane.ts`, `src/core/types.ts` (`OrchestrateDeps`)
- Tests: `test/unit/execution-lane.test.ts`, `test/unit/strong-meta-lane.test.ts`
- Receipt: this file
- Non-goals held: no per-account CLI model probe, no progressive admission
  canary runner, no R2 mid-chat refresh, no semver

## Production path

`runWorkCall` / `runHedged` / `selectStrongMetaLane` → `selectExecutionLane` →
ok `ExecutionLane.inventoryGeneration` (explicit freeze or content-derived).

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/execution-lane.test.ts test/unit/strong-meta-lane.test.ts test/unit/hedge.test.ts` | 82 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
| `git diff --check` | exit 0 |
