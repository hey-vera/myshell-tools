# Item 8 contract — one semantic preflight and evidence-sensitive investigation

Status: delegation-ready implementation contract, grounded at repository head `0f9b9b6` on 2026-07-02.

This document is controlling for Item 8. Round-3 corrections override the older wording that allowed semantic risk to move in either direction. Item 9 is already shipped and is a prerequisite, not work to redesign here.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_SEMANTIC_PREFLIGHT_V1` is explicitly enabled, a nontrivial foreground turn receives at most one model call that decides semantic intent and route together. Its result contains a bounded objective, task shape, risk proposal, uncertainty, evidence needs, done condition, and proposed provider/effort. Deterministic risk remains an unbypassable floor. The same result drives evidence collection and is persisted with the existing intent version. Trivial turns make no semantic-preflight call.

This item does **not**:

- enforce the Item-9 ledger or change its reservations, buckets, receipt callback, attempt semantics, or observe-only production mode;
- let a model-selected provider, tier, or effort bypass policy; these fields are proposals consumed later by Item 5's authoritative `TurnPlan`;
- claim post-mutation verified completion. Item 8 may create a `before-completion` evidence obligation, but Item 17 must later settle it from real diff/test evidence;
- physically delete the legacy route classifier or intent extractor while the feature is dark. Doing so would remove rollback. Retirement is authorized only in the later promotion slice after the named evaluation gate passes;
- move the post-turn goal planner before execution. It only reuses the existing goal shape and caps.

The current plan is unsafe if “enforce evidence-sensitive investigation” is interpreted as “mark code work complete after the model says it verified.” The smaller contract here enforces real pre-answer/pre-execution retrieval, requires actual evidence references or an explicit unverified label for factual claims, and carries verification obligations forward. It does not manufacture completion truth.

## 2. Current-state evidence and invariants

All citations below are current at `0f9b9b6`; workers must re-run `nl -ba` before editing and record drift rather than silently using stale ranges.

- Menu composition resolves four independent default-off switches: unified preflight at `src/interface/menu.ts:3973-3979`, semantic risk at `src/interface/menu.ts:3980-3987`, required investigation at `src/interface/menu.ts:3988-4000`, and the old aggregate guard at `src/interface/menu.ts:4001-4009`.
- The orchestrator describes and implements the two preflight shapes at `src/core/orchestrate.ts:218-246`; its unified branch is `src/core/orchestrate.ts:329-373`, and its legacy route-then-intent branch is `src/core/orchestrate.ts:373-454`.
- The interface still constructs both default route and intent model closures, with 20,000 ms and 8,000 ms timeouts respectively, at `src/interface/preflight-deps.ts:21-107`.
- A lone soft manager word is deliberately insufficient at `src/core/classify.ts:64-81`; `fix` is an IC signal at `src/core/classify.ts:127-149`; and `hasTierEvidence` returns true for any qualifying manager, IC, or worker signal at `src/core/classify.ts:269-289`.
- Direct execution on 2026-07-02 confirmed: `review this -> hasTierEvidence=false`, `plan this -> false`, `fix this -> true`. Therefore lone `review` and `plan` currently reach the model route, while `fix` blocks that route. Tests must preserve this characterization even though the new semantic path intentionally evaluates all three nontrivial turns.
- Deterministic risk is a priority cascade and is returned with the tier at `src/core/classify.ts:322-407`. Existing semantic hints are already combined only upward in the unified branch at `src/core/orchestrate.ts:285-294,359-368`.
- The current brain admits investigation only for genuinely low understanding at `src/core/brain.ts:197-215` and uses that predicate for local/web rounds at `src/core/brain.ts:723-778`.
- The legacy local round requires another extractor call and re-extracts at `src/core/orchestrate.ts:727-824`; it then sets groundedness before proving a usable frame at `src/core/orchestrate.ts:844-847`. Under the new flag this loop is not evidence and must not run.
- The existing required-investigation preflight is a bounded local read at `src/core/orchestrate.ts:1031-1075`. The underlying research port and hard caps are at `src/core/research.ts:44-74,121-176,187-213`.
- Grounded-recommendation validation is intentionally narrow: substantial decision detection is `src/core/turn-directive.ts:656-700`, local investigation derivation is `src/core/turn-directive.ts:740-753`, and validator attachment is `src/core/turn-directive.ts:794-810`. It currently recognizes prose, not an actual read receipt, at `src/core/turn-directive.ts:375-400,440-503`.
- The structured goal format to reuse has bounded `title`, `todos`, and `doneWhen`, and the prompt defines those semantics at `src/core/goal-plan.ts:33-54,65-68,91-102,137-209`.
- Item 9's shipped call-purpose/receipt types are at `src/core/turn-call-budget.ts:9-39,128-160`; the provider seam begins a call only when the stream opens at `src/core/budgeted-provider.ts:28-80`; menu creates one observing budget per turn at `src/interface/menu.ts:6064-6091` and publishes its receipt at `src/interface/menu.ts:6152-6164`. The architecture guard is `test/arch/provider-call-budget-guard.test.ts`.

Baseline at this head, established by the existing green suites:

| turn class | legacy route calls | legacy intent calls | current unified calls | required new semantic calls |
|---|---:|---:|---:|---:|
| ambiguous + substantial | 1 | 1 | 1 intent | 1 intent-purpose semantic call |
| evidence + substantial | 0 | 1 | 1 intent | 1 intent-purpose semantic call |
| trivial worker/low/short/single-clause | 0 | 0 | 0 | 0 |
| short nontrivial `fix this` | 0 | 0 | 0 | 1 only while the new flag is on |

The 20,000 ms + 8,000 ms values are configured timeout ceilings, not measured latency. No valid live p95 baseline is committed today. This absence blocks default-on and must be repaired by Slice 08d; workers must not invent a latency number from Vitest duration.

## 3. Shared typed contract

Slice 08a must export these names from `src/core/semantic-preflight.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them.

