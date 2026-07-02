# Item 5 contract - one authoritative TurnPlan after semantic preflight

Status: delegation-ready implementation contract, grounded at repository head `ff831cd` on 2026-07-02.

This document is controlling for Round-7 Item 5. Item 9 is already shipped as the observe-only budget/event ledger foundation. Item 8 is already shipped dark through `MYSHELL_SEMANTIC_PREFLIGHT_V1`, but default-on promotion 08k has not landed. This contract therefore finalizes and enforces a `TurnPlan` only behind explicit Item-5 flags and must keep Item 8, Item 9, and the provider architecture guard green after every slice.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_TURNPLAN_V1` is explicitly enabled, a foreground turn starts with the existing Item-9 `TurnCallBudget`, runs the semantic preflight path when Item 8 is enabled, and then finalizes exactly one immutable `TurnPlanV1` before evidence collection, panel/hedge selection, verification, repair, failover, review, background planning, or ordinary work can open another provider stream. The plan is the sole source of truth for task shape, selected execution strategy, provider/model/effort order, reserved work/failover/verification units, allowed auxiliary calls, research/evidence obligations, fallback order, quota evidence, and user-facing Auto receipt text. Every later model call is reconciled against a serialized plan allocation and the shipped Item-9 ledger receipt.

This item does **not**:

- redesign the Item-9 ledger domain, purpose names, receipt callback, or `runBudgetedProvider` seam;
- enforce by merely wrapping all provider calls after preflight. That is too late for route/intent/semantic calls and too coarse for failover, verification, panel, hedge, research, and background calls;
- authorize unlimited calls from a seam because a semantic preflight succeeded. A plan allocation is purpose, bucket, stage, provider, and max-call bounded;
- remove the independent failover reserve. Work failures that are recoverable today must still be recoverable under the dark plan path;
- make Item 8 default-on. If semantic preflight is off, Item 5 can run in legacy-preflight reconciliation mode, but default-on semantic promotion remains Item 8's 08k gate;
- mark completion verified. Item 17 owns final completion truth. Item 5 only reserves and authorizes verification/review work;
- let Auto/Smart UI copy claim quota headroom, provider quality, or verification that is not present in the actual `TurnPlanV1` and actual ledger receipt;
- persist exactly-once/restartable execution state. Item 10 owns durable replay and resume.

The current plan would be unsafe if "single TurnPlan" were interpreted as "one post-preflight counter that denies every later call after the first work attempt." That would convert a recoverable provider-local failure into no answer. The smaller contract here preserves a named failover reserve and a one-use loss-preservation override while still making every accepted call reconcile to the plan.

## 2. Current-state evidence and invariants

All citations below are current at `ff831cd`; workers must re-run `nl -ba` or equivalent before editing and record drift rather than silently relying on stale line ranges.

- Item 9 defines the existing call buckets and purposes at `src/core/turn-call-budget.ts:9-39`, the observe/enforce modes and budget spec at `src/core/turn-call-budget.ts:41-54`, request metadata at `src/core/turn-call-budget.ts:56-61`, and receipt shape at `src/core/turn-call-budget.ts:128-160`.
- The current budget spec hard-validates `reserved.work === 1`, `failover` and `verification` as 0/1, and reservation sum within `totalUnits` at `src/core/turn-call-budget.ts:182-207`.
- The ledger consumes bucket capacity and records begun/settled events at `src/core/turn-call-budget.ts:305-395`; observe mode emits `call-would-deny` instead of blocking at `src/core/turn-call-budget.ts:326-347`.
- Work reservation can be finalized only once and only before work execution starts at `src/core/turn-call-budget.ts:398-421`.
- Loss-preservation override already exists, is one-use, requires an existing work/failover failed call, validates reason, requires a distinct next provider and retained idempotency key, and restores one failover unit at `src/core/turn-call-budget.ts:424-495`.
- The budgeted provider seam starts the ledger call only when the stream is first pulled at `src/core/budgeted-provider.ts:28-80`, settles success/provider-error at `src/core/budgeted-provider.ts:111-120`, and settles abandoned return at `src/core/budgeted-provider.ts:126-139`.
- The architecture guard rejects direct product `Provider.run` outside the seam and scans `src/core` plus `src/interface` at `test/arch/provider-call-budget-guard.test.ts:1-18,134-163`.
- Item 8's semantic contract exists at `src/core/semantic-preflight.ts:48-81`; the trivial/run disposition helper is at `src/core/semantic-preflight.ts:184-197`.
- The semantic extractor records its single model call as `purpose:'intent'`, `bucket:'discretionary'` at `src/core/semantic-preflight-extractor.ts:151-155`.
- Orchestrate's semantic branch is already dark and suppresses legacy preflight/re-extraction when `semanticPreflightV1` is true at `src/core/orchestrate.ts:342-358,424-450`.
- Production preflight composition still builds legacy route and intent closures at `src/interface/preflight-deps.ts:55-112`, then adds the semantic extractor only when `semanticPreflightV1Enabled` is true at `src/interface/preflight-deps.ts:114-180`.
- `MYSHELL_SEMANTIC_PREFLIGHT_V1` is default-off in the config mirror at `src/infra/config.ts:377-383` and flag helper at `src/interface/ui/semantic-preflight-flag.ts:1-30`.
- Menu currently mints one observing Item-9 budget per foreground turn with `totalUnits:64`, `work:1`, `failover: authedCount >= 2 ? 1 : 0`, and `verification: verifyOn ? 1 : 0` at `src/interface/menu.ts:6071-6096`.
- Menu publishes the observing budget receipt after `runTaskWithInputHooks` and swallows receipt-callback errors at `src/interface/menu.ts:6159-6171`.
- `OrchestrateDeps` exposes `semanticPreflightV1`, `semanticPreflightExtractor`, `turnCallBudget`, and the receipt callback at `src/core/types.ts:725-819`.
- The current governor/panel/hedge decision point is after semantic preflight but before work at `src/core/orchestrate.ts:2061-2115` and `src/core/orchestrate.ts:2115-2185`.
- Sequential work appends the user message and then re-derives tier admission/routing at `src/core/orchestrate.ts:2187-2327` before delegating to `runWorkCall`.
- `runWorkCall` still owns the ordinary loop budget and explicitly allows queued failover independently of ordinary attempt exhaustion at `src/core/work-call.ts:1246-1253`.
- The sequential work call maps normal work to `purpose:'work'`, `bucket:'work'`, and failover to `purpose:'failover'`, `bucket:'failover'` at `src/core/work-call.ts:1520-1527`.
- Timeout is currently terminal, not cross-vendor failover, at `src/core/work-call.ts:1841-1918`. Any Item-5 override must preserve this unless a later slice explicitly proves a usable partial-draft preservation case.
- Recoverable cross-vendor failover and rate-limit draft salvage are current behavior at `src/core/work-call.ts:1920-2000`; enforcement must not strand that path.
- Panel candidates and synthesis consume work bucket calls at `src/core/ensemble.ts:1089-1097` and `src/core/ensemble.ts:1910-1923`; panel review consumes verification at `src/core/ensemble.ts:2052-2112`.
- Hedge primary/secondary consume work at `src/core/hedge.ts:501-510`; hedge review consumes verification at `src/core/hedge.ts:857-870`; hedge repair currently consumes discretionary at `src/core/hedge.ts:963-1021`.
- Reasoning effort is currently selected after routing and never opens manager by itself at `src/core/route.ts:795-836`; Item 5 may centralize this decision but must preserve the same policy ceiling.

Baseline at this head:

| surface | current source of authority | Item-5 requirement |
|---|---|---|
| route/intent/semantic preflight | Item-9 observe ledger plus legacy/semantic branch logic | reconciled as pre-plan observed calls; semantic path remains at most one `intent` call when Item 8 flag is on |
| work | `runWorkCall` loop, numeric `turnCallBudget`, route/effort in consumers | authorized by a `work` allocation and reconciled to actual `work` ledger calls |
| provider failover | independent failover loop plus Item-9 failover bucket | keep a reserved failover allocation or a named loss-preservation override |
| verification/review/repair | accept-stage, panel/hedge/work local rules | authorized by verification/repair/review allocations; no completion claim |
| panel/hedge/judgment/tribunal | policy flags plus governor/numeric budgets | selected only by `TurnPlanV1.execution.strategy` and explicit allocations |
| meta/recap/understanding/goal/research/autostage | distributed helper seams | either allocated as background/research or denied/skipped with a receipt reason |

## 3. Shared typed contract

Slice 05a must export these names from `src/core/turn-plan.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them.

