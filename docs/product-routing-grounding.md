# Product Routing Grounding

## Scope

This scan is limited to product-runtime model/provider routing and adjacent selection logic under `src/`. It is not a design review of docs or dormant plans except where runtime code explicitly wires them in.

## 1. Routing and selection logic that exists today

### Main runtime decision path

- `src/cli.ts`
  - Builds `OrchestrateDeps` in `buildDeps()`.
  - Populates `providers`, `availableModels`, `authenticatedProviders`, `planInfos`, and optionally `capabilityRegistry`.
  - One-shot `run` path also composes preflight deps via `src/interface/preflight-deps.ts`.
  - Important nuance: the one-shot CLI path does **not** set `vendorNeutralEnabled: true` in `buildDeps()`, so it mainly uses the classic `route()` path.
- `src/interface/menu.ts`
  - Interactive runtime assembles the richer per-turn deps.
  - Passes `availableModels`, `authenticatedProviders`, `planInfos`, `capabilityRegistry`, `subscriptionAccounts`, and `learnedProviderOrder`.
  - Explicitly sets `vendorNeutralEnabled: true`, so the interactive product path uses the vendor-neutral routing layer when capability data is present.

### Deterministic tier routing

- `src/core/classify.ts`
  - Produces initial tier/risk classification from rules.
- `src/core/router.ts`
  - `decideRoute()` keeps the rules result when there is explicit tier evidence.
  - On ambiguous turns only, it may ask a cheap worker-tier model classifier to pick `worker` / `ic` / `manager` and whether `plan: true`.
  - This is model-backed tier selection, not provider optimization.
- `src/core/route-classifier.ts`
  - Implements that cheap routing-model call.
  - It routes the classifier itself to the `worker` tier using `route()`, then sends the tiny routing prompt.

### Concrete provider/model selection

- `src/core/route.ts`
  - Core provider+model selector.
  - Starts from tier, clamps via policy, then selects a provider and model.
  - Uses `policy.providerOrderByTier` first; if no preferred provider is available, falls back to `getCheapestForTier()` from `src/infra/pricing.ts`.
  - Uses `availableModels` so it prefers models the installed provider CLI actually advertises.
  - Prefers authenticated providers over merely installed ones when `authenticatedProviders` is available.
  - Accepts `preferredOrder` to reorder providers dynamically.
  - Has bounded capability-fit within the chosen provider:
    - vision
    - large-context fit
    - native search soft preference
    - native session support soft preference
    - learned model-outcome tie-break
  - Also exposes `selectReasoningEffort()` for per-model effort sizing.

### Vendor-neutral provider/model routing

- `src/core/vendor-neutral-route.ts`
  - Deterministic provider-agnostic router over authenticated providers and concrete advertised models.
  - Builds candidates from `availableModels` + capability registry + routing profiles.
  - Hard-filters on tier admission, vision, context window, and adapter passability.
  - Soft-prefers native search when relevant.
  - Ranks candidates by suitability, then applies pool/cooldown/load tie-breakers.
- `src/core/route-types.ts`
  - Routing profile types, quota-pool identities, and OpenCode tier ranking support.
- `src/core/work-call.ts`
  - In the main work loop, calls vendor-neutral routing when `vendorNeutralEnabled` and `capabilityRegistry` are present; otherwise falls back to classic `route()`.
- `src/interface/menu.ts`
  - Wires `vendorNeutralEnabled: true` for the interactive path.

### Policy, mode, and flagship admission

- `src/core/policy.ts`
  - Defines the policy presets and provider order by tier.
  - Modes are `cost-saver`, `balanced`, `quality-first`.
  - `maxTier` is a safety clamp, but flagship admission is now the primary control.
- `src/core/flagship.ts`
  - Governs whether a turn may use `manager` tier.
  - Decision is based on risk, confidence/escalation triggers, per-turn flagship budget, and observed free-plan veto.
  - This is about tier access, not cheapest-provider selection.

### Capability and effort selection