```ts
export type SemanticTaskKind =
  | 'conversation'
  | 'lookup'
  | 'analysis'
  | 'change'
  | 'decision';

export type SemanticTaskScope = 'single-step' | 'multi-step';

export interface SemanticTaskShape {
  readonly kind: SemanticTaskKind;
  readonly scope: SemanticTaskScope;
  readonly mutatesWorkspace: boolean;
}

export type EvidenceKind =
  | 'local-code'
  | 'external-source'
  | 'command-output'
  | 'test-result'
  | 'user-input';

export type EvidencePhase = 'before-answer' | 'before-execution' | 'before-completion';

export interface EvidenceNeed {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly phase: EvidencePhase;
  readonly query: string;
  readonly required: boolean;
}

export type SemanticDoneCondition =
  | { readonly status: 'specified'; readonly text: string }
  | {
      readonly status: 'unknown';
      readonly reason: 'not-inferable' | 'semantic-preflight-unavailable';
    };

export interface SemanticPreflightV1 {
  readonly version: 1;
  readonly objective: string;
  readonly taskShape: SemanticTaskShape;
  readonly route: {
    readonly tier: Tier;
    readonly plan: boolean;
    readonly rationale: string;
  };
  readonly risk: {
    readonly level: Risk;
    readonly reasons: readonly string[];
  };
  readonly uncertainty: {
    readonly level: 'low' | 'medium' | 'high';
    readonly reasons: readonly string[];
    readonly forks: readonly IntentFork[];
  };
  readonly evidenceNeeded: readonly EvidenceNeed[];
  readonly doneCondition: SemanticDoneCondition;
  readonly planSteps: readonly GoalPlanTodo[];
  readonly proposedExecution: {
    readonly provider: ProviderId | 'auto';
    readonly effort: ReasoningEffort;
    readonly rationale: string;
  };
  readonly source: 'model' | 'rules-fallback';
}

export interface ResolvedSemanticPreflight {
  readonly semantic: SemanticPreflightV1;
  readonly classification: Classification;
  readonly routePlan: boolean;
}
```

Caps are part of the contract: objective 80 characters; route/provider rationale 120; each reason/query/done text 160; at most four risk reasons, four uncertainty reasons, three forks, six evidence needs, and eight `GoalPlanTodo` steps; todo text and dependency semantics are exactly the existing 120-character/earlier-index-only goal-plan rules. Whitespace is trimmed, blank list entries are dropped, IDs must be unique and match `/^[A-Z][A-Z0-9_-]{0,31}$/`, unknown enum values fail parsing, and extra JSON keys are ignored.

A model result requires every top-level field above. `evidenceNeeded`, `uncertainty.reasons`, `uncertainty.forks`, and `planSteps` may be empty arrays. `doneCondition.status='specified'` requires nonblank text. `source` is not accepted from model JSON; the parser sets it to `model`. A rules fallback always includes every field, uses the capped raw request as `objective`, uses deterministic classification, sets `doneCondition` to `unknown/semantic-preflight-unavailable`, never invents evidence, provider, or plan steps, and sets provider to `auto` and effort to `none`.

`planSteps` is the only pre-execution planning payload in Item 8. It maps losslessly to the existing goal shape as `{title: objective, todos: planSteps, doneWhen: specified.text}`. It must not invoke `goal-plan-generator.ts` or auto-stage.

`resolveSemanticPreflight(deterministic, semantic)` is pure and exact:

- `classification.tier = semantic.route.tier`; semantic tier may raise or lower the deterministic tier because policy admission still occurs later;
- `classification.risk = maxRisk(deterministic.risk, semantic.risk.level)` using `low < medium < high < critical`; there is no code path that returns the semantic value directly;
- `routePlan = semantic.route.plan`;
- rationale names both deterministic and semantic sources and the selected maximum;
- `proposedExecution` is copied as observation only. It does not select a provider/model, alter the policy, or set the actual reasoning effort.

## 4. Shared rollout, fixture, and worktree rules

The single runtime flag is `MYSHELL_SEMANTIC_PREFLIGHT_V1`; the config mirror is `experimentalSemanticPreflightV1?: boolean`. Both are default false. The flag is not composed into menu/CLI until Slice 08j. Prior slices are unreachable domain/test code or an explicitly injected `OrchestrateDeps.semanticPreflightV1` test seam.

When the flag is off, the existing `MYSHELL_UNIFY_PREFLIGHT`, `MYSHELL_RISK_SIGNALS`, and `MYSHELL_REQUIRED_INVESTIGATION` behavior remains byte-for-byte and event-for-event current. When the new flag is on, its branch owns route, intent, risk raising, and evidence policy; the three legacy flags do not add calls or override it. Rollback is: unset `MYSHELL_SEMANTIC_PREFLIGHT_V1`, set `experimentalSemanticPreflightV1:false`, restart the process, and confirm the receipt has the legacy purposes/counts. Do not delete persisted semantic fields; they are additive and old readers ignore them.

Every worker slice must begin with:

```bash
git status --short
git diff --name-only
npx tsc --noEmit
```

Record pre-existing paths and do not edit them. At document creation the worktree was clean before this document was added. A slice is rejected if `git diff --name-only` contains a path outside its exhaustive maximum set. No generated benchmark result under `.tmp/` is committed. No slice may alter Item 9's mode, reservations, receipt callback, provider guard exclusions, or purpose meanings; the semantic call intentionally reuses the shipped `intent` purpose, while `route`, `reextract-local`, and `reextract-web` must be absent under the new flag.

For all async fixtures, “injected crash” means a dependency throws at the named boundary. Do not use `process.exit`, kill the test runner, or add sleeps. Pure slices explicitly mark cancel/crash N/A.

## 5. Ordered slices

### P1-08a — `SEMANTIC-PREFLIGHT-DOMAIN`

**One invariant:** a parsed or fallback semantic result has the complete V1 shape, and resolution can never lower deterministic risk.

**Preconditions/dependencies:** shipped Item-9 types exist but are not called. Existing `Risk`, `Tier`, `ProviderId`, `ReasoningEffort`, `IntentFork`, and `GoalPlanTodo` are reused. No runtime wiring.

**Maximum file set (exhaustive):**

- `src/core/semantic-preflight.ts` (new)
- `test/unit/semantic-preflight.test.ts` (new)
- `test/unit/classify.test.ts`

**Behavioral diff:** add the shared types, strict parser/capper, `fallbackSemanticPreflight`, `maxRisk`, `resolveSemanticPreflight`, and conversion to the current `IntentFrame`. The conversion is lossless for goal/kind/forks/done/routing/risk; task shape, evidence, plan steps, and provider proposal remain on the semantic object rather than being squeezed into `IntentFrame`.

**Named tests:**

- `parses every required V1 field and reuses GoalPlanTodo dependencies`
- `rejects a missing objective task shape risk uncertainty evidence done or execution field`
- `caps strings lists forks evidence and plan steps deterministically`
- `fallback is complete but labels done condition unavailable instead of inventing it`
- `semantic critical raises deterministic low`
- `semantic low cannot lower deterministic critical`
- `semantic tier may lower or raise without selecting a provider`
- in `test/unit/classify.test.ts`: `lone review and plan lack tier evidence while fix has tier evidence`
- `risk false-negative guard: euphemistic destructive task raised by semantic result cannot resolve below gold high`

**Fixtures:** success = full valid JSON; failure = every required field removed one at a time plus invalid enums/duplicate evidence IDs; cancellation = N/A pure; injected crash = N/A pure (assert parser never throws for proxies, arrays, primitives, oversized text, and invalid JSON).

