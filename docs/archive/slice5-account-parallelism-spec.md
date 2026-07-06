# Slice 5 - Account-Aware Parallelism Spec

## Scope

Implement the smallest safe version of the deferred account-level "Parallelism" design: one optional same-provider sibling account may be used as the second arm of an existing latency hedge. Do not extend judgment panels.

This feature is default off behind a new dedicated flag:

- Config: `experimentalAccountParallelism?: boolean`
- Env: `MYSHELL_ACCOUNT_PARALLELISM=1`

It also requires the base subscriptions feature to be enabled. If either the base subscriptions flag or this new flag is off, behavior must be byte-identical to the current code.

## Chosen Surface

Use the existing hedge path, not the panel path.

Reason:

- `PanelPlan.candidates` is explicitly provider-diverse: `readonly ProviderId[]`, `>=2`, distinct providers, with cross-vendor judgment semantics in [src/core/ensemble.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/ensemble.ts:80). The red-team specifically says same-provider accounts are not independent vendor minds.
- `planPanel()` currently returns `null` unless `panelPolicy` is enabled and there are at least two authenticated providers ([src/core/ensemble.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/ensemble.ts:122), [src/core/ensemble.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/ensemble.ts:214)). Leave this unchanged.
- `runHedged()` already owns a two-arm throughput/latency race and records both executed arms ([src/core/hedge.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/hedge.ts:1047), [src/core/hedge.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/hedge.ts:1190)). A sibling account is a safer fit there than in a judgment panel.

Non-goal: same-provider accounts must never be used to fill a judgment/diversity panel slot.

## Existing Grounding

Current account routing and execution already exist in the sequential work-call path:

- `selectSubscriptionAccount()` filters by provider, enabled, priority, expiry, cooldown, and session load ([src/core/opencode-account-routing.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/opencode-account-routing.ts:56)).
- `accountEnvFor()` maps account identity to provider env overrides ([src/infra/subscriptions.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/infra/subscriptions.ts:139)).
- `runWorkCall()` selects an account at route time, emits `tier-start.accountId`, injects `ProviderRequest.accountEnv`, calls `onAccountUsed`, and records ledger `accountId` ([src/core/work-call.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/work-call.ts:1354), [src/core/work-call.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/work-call.ts:1441), [src/core/work-call.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/work-call.ts:1568)).
- `ProviderRequest` already supports `accountId` and `accountEnv` ([src/providers/port.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/providers/port.ts:98)).
- The renderer already reports rate-limited accounts from `tier-start.accountId` plus provider error events ([src/interface/render.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/interface/render.ts:413), [src/interface/render.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/interface/render.ts:731)).
- `menu.ts` already owns per-session `accountCooldownUntil` and `sessionTokensByAccount` ([src/interface/menu.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/interface/menu.ts:1059)).

## Flag Wiring

Add a subscriptions-flag-style helper:

```ts
// src/interface/ui/account-parallelism-flag.ts
export function accountParallelismEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: Pick<AppConfig, 'experimentalSubscriptions' | 'experimentalAccountParallelism'> | undefined,
): boolean {
  if (!subscriptionsEnabled(env, config)) return false;
  if (config?.experimentalAccountParallelism === true) return true;
  const raw = env?.['MYSHELL_ACCOUNT_PARALLELISM'];
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}
```

Also add `experimentalAccountParallelism?: boolean` to `AppConfig` near `experimentalSubscriptions` ([src/infra/config.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/infra/config.ts:568)). Do not add it to `DEFAULTS`; absent means off.

When false, do not pass any new account-parallelism deps to `orchestrate()`. When base subscriptions are false, this helper is false even if `MYSHELL_ACCOUNT_PARALLELISM=1`.

## Types

Add only optional fields to `OrchestrateDeps`:

```ts
readonly accountParallelism?: boolean;
readonly accountParallelismDisabledProviders?: ReadonlySet<import('../infra/subscriptions.js').SubscriptionProvider>;
```

Do not change `Policy`. Do not change `PanelPlan`. Do not change `HedgePlan`.

Extend hedge-local `RunResult` with optional account identity:

```ts
readonly accountId?: string;
```

Ledger schema already has optional `accountId` ([src/core/types.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/types.ts:181)); use it for each executed hedge arm.

## Account Candidate Derivation

Add a small pure helper next to `selectSubscriptionAccount()` in [src/core/opencode-account-routing.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/opencode-account-routing.ts:56):

```ts
export function selectSiblingSubscriptionAccount<T extends SubscriptionAccount>(input: {
  accounts: readonly T[];
  provider: SubscriptionProvider;
  pool?: OpencodePool;
  primaryAccountId: string;
  nowMs: number;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
}): T | null {
  return selectSubscriptionAccount({
    ...input,
    accounts: input.accounts.filter((a) =>
      a.id !== input.primaryAccountId &&
      a.priority !== 'low' &&
      a.priorityWeight >= 100
    ),
    strategy: 'spread',
  });
}
```

Eligibility rules:

- Only when `modeFromPolicy(deps.policy) === 'quality-first'`.
- Only when `deps.accountParallelism === true`.
- Only when `deps.subscriptionAccounts` exists.
- Only when `deps.accountParallelismDisabledProviders` does not contain the provider.
- Only when `authority.turnCallBudget` is absent or at least `2`.
- Primary and sibling must have distinct account ids.
- Existing selector rules still apply: enabled, not disabled priority, `priorityWeight > 0`, not expired, not cooling. The sibling helper additionally excludes `low` / `priorityWeight < 100` accounts so overflow-style accounts are not burned speculatively.