```ts
export type TurnPlanShape =
  | 'quick'
  | 'answer'
  | 'investigate'
  | 'build'
  | 'decide'
  | 'risky'
  | 'review';

export type TurnPlanStrategy =
  | 'none'
  | 'single'
  | 'panel'
  | 'hedge'
  | 'judgment'
  | 'tribunal';

export type TurnPlanStage =
  | 'preflight'
  | 'evidence'
  | 'work'
  | 'failover'
  | 'verification'
  | 'repair'
  | 'review'
  | 'panel'
  | 'hedge'
  | 'research'
  | 'background';

export type TurnPlanAllocationId = string;

export interface TurnPlanCallAllocation {
  readonly id: TurnPlanAllocationId;
  readonly stage: TurnPlanStage;
  readonly purpose: TurnCallPurpose;
  readonly bucket: TurnCallBucket;
  readonly maxCalls: number;
  readonly required: boolean;
  readonly providerOrder: readonly ProviderId[];
  readonly modelByProvider: Partial<Record<ProviderId, string>>;
  readonly effortByProvider: Partial<Record<ProviderId, ReasoningEffort>>;
  readonly parentAllocationId?: TurnPlanAllocationId;
  readonly allowLossPreservationOverride?: boolean;
  readonly rationale: string;
}

export interface TurnPlanObservedCall {
  readonly callId: string;
  readonly purpose: TurnCallPurpose;
  readonly bucket: TurnCallBucket;
  readonly outcome?: TurnCallOutcome;
}

export interface TurnPlanQuotaEvidence {
  readonly provider: ProviderId;
  readonly kind:
    | 'observed-cooldown'
    | 'session-consumption'
    | 'plan-label'
    | 'unknown';
  readonly value: string;
}

export interface TurnPlanVerification {
  readonly required: boolean;
  readonly level: 'none' | 'tests' | 'tests+critic';
  readonly reservedUnit: 0 | 1;
  readonly obligations: readonly string[];
}

export interface TurnPlanRecovery {
  readonly reservedFailoverUnit: 0 | 1;
  readonly fallbackOrder: readonly ProviderId[];
  readonly lossPreservationOverride:
    | { readonly allowed: true; readonly reasons: readonly LossPreservationReason[] }
    | { readonly allowed: false; readonly reason: string };
}

export type LossPreservationReason =
  | 'rate-limit'
  | 'auth'
  | 'transport-failure'
  | 'empty'
  | 'threw'
  | 'usable-partial-draft'
  | 'timeout-with-usable-partial-draft';

export interface TurnPlanV1 {
  readonly version: 1;
  readonly id: string;
  readonly turnId: string;
  readonly budgetId: string;
  readonly createdAt: string;
  readonly source: 'semantic-v1' | 'legacy-reconciled';
  readonly objective: string;
  readonly doneCondition: string | null;
  readonly shape: TurnPlanShape;
  readonly risk: Risk;
  readonly uncertainty: 'low' | 'medium' | 'high' | 'unknown';
  readonly routePlan: boolean;
  readonly execution: {
    readonly strategy: TurnPlanStrategy;
    readonly tier: Tier;
    readonly providerOrder: readonly ProviderId[];
    readonly modelByProvider: Partial<Record<ProviderId, string>>;
    readonly effortByProvider: Partial<Record<ProviderId, ReasoningEffort>>;
  };
  readonly budget: {
    readonly totalUnits: number;
    readonly reserved: {
      readonly work: number;
      readonly failover: 0 | 1;
      readonly verification: 0 | 1;
    };
    readonly workReservationUnits: number;
    readonly discretionaryMax: number;
  };
  readonly preflightObserved: readonly TurnPlanObservedCall[];
  readonly allocations: readonly TurnPlanCallAllocation[];
  readonly verification: TurnPlanVerification;
  readonly research: {
    readonly local: boolean;
    readonly web: boolean;
    readonly requiredBeforeWork: boolean;
  };
  readonly recovery: TurnPlanRecovery;
  readonly quotaEvidence: readonly TurnPlanQuotaEvidence[];
  readonly receiptLine: string;
}

export interface FinalizeTurnPlanInput {
  readonly turnId: string;
  readonly budgetReceiptBeforePlan: TurnCallBudgetReceipt;
  readonly semantic?: ResolvedSemanticPreflight;
  readonly legacy: {
    readonly classification: Classification;
    readonly routePlan: boolean;
    readonly intentFrame?: IntentFrame;
  };
  readonly authenticatedProviders: readonly ProviderId[];
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly policy: Policy;
  readonly mode: Mode;
  readonly quotaEvidence: readonly TurnPlanQuotaEvidence[];
  readonly evidenceNeeds: readonly EvidenceNeed[];
  readonly verifyRequested: boolean;
  readonly nowIso: string;
  readonly uuid: () => string;
}

export function finalizeTurnPlan(input: FinalizeTurnPlanInput): TurnPlanV1;
```