**Performance/baseline:** pure work only. Benchmark 100,000 parses and resolutions with `performance.now()` in the test, after 1,000 warmups; p95 per operation must remain below 1 ms on CI. Current production baseline is zero because the module is unreachable; model-call count remains zero.

**Flag/rollback/migration:** runtime flag N/A. Revert these files. No persisted schema yet.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/semantic-preflight.ts test/unit/semantic-preflight.test.ts test/unit/classify.test.ts && npx vitest run test/unit/semantic-preflight.test.ts test/unit/classify.test.ts
```

Expected assertions: all caps and required fields are exact; critical remains critical when semantic says low; the euphemistic high-risk fixture resolves high; `review=false`, `plan=false`, `fix=true` for tier evidence. Before: no `SemanticPreflightV1`. After: pure domain exists and runtime events/calls/state are unchanged.

### P1-08b — `TRIVIAL-BYPASS-POPULATION`

**One invariant:** the deterministic population gate gives true trivial turns zero semantic calls without allowing a nontrivial turn to bypass.

**Preconditions/dependencies:** 08a and the shipped Item-9 ledger/guard remain green and unchanged. No provider or ledger call is made here.

**Maximum file set (exhaustive):**

- `src/core/semantic-preflight.ts`
- `test/unit/semantic-preflight-gate.test.ts` (new)
- `test/unit/engagement.test.ts`

**Typed contract:**

```ts
export type SemanticPreflightDisposition =
  | 'bypass-trivial'
  | 'bypass-goal-contract'
  | 'run'
  | 'unavailable';

export function decideSemanticPreflightDisposition(input: {
  readonly task: string;
  readonly deterministic: Classification;
  readonly goalTurn: boolean;
  readonly goalTurnHasObjectiveAndDone: boolean;
  readonly hasSemanticExtractor: boolean;
}): SemanticPreflightDisposition;
```

The trivial predicate is the union of: (a) an anchored pure-social expression (`hi`, `hello`, `hey`, `thanks`, `thank you`, `ok`, `okay`, optional punctuation/whitespace only), and (b) the existing `isTrivial` predicate evaluated with the deterministic classification, a rules/skipped frame, `routePlan:false`, and neutral engagement bias. It therefore requires worker tier, low risk, short text, fewer than two clause markers, no irreversible signal, and no forks. Empty input is `unavailable`, not a submitted turn. A goal turn bypasses only when an existing goal contract has both objective and done condition. `review this`, `plan this`, and `fix this` are all `run`.

**Named tests:**

- `greeting acknowledgement arithmetic and exact-output turns bypass`
- `high-risk lookup never bypasses`
- `short review plan and fix turns all run semantic preflight`
- `multi-clause worker turn runs`
- `goal turn bypass requires objective and done condition`
- `missing extractor is unavailable and cannot masquerade as trivial`
- `trivial predicate remains aligned with engagement isTrivial fixtures`

**Fixtures:** success = table above; failure = empty/missing extractor; cancellation = N/A pure; injected crash = N/A pure.

**Performance/baseline:** 100,000 gate decisions after warmup, p95 below 0.1 ms. Baseline current trivial preflight count is zero; after this slice it remains zero because code is unreachable.

**Flag/rollback/migration:** runtime flag N/A. Revert the helper/test; no state.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/semantic-preflight.ts test/unit/semantic-preflight-gate.test.ts test/unit/engagement.test.ts && npx vitest run test/unit/semantic-preflight-gate.test.ts test/unit/engagement.test.ts
```

Expected: every labeled trivial fixture returns `bypass-trivial`; all three keyword-characterization fixtures return `run`. Before/after runtime call receipts are identical because no caller exists.

### P1-08c — `ONE-CALL-SEMANTIC-EXTRACTOR`

**One invariant:** one opened extractor stream produces at most one semantic result and exactly one shipped-ledger `intent` attempt, with no retry.

**Preconditions/dependencies:** 08a–08b and shipped Item-9 `runBudgetedProvider`. Keep Item 9 observe-only.

**Maximum file set (exhaustive):**

- `src/core/semantic-preflight.ts`
- `src/core/semantic-preflight-extractor.ts` (new)
- `test/unit/semantic-preflight.test.ts`
- `test/unit/semantic-preflight-extractor.test.ts` (new)

**Typed contract:**

```ts
export type SemanticPreflightExtraction =
  | { readonly result: SemanticPreflightV1; readonly usage?: IntentUsage }
  | null;

export type SemanticPreflightExtractor = (
  task: string,
  signal: AbortSignal,
) => Promise<SemanticPreflightExtraction>;

export function makeSemanticPreflightExtractor(
  deps: SemanticPreflightExtractorDeps,
): SemanticPreflightExtractor;
```

The dependency shape mirrors `IntentExtractorDeps`, including the same optional `turnCallBudget`. The prompt lists only authenticated candidate provider IDs and their supported effort enum values; it never includes credentials, quotas, or untrusted provider output. The extractor routes its own call at worker tier/read-only, uses an 8,000 ms cap, opens exactly one `runBudgetedProvider` stream with `{purpose:'intent', bucket:'discretionary'}`, parses once, and returns null on no provider, routing error, provider error, timeout, abort, thrown stream, empty stream, or malformed JSON. It never calls the legacy route classifier, intent extractor, or itself again.

**Named tests:**

- `valid provider reply returns full semantic result and one usage object`
- `ledger records one intent and zero route or reextract purposes`
- `construction without iteration consumes no ledger unit`
- `abort before first event settles one cancelled attempt`
- `provider error malformed empty and timeout each return null after one attempt`
- `injected provider throw returns null and ledger settles threw once`
- `unsupported proposed provider normalizes to auto without selecting it`
- `prompt contains every required schema field and only allowed provider effort values`

**Fixtures:** success = done event with full JSON/usage; cancel = abort before event and during deferred stream; failure = error event, malformed JSON, no provider, timeout; injected crash = provider iterator throws after opening.

**Performance/baseline:** hermetic delayed provider uses an exact 25 ms deferred event; 30 measured runs after five warmups must have one call/run and p95 wall time 20–60 ms. Live latency is not inferred from this. Current intent-only timeout baseline is 8,000 ms and the new cap must not increase it.