- `src/core/model-capabilities.ts`
  - Capability registry and routing profiles.
  - Encodes model traits like tier hints, context windows, vision, search tool, native session support, routing profiles, and supported reasoning efforts.
- `src/core/orchestrate-signals.ts`
  - Derives `taskKind`, input-size estimate, and selects `reasoningEffort` for the resolved provider/model.
- `src/providers/claude.ts` and peers
  - Provider adapters consume the selected model and optional reasoning effort.
  - Provider-effort wiring is gated; it does not choose providers.

### Learned/adaptive ordering

- `src/core/routing-memory.ts`
  - Learns provider order from the user's own ledger by tier using observed success rate and latency.
  - Separately learns model outcome order by task kind.
  - Explicitly does **not** use USD or token counts for ranking.
- `src/interface/menu.ts`
  - Threads learned provider order into `learnedProviderOrder`.
- `src/core/route.ts`
  - Consumes that order as `preferredOrder`.

### Subscription/account selection

- `src/infra/subscriptions.ts`
  - Defines subscription-account storage and env injection.
- `src/core/opencode-account-routing.ts`
  - Picks which subscription account to use for the already-selected provider/model.
  - Strategy is `sticky` in efficient/balanced and `spread` in quality-first.
- `src/core/work-call.ts`
  - Applies account selection after provider/model routing, before provider invocation.
- `src/interface/menu.ts`
  - Enriches deps with `subscriptionAccounts`, cooldown maps, and usage tracking when subscriptions are enabled.

### Semantic preflight and goal steward

- `src/interface/preflight-deps.ts`
  - Builds `routeClassifier`, `intentExtractor`, and dark `semanticPreflightExtractor`.
- `src/core/semantic-preflight.ts`
  - Defines the semantic-preflight output shape: objective, route tier/plan, risk, uncertainty, evidence needs, done condition, plan steps, and proposed execution effort/provider.
  - This is pre-execution analysis, not provider cost optimization.
- `src/core/goal-steward.ts`
  - Deterministic goal audit engine for stale/blocked/done goals.
- `src/interface/menu-goal-review-wiring.ts`
  - Wires goal steward at conversation-open only; it does not route turns to providers.

## 2. Does current runtime already do cost-aware or quality/capability-aware model selection?

### Yes: there is real routing intelligence already

The runtime already has all of the following:

- tier selection (`worker` / `ic` / `manager`)
- provider ordering by policy
- authenticated-provider preference
- fallback to cheapest model for a tier using `src/infra/pricing.ts`
- capability-aware hard filtering and soft preferenceing
- vendor-neutral routing in the interactive path
- adaptive flagship admission by plan/risk/confidence
- learned provider ordering from observed success/latency
- learned model tie-breaks by task kind
- per-model reasoning-effort selection
- subscription-account selection within a provider

### But its optimization target is not "cheapest model that clears a quality bar"

What the current runtime optimizes for:

- coarse tier appropriateness
- capability fit
- authenticated availability
- plan/quota posture
- success/latency from observed outcomes
- some static price ordering as a fallback or baseline

What it does **not** currently do:

- estimate a task-specific quality threshold and then search for the cheapest provider/model that clears it
- trade off expected quality against expected dollar cost across providers/models using a unified objective
- use live or learned cost/quality curves to choose between two equally capable candidates
- use ledger USD/token data to rank providers or models

Important evidence:

- `src/core/routing-memory.ts` explicitly says it ranks only on observed `success` and `durationMs`, never `usd` or tokens.
- `src/core/flagship.ts` is quota/subscription-oriented, not API-spend-oriented.
- `src/core/route.ts` does use `getCheapestForTier()`, but only inside a tiered policy/capability framework; it is not a generalized cost-vs-quality optimizer.
- `src/core/vendor-neutral-route.ts` ranks by suitability and pool/load tie-breakers, not by "minimum expected spend for acceptable quality."

## 3. Net-new or enhancement?

Task-calibrated "cheapest model that clears a quality bar" routing is an **enhancement of existing routing architecture**, not a greenfield feature.

Why it is an enhancement:

- There is already a runtime router, not just static provider selection.
- There is already provider-agnostic candidate construction and capability filtering.
- There is already a capability registry, routing profiles, learned ordering, tiering, and pricing table.
- There is already a place where routing policy decisions are centralized: primarily `src/core/route.ts`, `src/core/vendor-neutral-route.ts`, `src/core/policy.ts`, and the menu/CLI deps assembly.

Why it is still materially net-new in behavior:

- The **objective function** would be new.
- Current code does not compute "quality bar cleared" as an explicit thresholded optimization problem.
- Current code does not combine cost, quality expectation, and task requirements into one per-turn scoring/ranking function.

Bottom line: architecturally this is an enhancement; behaviorally the cost/quality-aware selection logic itself would be a substantial new capability.

## 4. Rough blast radius for a real implementation

Primary modules likely touched:

- `src/core/route.ts`
  - If the classic router gains explicit cost/quality scoring.
- `src/core/vendor-neutral-route.ts`
  - Likely the main ranking function if the product wants provider-agnostic "best acceptable cheapest" routing in the interactive path.
- `src/core/model-capabilities.ts`
  - To add quality/capability metadata or learned quality priors beyond the current routing profiles.
- `src/core/routing-memory.ts`
  - If learned quality/cost signals are added from ledger data.
- `src/infra/pricing.ts`
  - If price data becomes a first-class ranking input rather than mostly a baseline/fallback.
- `src/core/policy.ts`
  - If new routing modes/objectives/thresholds are user-configurable.
- `src/core/orchestrate-signals.ts`
  - If task difficulty or quality-bar estimation is promoted into routing inputs.
- `src/interface/menu.ts`
  - For wiring flags, learned inputs, and possibly UI disclosure.
- `src/cli.ts`
  - To keep one-shot behavior aligned with menu behavior; today the two paths are not identical because vendor-neutral routing is only explicitly enabled in menu.

Secondary modules that may need updates:

- `src/interface/preflight-deps.ts`
  - If preflight should estimate required quality bar.
- `src/commands/cost.ts`
  - If reporting should explain new routing decisions.
- `src/core/work-call.ts`
  - If review/failover/escalation should reuse the new optimizer consistently.
- provider adapters under `src/providers/`
  - Only if new routing needs additional provider metadata surfaced.

Risk areas:

- preserving current fail-soft behavior
- keeping auth/cooldown/subscription constraints authoritative
- avoiding divergence between menu and one-shot runtime paths
- keeping routing explanations honest and legible

## 5. Relevant gated flags

- `SEMANTIC_PREFLIGHT_V1`
  - Env/config gate is implemented by `src/interface/ui/semantic-preflight-flag.ts`.
  - Config field lives in `src/infra/config.ts` as `experimentalSemanticPreflightV1`.
  - Wiring occurs in `src/interface/preflight-deps.ts`.
  - Purpose: switches preflight/evidence extraction path; not a router optimizer.

- `SUBSCRIPTIONS`
  - Env/config gate is implemented by `src/interface/ui/subscriptions-flag.ts`.
  - Config field lives in `src/infra/config.ts` as `experimentalSubscriptions`.
  - Wiring occurs in `src/interface/menu.ts` via `enrichDepsWithAccounts()`.
  - Purpose: enables account-scoped provider execution and account selection after provider/model routing.

- `GOAL_STEWARD`
  - Env/config gate is implemented by `src/interface/ui/goal-steward-flag.ts`.
  - Config field lives in `src/infra/config.ts` as `experimentalGoalSteward`.
  - Wiring occurs in `src/interface/menu-goal-review-wiring.ts`.
  - Purpose: deterministic goal audit at conversation-open; not part of model/provider routing.

## Bottom line

The product runtime already has non-trivial routing and selection intelligence: tier routing, provider ordering, capability-aware routing, interactive vendor-neutral routing, reasoning-effort selection, learned provider/model ordering, and subscription-account selection. What it does not yet have is an explicit cost/quality optimizer that chooses the cheapest candidate that still satisfies a task-specific quality threshold.