Caps are part of the contract: objective 80 characters; done condition 160; receipt line 180; allocation rationale 120; quota value 120; at most 24 allocations, 12 observed preflight calls, 12 quota evidence entries, 12 fallback providers, and 16 verification obligations. IDs must match `/^[a-z][a-z0-9_-]{0,47}$/`. Unknown enum values fail parsing when deserializing fixtures. Extra JSON keys are ignored only by a dedicated `parseTurnPlanV1` helper, never by `finalizeTurnPlan`.

Pure finalization rules:

- If `semantic` is present, `source='semantic-v1'`, objective/done/shape/risk/uncertainty come from the resolved semantic result with deterministic risk already floored by Item 8. If absent, `source='legacy-reconciled'` and the plan uses deterministic classification plus any legacy `IntentFrame` goal/done fields.
- `preflightObserved` is copied from `budgetReceiptBeforePlan.events` and may contain `route`, `intent`, `reextract-local`, `reextract-web`, `research-web`, `recap`, or `understanding` calls that already occurred before finalization. It reconciles those calls; it does not pretend the final plan authorized them retroactively.
- Future calls are authorized only by `allocations`. Each allocation is exact on `purpose`, `bucket`, stage, `maxCalls`, and provider order.
- `budget.totalUnits` equals the existing `TurnCallBudgetReceipt.totalUnits`; finalization cannot increase it. Work reservation can only move units from discretionary into work via `finalizeWorkReservation`.
- `reserved.failover` is `1` whenever at least two authenticated providers can serve the selected tier and the strategy can perform provider-local failover. Quota pressure may reduce optional panel/hedge/review/background allocations before it removes this failover reserve.
- `reserved.verification` is `1` when verification is requested, Item 8 carries a before-completion test/review obligation, or a strategy depends on critic review. Optional background/research allocations cannot borrow this unit.
- `workReservationUnits` is the exact number of work bucket calls required by the chosen strategy: `0` for `none`, `1` for `single`, `2` for `hedge`, `3` for panel with two candidates plus synthesis, and higher only if a named tribunal fixture explicitly proves the extra work calls and discretionary capacity exists. If capacity is insufficient, degrade the strategy before touching failover or verification reserves.
- `lossPreservationOverride.allowed` is true only for provider-local recoverable failures where the next provider is distinct and the idempotency key is retained. Timeout is eligible only as `timeout-with-usable-partial-draft`; today's terminal timeout behavior remains the default.
- A legitimate core answer is never starved by optional reservations. If `totalUnits` is squeezed, shed in this order: background, optional research, judgment/tribunal, panel/hedge, optional critic/review, optional repair. Keep one work unit and eligible failover before optional spend.

## 4. Shared rollout, fixture, worktree, and rollback rules

The runtime flags are:

- `MYSHELL_TURNPLAN_V1` / `experimentalTurnPlanV1?: boolean`, default false. When true, compose and emit one dark `TurnPlanV1` and reconcile receipts. In early slices this is test-injected through `OrchestrateDeps.turnPlanV1`.
- `MYSHELL_TURNPLAN_ENFORCE_V1` / `experimentalTurnPlanEnforceV1?: boolean`, default false and ignored unless `TurnPlanV1` is active. When true in the final enforcement slice, the Item-9 budget mode may switch from observe to enforce for authorized foreground turns.

When both flags are off, `MYSHELL_SEMANTIC_PREFLIGHT_V1`, `MYSHELL_UNIFY_PREFLIGHT`, `MYSHELL_RISK_SIGNALS`, `MYSHELL_REQUIRED_INVESTIGATION`, `MYSHELL_GOVERNOR`, panel, hedge, tribunal, and Auto behavior remain current. Rollback is: unset `MYSHELL_TURNPLAN_V1` and `MYSHELL_TURNPLAN_ENFORCE_V1`, set both config mirrors false, restart the process, and confirm the call-budget receipt no longer contains a turn-plan event or allocation IDs. Do not delete persisted or logged plan receipts; they are additive diagnostic records.

Every worker slice must begin with:

```bash
git status --short
git diff --name-only
npx tsc --noEmit
```

Record pre-existing paths and do not edit them. At document creation the worktree was clean before this document was added. A slice is rejected if `git diff --name-only` contains a path outside its exhaustive maximum set. No generated benchmark result under `.tmp/` is committed. No slice may change Item 8's default, Item 9's purpose names, the `runBudgetedProvider` direct-call guard exclusions, or the existing provider adapter contract.

Every slice must include success, failure, cancellation, and injected-crash fixtures. "Injected crash" means a dependency throws at the named boundary. Do not use `process.exit`, kill the test runner, or add sleeps.

## 5. Ordered slices

### P1-05a - `TURNPLAN-DOMAIN`

**One invariant:** pure finalization always returns one complete `TurnPlanV1` whose required work, failover, and verification reservations fit within the existing Item-9 `totalUnits` without borrowing safety reserves for optional calls.

**Preconditions/dependencies:** shipped Item 9 types, Item 8 `ResolvedSemanticPreflight`, existing `Risk`, `Tier`, `Policy`, `Mode`, `ProviderId`, `ReasoningEffort`, and `IntentFrame`. No runtime wiring.

**Maximum file set (exhaustive):**

- `src/core/turn-plan.ts` (new)
- `test/unit/turn-plan.test.ts` (new)

**Typed/behavioral diff:** add the shared types, `parseTurnPlanV1`, `finalizeTurnPlan`, cap helpers, shape derivation, reservation derivation, strategy degradation, quota evidence normalization, and receipt-line formatter. The finalizer reads a `TurnCallBudgetReceipt` but does not mutate a `TurnCallBudget`.

**Named tests:**

- `semantic result produces complete TurnPlanV1 with capped objective done and receipt`
- `legacy reconciliation produces complete plan without semantic preflight`
- `preflight observed calls are copied but not counted as future allocations`
- `panel degrades to single before borrowing failover reserve`
- `verification reserve survives optional background and research pressure`
- `single authenticated provider has no failover reserve but still has one work unit`
- `two authenticated providers reserve failover for recoverable provider-local failure`
- `timeout is not loss-preservation eligible unless usable partial draft is named`
- `allocation ids are stable unique and capped`
- `parse rejects invalid enum negative maxCalls duplicate ids and oversized malformed JSON`