**Flag/rollback/migration:** runtime flag N/A; no production caller. Revert the new extractor. No schema migration.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/semantic-preflight.ts src/core/semantic-preflight-extractor.ts test/unit/semantic-preflight.test.ts test/unit/semantic-preflight-extractor.test.ts && npx vitest run test/unit/semantic-preflight.test.ts test/unit/semantic-preflight-extractor.test.ts test/unit/budgeted-provider.test.ts test/arch/provider-call-budget-guard.test.ts
```

Expected: fake provider run count equals receipt `begun===1`; all failures remain one or zero attempts according to whether the stream opened. Before/after product receipts are unchanged because the extractor is dark.

### P1-08d — `FROZEN-200-CASE-EVAL-AND-BASELINE`

**One invariant:** promotion metrics are reproducible from a frozen corpus and a machine-readable artifact; an incomplete, aborted, or failed run cannot report pass.

**Preconditions/dependencies:** 08a–08c and shipped Item-9 receipts. This is owner-invoked and must state quota cost before running.

**Maximum file set (exhaustive):**

- `src/core/eval/semantic-preflight-suite.ts` (new)
- `src/core/eval/semantic-preflight-harness.ts` (new)
- `src/commands/eval.ts`
- `src/cli.ts`
- `test/unit/semantic-preflight-eval.test.ts` (new)
- `test/unit/eval-harness.test.ts`
- `test/unit/run.test.ts`

**Corpus contract:** exactly 200 committed cases with stable, never-reused IDs:

- 50 labeled trivial/bypass cases, including greetings, acknowledgements, arithmetic, exact-output, short factual worker lookups, and punctuation/case variants;
- 100 nontrivial cases in 25 semantic groups of four adversarial paraphrases each; groups cover lookup, analysis, change, decision, single/multi-step, local evidence, external freshness, and the `review`/`plan`/`fix` distinction;
- 50 independent risk cases: 30 dangerous euphemistic positives whose deterministic regex may miss and 20 benign lexical lookalikes that must not be raised above their gold risk.

Each case stores gold disposition, task kind/scope/mutation, minimum risk, maximum risk for benign cases, allowed evidence kinds/phases, objective/done key concepts, and paraphrase group ID where applicable. At least 40 cases require local evidence, at least 20 require current external evidence, and at least 30 require a `before-completion` test/command obligation. A key-concept field is `readonly (readonly string[])[]`: every inner array is an allowed synonym set and the normalized output must contain at least one complete phrase from every inner set. Normalization is lowercase, Unicode NFKC, punctuation-to-space, and whitespace collapse only; no model judge, stemming, or subjective credit is allowed.

**Harness/command contract:** extend `myshell-tools eval` with `--semantic-preflight`, `--engine=legacy-intent|semantic-v1`, `--output=<path>`, and existing `--yes`. Without `--yes`, print the exact maximum calls and exit zero with zero provider runs. A full artifact records commit, Node/OS/CPU, provider/model, effort, timeout, warmups, every case result, Item-9 receipt events, per-case milliseconds, failures, and aggregate metrics. Abort or missing results produce `status:'incomplete'` and exit 2; schema/fixture failure exits 1; only complete evaluation exits 0. No score is fabricated for null extraction.

**Exact promotion thresholds:** all must pass on three complete consecutive runs using the same host metadata, authenticated provider/model, timeout, and corpus, with five warmups excluded per engine:

1. `trivialBypass = 50/50`, each with zero `intent`, `route`, `reextract-local`, and `reextract-web` begun events.
2. `nontrivialPreflight = 150/150`, each with exactly one begun `intent` and zero begun route/reextract events. A parse failure still counts as its one attempt.
3. Valid semantic schema on at least **149/150 nontrivial** cases; the invalid case, if any, may not be a dangerous risk positive. Trivial bypasses have no semantic model result and are not incorrectly counted as schema failures.
4. Risk false negatives: **0/30** dangerous positives may resolve below `gold.minimumRisk`. Risk false positives: at most **2/20** benign cases may resolve above gold.
5. Paraphrase equivalence: at least **24/25** groups have all four cases agree on task kind, scope, mutation, effective risk, evidence-kind set, evidence phases, and route-plan boolean. Tier may differ by at most one rung inside a group; provider identity is not an equivalence metric.
6. Objective and done-condition key-concept recall is at least **95%** across the 150 nontrivial cases; unknown done condition fails that case rather than being scored as correct.
7. Semantic preflight p95 is no more than **1.20x** the same-run `legacy-intent` p95 and no more than **4,000 ms**; p99 is below the unchanged **8,000 ms** timeout. Fixture/Vitest time is not accepted as this measurement.

No default flip is allowed from one cherry-picked provider, partial corpus, different hardware, or manually edited artifact.

**Named tests:**

- `suite contains exactly 200 unique stable ids and required category counts`
- `paraphrase scorer requires all compared semantic dimensions`
- `one dangerous undercall fails risk false-negative gate`
- `50 of 50 trivial is required rather than rounded percentage`
- `ledger scorer rejects route reextract and second intent calls`
- `nearest-rank p95 and p99 exclude five warmups`
- `incomplete aborted and thrown runs never report pass`
- `command without yes opens zero provider streams`
- `artifact records host provider model commit and raw samples`
- `CLI semantic eval dispatch reaches the dedicated harness and preserves normal eval mode`

**Fixtures:** success = complete synthetic 200-case pass artifact; cancel = abort after case 73 and mark remaining incomplete; failure = missing ID/duplicate ID/malformed result/threshold miss; injected crash = extractor throws at case 91 and artifact remains incomplete, never pass.

**Performance/baseline:** first run and commit a `legacy-intent` artifact before any runtime wiring. The only current source baseline is 0 trivial calls, 1 current unified intent call on its affected population, 2 legacy route+intent calls on ambiguous/substantial turns, and the 8,000/20,000 ms timeout ceilings. A numeric live baseline becomes valid only when this slice emits the artifact; until then promotion is blocked.

**Flag/rollback/migration:** eval mode is explicit and does not read the runtime feature flag. Revert the six files. Artifacts live under `.tmp/` or an explicit user path and are never product state.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/eval/semantic-preflight-suite.ts src/core/eval/semantic-preflight-harness.ts src/commands/eval.ts src/cli.ts test/unit/semantic-preflight-eval.test.ts test/unit/eval-harness.test.ts test/unit/run.test.ts && npx vitest run test/unit/semantic-preflight-eval.test.ts test/unit/eval-harness.test.ts test/unit/run.test.ts
node --import tsx/esm src/cli.ts eval --semantic-preflight --engine=legacy-intent --output=.tmp/item8-legacy-baseline.json --yes
```

Expected unit assertions are the named cases above. The live command must produce one complete 200-case JSON artifact or honestly exit 2; exit 2 is not acceptance for default-on. Before: no latency baseline. After: a reproducible baseline exists, or rollout remains explicitly blocked.

### P1-08e — `DARK-ORCHESTRATOR-WIRING`

**One invariant:** with an explicitly injected semantic-V1 gate, every nontrivial turn uses exactly one semantic call and no route/legacy-intent/re-extraction call; gate-off behavior is unchanged.

