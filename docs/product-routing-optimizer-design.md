Plain-language summary: myshell-tools already has tier routing, capability-aware selection, learned success/latency ordering, pricing data, and a stronger vendor-neutral router in the interactive path, but it does not yet optimize for "the cheapest model expected to be good enough for this turn." This design proposes adding one shared cost/quality objective underneath the existing policy modes and gates: first keep today's authoritative filters for tier admission, auth, cooldown, subscription, vision, context, and adapter passability; then estimate a task-specific quality bar from existing classification and task signals; then pick the lowest expected USD candidate whose estimated quality clears that bar. The change should ship behind a new explicit experimental flag, run in shadow first, and unify the one-shot CLI with the interactive menu so both product paths use the same routing rules.

# Product Routing Cost/Quality Optimizer Design

## Grounding

This document is grounded in [docs/product-routing-grounding.md](product-routing-grounding.md). I am treating that file as the source of truth for the current runtime shape rather than re-deriving it. Relevant grounded facts:

- `src/core/route.ts` is the classic tiered router. It clamps by policy, applies provider order, uses `getCheapestForTier()` as a fallback/baseline, applies bounded capability-fit, and consumes learned provider/model ordering.
- `src/core/vendor-neutral-route.ts` is the provider-agnostic candidate router. It builds candidates from authenticated providers, advertised models, the capability registry, and routing profiles, then hard-filters and ranks by suitability plus pool/cooldown/load tie-breakers.
- `src/core/policy.ts` owns `cost-saver`, `balanced`, and `quality-first`, plus `maxTier` and flagship admission posture.
- `src/core/model-capabilities.ts` owns objective model facts and routing profiles.
- `src/core/routing-memory.ts` learns from success and latency, explicitly not USD/token cost today.
- `src/infra/pricing.ts` has static price data and helpers, but price is currently a tie-break/fallback rather than a unified cost/quality objective.
- `src/core/orchestrate-signals.ts` derives task kind, input-size estimates, and reasoning effort.
- `src/cli.ts` and `src/interface/menu.ts` diverge today: one-shot CLI does not set `vendorNeutralEnabled: true`, while the interactive menu does.

## Recommendation

Add a shared optimizer that can be used by both routing paths:

```ts
selectCheapestClearingCandidate(input): OptimizerDecision | null
```

The optimizer should not be a second routing system. It should run after the existing hard gates have defined the legal candidate set and before the final winner is chosen among legal candidates. If it cannot make a trustworthy decision, it should return `null` and the current router should continue unchanged.

Judgment call: use a threshold objective, not a single weighted score. In other words, choose the cheapest candidate whose expected quality clears the task bar, instead of choosing the highest `quality - lambda * cost`. This is easier to explain, aligns with the requested "cheapest model that clears the bar" behavior, and preserves the meaning of existing policy modes.

## Objective Function

### Hard Filters First

The optimizer must only score candidates that already satisfy existing authoritative constraints:

- Requested tier after `clampTier()` / flagship admission.
- Provider availability and authentication.
- Cooldown and subscription/account availability as passed into the route call.
- Capability hard requirements: tier admission, vision, context window, and adapter passability.
- Policy ceilings from `policy.ts`, including `maxTier`.
- Any existing pool pin/exclude override in `vendorNeutralRoute()`.

The optimizer must never resurrect a candidate dropped by these filters. This is a fact-based requirement from the current architecture described in the grounding doc; the optimizer is additive, not a replacement.

### Quality Bar

Define a per-turn scalar quality bar:

```ts
qualityBar = f(tier, risk, routePlan, taskKind, estimatedInputTokens, needsVision, needsWebSearch, difficulty, mode)
```

Proposed starting values, subject to user approval:

| Signal | Effect |
| --- | --- |
| `worker` | Base bar 25 |
| `ic` | Base bar 55 |
| `manager` | Base bar 80 |
| `risk: medium/high/critical` | Add 5/12/18 |
| `routePlan: true` | Add 5 |
| `taskKind: architecture/review/large-context` | Add 8/8/10 |
| `needsVision` or large context hard requirement | Require the matching capability, then add 5 |
| `cost-saver` | Subtract 5, still bounded by hard gates |
| `balanced` | No adjustment |
| `quality-first` | Add 8 and prefer higher-quality ties |

Clamp the final bar to `[0, 100]`.