For OpenCode, pass the same pool derivation already used in work-call: `opencodePoolForModel(model) ?? 'zen'` ([src/core/work-call.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/work-call.ts:1374)).

## Hedge Integration

Keep `planHedge()` pure and unchanged ([src/core/hedge.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/hedge.ts:126)). Account expansion happens inside `runHedged()` as derived execution input.

Minimal before:

```ts
const primaryPromise = runAttempt(task, deps, plan.primaryTier, deps.policy, ...);
...
const speculativePromise = runAttempt(task, deps, plan.speculativeTier, specPolicy, ...);
```

Minimal after:

```ts
const primaryPromise = runAttempt(task, deps, plan.primaryTier, deps.policy, ..., {
  role: 'primary',
});
...
const speculativePromise = runAttempt(task, deps, plan.speculativeTier, specPolicy, ..., {
  role: 'speculative',
  avoidAccountId: primary.accountId,
  preferSiblingProvider: primary.provider,
});
```

Inside `runAttempt()`:

1. Route exactly as today.
2. If account parallelism is off, do nothing else.
3. Select the primary account with `selectSubscriptionAccount()` using `strategy: 'spread'`.
4. For the speculative arm only, if the routed provider equals the primary provider and `avoidAccountId` is present, select a sibling with `selectSiblingSubscriptionAccount()`.
5. Add `accountId` and `accountEnv: accountEnvFor(account)` to `ProviderRequest`.
6. Emit `tier-start.accountId`.
7. Call `deps.onAccountUsed(account.id, deps.clock.isoNow())` best-effort.
8. Record ledger `accountId` for the arm.

Do not force the speculative arm to the same provider. If normal hedge routing picks a different provider, preserve provider-level hedge behavior and select that provider's account normally. Same-provider account fanout only happens when the normal provider route would otherwise reuse the same provider and a safe sibling exists.

Reconciliation remains hedge-simple: first adequate success wins, using the existing `pickWinner()` logic ([src/core/hedge.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/hedge.ts:1266)). Both executed arms are recorded; the loser is cancelled best-effort and still ledgered if it ran.

## Correlated-429 Backoff

Add a tiny in-memory detector in [src/interface/menu.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/interface/menu.ts:1627), next to `accountCooldownUntil`:

```ts
const accountProviderById = new Map<string, SubscriptionProvider>();
const recentAccount429sByProvider = new Map<SubscriptionProvider, Array<{ accountId: string; atMs: number }>>();
const accountParallelismDisabledProviders = new Set<SubscriptionProvider>();
```

Populate `accountProviderById` whenever `subscriptionAccounts: allAccounts` is loaded for deps ([src/interface/menu.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/interface/menu.ts:2783)).

In `noteRateLimit()`, after existing account cooldown handling:

- For each `rateLimitedAccounts` id, find provider from `accountProviderById`.
- Append `{ accountId, atMs: now }` to that provider's recent list.
- Drop entries older than `60_000` ms.
- If the remaining list contains `>= 2` distinct account ids for the same provider, add the provider to `accountParallelismDisabledProviders` for the rest of the session.
- Emit one concise notice once: `shared vendor limit suspected for <provider>; disabling same-provider account fanout this session`.

Thread the set into deps only when `accountParallelismEnabled(...)` is true:

```ts
accountParallelism: true,
accountParallelismDisabledProviders,
```

When tripped, same-provider fanout is suppressed. Sequential account failover and existing per-account cooldowns continue to work.

## Tests

Add focused tests only:

- Flag off: with `experimentalAccountParallelism` absent and no env var, `orchestrate()` / hedge output is unchanged and no new deps are required.
- Base subscriptions off: `MYSHELL_ACCOUNT_PARALLELISM=1` alone does not load accounts and does not change execution.
- Judgment diversity: `planPanel()` still requires `>=2` providers and never treats two same-provider accounts as panel candidates.
- Hedge eligibility: quality-first mode, hedge on, budget room, two distinct non-cooling medium/high same-provider accounts -> primary request gets account A, speculative same-provider arm gets account B.
- Hedge ineligible cases: balanced/cost-saver mode, low-priority sibling, expired sibling, disabled sibling, cooling sibling, or tripped provider -> no sibling fanout.
- Correlated 429: two distinct same-provider account ids rate-limit within 60 seconds -> provider enters `accountParallelismDisabledProviders`.
- Correlated 429 non-trip: one account rate-limits twice, or two providers each have one account rate-limit -> no provider disable.
- Reconciliation: when both arms run, first adequate success wins and both ledger entries include their account ids.
- Regression: existing `planHedge()` and `planPanel()` pure tests remain unchanged; no account imports are added to those planners.

## Intentionally Not Built

- No account-aware `PanelPlan`. Red-team risk: same-provider accounts are not independent judgment sources.
- No same-provider accounts as fallback panel slots. That would blur throughput and adjudication.
- No Auto/Smart account balancing. The red-team says account pooling belongs behind governor facts and should not be hidden in smart routing.
- No persistent shared-limit ledger schema. The detector is session-local and conservative; the red-team asked for a safety valve before productizing the capacity claim.
- No forced provider choice for the speculative hedge arm. The existing provider router remains authoritative; Slice 5 only prevents accidental reuse of the same account when the hedge already uses the same provider.
- No more than one sibling arm. This is a safety-gated capability, not pooled capacity.

## Riskiest Integration Point

The riskiest point is [src/core/hedge.ts](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/core/hedge.ts:232): `runAttempt()` currently routes and executes a provider arm without account selection. The implementation must add account selection, env injection, `tier-start.accountId`, `onAccountUsed`, and ledger `accountId` there without changing `planHedge()` admission or the existing provider-level hedge race.
