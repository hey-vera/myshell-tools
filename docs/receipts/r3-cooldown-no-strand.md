# R3.1 receipt: no silent cooling-account pick

## Behavior

When every structurally eligible account for a managed provider path is in
cooldown (and no healthy alternate lane remains), the runtime **does not** spawn
on a cooling account.

- `selectSubscriptionAccount`: all-cooling candidates → `null` (R3.1). Healthy
  siblings still win; structural filters (`auth-failed` / `unknown` / disabled /
  expired) unchanged.
- `selectExecutionLane`: pure cooldown failure → typed
  `waiting_on_quota` with `retryAfterMs` (earliest account expiry − now) and an
  actionable message. Mixed failures keep `no_eligible_lane` and may still attach
  `retryAfterMs` + a cooldown note.
- Healthy alternate provider/account still selected (cross-provider failover).
- Provider-level `availableAfterCooldown` never-strand for menu/route pool ordering
  is **unchanged** (cross-provider preference only; does not force a cooled
  managed account).

## Scope

- Branch: `actualize/r3-cooldown-no-strand`
- Touched:
  - `src/core/opencode-account-routing.ts`
  - `src/core/execution-lane.ts`
  - account-routing + execution-lane + hedge unit tests
  - this receipt
- Non-goals held: subscriptions schema lock/CAS (R3.2)

## Production path

`selectSubscriptionAccount` (no cooling pick) → `selectExecutionLane` (typed
failure / healthy failover) → `work-call` / hedge arms that already consume the
lane failure message.

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` (account routing + execution-lane + hedge) | 180 passed |
| `npx eslint` (touched src) | exit 0 |
| `npx knip` | exit 0 |
