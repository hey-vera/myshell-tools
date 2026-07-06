# Core Answer Starvation Fix Design

Date: 2026-06-29
Repo: `myshell-tools`
Status: source/tests untouched by this audit update.

## REAL ROOT CAUSE: vendor-neutral routing returns null and aborts the turn

The live rank-9 instrumentation changes the diagnosis. The turn makes exactly one provider request, but it is the intent-extraction preflight ("You extract the INTENT of a user message..."). The core work provider is never called because default-on vendor-neutral routing returns `NoCapableProvider` for tier `manager`, `vendorNeutralDecision()` maps that to `null`, and `runWorkCall()` breaks out of `mainLoop`.

Observed buffer:

```text
[error] Vendor-neutral routing could not find a provider for tier "manager". No capable provider available.
* Failed - tier: manager, 0 tokens, attempts: 1
```

Code proof:

- `src/interface/menu.ts:1112-1128` builds `caps.registry` from `refreshCapabilities()`.
- `src/interface/menu.ts:2464-2466` passes both `capabilityRegistry` and default-on `vendorNeutralEnabled`.
- `src/core/work-call.ts:620-648` calls `vendorNeutralRoute()` and returns `null` on `!result.ok`.
- `src/core/work-call.ts:1235-1246` handles that `null` by yielding the error notice and `break mainLoop`.
- `src/core/vendor-neutral-route.ts:269-272` treats unknown non-OpenCode models as worker-floor only: `{ worker: true, ic: false, manager: false }`.
- `src/core/vendor-neutral-route.ts:338-354` drops that candidate for `manager`/`ic` and returns `NoCapableProvider`.
- `src/core/model-capability-refresh.ts:186-193` confirms production detected-but-unknown models are merged with no invented tier or routing profile.

## Verdict

This is both a real robustness regression and a stale fixture exposure.

It is real because production can reproduce the same behavior: if an authenticated provider advertises a new/unknown non-OpenCode model and that id has no static routing profile yet, VN routing admits it only for worker tier. A manager/ic turn with only that model yields `NoCapableProvider`; current `work-call.ts` then aborts before the adapter is called, so the user gets no answer despite an authenticated provider.

The failing menu tests also have a stale fixture: `FAKE_ENV.claude.availableModels = ['model-a']`. `model-a` is intentionally unknown to the static capability catalog, so default-on VN routing cannot use it for manager/ic. The fixture is useful because it exposes the production failure mode, but the minimal fix belongs in the executor fallback, not by disabling VN routing or teaching every legacy test about `model-a`.

## Exact Minimal Fix

Keep the already-applied budget guard:

```ts
const callBudgetAvailable = (): boolean =>
  turnCallBudget === undefined ||
  providerCalls === 0 ||
  providerCalls < turnCallBudget;
```

That fix is still correct, but it is necessary-not-sufficient. It protects the first work call from budget starvation; it cannot help when routing aborts before a provider is selected.

Primary source fix: make VN `null` fail soft to static `route()` at the work-call routing sites. Do not change `vendorNeutralRoute()` semantics; its `NoCapableProvider` result is still correct for strict VN ranking and its unit tests.

### 1. Initial work route: `src/core/work-call.ts:1235-1246`

Before:

```ts
if (vnDecision) {
  decision = vnDecision;
} else {
  yield {
    type: 'notice',
    level: 'error',
    message: `Vendor-neutral routing could not find a provider for tier "${currentTier}". No capable provider available.`,
  };
  break mainLoop;
}
```

After:

```ts
if (vnDecision) {
  decision = vnDecision;
} else {
  yield {
    type: 'notice',
    level: 'warn',
    message: `Vendor-neutral routing could not find a provider for tier "${currentTier}". Falling back to static routing.`,
  };
  decision = route(
    currentTier,
    routePool,
    effPolicy,
    deps.availableModels,
    deps.authenticatedProviders,
    deps.learnedProviderOrder?.[currentTier],
    capabilityContext,
  );
}
```

Why: this is the starvation point. Static `route()` already degrades when `availableModels` contains an unknown id: `getCheapestForTier()` ignores an empty allowed-model intersection and returns the provider's tier baseline. The adapter is then called, preserving the un-sheddable core answer.

### 2. Cross-provider failover route: `src/core/work-call.ts:1876-1887`

Before: VN null emits the failover error notice and `break mainLoop`.

After: emit a warn notice and set `nextDecision = route(currentTier, remaining, effPolicy, deps.availableModels, deps.authenticatedProviders, deps.learnedProviderOrder?.[currentTier], capabilityContext)`.

Why: failover is the recovery path after a provider failure. A VN-null on the remaining pool should not strand the turn when static routing can still choose an authenticated provider.

### 3. Review route: `src/core/work-call.ts:2084-2105`

Current source already falls back to static `route()` after VN null, but the notice/comment say "Skipping review" even though `reviewDecision` is assigned via `route()`. Keep the fallback and change only the message/comment to "falling back to static routing." If an older branch truly skips or breaks here, use the same static fallback pattern.

Why: review is optional, so a hard abort would be wrong; a static fallback is safe and consistent. The separate verify-at-accept critic at `src/core/work-call.ts:827-833` can remain fail-soft (`{ ran: false }`) because it is optional verification, not the core answer.

## Test Impact

Expected to turn green because the fake `model-a` manager/ic route now falls back to static routing and reaches the fake provider:

| audit # | test |
|---:|---|
| 8 | `with autoGoal off, manager-tier task stays on single runTask path` |
| 9 | `clear actionable chat answers first, then auto-stages one goal` |
| 24 | `rank-7 unify=false router preflight prompt fires` |
| 25 | `rank-7 unify=true router preflight suppressed` |
| 26 | `rank-9 requiredInvestigation=false` |
| 27 | `rank-9 requiredInvestigation=true` |
| 28 | `rank-10 preflightGuard=false` |
| 29 | `rank-10 preflightGuard=true` |
| 36 | `user answers y -> login is called with failing provider` |
| 37 | `user answers y -> runTask is retried` |
| 38 | `no real login subprocess spawned` |
| 39 | `after re-login, retry uses fresh env` |
| 40 | `/retry regenerates last answer` |
| 41 | `/edit picks prior message and re-runs` |

VN-routing tests should not break: `vendorNeutralRoute()` still returns `NoCapableProvider` for unknown manager/ic models, and the work-call VN happy-path tests use known catalog models so they still take the VN branch. Add one work-call regression for `vendorNeutralEnabled=true`, registry present, authenticated Claude, `availableModels: ['model-a']`, start tier `manager`; assert one provider call and final success via static fallback.

Budget-cap tests should not break: the budget fix admits only the first provider call (`providerCalls === 0`) and still denies optional second ordinary calls when `turnCallBudget=1`. The VN fallback chooses a provider for that admitted core slot; it does not add retry/review capacity.

## Fixture Follow-Up

Do not turn VN off for these legacy tests; that would hide the production robustness bug. Optional cleanup after the source fix: replace `model-a` in broad menu fixtures with a real catalog alias such as `opus`/`sonnet`, or provide a test-only capability entry for `model-a` only in tests that explicitly need a fake model id. The source fallback is still required either way.