**Fixtures:** success = semantic build/decision/research/quick tables; failure = malformed serialized plans and insufficient total units; cancellation = N/A pure; injected crash = N/A pure, but parser must never throw for proxies, primitives, arrays, invalid JSON, or oversized strings.

**Performance/baseline:** pure work only. Benchmark 100,000 finalizations after 1,000 warmups with `performance.now()`; p95 below 1 ms on CI. Runtime model-call baseline remains zero because module is unreachable.

**Flag/rollback/migration:** runtime flag N/A. Revert the two files. No persisted schema yet.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/turn-plan.ts test/unit/turn-plan.test.ts && npx vitest run test/unit/turn-plan.test.ts test/unit/turn-call-budget.test.ts
```

Expected: finalization cannot increase `totalUnits`, cannot remove eligible failover to fund optional calls, and never lowers Item-8 risk. Before: no `TurnPlanV1`. After: pure domain exists and runtime events/calls/state are unchanged.

### P1-05b - `PLAN-LEDGER-RECONCILER`

**One invariant:** planned allocations and actual Item-9 ledger events reconcile exactly by purpose, bucket, maxCalls, and allocation id; observe mode reports drift without denying calls.

**Preconditions/dependencies:** 05a, shipped Item-9 receipt shape. No product call site changes.

**Maximum file set (exhaustive):**

- `src/core/turn-plan.ts`
- `src/core/turn-plan-reconcile.ts` (new)
- `test/unit/turn-plan.test.ts`
- `test/unit/turn-plan-reconcile.test.ts` (new)
- `test/unit/global-call-budget-receipt.test.ts`

**Typed/behavioral diff:** add:

```ts
export type TurnPlanAuthorization =
  | { readonly allowed: true; readonly allocationId: TurnPlanAllocationId }
  | { readonly allowed: false; readonly reason: string };

export function authorizePlannedCall(
  plan: TurnPlanV1,
  request: TurnCallRequest,
): TurnPlanAuthorization;

export function reconcileTurnPlanReceipt(input: {
  readonly plan: TurnPlanV1;
  readonly receipt: TurnCallBudgetReceipt;
}): TurnPlanReconciliation;
```

The reconciler treats `preflightObserved` as already-spent evidence and all later `call-begun` events as allocation consumption. It reports unknown purpose, wrong bucket, over max, missing required allocation, unfilled verification, and unfilled failover reserve. It never mutates the receipt.

**Named tests:**

- `reconciles semantic preflight intent as observed before plan`
- `work call consumes only matching work allocation`
- `failover call consumes failover allocation with parent ancestry`
- `wrong bucket is drift even when purpose matches`
- `optional unspent background allocation is not a failure`
- `required verification allocation unspent is incomplete`
- `over max panel candidate call is drift`
- `observe drift produces report not denial`
- `loss-preservation override event reconciles to recovery receipt`

**Fixtures:** success = semantic+work+verification+failover receipts; failure = wrong bucket/over max/missing required; cancellation = cancelled receipt settles and reconciles incomplete; injected crash = malformed receipt event array is parsed to a drift report, not thrown.

**Performance/baseline:** 10,000 reconciliations of a 200-event receipt, p95 below 1 ms. No provider calls.

**Flag/rollback/migration:** runtime flag N/A. Revert files. No state.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/turn-plan.ts src/core/turn-plan-reconcile.ts test/unit/turn-plan.test.ts test/unit/turn-plan-reconcile.test.ts test/unit/global-call-budget-receipt.test.ts && npx vitest run test/unit/turn-plan.test.ts test/unit/turn-plan-reconcile.test.ts test/unit/global-call-budget-receipt.test.ts
```

Expected: every actual post-plan call is either matched to one allocation or reported as drift; pre-plan semantic/route/intent calls remain reconciled, not retroactively authorized.

### P1-05c - `DARK-PLAN-COMPOSITION`

**One invariant:** under an injected dark flag, orchestrate emits exactly one `turn-plan` event after semantic/legacy preflight resolution and before evidence, panel, hedge, judgment, tribunal, or work provider calls.

**Preconditions/dependencies:** 05a-05b and Item 8 08j path remains default off. `MYSHELL_TURNPLAN_V1` is not yet read by production entry points.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/orchestrate.ts`
- `src/core/turn-plan.ts`
- `src/core/turn-plan-reconcile.ts`
- `test/unit/orchestrate-turn-plan.test.ts` (new)
- `test/unit/orchestrate-semantic-preflight.test.ts`
- `test/unit/turn-call-budget-preflight.test.ts`

**Typed/behavioral diff:** add optional `OrchestrateDeps.turnPlanV1?: boolean` and CoreEvent `{type:'turn-plan'; plan: TurnPlanV1}`. When `turnPlanV1` is true, call `finalizeTurnPlan` immediately after semantic/legacy preflight resolution and before evidence investigation. Call `turnCallBudget.finalizeWorkReservation(plan.budget.workReservationUnits)` exactly once when a budget is present and no work has begun. Emit no plan when a terminal pre-provider ask returns before work only if the plan strategy is `none` and allocations contain no work call.

**Named tests:**

- `semantic enabled emits one turn-plan after semantic intent and before research or work`
- `legacy preflight emits legacy-reconciled plan when semantic flag is off`
- `trivial terminal path emits none strategy and zero work allocation`
- `work reservation finalizes before first work call`
- `injected finalizer throw falls back to legacy behavior and notice without provider duplication`
- `cancel during semantic preflight emits no partial plan and zero work calls`
- `Item 8 semantic call counts remain unchanged`
- `arch guard remains green`

**Fixtures:** success = semantic model result and legacy intent frame; failure = finalizer throws; cancellation = abort during semantic extractor; injected crash = clock/uuid/finalizer throws. Provider spies fail if work starts before `turn-plan`.

**Performance/baseline:** on fake 25 ms semantic fixture, plan finalization adds below 1 ms p95. Model-call counts are unchanged from Item 8: trivial zero, nontrivial semantic exactly one `intent` when semantic flag is on.

**Flag/rollback/migration:** test-only `OrchestrateDeps.turnPlanV1`; no env/config. Rollback removes the injected field and event. No persistence.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/types.ts src/core/orchestrate.ts src/core/turn-plan.ts src/core/turn-plan-reconcile.ts test/unit/orchestrate-turn-plan.test.ts test/unit/orchestrate-semantic-preflight.test.ts test/unit/turn-call-budget-preflight.test.ts && npx vitest run test/unit/orchestrate-turn-plan.test.ts test/unit/orchestrate-semantic-preflight.test.ts test/unit/turn-call-budget-preflight.test.ts test/arch/provider-call-budget-guard.test.ts
```