This bar should be produced from existing signals already named in the grounding doc: `classify()` / tier/risk output, `routePlan`, `deriveTaskKind()`, `estimateInputTokens()`, and reasoning/difficulty signals that are already threaded through `CapabilityTaskSignals`.

Judgment call: keep the initial thresholds static and conservative. Learned data should adjust candidate expectations only after enough runs, not rewrite the bar itself in v1.

### Quality Expectation

For each legal candidate `c`, estimate:

```ts
expectedQuality(c) = baseSuitability(c, tier)
                   + capabilityFit(c, taskSignals)
                   + learnedOutcomeAdjustment(c, taskKind)
                   + modeAdjustment(c, mode)
```

Inputs:

- `baseSuitability`: use `RoutingProfile.tierSuitability[tier]` from `model-capabilities.ts` / `route-types.ts`; for OpenCode, use `opencodeTierRank()` as `vendorNeutralRoute()` does today.
- `capabilityFit`: reuse the intent of `route.ts` `scoreModel()` for objective facts: vision, large context, native session, search support where relevant, and model outcome order.
- `learnedOutcomeAdjustment`: use `routing-memory.ts` model outcome stats by `taskKind`, with minimum-run thresholds and neutral priors.
- `modeAdjustment`: small, explicit adjustment. `quality-first` should widen the accepted quality margin and `cost-saver` should accept lower-cost candidates that still clear the bar.

Unknown facts should be neutral, not negative, except where the existing hard filter already requires a known capability. This matches the capability registry invariant that unknown is absent, not false.

### Cost Expectation

For each legal candidate `c`, estimate:

```ts
expectedUsd(c) = calculateEffectiveCost(
  estimatedInputTokens,
  expectedOutputTokens,
  getModelPricing(c.provider, c.model),
  expectedCacheUsage?
)
```

Use `src/infra/pricing.ts`:

- `getModelPricing(provider, model)` for price lookup.
- `calculateCost()` or `calculateEffectiveCost()` for expected USD.
- `isPricingStale()` for rollout warnings and fail-soft behavior.

`estimatedInputTokens` should come from `orchestrate-signals.ts` `estimateInputTokens()`. For v1, `expectedOutputTokens` can be a deterministic heuristic by task kind/tier, with learned averages from `routing-memory.ts` added later.

Judgment call: in optimizer mode, candidates with missing pricing should not win the "cheapest clearing" contest unless all priced candidates fail or no priced candidates exist. They remain eligible for legacy fallback so routing never strands.

### Selection Rule

Let `C` be the legal candidate set after hard filters.

1. Compute `qualityBar`.
2. Compute `expectedQuality(c)` and `expectedUsd(c)` for each `c in C`.
3. Let `P = candidates where expectedQuality(c) >= qualityBar and pricing is known`.
4. If `P` is non-empty, select the candidate with lowest `expectedUsd`.
5. Tie-break among same-cost candidates by higher `expectedQuality`, then existing pool/cooldown/load/session hash rules.
6. If `P` is empty but candidates clear the bar with missing price, either:
   - shadow/off: keep legacy route, record trace only;
   - on: select the highest-quality clearing candidate only if policy permits `missingPricingBehavior: 'allow'`.
7. If no candidate clears the bar, fall back to current routing and optionally surface `optimizer:no-clearing-candidate` in trace.

This composes with tier/capability filtering as additive scoring. It does not replace tier selection, flagship admission, capability hard filters, subscription account routing, or retry/failover behavior.

## Integration Points

### Shared Optimizer Module

Recommended new pure module:

```txt
src/core/routing-optimizer.ts
```

Suggested exports:

```ts
export interface RoutingOptimizerParams { ... }
export interface RoutingOptimizerTrace { ... }
export interface OptimizerCandidate { ... }
export interface OptimizerDecision {
  readonly provider: ProviderId;
  readonly model: string;
  readonly expectedQuality: number;
  readonly qualityBar: number;
  readonly expectedUsd?: number;
  readonly reasons: readonly string[];
}
export function estimateQualityBar(input): number
export function scoreCandidateQuality(input): number
export function estimateCandidateCost(input): number | undefined
export function selectCheapestClearingCandidate(input): OptimizerDecision | null
```

This keeps `route.ts` and `vendor-neutral-route.ts` from growing two competing implementations.

### `src/core/vendor-neutral-route.ts`

Primary live integration point:

- `vendorNeutralRoute(params: VendorNeutralRouteParams): RouteResult`
- `buildCandidates(params, trace)`
- `passesHardRequirements(candidate, tier, params)`
- `suitabilityScore(candidate, tier, opencodeVerboseFacts)`
- `costQuotaTiebreak(scored, params)`
- `toRouteDecision(candidate, tier)`

Recommended change:

1. Extend `VendorNeutralRouteParams` with optional optimizer context:

```ts
readonly optimizer?: RoutingOptimizerConfig;
readonly mode?: Mode;
readonly risk?: Risk;
readonly routePlan?: boolean;
readonly taskKind?: TaskKind;
readonly expectedOutputTokens?: number;
readonly modelOutcomeStats?: readonly ModelOutcomeStats[];
```

2. Keep steps 1-5 unchanged: build candidates, hard-filter, apply pool override, and soft-prefer native search.
3. Replace or wrap Step 6 ranking:
   - If optimizer is enabled, call `selectCheapestClearingCandidate()` over the remaining candidates.
   - Use `suitabilityScore()` as the base quality signal.
   - Use `getModelPricing()` and `calculateEffectiveCost()` inside the optimizer for cost.
   - If the optimizer returns `null`, keep today's suitability ranking and `costQuotaTiebreak()`.

This is the cleanest path because `vendorNeutralRoute()` already has the provider/model candidate set that the optimizer needs.

### `src/core/route.ts`

Secondary/backward-compatible integration point:

- `route(...)`
- `clampTier(requested, ceiling)`
- nested `decisionFor(id)`
- nested `candidateModelsFor(id, allowedSet)`
- nested `applyCapabilityFit(...)`
- `scoreModel(...)`
- `selectReasoningEffort(...)` should remain effort-only, not route selection.

Recommended change:

1. Add optimizer fields to `CapabilityRouteContext` or a sibling route context:

```ts
readonly optimizer?: RoutingOptimizerConfig;
readonly estimatedOutputTokens?: number;
readonly qualityBarOverride?: number;
```

2. In `route()`, after `tier = clampTier(...)` and after the capability hard/soft pre-passes have had their chance, build a bounded candidate list from:
   - `available`
   - `availableModels`
   - `authenticatedProviders`
   - `candidateOrders`
   - `candidateModelsFor()`
   - `PRICING_TABLE` / `getModelPricing()`
   - `findCapability()`
3. Call `selectCheapestClearingCandidate()` only when policy/flag enables it.
4. If a decision is returned, convert it to `RouteDecision` and include concise `capabilityReasons` / optimizer reasons.
5. If no decision is returned, fall through to the current provider-order path unchanged.

Judgment call: the classic router should not become the preferred optimizer path long term because its structure is provider-order-first. It should have a fail-soft compatibility integration, while `vendorNeutralRoute()` should be the main optimizer path once CLI/menu are unified.

### `src/core/policy.ts`

Expose the optimizer as an enhancement under existing modes, not as a fourth mode.

Recommended type addition in `Policy`:

```ts
routingOptimizer?: {
  readonly mode: 'off' | 'shadow' | 'on';
  readonly missingPricingBehavior?: 'fallback' | 'allow';
  readonly stalePricingBehavior?: 'shadow-only' | 'fallback';
}
```

Recommended preset behavior while experimental:

- `cost-saver`: optimizer config is allowed to lower accepted quality bar slightly, but cannot bypass `flagshipAdmission: 'never-auto'`.
- `balanced`: default quality bar, cheapest clearing candidate among legal candidates.
- `quality-first`: higher quality bar and tie-break toward quality before small cost deltas.

Do not add a new top-level user mode. `cost-saver`, `balanced`, and `quality-first` should remain the user's mental model.

### `src/infra/pricing.ts`

Use existing helpers:

- `getModelPricing(provider, model)`
- `calculateCost(inputTokens, outputTokens, pricing)`
- `calculateEffectiveCost(inputTokens, outputTokens, pricing, cache)`
- `isPricingStale(maxAgeDays)`
- `PRICING_TABLE.asOf`

Recommended small addition:

```ts
export function estimateModelCost(input): number | undefined
```

This is optional. The optimizer can call the existing helpers directly, but one helper would centralize cache-aware and missing-pricing behavior.

### `src/core/model-capabilities.ts`

Use existing fields:

- `routingProfile`
- `tierHint`
- `contextWindow` / `maxContextWindow`
- `supportsVision`
- `supportsSearchTool`
- `supportsNativeSession`
- `supportedReasoningEfforts`
- `costSpeedTier`

Do not add guessed quality scores to the declarative registry in v1. The routing profile's `tierSuitability` should be the base quality prior; learned outcomes can adjust it once enough local data exists.

## CLI/Menu Unification

Grounded fact: the one-shot CLI builds deps in `src/cli.ts` and does not set `vendorNeutralEnabled: true`, while `src/interface/menu.ts` explicitly sets it. That divergence should be fixed before or during optimizer rollout.

Recommended design:

1. Extract a shared routing-deps builder for product runtime paths, for example:

```txt
src/interface/routing-deps.ts
```

2. Both `src/cli.ts` `buildDeps()` and `src/interface/menu.ts` should use it to set:
   - `availableModels`
   - `authenticatedProviders`
   - `planInfos`
   - `capabilityRegistry`
   - `learnedProviderOrder`
   - `vendorNeutralEnabled`
   - optimizer flag/config
3. Set `vendorNeutralEnabled: true` whenever:
   - a capability registry is present, and
   - authenticated providers and advertised models are available, and
   - the vendor-neutral path can fail-soft to `route()` as `work-call.ts` already does.
4. Keep one-shot behavior protected by the same fallback as menu behavior: if `vendorNeutralRoute()` returns `NoCapableProvider` or optimizer returns `null`, call classic `route()`.

Judgment call requiring approval: unifying CLI and menu around vendor-neutral routing can change one-shot provider/model choices even without the optimizer. It is architecturally correct, but it should be staged behind the same experimental flag or a separate `MYSHELL_VENDOR_NEUTRAL_CLI` migration flag if compatibility risk matters.

## Routing Memory and Data

Grounded fact: `routing-memory.ts` currently ranks providers/models from observed success and latency, explicitly not USD/token data. `LedgerEntry` already records `inputTokens`, `outputTokens`, cached token counts, `usd`, `durationMs`, `success`, `tier`, `model`, `provider`, `reasoningEffort`, and `taskKind`.

Recommendation:

- Do not change the existing `learnProviderOrder()` semantics. It should remain success/latency only to avoid surprising current routing.
- Add separate cost-aware aggregators instead:

```ts
computeModelCostQualityStats(entries, taskKind)
learnCostQualityModelPriors(entries, taskKind)
```

The aggregator can use existing ledger fields for:

- actual USD
- average input/output tokens
- average duration
- success rate
- smoothed success / confidence weight
- task kind
- reasoning effort

Minimal schema addition:

```ts
interface LedgerEntry {
  readonly routingObjective?: {
    readonly optimizerVersion: 'cost-quality-v1';
    readonly mode: 'off' | 'shadow' | 'on';
    readonly qualityBar: number;
    readonly expectedQuality: number;
    readonly expectedUsd?: number;
    readonly selectedBy: 'legacy' | 'optimizer' | 'optimizer-shadow';
  };
}
```

This metadata is not required to compute actual cost outcomes, because `usd` and tokens already exist. It is useful for validating optimizer calibration: did the selected candidate clear the predicted bar, and were the estimated costs close to actual costs?

Judgment call: do not add a new `qualityCleared` field in v1. Use `success` plus existing acceptance/review outcomes as the observed quality proxy until there is a separate, well-defined acceptance signal.

## Rollout Plan

### Flag

Use the existing explicit opt-in pattern:

- Env: `MYSHELL_ROUTING_OPTIMIZER_V1`
- Config: `experimentalRoutingOptimizerV1?: boolean`
- Helper: `src/interface/ui/routing-optimizer-flag.ts`
- Truthy values: `1`, `true`, `on`, `yes`
- Default: off

This matches the `MYSHELL_SEMANTIC_PREFLIGHT_V1`, `MYSHELL_SUBSCRIPTIONS`, and `MYSHELL_GOAL_STEWARD` style documented in the grounding file and visible in the current flag helpers.

### Stages

1. `off`: no behavior change.
2. `shadow`: compute optimizer decision and trace, but execute legacy route. Record `routingObjective.selectedBy: 'optimizer-shadow'`.
3. `on-for-worker`: allow optimizer to choose only worker-tier candidates.
4. `on-for-worker-ic`: allow worker and IC, but never manager unless existing flagship admission already granted it.
5. `on`: allow all already-admitted tiers. Still no bypass of `flagship.ts`.

