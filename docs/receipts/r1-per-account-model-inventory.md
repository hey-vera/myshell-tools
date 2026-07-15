# R1.5 receipt: per-account (profile) model inventory foundation

## Behavior

`selectExecutionLane` can take **per-account model inventories** so two accounts
with different entitlements cannot be cross-paired silently:

- New types: `AccountModelList`, `AvailableModelsByAccount` (provider → account
  id → model ids).
- When `availableModelsByAccount[provider][accountId]` is present, that list is
  preferred for pairing; provider-global `availableModels` is used only when the
  per-account map (or the account row) is absent (backward compatible).
- Routing inventory is the union of per-account lists (plus global fallback for
  accounts without a row). After `route()` picks a model, only accounts entitled
  to that model are candidates for `selectSubscriptionAccount`.
- If a model is only listed under account B, account A is never selected with it.
- Inventory generation fingerprints include `account-model` rows.
- `buildAvailableModelsByAccount` shapes probe results into the map (pure helper).

**Live per-account CLI probe is follow-on.** `subscription-detect` still returns
status/plan only; this slice is the pure selection API + `OrchestrateDeps` /
work-call / hedge / strong-meta plumb.

## Scope

- Branch: `actualize/r1-per-account-model-inventory`
- Core: `src/core/execution-lane.ts`, `src/core/live-model-inventory.ts`
- Plumb: `src/core/types.ts` (`OrchestrateDeps.availableModelsByAccount`),
  `src/core/work-call.ts`, `src/core/hedge.ts`, `src/core/strong-meta-lane.ts`
- Tests: `test/unit/execution-lane.test.ts`, `test/unit/live-model-inventory.test.ts`
- Receipt: this file
- Non-goals held: no multi-account OS isolation matrix, no progressive-admission
  rework, no credentials rewrite, no semver, no live per-account model probe

## Production path

Caller supplies `deps.availableModelsByAccount` (when known) →
`runWorkCall` / hedge / strong-meta → `selectExecutionLane` → lane pairs
`provider + model + account` only when the account’s inventory (or global
fallback) includes the model.

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/execution-lane.test.ts test/unit/live-model-inventory.test.ts test/unit/model-admission.test.ts test/unit/strong-meta-lane.test.ts` | 89 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
| `git diff --check` | exit 0 |