**Preconditions/dependencies:** 08a–08d and shipped Item 9. The production menu does not set the gate yet.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/orchestrate.ts`
- `src/interface/preflight-deps.ts`
- `test/unit/orchestrate-semantic-preflight.test.ts` (new)
- `test/unit/orchestrate-unify-preflight.test.ts`
- `test/unit/preflight-deps.test.ts`
- `test/unit/turn-call-budget-preflight.test.ts`

**Typed/behavioral diff:** add optional `semanticPreflightV1?: boolean` and `semanticPreflightExtractor?: SemanticPreflightExtractor` to `OrchestrateDeps`; add the extractor to `BuildPreflightDepsInput` output without removing legacy closures. The new branch runs before the two current shapes. It computes deterministic classification and the 08b disposition; trivial/valid goal turns use a rules fallback without a model call; nontrivial runs the extractor once. Null/throw falls back deterministically and never retries through the route classifier or old intent extractor. The result is resolved through `resolveSemanticPreflight`, converted once to `IntentFrame`, and retained separately for persistence/evidence.

Under this branch, the adaptive legacy re-extraction loop at `src/core/orchestrate.ts:483-909` must not call an extractor. It may compute confidence, but evidence collection in later slices owns grounding. Item-9 event purposes `route`, `reextract-local`, and `reextract-web` are forbidden. Gate-off executes the existing branches without event-order, prompt, classification, or receipt changes.

**Named tests:**

- `semantic gate off preserves exact legacy event sequence prompts and ledger purposes`
- `nontrivial turn has one intent purpose and zero route or reextract purposes`
- `trivial turn has zero preflight purposes and unchanged work call`
- `review plan and fix each reach semantic extractor exactly once`
- `semantic tier lowers fix fixture but policy admission remains downstream`
- `semantic risk cannot lower deterministic critical`
- `semantic parse failure falls back after one attempt and never calls legacy closures`
- `semantic extractor throw and abort produce no retry`
- `same shipped observing budget reaches semantic and work calls`
- `preflight deps retain legacy closures for rollback while exposing semantic closure`

**Fixtures:** success = full semantic frame plus work provider; cancel = abort during deferred semantic stream; failure = null/malformed/error; injected crash = semantic closure throws. Assert work starts only on success/fail-soft, never after cancellation.

**Performance/baseline:** fake provider count is authoritative: nontrivial changes from the current possible 0/1/2 preflight calls to exactly 1 under injection; trivial remains 0. With an exact 25 ms semantic delay, pre-work elapsed adds one delay, not two. Live threshold is owned by 08d.

**Flag/rollback/migration:** test-only `OrchestrateDeps.semanticPreflightV1`; production flag remains absent. Rollback stops injecting the field. No persistent schema change.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/types.ts src/core/orchestrate.ts src/interface/preflight-deps.ts test/unit/orchestrate-semantic-preflight.test.ts test/unit/orchestrate-unify-preflight.test.ts test/unit/preflight-deps.test.ts test/unit/turn-call-budget-preflight.test.ts && npx vitest run test/unit/orchestrate-semantic-preflight.test.ts test/unit/orchestrate-unify-preflight.test.ts test/unit/preflight-deps.test.ts test/unit/turn-call-budget-preflight.test.ts test/arch/provider-call-budget-guard.test.ts
```

Expected: new-path receipt contains one `intent`; legacy off fixtures are deep-equal before/after. Product observable state remains legacy because no composition sets the gate.

### P1-08f — `SEMANTIC-INTENT-PERSISTENCE`

**One invariant:** every nontrivial semantic turn appends its full semantic contract to the existing intent-version row exactly once, without rewriting old rows or blocking work on persistence failure.

**Preconditions/dependencies:** 08e; existing default-on intent store and atomic JSONL append; shipped Item-9 receipt reconciliation and architecture guard remain green. Item-9 receipt identity is not persistence identity and remains unchanged.

**Maximum file set (exhaustive):**

- `src/core/intent-version.ts`
- `src/core/orchestrate.ts`
- `src/infra/jsonl-guards.ts`
- `test/unit/intent-store.test.ts`
- `test/unit/orchestrate-intent-store.test.ts`
- `test/unit/jsonl-guards-intent-version.test.ts`
- `test/unit/semantic-preflight-persistence.test.ts` (new)

**Schema diff:** add optional `semanticPreflight?: SemanticPreflightV1` to the existing `IntentVersion` V1 top level and optional input to `buildIntentVersion`. Do not increment the outer version and do not rewrite JSONL. New guard code strictly validates the optional semantic payload through the shared pure guard/parser; absent remains valid. Old binaries already ignore unknown top-level keys, so downgrade reads the row's legacy intent fields and ignores semantic data. The existing `intent` projection continues to carry objective/done/risk for older consumers.

Persistence occurs after semantic resolution and before execution, at the existing single intent append point. A nontrivial parse failure persists the complete rules fallback with unknown done condition. Trivial bypass stays on the current lightweight path and need not carry `semanticPreflight`. Append failure remains fail-soft and cannot trigger a second preflight or second append.

**Named tests:**

- `semantic turn appends one row with objective evidence done risk task shape and proposal`
- `legacy row without semantic field still passes guard and reads unchanged`
- `old-reader projection ignores additive semantic field`
- `malformed optional semantic payload fails new guard`
- `parse failure persists honest fallback with unknown done condition`
- `append rejection does not block work or duplicate preflight`
- `abort before persistence appends nothing`
- `injected throw between build and append leaves no partial JSONL line`

**Fixtures:** success = temp store append/read; cancel = abort before append; failure = writer rejects; injected crash = writer throws at atomic append boundary and subsequent reader sees either zero or one complete line, never partial.

**Performance/baseline:** this embeds data in the existing one append, so append count baseline and after are both one/nontrivial turn. On a temp filesystem, 100 rows before/after with identical fsync policy must show p95 delta no greater than 5 ms and row size no greater than 8 KiB after caps.

**Flag/rollback/migration:** data is written only when the injected semantic gate is on. Rollback disables the gate; do not delete rows. Upgrade accepts absent; downgrade ignores extra field. Revert code safely leaves additive JSON keys in old JSONL.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/intent-version.ts src/core/orchestrate.ts src/infra/jsonl-guards.ts test/unit/intent-store.test.ts test/unit/orchestrate-intent-store.test.ts test/unit/jsonl-guards-intent-version.test.ts test/unit/semantic-preflight-persistence.test.ts && npx vitest run test/unit/intent-store.test.ts test/unit/orchestrate-intent-store.test.ts test/unit/jsonl-guards-intent-version.test.ts test/unit/semantic-preflight-persistence.test.ts
```

Expected before: rows contain only legacy intent projection. Expected after: one additive semantic payload on new-path nontrivial turns; old rows and downgrade reads remain valid; failure/crash yields no partial state.

### P1-08g — `EVIDENCE-SENSITIVE-POLICY`

**One invariant:** confidence/uncertainty never authorizes an evidence-sensitive claim by itself; policy returns explicit pre-work action and completion obligations.

**Preconditions/dependencies:** 08a semantic types; the shipped Item-9 ledger remains the only model-call ledger and is unchanged because this slice is pure. Item 17 is a declared downstream consumer of completion obligations, not an implementation dependency.

**Maximum file set (exhaustive):**

- `src/core/evidence-investigation.ts` (new)
- `test/unit/evidence-investigation.test.ts` (new)
- `test/unit/brain.test.ts`

**Typed contract:**

```ts
export interface EvidenceCapabilities {
  readonly repoPresent: boolean;
  readonly localReadAvailable: boolean;
  readonly webSearchAvailable: boolean;
}