Expected before: no `turn-plan` event. Expected after under injection: one immutable plan precedes every post-preflight model call and flag-off output is unchanged.

### P1-05d - `SEQUENTIAL-WORK-AND-FAILOVER-CONSUMER`

**One invariant:** sequential work and provider failover consume plan allocations without regressing today's recoverable cross-provider failover or partial-draft preservation.

**Preconditions/dependencies:** 05c. Work-loop numeric `turnCallBudget` remains as a compatibility guard until final enforcement.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/orchestrate.ts`
- `src/core/work-call.ts`
- `src/core/turn-plan.ts`
- `src/core/turn-plan-reconcile.ts`
- `test/unit/work-call-turn-plan.test.ts` (new)
- `test/unit/work-call-call-budget.test.ts`
- `test/unit/work-call-failover.test.ts`
- `test/unit/governor-authority.test.ts`
- `test/unit/orchestrate-turn-plan.test.ts`

**Typed/behavioral diff:** thread `turnPlan?: TurnPlanV1` into `runWorkCall`. Sequential routing uses the plan's first eligible provider/model/effort when `turnPlanV1` is true and falls back to current `route()` only when the planned provider is absent, unauthenticated, or capability-ineligible; that fallback is reconciled as drift in observe mode. Normal work passes allocation metadata into `runBudgetedProvider` via `TurnCallRequest.metadata.allocationId`. Failover may start only from a `failover` allocation or a granted loss-preservation override. Today's timeout terminal path remains terminal unless the failure reason is `timeout-with-usable-partial-draft`.

**Named tests:**

- `single work call carries work allocation id`
- `planned provider model effort are used when available`
- `planned provider absent falls back and reports drift without no-answer in observe mode`
- `recoverable empty output failover succeeds with turnCallBudget one and failover reserve`
- `rate-limit partial draft failover preserves salvage context under plan`
- `missing failover reserve blocks only under enforce flag and reports actionable final`
- `loss-preservation override grants one distinct-provider failover after eligible failed call`
- `loss-preservation denied for same provider new idempotency key invalid reason and non-work call`
- `timeout remains terminal by default`
- `timeout with usable partial draft uses named override at most once`

**Fixtures:** success = first provider succeeds; failure = first provider empty/rate-limit/auth/transport with second provider available; cancellation = abort before first stream and between work/failover; injected crash = route fallback throws or provider stream throws. No fixture may return no-answer when current legacy path would have answered via failover.

**Performance/baseline:** zero extra model calls. Reconciler overhead below 1 ms p95 for 50-event receipts. Existing quick-turn failover tests remain green.

**Flag/rollback/migration:** only active under injected `turnPlanV1`; enforcement still observe. Rollback omits `turnPlan` from `runWorkCall` and uses current routing/failover. No state.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/types.ts src/core/orchestrate.ts src/core/work-call.ts src/core/turn-plan.ts src/core/turn-plan-reconcile.ts test/unit/work-call-turn-plan.test.ts test/unit/work-call-call-budget.test.ts test/unit/work-call-failover.test.ts test/unit/governor-authority.test.ts test/unit/orchestrate-turn-plan.test.ts && npx vitest run test/unit/work-call-turn-plan.test.ts test/unit/work-call-call-budget.test.ts test/unit/work-call-failover.test.ts test/unit/governor-authority.test.ts test/unit/orchestrate-turn-plan.test.ts
```

Expected: every sequential work/failover provider start has a plan allocation id; quick-turn cross-provider failover still succeeds; no enforcement denial can convert a recoverable provider-local failure into no-answer.

### P1-05e - `VERIFICATION-REPAIR-REVIEW-CONSUMER`

**One invariant:** verification, model review, and same-author repair are authorized from verification/repair/review allocations and cannot borrow the independent failover reserve.

**Preconditions/dependencies:** 05d. Item 17 completion remains absent, so verification outcomes are receipts/obligations only.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/accept-stage.ts`
- `src/core/work-call.ts`
- `src/core/ensemble.ts`
- `src/core/hedge.ts`
- `src/core/turn-plan.ts`
- `src/core/turn-plan-reconcile.ts`
- `test/unit/turn-plan-verification.test.ts` (new)
- `test/unit/work-call-accept-gate.test.ts`
- `test/unit/panel-hedge-call-budget.test.ts`
- `test/unit/ensemble.test.ts`
- `test/unit/hedge.test.ts`

**Typed/behavioral diff:** pass `turnPlan` to accept-stage candidate gates. Model critics use `bucket:'verification'` only when a verification allocation exists. Same-author repair uses a `repair` allocation and is shed before failover if the plan is tight. Unallocated review/repair returns `{ran:false}` or a typed skipped receipt; it never fabricates a pass and never marks completion.

**Named tests:**

- `tests-only verification consumes no model allocation`
- `critic review carries verification allocation id`
- `critic review skipped when verification reserve absent without marking pass`
- `same-author repair uses repair allocation and parent work allocation`
- `repair is shed before failover reserve`
- `panel critic and hedge critic both consume verification allocation`
- `review provider crash returns ran false and preserves plan reconciliation`
- `cancellation during critic leaves work final honest and no fabricated verification`

**Fixtures:** success = passing local tests, parsed critic, same-author repair; failure = failing tests, missing critic allocation, repair provider error; cancellation = abort during critic; injected crash = verify port throws or review stream throws.

**Performance/baseline:** zero extra model calls beyond allocations. Local tests remain bounded by existing verify timeout. Receipt reconciliation p95 below 1 ms for 100 events.

**Flag/rollback/migration:** injected `turnPlanV1` only; enforcement observe. Rollback removes plan threading and restores current accept-stage behavior. No completion schema migration.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/types.ts src/core/accept-stage.ts src/core/work-call.ts src/core/ensemble.ts src/core/hedge.ts src/core/turn-plan.ts src/core/turn-plan-reconcile.ts test/unit/turn-plan-verification.test.ts test/unit/work-call-accept-gate.test.ts test/unit/panel-hedge-call-budget.test.ts test/unit/ensemble.test.ts test/unit/hedge.test.ts && npx vitest run test/unit/turn-plan-verification.test.ts test/unit/work-call-accept-gate.test.ts test/unit/panel-hedge-call-budget.test.ts test/unit/ensemble.test.ts test/unit/hedge.test.ts
```

