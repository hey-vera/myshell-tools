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
- SHA: `02ade7a11339a06f8ea634155a19a96f14c68707`
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

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/execution-lane.test.ts` | 15 passed |
| account-routing unit files (subscription / claude / codex-grok) | 66 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
| `git diff --check` | exit 0 |