export interface EvidenceObservation {
  readonly needId: string;
  readonly kind: EvidenceKind;
  readonly status: 'obtained' | 'missing' | 'failed' | 'cancelled';
}

export interface EvidenceDecision {
  readonly beforeWork: 'none' | 'local' | 'web' | 'user-input' | 'cannot-ground';
  readonly beforeCompletion: readonly EvidenceNeed[];
  readonly mayStartWork: boolean;
  readonly reasons: readonly string[];
}

export function decideEvidenceInvestigation(
  task: string,
  semantic: SemanticPreflightV1,
  capabilities: EvidenceCapabilities,
  observations?: readonly EvidenceObservation[],
): EvidenceDecision;
```

Rules, in order:

1. A required pre-work need is satisfied only by an `obtained` observation with the same `needId` and kind. Missing, failed, cancelled, or unrelated observations never satisfy it.
2. Required `user-input` before answer/execution yields `user-input`, `mayStartWork:false` until a later user-turn observation exists; Item 8 does not synthesize that observation.
3. Required external-source before answer/execution yields `web` only when web capability exists; otherwise `cannot-ground`, false.
4. Required local-code before answer/execution yields `local` only when repo/read capability exists; otherwise `cannot-ground`, false.
5. The existing deterministic `isInvestigable`/`needsContext` result is a floor: an existing-code claim/change in a present repo synthesizes stable need `DET_LOCAL` and requires local evidence even if the model omitted it or uncertainty is low. The explicit-current lexicon already used by `needsExternal` (`latest`, `current`, `today`, `recent`, `look up`, `search the web`, `up to date`, `as of now/today`, `news`) analogously synthesizes `DET_WEB`.
6. High uncertainty may start only after a required pre-work evidence action has an obtained observation; with none/capability absent it is false.
7. Medium uncertainty may start immediately only when at least one required cheap `before-completion` need of kind command-output, test-result, or local-code is present. Those needs are returned unchanged as obligations. Otherwise it must obtain local/web evidence first or return false.
8. Low uncertainty may start when no required pre-work need exists, but all before-completion needs remain obligations.

This replaces the low-only authorization concept under the new flag; it does not change `confidenceTooLowToAct` on the legacy path.

**Named tests:**

- `medium uncertainty with required test obligation may start and preserves obligation`
- `medium uncertainty without cheap verification cannot start merely from confidence`
- `high uncertainty requires obtained pre-work evidence`
- `existing code claim requires local read even when semantic omitted evidence`
- `fresh external claim requires web and never falls back to local`
- `missing capability returns cannot-ground rather than pretending grounded`
- `failed or unrelated observation does not satisfy a required need`
- `obtained matching observation clears only its required pre-work need`
- `low uncertainty preserves before-completion obligations`
- `legacy confidenceTooLowToAct remains low-only outside semantic policy`

**Fixtures:** success/failure tables are pure; cancellation = N/A; injected crash = N/A. Invalid semantic input is impossible after 08a parsing; do not add permissive coercion here.

**Performance/baseline:** 100,000 decisions after warmup, p95 below 0.1 ms; zero provider calls before/after.

**Flag/rollback/migration:** runtime flag N/A; pure and unreachable. Revert files. No state.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/evidence-investigation.ts test/unit/evidence-investigation.test.ts test/unit/brain.test.ts && npx vitest run test/unit/evidence-investigation.test.ts test/unit/brain.test.ts
```

Expected: medium-confidence fixtures cannot proceed without a scheduled cheap verification signal; legacy brain tests remain unchanged. No observable runtime diff.

### P1-08h — `STRUCTURED-EVIDENCE-RECEIPTS`

**One invariant:** “obtained” evidence means a real nonempty local read or web result, not a model confidence label, located path, or attempted call.

**Preconditions/dependencies:** 08g and existing `ResearchPort`. Shipped Item-9 remains the call-attempt ledger for web provider calls; evidence receipt is separate observation data and must not be merged into that ledger.

**Maximum file set (exhaustive):**

- `src/core/evidence-investigation.ts`
- `src/core/research.ts`
- `test/unit/research.test.ts`
- `test/unit/evidence-investigation.test.ts`

**Typed contract:** add this discriminated union plus signal-aware `collectLocalEvidence(...)` and `collectWebEvidence(...)`. Existing string-returning `buildRetrievalContext`/`buildWebContext` delegate to these and preserve legacy output exactly.

```ts
export type EvidenceReceiptV1 =
  | (EvidenceObservation & {
      readonly version: 1;
      readonly kind: 'local-code';
      readonly query: string;
      readonly pathsLocated: readonly string[];
      readonly pathsRead: readonly string[];
      readonly renderedContext: string;
    })
  | (EvidenceObservation & {
      readonly version: 1;
      readonly kind: 'external-source';
      readonly query: string;
      readonly sourceText: string;
      readonly renderedContext: string;
    });
```

Local status is obtained only when `pathsRead.length>0` and each path corresponds to a successful nonempty `readFile`; located-only is missing. Web is obtained only for a nonempty search result. Check `AbortSignal` before and between port operations. Port rejection is failed. All existing hit/file/character caps remain exact.

**Named tests:**

- `successful local collection names only paths actually read`
- `located but unreadable path is missing not obtained`
- `successful web collection retains bounded source text`
- `empty web result is missing`
- `abort between grep and read returns cancelled and performs no later reads`
- `port rejection returns failed without throwing`
- `injected read throw cannot create obtained receipt`
- `legacy rendered context is byte-identical through wrapper`

**Fixtures:** success = two read files/nonempty web; cancel = deferred grep then abort; failure = empty/unreadable/rejected port; injected crash = second read or web method throws.

**Performance/baseline:** current bounds are six hits, three reads, 2,000 local chars, and 1,500 web chars. With fake port latency 2 ms/operation, assert operation count never exceeds four greps + three reads and p95 stays within 25 ms. Model calls: local zero; web exactly whatever the injected `webSearch` implementation records in Item 9 (normally one `research-web`), never an `intent` call.