Validation gates:

- Unit tests for `estimateQualityBar()`, `scoreCandidateQuality()`, and `selectCheapestClearingCandidate()`.
- Golden tests proving `off` is behavior-identical.
- Tests for stale/missing pricing fallback.
- Tests that auth/cooldown/subscription filters cannot be bypassed.
- Shadow report comparing legacy choice vs optimizer choice, predicted USD vs actual USD, and success rate by task kind.

### Fail-Soft Behavior

- If `isPricingStale()` is true, emit a warning and either run shadow-only or fall back to legacy selection, depending on policy config.
- If a candidate has missing pricing, exclude it from the cheapest-priced clearing pool but keep it eligible for legacy fallback.
- If all priced candidates fail the quality bar, fall back to existing suitability/policy routing.
- If capability registry is missing, do not run the optimizer.
- If available model data is missing, do not invent candidates; use current `route()` fallback behavior.
- If the optimizer throws, catch at the route integration point and continue with current routing.

## Risks

- Fail-soft regression: current routing is deliberately resilient. The optimizer must return `null` instead of hard failing when metadata is absent, stale, or contradictory.
- Gate bypass: auth, cooldown, subscription, account selection, policy max tier, and flagship admission must remain authoritative.
- Competing router risk: a separate optimizer path could diverge from `route()` and `vendorNeutralRoute()`. Mitigation: shared pure scoring module consumed by both, not a new orchestration branch.
- Explanation quality: routing explanations can become noisy. The trace should say only: quality bar, expected quality, expected cost, and the top reason a cheaper candidate was rejected.
- Pricing freshness: static pricing can become stale. The flag should default off and stale pricing should force shadow/fallback.
- Quality calibration: static thresholds may be wrong. Mitigation: shadow mode, conservative thresholds, and learned adjustments only after minimum sample sizes.
- Subscription reality: on flat-rate plans, USD may not be the user's scarce resource. The optimizer should be framed as API-cost aware where prices apply, while cooldown/quota/subscription routing still governs availability.

## Blast Radius

Estimated implementation size: medium, roughly 6-10 source files plus tests.

Primary files:

- `src/core/routing-optimizer.ts` - new pure objective/scoring module.
- `src/core/vendor-neutral-route.ts` - main integration point.
- `src/core/route.ts` - compatibility integration for classic routing.
- `src/core/policy.ts` and `src/core/types.ts` - policy/config shape.
- `src/core/routing-memory.ts` - separate cost/quality aggregators.
- `src/infra/pricing.ts` - optional cost-estimation helper.
- `src/core/orchestrate-signals.ts` - expected output/token signal helper if added.
- `src/cli.ts` - unify one-shot deps.
- `src/interface/menu.ts` - use shared routing deps.
- `src/infra/config.ts` and `src/interface/ui/routing-optimizer-flag.ts` - new gate.

Likely tests:

- `test/core/routing-optimizer.test.ts`
- `test/core/vendor-neutral-route.test.ts`
- `test/core/route.test.ts`
- `test/core/routing-memory.test.ts`
- `test/interface/routing-deps.test.ts` or equivalent CLI/menu parity test.
- Arch/purity guard updates if a new pure module is added.

## Open Questions Requiring Approval

1. Quality threshold values: approve or revise the proposed base bars and mode/risk adjustments.
2. Missing pricing behavior: should missing-price candidates be excluded from optimizer wins, or allowed when their quality is clearly higher?
3. Stale pricing behavior: should stale pricing force shadow-only, or allow optimizer decisions with a warning?
4. CLI/menu unification: should one-shot CLI adopt vendor-neutral routing as soon as capability data is present, or should that be separately gated for compatibility?
5. Ledger schema: approve the optional `routingObjective` metadata, or keep validation entirely out-of-band in shadow logs.
6. Expected output token heuristic: approve static estimates by task kind/tier for v1, or require learned output averages before enabling optimizer-on.
7. Policy exposure: approve embedding optimizer posture under existing `Policy`, rather than adding a fourth user-visible routing mode.

## Implementation Notes

The implementation should preserve this invariant:

```txt
legal candidates are defined by existing routing gates;
the optimizer only chooses among legal candidates;
when uncertain, it returns null and legacy routing runs.
```

That invariant is the main guardrail preventing this feature from becoming a parallel routing system.
