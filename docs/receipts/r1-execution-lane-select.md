# R1.1 receipt: atomic execution-lane selection

## Behavior

Work-call spawn selects an **execution lane** as one atom: `provider + model +
account` (via `selectExecutionLane` in `src/core/execution-lane.ts`), instead of
`route()` then a later `selectSubscriptionAccount` attach.

- Managed subscription accounts for a provider never fall through to ambient
  global credentials when no account is eligible.
- Accounts with `status` in `auth-failed` / `unknown` / `disabled` / `expired`
  are structurally ineligible (`isSubscriptionAccountStructurallyEligible`).
- Zero managed accounts: same provider+model as `route()` with `account: null`.

## Scope

- Branch: `actualize/r1-execution-lane-select`
- New: `src/core/execution-lane.ts`, `test/unit/execution-lane.test.ts`, this receipt
- Touched: `src/core/work-call.ts` (main path), `src/core/opencode-account-routing.ts`
  (shared eligibility)
- Non-goals held: no pickStrongMeta, no per-account live discovery, no progressive
  admission, no credentials migration, no semver bump

## Production path

`runWorkCall` main loop → `selectExecutionLane(...)` → `decision` + `laneAccount`
→ tier-start / ProviderRequest `accountId` + `accountEnv`. Vendor-neutral route
still pairs accounts against its exact model and falls back to another lane or
fails with the typed `no_eligible_lane` message when managed inventory blocks
ambient use.

## Command evidence

```
npm run typecheck
npx vitest run test/unit/execution-lane.test.ts
npx vitest run test/unit/subscription-account-routing.test.ts test/unit/claude-account-routing.test.ts test/unit/codex-grok-account-routing.test.ts
npm run lint
npm run knip
git diff --check
```