Expected: verification/review/repair calls reconcile to explicit allocations; no skipped verification is reported as complete; failover reserve is untouched by optional repair/review.

### P1-05f - `PANEL-HEDGE-JUDGMENT-AUTHORITY`

**One invariant:** panel, hedge, judgment, and tribunal composition can run only when `TurnPlanV1.execution.strategy` and allocations name the required calls up front.

**Preconditions/dependencies:** 05e. Existing panel/hedge/tribunal flags remain off or current by default; Item 5 does not independently promote them.

**Maximum file set (exhaustive):**

- `src/core/orchestrate.ts`
- `src/core/ensemble.ts`
- `src/core/hedge.ts`
- `src/core/judgment-poll.ts`
- `src/core/tribunal.ts`
- `src/core/turn-plan.ts`
- `src/core/turn-plan-reconcile.ts`
- `test/unit/turn-plan-composition.test.ts` (new)
- `test/unit/panel-hedge-call-budget.test.ts`
- `test/unit/judgment-tribunal-call-budget.test.ts`
- `test/unit/ensemble.test.ts`
- `test/unit/hedge.test.ts`

**Typed/behavioral diff:** existing policy flags become inputs to `finalizeTurnPlan`; consumers stop re-deriving admission when `turnPlanV1` is true. Panel requires candidate and synthesis allocations; hedge requires primary and secondary work allocations; judgment/tribunal require explicit participant allocations and degrade to single strategy when capacity is insufficient. `finalizeWorkReservation` is called with the planned work-call count before these branches open streams.

**Named tests:**

- `panel denied when plan strategy single even if legacy panel flag is on`
- `panel runs two candidates plus synthesis only with three work allocations`
- `panel degrades before consuming failover reserve`
- `hedge requires two work allocations and delay capability`
- `judgment poll requires explicit candidate and synthesis allocations`
- `tribunal build-off requires explicit build review and synthesis allocations`
- `strategy mismatch reports drift in observe and denial in enforce fixture`
- `cancellation before second panel candidate settles first and starts no unallocated calls`

**Fixtures:** success = single/panel/hedge/judgment/tribunal plans; failure = missing allocation or insufficient work reservation; cancellation = abort between concurrent starts; injected crash = one candidate stream throws and reconciliation still settles.

**Performance/baseline:** no new calls; plan composition only changes admission under injected flag. Current flag-off panel/hedge tests remain snapshot-equal.

**Flag/rollback/migration:** injected `turnPlanV1`; enforcement observe. Rollback removes strategy consumption and returns to legacy policy flags. No persisted state.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/orchestrate.ts src/core/ensemble.ts src/core/hedge.ts src/core/judgment-poll.ts src/core/tribunal.ts src/core/turn-plan.ts src/core/turn-plan-reconcile.ts test/unit/turn-plan-composition.test.ts test/unit/panel-hedge-call-budget.test.ts test/unit/judgment-tribunal-call-budget.test.ts test/unit/ensemble.test.ts test/unit/hedge.test.ts && npx vitest run test/unit/turn-plan-composition.test.ts test/unit/panel-hedge-call-budget.test.ts test/unit/judgment-tribunal-call-budget.test.ts test/unit/ensemble.test.ts test/unit/hedge.test.ts
```

Expected: no multi-model composition starts unless the plan names every participant call, and pressure degrades optional composition before failover/verification reserves are consumed.

### P1-05g - `BACKGROUND-RESEARCH-GOAL-AUTHORITY`

**One invariant:** research, meta, recap, understanding, goal planning/replanning, and autostage helper calls are allocated or skipped; post-turn auto-stage cannot launch duplicate work.

**Preconditions/dependencies:** 05f, Item 8 evidence receipts, shipped Item-9 helper call migrations. Item 4 single-execution lifecycle is not complete, so this slice may only authorize parked/planning helpers, not autonomous duplicate execution.

**Maximum file set (exhaustive):**

- `src/core/decompose.ts`
- `src/core/goal-objective-generator.ts`
- `src/core/goal-plan-generator.ts`
- `src/core/goal-replan-generator.ts`
- `src/core/recap-generator.ts`
- `src/core/understanding-generator.ts`
- `src/core/research.ts`
- `src/interface/menu.ts`
- `src/interface/auto-stage.ts`
- `src/core/turn-plan.ts`
- `src/core/turn-plan-reconcile.ts`
- `test/unit/turn-plan-background.test.ts` (new)
- `test/unit/context-helper-call-budget.test.ts`
- `test/unit/goal-planning-call-budget.test.ts`
- `test/unit/menu-background-call-budget.test.ts`
- `test/unit/auto-stage-engine.test.ts`
- `test/unit/research.test.ts`

**Typed/behavioral diff:** helper constructors accept optional `turnPlan` and require a matching background/research allocation before opening a model stream when `turnPlanV1` is true. Required Item-8 evidence research is allocated as `research-web` or local no-model evidence; optional research is shed before verification/failover. Post-turn auto-stage under Item 5 may only create parked goals and may not call `spawnBackgroundGoal` or any execution provider without a separate foreground `TurnPlanV1`.

**Named tests:**

- `required web research consumes research-web allocation`
- `optional web research sheds when discretionary exhausted`
- `meta recap and understanding helpers carry background allocation ids`
- `goal objective plan replan and decompose helpers carry distinct allocation ids`
- `autostage creates parked goal only and starts no work provider under TurnPlan`
- `missing allocation skips helper with receipt not provider call`
- `helper crash settles allocation drift and does not block foreground answer`
- `cancellation before helper start opens no provider stream`

**Fixtures:** success = allocated helpers; failure = missing allocation and exhausted discretionary; cancellation = abort before and during helper stream; injected crash = helper provider throws and receipt callback throws.

**Performance/baseline:** zero additional helper calls beyond current behavior. Optional helpers are reduced under tight plans. No `.tmp` benchmarks committed.

**Flag/rollback/migration:** injected `turnPlanV1`; enforcement observe. Rollback removes helper plan checks. No auto-stage default change.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/decompose.ts src/core/goal-objective-generator.ts src/core/goal-plan-generator.ts src/core/goal-replan-generator.ts src/core/recap-generator.ts src/core/understanding-generator.ts src/core/research.ts src/interface/menu.ts src/interface/auto-stage.ts src/core/turn-plan.ts src/core/turn-plan-reconcile.ts test/unit/turn-plan-background.test.ts test/unit/context-helper-call-budget.test.ts test/unit/goal-planning-call-budget.test.ts test/unit/menu-background-call-budget.test.ts test/unit/auto-stage-engine.test.ts test/unit/research.test.ts && npx vitest run test/unit/turn-plan-background.test.ts test/unit/context-helper-call-budget.test.ts test/unit/goal-planning-call-budget.test.ts test/unit/menu-background-call-budget.test.ts test/unit/auto-stage-engine.test.ts test/unit/research.test.ts
```