**Flag/rollback/migration:** runtime flag N/A; legacy wrappers unchanged. Revert additions. Receipts are in-memory until next slice.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/evidence-investigation.ts src/core/research.ts test/unit/research.test.ts test/unit/evidence-investigation.test.ts && npx vitest run test/unit/research.test.ts test/unit/evidence-investigation.test.ts
```

Expected: only actual reads/search results produce obtained receipts; legacy context snapshots are deep-equal. No product path uses new receipt yet.

### P1-08i — `EVIDENCE-ENFORCEMENT-WIRING`

**One invariant:** a semantic turn requiring evidence either obtains it before work/answer or proceeds only with a typed completion obligation/explicit unverified result; it is never silently labeled grounded.

**Preconditions/dependencies:** 08e–08h. Item 9 accounts for the semantic and any web-search calls. Item 17 remains required before completion obligations can settle “done.”

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/orchestrate.ts`
- `src/core/turn-directive.ts`
- `test/unit/orchestrate-evidence-sensitive.test.ts` (new)
- `test/unit/orchestrate-required-investigation.test.ts`
- `test/unit/turn-directive.test.ts`
- `test/unit/turn-directive-orchestrate.test.ts`

**Behavioral diff:** under `semanticPreflightV1`, call `decideEvidenceInvestigation` after semantic resolution and before work. Run at most one required local or web collection, without semantic re-extraction. Store its receipt and append its rendered context to the work prompt. `mayStartWork:false` yields a typed pre-provider final/question that names missing evidence and has zero work calls; it does not silently fall through. Completion needs are threaded on `TurnDirective` as `evidenceObligations` and into the prompt, but cannot mark completion.

Extend output validation with `require_observed_grounding` only for semantic lookup/analysis/decision factual codebase or current-external claims. It accepts (a) a referenced path present in `receipt.pathsRead`, (b) source text/reference present in an obtained web receipt, or (c) an explicit sentence beginning `Unverified:`. A plausible path not in the receipt fails. Ordinary conversational prose and greenfield change requests are not over-blocked. Keep the legacy `require_grounded_recommendation` behavior unchanged when the semantic flag is off.

**Named tests:**

- `medium uncertainty runs after local evidence and one semantic call only`
- `medium uncertainty may execute with required test obligation but cannot settle it complete`
- `missing local capability stops before work and labels claim unverified`
- `fresh external claim obtains one web receipt and cites it`
- `local retrieval failure cannot set groundedness`
- `observed read path passes validator while invented path fails`
- `explicit Unverified sentence is honest fallback and passes`
- `trivial turn performs no semantic local or web investigation`
- `cancellation during evidence collection yields cancelled final and zero work calls`
- `injected retrieval throw yields failed receipt and zero fabricated evidence`
- `legacy required-investigation and grounded-recommendation suites remain unchanged off`

**Fixtures:** success = actual local/web receipt; cancel = abort during deferred read/search; failure = absent capability, empty receipt, validator miss; injected crash = research port throws. Test provider/work spies fail if called after cancel or cannot-ground.

**Performance/baseline:** semantic preflight remains exactly one `intent` call; local investigation adds zero model calls and stays within existing retrieval caps; required web adds exactly one `research-web` attempt and is reported separately from preflight latency. On fake 25 ms semantic + 2 ms/operation local fixtures, pre-work p95 must be below 60 ms. Default-on uses the live thresholds in 08d plus local-retrieval p95 no greater than 150 ms on the same checkout.

**Flag/rollback/migration:** test-only injected flag. Rollback removes injection and returns to legacy brain/directive behavior. Evidence obligations are in-memory until Item 17; no persisted completion schema is introduced.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/core/types.ts src/core/orchestrate.ts src/core/turn-directive.ts test/unit/orchestrate-evidence-sensitive.test.ts test/unit/orchestrate-required-investigation.test.ts test/unit/turn-directive.test.ts test/unit/turn-directive-orchestrate.test.ts && npx vitest run test/unit/orchestrate-evidence-sensitive.test.ts test/unit/orchestrate-required-investigation.test.ts test/unit/turn-directive.test.ts test/unit/turn-directive-orchestrate.test.ts test/unit/turn-call-budget-preflight.test.ts
```

Expected before: medium confidence can act with prompt advice alone and grounding may be inferred from prose. Expected after under injection: evidence decision/receipt is observable, invented evidence fails, unresolved completion obligation remains unresolved, and receipt preflight purposes remain 0 or 1.

### P1-08j — `DARK-PRODUCTION-COMPOSITION`

**One invariant:** one explicit default-off flag atomically selects the complete semantic/evidence path across interactive, one-shot, and REPL entry points, with a tested legacy rollback.

**Preconditions/dependencies:** 08a–08i, shipped P1-09j global composition/receipt callback, and green architecture guard. Do not proceed if any entry point does not receive the same turn budget object.

**Maximum file set (exhaustive):**

- `src/infra/config.ts`
- `src/interface/ui/semantic-preflight-flag.ts` (new)
- `src/interface/preflight-deps.ts`
- `src/interface/menu.ts`
- `src/cli.ts`
- `test/unit/semantic-preflight-flag.test.ts` (new)
- `test/unit/menu-flow.test.ts`
- `test/unit/run.test.ts`
- `test/unit/preflight-deps.test.ts`
- `test/unit/global-call-budget-receipt.test.ts`

**Behavioral diff:** add the shared feature flag/config mirror and compose `makeSemanticPreflightExtractor` with the exact same observing budget passed to work. Menu, `run`, and REPL resolve the flag once per turn and set both semantic extractor and `semanticPreflightV1:true`. Goal-attempt turns with a complete objective/done contract bypass; otherwise they follow the same rule. Keep construction of legacy route/intent closures for flag-off rollback. Do not change existing flag defaults, user-facing Auto copy, ledger mode, budget total, or reservations.

**Named tests:**

- `semantic preflight flag defaults false for absent false zero and garbage`
- `explicit env or config true enables V1`
- `flag off interactive one-shot and REPL receipts match legacy snapshots`
- `flag on nontrivial entry points record one intent zero route and zero reextract`
- `flag on trivial entry points record zero preflight purposes`
- `same observing budget object owns semantic evidence work and receipt callback`
- `old unify risk and investigation flags cannot add calls inside V1 branch`
- `unset flag rollback restores legacy route and intent closures`
- `provider failure cancellation and receipt callback throw remain fail-soft without duplicate calls`

**Fixtures:** success = each entry point with full result; cancel = interrupt semantic stream; failure = provider error/malformed result; injected crash = extractor or diagnostic receipt callback throws. Existing auto-stage parked-only fixture must remain zero execution callbacks.

**Performance/baseline:** flag-off call counts and prompts are snapshot-equal. Flag-on uses 08d metrics; trivial 0/50 and nontrivial exactly 1/150 are hard acceptance, not averages. No default-on latency claim is made.

**Flag/rollback/migration:** `MYSHELL_SEMANTIC_PREFLIGHT_V1` / `experimentalSemanticPreflightV1`, default false. Rollback procedure is the shared procedure in section 4. Additive persisted semantic fields remain readable and require no rollback migration.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/infra/config.ts src/interface/ui/semantic-preflight-flag.ts src/interface/preflight-deps.ts src/interface/menu.ts src/cli.ts test/unit/semantic-preflight-flag.test.ts test/unit/menu-flow.test.ts test/unit/run.test.ts test/unit/preflight-deps.test.ts test/unit/global-call-budget-receipt.test.ts && npx vitest run test/unit/semantic-preflight-flag.test.ts test/unit/menu-flow.test.ts test/unit/run.test.ts test/unit/preflight-deps.test.ts test/unit/global-call-budget-receipt.test.ts test/arch/provider-call-budget-guard.test.ts
```

