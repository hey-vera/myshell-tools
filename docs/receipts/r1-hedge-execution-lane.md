# R1.3a receipt: hedge uses atomic `selectExecutionLane`

## Behavior

Hedge primary/speculative arms (when account-parallelism is armed in
quality-first mode) select **provider + model + account** as one atom via
`selectExecutionLane` (`src/core/execution-lane.ts`), instead of `route()` /
`vendorNeutralRoute()` then a later `selectSubscriptionAccount` attach.

- Managed subscription accounts for a provider never fall through to ambient
  global credentials when no account is eligible (`no_eligible_lane` error arm).
- Accounts with status `auth-failed` / `unknown` / `disabled` / `expired` are
  excluded by shared structural eligibility.
- Speculative same-provider sibling preference remains (`selectSibling…`) but
  when no sibling exists the arm keeps the atomic lane account (not ambient).
- Review path inside hedge still only picks a manager model via `route()` —
  no account attach (unchanged).
- Flag off / non-quality-first: previous route-only path (no account attach).

## Scope

- Branch: `actualize/r1-hedge-execution-lane`
- Touched: `src/core/hedge.ts` (`runAttempt` + primary pre-select)
- Tests: `test/unit/hedge.test.ts` (R1.3a atomic cases + single-account ambient fix)
- Receipt: this file
- Non-goals held: no per-account discovery (full R1.3), no detached-goal path,
  no pickStrongMeta, no semver

## Production path

`runHedged` → primary pre-select via `selectExecutionLane` (sibling identity) →
`runAttempt` → `selectExecutionLane` (+ optional VN pairing like work-call) →
optional `selectSiblingSubscriptionAccount` for speculative →
`accountEnv` / `accountId` on `ProviderRequest`.

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/execution-lane.test.ts` | 15 passed |
| `npx vitest run test/unit/hedge.test.ts test/unit/panel-hedge-call-budget.test.ts` | 60 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
| `git diff --check` | exit 0 |