Expected: all helper model calls are plan-addressable; required evidence remains possible; optional helpers cannot starve work/failover/verification.

### P1-05h - `DARK-PRODUCTION-COMPOSITION`

**One invariant:** one explicit default-off flag composes TurnPlan V1 across interactive, one-shot, and REPL entry points in observe mode, and removing the flag restores exact legacy receipts.

**Preconditions/dependencies:** 05g, Item 8 08j dark production composition, Item 9 P1-09j global ledger composition. Do not proceed if any entry point fails to pass the same budget object through semantic preflight and work.

**Maximum file set (exhaustive):**

- `src/infra/config.ts`
- `src/interface/ui/turn-plan-flag.ts` (new)
- `src/interface/preflight-deps.ts`
- `src/interface/menu.ts`
- `src/interface/repl.ts`
- `src/interface/run.ts`
- `src/cli.ts`
- `src/core/types.ts`
- `test/unit/turn-plan-flag.test.ts` (new)
- `test/unit/menu-flow.test.ts`
- `test/unit/run.test.ts`
- `test/unit/preflight-deps.test.ts`
- `test/unit/global-call-budget-receipt.test.ts`
- `test/unit/orchestrate-turn-plan.test.ts`

**Typed/behavioral diff:** add config mirrors and flag helper. When `MYSHELL_TURNPLAN_V1` is true, entry points pass `turnPlanV1:true` and keep the Item-9 budget in observe mode. The budget receipt callback receives both the raw `TurnCallBudgetReceipt` and, when available, the `TurnPlanV1` plus reconciliation report. Flag off remains byte-for-byte current.

**Named tests:**

- `turn plan flag defaults false for absent false zero and garbage`
- `explicit env or config true enables observe TurnPlan`
- `interactive one-shot and REPL flag off receipts match legacy snapshots`
- `flag on emits one turn-plan event per nonterminal foreground turn`
- `same budget object owns semantic evidence work helpers and receipt callback`
- `semantic flag off still produces legacy-reconciled plan under TurnPlan flag`
- `semantic flag on produces semantic-v1 plan with one intent preflight`
- `receipt callback throw remains fail-soft`
- `rollback by unsetting flag restores exact legacy receipt`

**Fixtures:** success = each entry point with semantic on/off; failure = malformed semantic result/finalizer fallback; cancellation = interrupt semantic and work; injected crash = receipt callback throws.

**Performance/baseline:** flag-off call counts and receipt snapshots are identical. Flag-on adds no model calls beyond already-enabled semantic/evidence/helper choices. Plan finalization p95 below 1 ms on fake fixtures.

**Flag/rollback/migration:** `MYSHELL_TURNPLAN_V1` default false. Rollback is the shared procedure. No persisted schema required.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/infra/config.ts src/interface/ui/turn-plan-flag.ts src/interface/preflight-deps.ts src/interface/menu.ts src/interface/repl.ts src/interface/run.ts src/cli.ts src/core/types.ts test/unit/turn-plan-flag.test.ts test/unit/menu-flow.test.ts test/unit/run.test.ts test/unit/preflight-deps.test.ts test/unit/global-call-budget-receipt.test.ts test/unit/orchestrate-turn-plan.test.ts && npx vitest run test/unit/turn-plan-flag.test.ts test/unit/menu-flow.test.ts test/unit/run.test.ts test/unit/preflight-deps.test.ts test/unit/global-call-budget-receipt.test.ts test/unit/orchestrate-turn-plan.test.ts test/arch/provider-call-budget-guard.test.ts
```

Expected before: new path unreachable. Expected after: still unreachable by default; explicit flag emits plan and reconciliation; removing it restores exact legacy receipts.

### P1-05i - `DARK-ENFORCEMENT-AND-AUTO-RECEIPT`

**One invariant:** enforcement denies only calls that lack a plan allocation after rollback-safe observation proves reconciliation; recoverable failover and loss preservation still produce an answer when legacy would.

**Preconditions/dependencies:** 05h green on all entry points. At least one observe-mode artifact per fixture class under `.tmp/turnplan-observe/` must show zero unexplained drift before this slice is attempted. Item 8 default-on is not required.

**Maximum file set (exhaustive):**

- `src/infra/config.ts`
- `src/interface/ui/turn-plan-flag.ts`
- `src/interface/menu.ts`
- `src/interface/repl.ts`
- `src/interface/run.ts`
- `src/interface/render.ts`
- `src/interface/ui/core-event.ts`
- `src/interface/ui/reduce.ts`
- `src/core/types.ts`
- `src/core/turn-plan.ts`
- `src/core/turn-plan-reconcile.ts`
- `src/core/budgeted-provider.ts`
- `src/core/turn-call-budget.ts`
- `test/unit/turn-plan-enforcement.test.ts` (new)
- `test/unit/global-call-budget-receipt.test.ts`
- `test/unit/budgeted-provider.test.ts`
- `test/unit/turn-call-budget.test.ts`
- `test/unit/render.test.ts`
- `test/unit/core-event.test.ts`

**Typed/behavioral diff:** add `MYSHELL_TURNPLAN_ENFORCE_V1`, default false. When both Item-5 flags are true and observe artifacts are green, create the Item-9 budget in `mode:'enforce'` for the foreground turn and attach allocation metadata to every post-plan `TurnCallRequest`. Pre-plan route/intent/semantic calls remain authorized by the preflight budget envelope and reconciled as observed. Render the Auto receipt only from `TurnPlanV1.receiptLine` plus actual reconciliation status; no fabricated headroom.

**Named tests:**

- `enforce flag ignored when TurnPlan flag is off`
- `enforce denies unallocated post-plan work call`
- `enforce allows allocated semantic-observed then work then verification`
- `enforce preserves reserved failover after first provider-local failure`
- `loss-preservation override allows one distinct-provider recovery beyond exhausted failover`
- `optional review denied cannot consume failover reserve`
- `unknown helper call is denied with receipt and foreground answer continues when optional`
- `Auto receipt names shape provider model effort planned calls quota evidence and fallback`
- `rollback explicit off returns observe legacy receipt`

**Fixtures:** success = allocated work/verification/failover; failure = unallocated work/helper/review; cancellation = abort during denied and allowed streams; injected crash = denial path throws `TurnCallDeniedError` and caller converts to typed final/skip, never uncaught.

**Performance/baseline:** enforcement adds O(allocations) lookup per stream open; p95 below 0.1 ms for 24 allocations. Model-call counts do not increase. Observe artifacts are required but not committed.

**Flag/rollback/migration:** `MYSHELL_TURNPLAN_ENFORCE_V1` default false. Rollback unset enforce flag; broader rollback unset both Item-5 flags. Additive receipts remain readable.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/infra/config.ts src/interface/ui/turn-plan-flag.ts src/interface/menu.ts src/interface/repl.ts src/interface/run.ts src/interface/render.ts src/interface/ui/core-event.ts src/interface/ui/reduce.ts src/core/types.ts src/core/turn-plan.ts src/core/turn-plan-reconcile.ts src/core/budgeted-provider.ts src/core/turn-call-budget.ts test/unit/turn-plan-enforcement.test.ts test/unit/global-call-budget-receipt.test.ts test/unit/budgeted-provider.test.ts test/unit/turn-call-budget.test.ts test/unit/render.test.ts test/unit/core-event.test.ts && npx vitest run test/unit/turn-plan-enforcement.test.ts test/unit/global-call-budget-receipt.test.ts test/unit/budgeted-provider.test.ts test/unit/turn-call-budget.test.ts test/unit/render.test.ts test/unit/core-event.test.ts test/arch/provider-call-budget-guard.test.ts
```