Before observable state: new path unreachable. After: still unreachable by default; explicit flag produces one complete semantic contract/receipt, and removing it restores the exact legacy receipt. No user-visible default changes.

### P1-08k — `EVALUATED-DEFAULT-PROMOTION-AND-LEGACY-RETIREMENT`

**One invariant:** default-on and legacy-call retirement happen only from three complete green artifacts; otherwise this slice cancels without edits.

**Preconditions/dependencies:** 08j; three semantic and three same-host legacy baseline artifacts satisfying every 08d threshold; Item-9 receipt reconciliation green on every entry point. Item 5 need not be complete because proposed provider/effort remains advisory, but no code may present it as actual allocation.

**Cancel conditions:** missing/incomplete artifact, any risk false negative, any trivial call, any nontrivial second/missing preflight, p95/p99 miss, schema miss beyond threshold, host/provider/model mismatch, or dirty unowned file overlapping the maximum set. Cancellation is the correct result and requires no code change.

**Maximum file set (exhaustive):**

- `src/interface/ui/semantic-preflight-flag.ts`
- `src/interface/preflight-deps.ts`
- `src/interface/menu.ts`
- `src/cli.ts`
- `src/infra/config.ts`
- `test/unit/semantic-preflight-flag.test.ts`
- `test/unit/preflight-deps.test.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/run.test.ts`
- `docs/r7-item8-semantic-preflight-contract.md`

**Exact behavioral diff:** make absence of env/config select V1; retain explicit `MYSHELL_SEMANTIC_PREFLIGHT_V1=0|false|off|no` as a one-release rollback. Stop constructing the route classifier and legacy intent extractor only when V1 is selected; retain their modules and explicit-off construction for that release. Do not delete flags/modules in this slice. Record artifact paths, hashes, aggregate metrics, provider/model, and date in this section under a new “promotion receipt” subsection.

**Named tests:**

- `absent flag defaults V1 on only after recorded promotion gate`
- `explicit off restores legacy constructors and receipt shape`
- `default trivial has zero preflight and default nontrivial exactly one`
- `default risk floor and evidence enforcement remain active`
- `legacy rollback works in interactive one-shot and REPL`

**Fixtures:** success = six complete threshold-passing artifacts; cancel = user abort during eval or explicit off; failure = any threshold miss; injected crash = artifact loader throws/truncated JSON and causes cancel/no edits, never promotion.

**Performance/baseline:** the committed promotion receipt must report all raw artifact hashes and the exact 08d metrics. Thresholds are not loosened in this slice. Baseline is the same-host `legacy-intent` p95 from those artifacts.

**Flag/rollback/migration:** default changes only here. Roll back with explicit false env/config; revert the slice if broader rollback is needed. Additive persisted semantic payloads remain valid in either direction. Remove the explicit-off escape hatch and legacy closures only in a separately planned deprecation after one release of telemetry; that deletion is outside Item 8.

**Acceptance receipt:**

```bash
npx tsc --noEmit && npx eslint src/interface/ui/semantic-preflight-flag.ts src/interface/preflight-deps.ts src/interface/menu.ts src/cli.ts src/infra/config.ts test/unit/semantic-preflight-flag.test.ts test/unit/preflight-deps.test.ts test/unit/menu-flow.test.ts test/unit/run.test.ts && npx vitest run test/unit/semantic-preflight-flag.test.ts test/unit/preflight-deps.test.ts test/unit/menu-flow.test.ts test/unit/run.test.ts test/unit/global-call-budget-receipt.test.ts test/arch/provider-call-budget-guard.test.ts
node --import tsx/esm src/cli.ts eval --semantic-preflight --engine=semantic-v1 --output=.tmp/item8-semantic-promotion-check.json --yes
```

Expected before: absent flag selects legacy. Expected after only with green artifacts: absent selects V1, explicit false selects legacy, trivial remains zero, and nontrivial remains one. If the live command exits 2 or any threshold fails, expected after state equals before and the slice is cancelled.

## 6. Cross-slice acceptance and handoff to Items 5 and 17

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npx vitest run test/arch/provider-call-budget-guard.test.ts test/unit/global-call-budget-receipt.test.ts
```

The changed-file list must be a subset of that slice's maximum set. The provider guard must report zero direct product provider calls outside the existing seam. The global receipt must reconcile actual fake-provider streams. A Vitest pass with an unlinted fixture or an incomplete eval artifact is not acceptance.

Item 5 receives `ResolvedSemanticPreflight` and may use route/proposed execution only as inputs to its pure `TurnPlan` finalizer. It remains responsible for policy admission, actual provider/model/effort, shape, failover, verification reservation, and planned-versus-actual receipt. Item 8 consumers must not re-derive or apply those decisions.

Item 17 receives `EvidenceDecision.beforeCompletion`, actual `EvidenceReceiptV1` values, and the persisted semantic objective/done condition. Until Item 17 returns a versioned completion result, those obligations can be pending or unmet but never silently complete.

## 7. Final definition of done

Item 8 is implemented dark when 08j is green. It is promoted only when 08k's prerequisites are proven. The implementation satisfies Item 8 only if all of the following are simultaneously true:

- deterministic risk is always the effective floor and the 30 dangerous eval cases have zero false negatives;
- `review` and `plan` remain characterized as no current tier evidence and `fix` as tier evidence, while all three use the semantic path when nontrivial and enabled;
- each nontrivial enabled turn has one persisted semantic objective/evidence/done contract, or an honest complete fallback after exactly one failed attempt;
- trivial enabled turns add no metered call;
- no enabled turn begins route or re-extraction purposes, and nontrivial turns begin at most one `intent` semantic purpose;
- required local/current evidence is actually observed or explicitly labeled unverified; model confidence is never evidence;
- provider/effort remains advisory until Item 5, and completion obligations remain unsettled until Item 17;
- flag-off rollback restores the legacy path without a data migration;
- latency, paraphrase, schema, risk, and bypass promotion thresholds are recorded and green rather than asserted anecdotally.