Expected: planless post-plan calls are denied only under explicit enforcement; rollback restores observe/legacy; recoverable failover remains green.

### P1-05j - `PLAN-AUTHORITY-GUARDS-AND-HANDOFF`

**One invariant:** no product provider call site can be added without both the budgeted-provider seam and a TurnPlan allocation/reconciliation test.

**Preconditions/dependencies:** 05i. Enforcement remains default off; this is guard and documentation closure, not promotion.

**Maximum file set (exhaustive):**

- `test/arch/provider-call-budget-guard.test.ts`
- `test/arch/turn-plan-authority-guard.test.ts` (new)
- `docs/r7-item5-turnplan-contract.md`
- `docs/master-plan.md`
- `test/unit/global-call-budget-receipt.test.ts`

**Typed/behavioral diff:** add an architecture guard that scans product `runBudgetedProvider` call sites and requires either an explicit allocation metadata handoff or a named pre-plan allowed purpose. Update the master-plan Item 5 note with the implemented slice IDs and rollback flags only after all implementation slices are green. Do not mark Item 8 08k, Item 10, Item 13, or Item 17 complete.

**Named tests:**

- `zero budgeted provider call sites lack allocation metadata or pre-plan exemption`
- `known pre-plan route intent semantic recap and understanding exemptions are named`
- `new direct provider run guard remains green`
- `global receipt reports planned actual and drift status`

**Fixtures:** success = current call-site inventory; failure = synthetic fixture file with missing allocation metadata; cancellation = N/A static; injected crash = unreadable file path in guard yields test failure with path.

**Performance/baseline:** static scan under 500 ms on CI. No provider calls.

**Flag/rollback/migration:** no runtime behavior. Rollback removes guard/doc updates.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint test/arch/provider-call-budget-guard.test.ts test/arch/turn-plan-authority-guard.test.ts test/unit/global-call-budget-receipt.test.ts && npx vitest run test/arch/provider-call-budget-guard.test.ts test/arch/turn-plan-authority-guard.test.ts test/unit/global-call-budget-receipt.test.ts
```

Expected: every product model-call path is either pre-plan observed or post-plan allocated; docs name handoffs to Items 10, 13, and 17.

## 6. Adversarial challenge and fix

**Challenge 1: where could enforcement drop a recoverable failure into no-answer?** The obvious failure is a quick turn with one planned work unit and no separate failover reserve: the first provider returns empty/rate-limit/auth/transport, enforcement denies the cross-vendor retry, and the user receives no answer even though today's `runWorkCall` succeeds via queued provider failover. This is explicitly guarded by 05a, 05d, and 05i: two eligible authenticated providers require `reserved.failover=1`; optional panel/hedge/review/background allocations degrade before that reserve; one-use loss-preservation can restore a failover unit for a distinct next provider with the same idempotency key; timeout remains terminal unless a usable partial draft is named.

**Challenge 2: where could reserved units starve a legitimate call?** A strict reservation scheme can over-reserve verification or failover on a single-provider, answer-only turn and deny the only legitimate work call or required semantic evidence research. The fix is in the finalizer: keep one work unit first; reserve failover only with an eligible distinct provider; reserve verification only when requested or obligated; classify required before-work evidence as required research/evidence before optional verification/review; shed background, optional research, judgment/tribunal, panel/hedge, optional critic, then optional repair before touching work/failover/required verification.

## 7. Cross-slice acceptance and definition of done

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npx vitest run test/arch/provider-call-budget-guard.test.ts test/unit/global-call-budget-receipt.test.ts
```

The changed-file list must be a subset of that slice's maximum set. A Vitest pass with an unlinted fixture, missing cancellation case, or unrecorded observe drift is not acceptance.

Item 5 is implemented dark when 05j is green. It is **not** default-promoted by this contract. The implementation satisfies Item 5 only if all of the following are simultaneously true:

- exactly one `TurnPlanV1` is finalized per nonterminal foreground turn when the flag is on;
- every pre-plan route/intent/semantic call is reconciled as observed and every post-plan provider call references a serialized allocation;
- planned and actual call counts reconcile by purpose, bucket, stage, provider, and allocation id;
- work/failover/verification reservations fit in the existing Item-9 `totalUnits` without increasing it;
- an eligible failover reserve or loss-preservation override prevents recoverable provider-local failures from becoming no-answer;
- optional panel/hedge/judgment/tribunal/review/repair/background/research calls shed before starving core work, failover, or required verification/evidence;
- Auto receipt text is generated from the actual plan and actual reconciliation, not reconstructed prose;
- flag-off rollback restores the legacy receipt shape and call behavior without data migration;
- Item 8 contracts, Item 9 guard/tests, and existing failover tests remain green.
