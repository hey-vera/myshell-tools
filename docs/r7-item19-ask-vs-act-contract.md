# Item 19 contract - ask-vs-act judgment policy

Status: delegation-ready implementation contract, grounded at repository head `893e8db` on 2026-07-02.

This document is controlling for Round-7 Item 19. Item 8 classifies semantic intent and evidence needs. Item 5 finalizes the authoritative `TurnPlanV1`. Item 17 owns terminal completion truth and delivery quality. Item 13 will own deeper goal stewardship. Item 19 owns the felt professional boundary between answering, asking, acting, parking, resuming, escalating, and refusing.

At document creation the worktree was clean before this file was added.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_ASK_ACT_JUDGMENT_V1` is explicitly enabled, every nonterminal foreground turn with a completed semantic preflight/legacy classification and a finalized or legacy-reconciled TurnPlan receives exactly one pure `AskActDecisionV1` before work, question rendering, goal mutation, stale-work resume, or refusal. The decision chooses exactly one professional action:

- `answer-now`
- `ask-one`
- `act`
- `park-goal`
- `resume-stale-work`
- `escalate-confirm`
- `decline`

The decision does not open a provider stream. It consumes signals already produced by Items 8 and 5 plus current goal/work state, menu confirmation policy, and hard safety rules. It feeds Item 13 as a structured stewardship action and feeds Item 17 as the expected terminal/quality contract for the turn.

This item does **not**:

- replace Item 8 semantic classification, evidence collection, or risk flooring;
- replace Item 5 provider/model/effort/allocation authority;
- mark completion done, reviewed, verified, or blocked; Item 17 remains terminal truth;
- create a goal DAG, durable resume machine, or exactly-once executor;
- add a model "judgment" call;
- ask generic menus such as "are you fixing, adding, polishing, or integrating?";
- silently execute high-risk, destructive, external, or credential-sensitive work without explicit confirmation;
- make stale goals resume automatically by default before Item 13 consumes the structured decision.

The unsafe interpretation would be "the assistant should be proactive, so act whenever possible." That overreaches. The equally bad interpretation is "ask whenever uncertain." That underreaches. The smaller contract here makes the single professional action explicit, table-tested, capped, rollback-safe, and grounded in existing evidence.

## 2. Current-state evidence and invariants

All citations below are current at `893e8db`; workers must re-run `nl -ba` or equivalent before editing and record drift rather than silently relying on stale ranges.

- `assess(output)` parses a trailing confidence envelope and deliberately returns `confidence:null` on absent, malformed, or invalid data; it never fabricates confidence from prose at `src/core/assess.ts:1-11,64-105`.
- `classify(task)` is pure and names matched tier/risk signals in its rationale; a lone soft manager word such as `plan` or `review` is not enough to select manager at `src/core/classify.ts:17-29,64-81,249-289,322-407`.
- `hasWorkIntent(task)` treats any manager or IC signal as work intent but keeps pure worker lookups out of goal planning at `src/core/classify.ts:297-310`.
- `classifyCommand(command)` is separate from task classification and defaults unrecognized shell commands conservatively to `local-write`; destructive filesystem, credential-sensitive, dependency-install, and read-only command tiers are explicit at `src/core/classify.ts:411-562`.
- `planEngagement(signals)` is already a pure, total judgment layer over intent frame, classification, route plan, style bias, memory, and task; it adds no model call and fail-softs to `EXECUTE_NOW` at `src/core/engagement.ts:1-25,375-386`.
- Existing engagement discipline says `EXECUTE_NOW` is the default, the trivial fast path is instant, irreversible plus ambiguous creates a safety floor, asks are capped at one, and stated assumptions are preferred over questions at `src/core/engagement.ts:12-21,78-90`.
- The current trivial predicate is worker tier, low risk, no route plan, no fork, reversible, short, and single-clause at `src/core/engagement.ts:154-169`.
- Existing engagement already implements "investigate before interrogate": investigable codebase forks become context investigation, while only genuine non-investigable forks earn an ask at `src/core/engagement.ts:427-459`.
- Existing ask derivation is bounded by `ASK_CAP`, rejects generic open menus, carries real fork options, and marks a recommended option from the extractor rather than inventing one at `src/core/engagement.ts:538-604`.
- Menu yes/no parsing has a strict mode where only explicit `y`/`yes` confirms; Enter, EOF, typos, and unrelated keys cannot confirm destructive/sensitive actions at `src/interface/menu-questions.ts:24-47,60-80`.
- Structured question answer parsing already has pure `answer|cancel|retry` outcomes and treats blank/EOF/Ctrl-C as cancel at `src/interface/menu-questions.ts:104-188`.
- Discovery signals are conservative, pure, no-I/O, derived only from provider output or parsed assessment, and cannot bypass existing policy gates at `src/core/discovery.ts:1-22`.
- Discovery escalation/review predicates only request existing gates for high-confidence wider root cause, cross-cutting change, or high-stakes surface; local larger fixes continue without asking the user when reversible and in scope at `src/core/discovery.ts:333-376`.
- Review verdict parsing fail-safes to `revise` with `parsed:false`, never `approve`, so a broken reviewer cannot silently ship work at `src/core/review.ts:1-14,25-35,117-158`.
- The current goal steward is pure and only classifies `fresh`, `stale`, `inactive`, `blocked`, and `verified-complete`; recommended actions are only `none`, `review`, or `resolve-done` at `src/core/goal-steward.ts:18-29`.
- Goal stewardship currently recommends review for blocked, inactive, stale, and done-without-verified-verdict cases, and auto-resolves only when `isGoalVerifiedDone` permits it at `src/core/goal-steward.ts:98-196`.
- Goal top-finding priority is blocked > inactive > stale > verified-complete > fresh at `src/core/goal-steward.ts:203-247`.

Baseline at this head:

| surface | current source of authority | Item-19 requirement |
|---|---|---|
| ask discipline | `planEngagement`, `deriveAskFromForks`, menu question parsers | one runtime decision chooses ask or non-ask, with one-question cap and receipt reason |
| semantic intent | Item 8 `ResolvedSemanticPreflight` when enabled, legacy frame otherwise | consumed as input, never re-derived |
| execution plan | Item 5 `TurnPlanV1` when enabled, legacy route/classification otherwise | consumed as input, never overwritten |
| high-risk confirmation | strict yes/no menu helpers plus command/task risk signals | structured `escalate-confirm` before irreversible or policy-sensitive action |
| stale goals | `goal-steward.ts` audit/review/resolve-done | Item 19 chooses whether current turn should resume, park, ask, or leave to steward |
| completion | fragmented final/verify/trust today, Item 17 contract later | Item 19 emits expected action/quality obligations only; no done claim |

## 3. Shared typed contract

Slice 19a must export these names from `src/core/ask-act-judgment.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them.

```ts
export type AskActAction =
  | 'answer-now'
  | 'ask-one'
  | 'act'
  | 'park-goal'
  | 'resume-stale-work'
  | 'escalate-confirm'
  | 'decline';

export type AskActReasonCode =
  | 'trivial-answer'
  | 'lookup-answer'
  | 'turnplan-no-work'
  | 'turnplan-work-authorized'
  | 'required-evidence-before-answer'
  | 'required-evidence-before-work'
  | 'genuine-user-fork'
  | 'ask-budget-exhausted'
  | 'investigate-instead-of-ask'
  | 'assumption-cheaper-than-ask'
  | 'irreversible-or-high-risk'
  | 'strict-confirm-required'
  | 'policy-denied'
  | 'capability-missing'
  | 'unsafe-or-disallowed'
  | 'goal-blocked'
  | 'goal-stale'
  | 'goal-inactive'
  | 'goal-park-requested'
  | 'goal-resume-requested'
  | 'resume-not-safe'
  | 'completion-obligation-unmet'
  | 'discovery-escalation'
  | 'review-inconclusive'
  | 'fail-soft';

export interface AskActAskBudget {
  readonly maxQuestionsThisTurn: 0 | 1;
  readonly questionsAlreadyAskedForIntentVersion: number;
  readonly questionsAlreadyAskedForGoal: number;
  readonly hardCapPerIntentVersion: 0 | 1;
  readonly hardCapPerGoalBeforeProgress: 0 | 1;
}

export type AskActGoalSignal =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'finding';
      readonly goalId: string;
      readonly classification: 'fresh' | 'stale' | 'inactive' | 'blocked' | 'verified-complete';
      readonly recommendedAction: 'none' | 'review' | 'resolve-done';
      readonly reason: string;
    };

export interface AskActWorkState {
  readonly hasActiveWork: boolean;
  readonly hasPendingMutation: boolean;
  readonly hasUnmetCompletionObligation: boolean;
  readonly lastAssistantAction?: AskActAction;
  readonly lastIntentVersionId?: string;
  readonly staleResumeCandidate?: {
    readonly goalId: string;
    readonly safeToResume: boolean;
    readonly reason: string;
  };
}

export interface AskActPolicyInput {
  readonly allowAct: boolean;
  readonly allowAsk: boolean;
  readonly allowGoalMutation: boolean;
  readonly allowResume: boolean;
  readonly requireExplicitConfirmForRisk: 'none' | 'high' | 'critical';
  readonly declineReasons: readonly string[];
}

export interface AskActDecisionInput {
  readonly turnId: string;
  readonly task: string;
  readonly semantic?: ResolvedSemanticPreflight;
  readonly turnPlan?: TurnPlanV1;
  readonly legacy: {
    readonly classification: Classification;
    readonly routePlan: boolean;
    readonly intentFrame?: IntentFrame;
  };
  readonly engagementPlan?: EngagementPlan;
  readonly askBudget: AskActAskBudget;
  readonly policy: AskActPolicyInput;
  readonly goal: AskActGoalSignal;
  readonly workState: AskActWorkState;
  readonly evidence: {
    readonly requiredBeforeAnswer: number;
    readonly requiredBeforeWork: number;
    readonly beforeCompletionObligations: number;
    readonly observedPreworkSatisfied: boolean;
  };
  readonly assessment?: Assessment;
  readonly discoverySignals?: readonly DiscoverySignal[];
}

export interface AskActQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
    readonly recommended: boolean;
  }[];
  readonly allowFreeText: boolean;
}

export interface AskActDecisionV1 {
  readonly version: 1;
  readonly turnId: string;
  readonly action: AskActAction;
  readonly reasonCodes: readonly AskActReasonCode[];
  readonly rationale: string;
  readonly question?: AskActQuestion;
  readonly confirm?: {
    readonly prompt: string;
    readonly requireExplicit: true;
    readonly risk: Risk;
  };
  readonly goalAction?: {
    readonly kind: 'park' | 'resume' | 'leave-active';
    readonly goalId?: string;
    readonly reason: string;
  };
  readonly expectedCompletion: {
    readonly terminalHint: 'answered' | 'needs-user' | 'done-or-answered' | 'blocked' | 'failed';
    readonly deliveryObligations: readonly string[];
  };
  readonly feeds: {
    readonly item13: 'none' | 'ask' | 'act' | 'park' | 'resume' | 'review';
    readonly item17: 'answer-quality' | 'work-completion' | 'blocked-or-declined' | 'needs-user';
  };
  readonly source: 'policy' | 'fail-soft';
}

export function decideAskAct(input: AskActDecisionInput): AskActDecisionV1;
```

Caps are part of the contract: rationale 180 characters; question prompt 180; option label 80; option description 120; confirm prompt 180; goal reason 180; at most six reason codes; at most four options; at most six delivery obligations. IDs must match `/^[a-z][a-z0-9_-]{0,47}$/`. Extra JSON keys are ignored only by a dedicated parser; constructors and `decideAskAct` must not accept unknown enum values. Invalid or malformed input fail-softs to `answer-now` only for read-only/trivial inputs, otherwise `ask-one` if asking is allowed and useful, otherwise `escalate-confirm` or `decline` with `fail-soft`.

`decideAskAct` is pure, total, deterministic, no I/O, no time, no randomness, and no provider imports. It may call existing pure helpers from `classify.ts`, `engagement.ts`, `discovery.ts`, `review.ts`, and `goal-steward.ts`; it must not call shell, filesystem, provider, web, menu I/O, or completion constructors.

## 4. Runtime decision contract

The runtime decision is a priority cascade. It returns exactly one `action`; later layers may render, execute, or skip based on that action, but they must not reinterpret multiple actions from prose.

1. **Decline beats everything.** If `policy.declineReasons` is nonempty, requested action is unsafe/disallowed, capability is missing in a way that cannot be resolved by user input, or Item 5 produced no legal allocation for required work, return `decline`. Include `policy-denied`, `unsafe-or-disallowed`, or `capability-missing`.
2. **Escalate/confirm beats ask.** If effective risk is `critical`, or risk is `high` and the next action mutates workspace/external state, or `classifyCommand`/TurnPlan marks destructive/credential-sensitive execution, return `escalate-confirm` with strict confirmation. This uses the strict menu contract: Enter/EOF/typos do not confirm.
3. **Resume stale work beats new parking only when safe.** If the current user turn explicitly requests continuation/resume and `workState.staleResumeCandidate.safeToResume=true`, return `resume-stale-work`. If not safe, return `ask-one` only when the missing user decision is specific and ask budget remains; otherwise `park-goal` or `escalate-confirm` according to risk.
4. **Park beats act when the user asks to defer or the work state cannot safely proceed.** Explicit "park/later/not now" intent, blocked goal findings, or unmet completion obligations that make continued execution ambiguous return `park-goal` unless the user explicitly asks for an answer-only summary.
5. **Required evidence beats answer/work.** Required before-answer evidence makes `answer-now` illegal. Required before-work evidence makes `act` illegal until evidence is observed or the action is a typed `ask-one`, `escalate-confirm`, `park-goal`, or `decline`.
6. **A genuine user fork may ask once.** Return `ask-one` only when the unresolved fork is non-investigable, user-owned, answer-changing, not generic, and the ask budget permits it.
7. **Answer beats act for no-work plans.** If TurnPlan strategy is `none`, task shape is conversation/lookup/analysis, and evidence obligations are either satisfied or explicitly not required, return `answer-now`.
8. **Act beats planning prose when work is authorized.** If TurnPlan has a legal work allocation, risk confirmation is not required or already satisfied by the caller, evidence-before-work is satisfied, and no genuine user fork remains, return `act`.
9. **Fail-soft order.** If inputs are inconsistent, choose the least environment-changing useful action: `answer-now` for trivial/read-only; `ask-one` for a specific user-owned fork within budget; `park-goal` for goal work that cannot proceed; `escalate-confirm` for risk ambiguity; `decline` for unsafe/capability-denied.

Tie-breaks are stable and testable:

- `decline > escalate-confirm > park-goal > resume-stale-work > ask-one > act > answer-now` when safety or authorization is involved.
- `resume-stale-work > park-goal` only on explicit resume/continue intent plus safe resume evidence.
- `act > ask-one` when uncertainty is investigable from repo/evidence or TurnPlan already names a safe default.
- `ask-one > act` when the wrong choice would cause irreversible, external, user-visible, or broad architectural work and the user is the only source of truth.
- `answer-now > ask-one` when a stated assumption can answer the request and the ask would merely choose tone, category, or a generic task menu.

## 5. Ask budget and one-question policy

The ask budget is deliberately stingy:

- hard cap per turn: `maxQuestionsThisTurn <= 1`;
- hard cap per `intentVersionId`: one clarifying question before material progress;
- hard cap per goal before progress: one clarifying question, then park or act on stated assumptions;
- a cancelled/blank question consumes the turn ask but not the intent/goal cap if no question was actually rendered;
- generic menus consume no budget because they must not render;
- confirmation prompts are not clarifying questions, but destructive/sensitive confirmations must be strict and cannot be repeated more than once for the same pending operation without a changed risk reason.

A single clarifying question is worth more than acting only when all are true:

- the answer materially changes the work product, external side effect, user-visible design, data loss risk, scope boundary, or goal ordering;
- the assistant cannot cheaply determine the answer from local code, current evidence, TurnPlan, prior accepted intent, or command output;
- acting on the default would be hard to reverse, expensive to repair, or likely to violate user preference;
- the question can be phrased as one concrete decision with 2-4 real options and one recommended default;
- the action can wait without losing state, quota, or user work.

An ask is not allowed when:

- it is a broad category menu;
- it asks about discoverable codebase facts;
- it asks the user to restate the task;
- it asks multiple unrelated questions;
- it compensates for missing investigation the system is capable of doing;
- ask cap is exhausted and no new evidence changed the decision.

## 6. Overreach and underreach thresholds

This contract draws the felt line with concrete thresholds:

Overreach guards:

- no `act` when effective risk is `critical`;
- no `act` for high-risk mutation/external side effect without strict confirmation;
- no `resume-stale-work` unless user intent is explicit and resume candidate is safe;
- no `park-goal` mutation unless user requested deferral, goal is blocked/stale/inactive, or Item 17/13 input says progress cannot be honest;
- no goal completion, done claim, or dependency advancement from Item 19;
- no shell execution authority is created here; Item 5 allocation and existing shell/command policy still govern execution;
- no assumption may override explicit user instruction, policy denial, or evidence obligation.

Underreach guards:

- `answer-now` for trivial worker/low-risk/single-clause turns;
- `act` for authorized reversible work when only investigable uncertainty remains;
- `act` when TurnPlan names a safe provider/work allocation and the semantic result has low/medium uncertainty with required prework evidence already satisfied;
- state assumptions rather than ask for low-cost defaults such as file naming, formatting, local refactor route, or a discoverable code path;
- resume explicit stale work when safe rather than asking "do you want me to continue?";
- park instead of nagging when ask budget is exhausted and no safe act exists.

Judgment-quality thresholds for eval:

- ask precision: at least 90% of rendered questions must be single-decision, answer-changing, and non-generic;
- ask rarity: no more than 15% of low-risk nontrivial fixture turns may render `ask-one`;
- overreach: zero fixtures may execute critical/high destructive work without `escalate-confirm` or `decline`;
- underreach: at least 90% of reversible, evidence-satisfied build/fix fixtures must choose `act`, not ask or park;
- stale-work safety: zero unsafe stale resumes; at least 90% of explicit safe-resume fixtures choose `resume-stale-work`;
- rollback: flag-off receipts and rendered prompts are snapshot-equal to legacy.

## 7. Named contract edges

### Edge `8->19` - semantic classification into judgment

Producer: Item 8 `ResolvedSemanticPreflight`.

Payload consumed: objective, task shape, risk, uncertainty, forks, evidence needs, done condition, plan steps, resolved classification, and route plan.

Rule: Item 19 may decide ask/act/answer/park/resume/escalate/decline from these fields, but cannot lower risk, invent evidence, or select provider/model/effort.

### Edge `5->19` - TurnPlan authority into judgment

Producer: Item 5 `TurnPlanV1`.

Payload consumed: shape, risk, route plan, strategy, allocations, research/evidence flags, verification obligations, recovery, and receipt line.

Rule: Item 19 may choose whether the professional next action is to use, wait on, or decline the plan. It cannot mutate allocations or authorize unplanned provider calls.

### Edge `19->13` - judgment into stewardship

Producer: `AskActDecisionV1.feeds.item13` plus `goalAction`.

Consumer: Item 13 goal stewardship and future multi-goal DAG.

Rule: Item 13 may ask, act, park, resume, review, or leave active only from this structured action plus its own goal authority. It must not infer stewardship from final prose.

### Edge `19->17` - expected action into completion quality

Producer: `AskActDecisionV1.expectedCompletion` and `feeds.item17`.

Consumer: Item 17 delivery-quality/completion.

Rule: Item 17 uses the expected action to catch mismatches such as an asked question that also claims done, an action final that omits verification, a decline that hides policy reason, or an answer that overclaims unobserved facts.

## 8. Rollout, flags, eval, and rollback

Runtime flags:

- `MYSHELL_ASK_ACT_JUDGMENT_V1` / `experimentalAskActJudgmentV1?: boolean`, default false.
- `MYSHELL_ASK_ACT_JUDGMENT_ENFORCE_V1` / `experimentalAskActJudgmentEnforceV1?: boolean`, default false and ignored unless V1 is active.

Flag behavior:

- flag off: existing engagement, questions, goal steward, and execution behavior remain byte-for-byte current;
- V1 observe: compute and log `AskActDecisionV1`, but do not block legacy behavior except in tests with injected enforcement;
- V1 enforce: the chosen action becomes authoritative for ask/render/act/park/resume/decline admission after eval passes;
- no default-on promotion in this contract.

Rollback is: unset `MYSHELL_ASK_ACT_JUDGMENT_V1` and `MYSHELL_ASK_ACT_JUDGMENT_ENFORCE_V1`, set both config mirrors false, restart, and confirm receipts no longer contain ask-act decision or drift fields. Decision records are additive diagnostics and require no data migration.

Evaluation gate:

- at least 120 curated fixtures: 20 trivial/answer, 20 reversible act, 20 evidence-before-answer/work, 20 genuine ask, 15 strict-confirm/risk, 15 decline/policy, 15 goal park/resume/stale, 15 discovery/review escalation;
- each fixture includes semantic input, TurnPlan input, goal/work state, expected action, allowed secondary reason codes, and "bad action" regression assertions;
- four human labels per fixture class: ask warranted, act warranted, confirm warranted, refuse/park warranted;
- pass thresholds in section 6 plus zero schema parse failures and zero flag-off snapshot diffs;
- write uncommitted artifacts under `.tmp/ask-act-judgment-v1/` with fixture count, git head, date, command, and hash.

## 9. Ordered slices

### P1-19a - `ASK-ACT-DOMAIN`

**One invariant:** pure `decideAskAct` always returns one complete `AskActDecisionV1` and never authorizes environment-changing work from malformed input.

**Preconditions/dependencies:** Item 8 and Item 5 types exist; current `Classification`, `IntentFrame`, `EngagementPlan`, `Assessment`, `DiscoverySignal`, and goal-steward types are reused. No runtime wiring.

**Maximum file set (exhaustive):**

- `src/core/ask-act-judgment.ts` (new)
- `test/unit/ask-act-judgment.test.ts` (new)

**Behavioral diff:** add shared types, parser/capper, default input normalizer, priority cascade, tie-breaks, expected completion mapper, and fail-soft behavior. No callers.

**Named tests:** `returns exactly one action for every action kind`; `decline beats all unsafe inputs`; `critical mutation becomes strict confirm not act`; `authorized reversible work acts`; `lookup no-work plan answers`; `malformed input fail-softs without throwing`; `caps questions options reasons and rationale`.

**Fixtures:** success = all seven actions; failure = malformed/unsafe/policy denied; cancellation = N/A pure; injected crash = proxy getters throwing during parse/normalize must return fail-soft parse failure, not throw.

**Verification receipt:** `npx tsc --noEmit && npx eslint src/core/ask-act-judgment.ts test/unit/ask-act-judgment.test.ts && npx vitest run test/unit/ask-act-judgment.test.ts`.

### P1-19b - `ASK-BUDGET-AND-QUESTION-QUALITY`

**One invariant:** one clarifying question is rendered only for a specific user-owned fork and only within the hard ask cap.

**Preconditions/dependencies:** 19a and existing `deriveAskFromForks`.

**Maximum file set (exhaustive):**

- `src/core/ask-act-judgment.ts`
- `src/core/engagement.ts`
- `test/unit/ask-act-judgment.test.ts`
- `test/unit/engagement.test.ts`

**Behavioral diff:** implement reusable `evaluateAskBudget(...)`, generic-menu rejection reuse, question conversion, per-intent/per-goal cap accounting fields, and ask-exhausted fallback to assumption/park/confirm.

**Named tests:** `generic menu never asks`; `discoverable code fork acts or investigates instead of asking`; `vision preference fork asks once`; `ask cap exhausted parks or acts on assumption`; `question has one prompt recommended default and bounded options`.

**Fixtures:** success = genuine fork; failure = generic/discoverable/exhausted; cancellation = N/A pure; injected crash = malformed fork fields.

**Verification receipt:** receipt command from 19a plus `npx vitest run test/unit/engagement.test.ts`.

### P1-19c - `RISK-CONFIRM-AND-DECLINE`

**One invariant:** high-risk/critical/destructive/sensitive operations cannot become `act` without strict explicit confirmation or policy admission.

**Preconditions/dependencies:** 19a-19b and `classifyCommand`.

**Maximum file set (exhaustive):**

- `src/core/ask-act-judgment.ts`
- `src/core/classify.ts`
- `src/interface/menu-questions.ts`
- `test/unit/ask-act-judgment.test.ts`
- `test/unit/classify.test.ts`
- `test/unit/menu-questions.test.ts`

**Behavioral diff:** add risk/command-tier predicates and confirm prompt construction. Preserve existing strict yes/no semantics; only add tests proving Item 19 consumes them.

**Named tests:** `critical risk confirms even with low semantic uncertainty`; `destructive command confirm uses requireExplicit true`; `policy denied declines before confirm`; `dependency install asks confirm only when policy requires`; `strict enter eof typo all decline`.

**Fixtures:** success = explicit confirm action; failure = policy denial/unsafe; cancellation = Ctrl-C/EOF parse; injected crash = command classifier malformed command.

**Verification receipt:** include exact command and assertion that existing menu strict tests remain snapshot-equal.

### P1-19d - `TURNPLAN-INTEGRATION-PURE`

**One invariant:** TurnPlan is consumed as authority for whether act is legal, but Item 19 never changes allocations.

**Preconditions/dependencies:** 19a-19c and Item 5 domain.

**Maximum file set (exhaustive):**

- `src/core/ask-act-judgment.ts`
- `src/core/turn-plan.ts`
- `test/unit/ask-act-judgment-turnplan.test.ts` (new)
- `test/unit/turn-plan.test.ts`

**Behavioral diff:** map TurnPlan strategy/allocation/research/verification fields into answer/act/confirm/decline decisions. Add drift reason when legacy says execute but plan has no work allocation.

**Named tests:** `strategy none answers`; `single work allocation acts`; `missing required work allocation declines`; `required before-work evidence blocks act`; `verification obligation feeds Item17 work-completion`; `plan allocation ids are copied not mutated`.

**Fixtures:** success = none/single/verification plans; failure = no allocation/drift; cancellation = N/A pure; injected crash = parse invalid plan fixture.

**Verification receipt:** run 19a tests plus `test/unit/ask-act-judgment-turnplan.test.ts test/unit/turn-plan.test.ts`.

### P1-19e - `GOAL-WORKSTATE-JUDGMENT`

**One invariant:** stale, inactive, blocked, and parked work become structured park/resume/review decisions, not ad hoc prose.

**Preconditions/dependencies:** 19a-19d and current `goal-steward.ts`.

**Maximum file set (exhaustive):**

- `src/core/ask-act-judgment.ts`
- `src/core/goal-steward.ts`
- `test/unit/ask-act-judgment-goal.test.ts` (new)
- `test/unit/goal-steward.test.ts`

**Behavioral diff:** add goal/work-state adapter helpers that consume `GoalFinding` and current work snapshot. Explicit safe resume returns `resume-stale-work`; blocked/stale unsafe returns `park-goal` or `ask-one` within budget. No goal mutation yet.

**Named tests:** `explicit safe resume resumes stale work`; `unsafe resume asks once then parks`; `blocked goal parks with Item13 review feed`; `fresh goal does not preempt current turn`; `verified complete never marks done from Item19`.

**Fixtures:** success = safe resume/park; failure = unsafe resume/blocked; cancellation = user cancels ask; injected crash = malformed finding.

**Verification receipt:** run goal tests and prove `goal-steward.ts` behavior stays unchanged except adapter tests.

### P1-19f - `DISCOVERY-REVIEW-ESCALATION`

**One invariant:** discovered wider/riskier work and inconclusive review can escalate or confirm, but cannot silently widen scope or ask a generic menu.

**Preconditions/dependencies:** 19a-19e.

**Maximum file set (exhaustive):**

- `src/core/ask-act-judgment.ts`
- `src/core/discovery.ts`
- `src/core/review.ts`
- `test/unit/ask-act-judgment-escalation.test.ts` (new)
- `test/unit/discovery.test.ts`
- `test/unit/review.test.ts`

**Behavioral diff:** consume `discoveryWarrantsManager`, `discoveryWarrantsReview`, local-larger-fix, assessment escalation, and review fail-safe signals as reason codes. High-stakes discovery becomes `escalate-confirm`; local larger reversible fix stays `act`.

**Named tests:** `high-stakes discovery confirms`; `cross-cutting discovery escalates not generic ask`; `local larger reversible fix acts`; `review parsed false on high risk confirms`; `review revise does not decline automatically`.

**Fixtures:** success = escalation/local act; failure = malformed review/discovery; cancellation = N/A pure; injected crash = parser throws via proxy fixture.

**Verification receipt:** run 19 escalation tests plus discovery/review unit tests.

### P1-19g - `ORCHESTRATE-OBSERVE-WIRING`

**One invariant:** flag-on observe mode computes one decision after semantic/TurnPlan and before ask/work/goal handling, without changing behavior.

**Preconditions/dependencies:** 19a-19f, Item 8 dark path, Item 5 dark path. Do not proceed if the same turn budget object is not available through preflight/plan/work.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/orchestrate.ts`
- `src/core/ask-act-judgment.ts`
- `test/unit/orchestrate-ask-act.test.ts` (new)
- `test/unit/orchestrate-turn-plan.test.ts`
- `test/unit/orchestrate-evidence-sensitive.test.ts`

**Behavioral diff:** add optional deps/outputs for observed `AskActDecisionV1`. In observe mode, legacy behavior proceeds and drift is recorded when legacy action disagrees with decision. No blocking.

**Named tests:** `one decision emitted after plan before work`; `flag off final events snapshot equal`; `observe drift recorded but does not block`; `trivial turn has zero extra provider calls`; `semantic and TurnPlan inputs are passed through unchanged`.

**Fixtures:** success = answer/act/ask/confirm observations; failure = finalizer unavailable; cancellation = abort before decision; injected crash = decision helper throws and observe logs fail-soft.

**Verification receipt:** run orchestrate ask-act, TurnPlan, evidence-sensitive, and provider-call-budget guard tests.

### P1-19h - `ASK-CONFIRM-ACT-ENFORCEMENT`

**One invariant:** when enforcement is injected, ask/confirm/decline/park/resume/act admission follows `AskActDecisionV1`.

**Preconditions/dependencies:** 19g and green observe drift fixtures.

**Maximum file set (exhaustive):**

- `src/core/orchestrate.ts`
- `src/core/types.ts`
- `src/interface/menu-questions.ts`
- `test/unit/orchestrate-ask-act.test.ts`
- `test/unit/menu-questions.test.ts`
- `test/unit/run.test.ts`

**Behavioral diff:** under injected enforce flag, `ask-one` renders exactly one question and waits; `escalate-confirm` renders strict yes/no before mutation; `decline` emits a typed blocked/failed final; `park-goal` emits a parked stewardship event without work provider calls; `resume-stale-work` passes resume intent to existing work path only when safe; `act` admits existing work.

**Named tests:** `ask action starts zero work calls`; `confirm denial starts zero work calls`; `confirm yes admits planned act`; `decline emits policy reason`; `park emits goalAction and no provider work`; `resume safe enters work once`; `decision/action drift is denial in enforce`.

**Fixtures:** success = all actions; failure = denial/drift; cancellation = Ctrl-C at ask/confirm; injected crash = renderer throws and converts to safe final.

**Verification receipt:** include call-budget receipt proving denied ask/confirm/decline/park start zero work/failover provider streams.

### P1-19i - `ITEM13-ITEM17-HANDOFFS`

**One invariant:** stewardship and completion consumers receive structured decision metadata instead of inferring from text.

**Preconditions/dependencies:** 19h plus Item 17 completion shape where present. Item 13 may still be partial; this slice only adds handoff fields/tests.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/orchestrate.ts`
- `src/core/goal-steward.ts`
- `src/core/accept-stage.ts`
- `test/unit/ask-act-handoff.test.ts` (new)
- `test/unit/goal-steward.test.ts`
- `test/unit/completion-result.test.ts`

**Behavioral diff:** attach `askActDecision` to the in-memory turn result/final path under flag. Completion quality checks expected action mismatch when Item 17 flag is present. Goal handoff records ask/act/park/resume/review feed for later Item 13 consumption without mutating goal DAG.

**Named tests:** `asked question completion hint is needs-user`; `act hint requires work-completion quality`; `decline hint becomes blocked-or-declined`; `goal park feed is structured`; `flag off final payload is unchanged`.

**Fixtures:** success = each feed; failure = mismatch overclaim; cancellation = cancelled ask; injected crash = completion accessor throws and final remains safe.

**Verification receipt:** run handoff, goal, and completion tests with flag-on/off snapshots.

### P1-19j - `DARK-PRODUCTION-COMPOSITION`

**One invariant:** one explicit default-off flag composes observe-mode Item 19 across interactive, one-shot, and REPL entry points; rollback restores legacy behavior.

**Preconditions/dependencies:** 19i, Item 8/5/9 guards green, and no observe drift artifact above eval thresholds.

**Maximum file set (exhaustive):**

- `src/infra/config.ts`
- `src/interface/ui/ask-act-judgment-flag.ts` (new)
- `src/interface/menu.ts`
- `src/interface/run.ts`
- `src/interface/repl.ts`
- `src/core/types.ts`
- `test/unit/ask-act-judgment-flag.test.ts` (new)
- `test/unit/menu-flow.test.ts`
- `test/unit/run.test.ts`
- `test/unit/global-call-budget-receipt.test.ts`

**Behavioral diff:** add config mirrors and flag helper. When V1 is true, entry points pass observe-mode judgment deps and include decision/drift in the diagnostic receipt. Enforcement flag remains test/injected unless eval artifacts pass.

**Named tests:** `ask-act flag defaults false for absent false zero and garbage`; `explicit env or config true enables observe decision`; `interactive one-shot and REPL flag off snapshots match legacy`; `flag on records one decision per nonterminal foreground turn`; `receipt callback throw remains fail-soft`; `rollback by unsetting flag removes decision receipt`.

**Fixtures:** success = each entry point; failure = malformed decision; cancellation = user interrupt; injected crash = flag parser or receipt callback throws.

**Verification receipt:** run flag/menu/run/global receipt tests plus provider-call-budget guard.

### P1-19k - `EVAL-HARNESS-AND-AUTHORITY-GUARD`

**One invariant:** enforcement/default promotion is blocked unless judgment-quality eval and authority guard pass.

**Preconditions/dependencies:** 19j observe artifacts.

**Maximum file set (exhaustive):**

- `src/core/ask-act-judgment.ts`
- `test/arch/ask-act-authority-guard.test.ts` (new)
- `test/unit/ask-act-judgment-eval.test.ts` (new)
- `docs/r7-item19-ask-vs-act-contract.md`

**Behavioral diff:** add a fixture runner and architecture guard that rejects new post-plan work/ask/goal-resume admission under the flag unless it consumes `AskActDecisionV1`. Record artifact path/hash only after passing; do not flip defaults.

**Named tests:** `no post-plan act path bypasses AskActDecision under flag`; `ask rarity threshold passes`; `ask precision threshold passes`; `zero high-risk overreach`; `safe reversible act threshold passes`; `flag-off snapshots unchanged`.

**Fixtures:** 120+ eval fixtures; failure = synthetic bypass, generic ask, unsafe act; cancellation = cancelled ask/confirm; injected crash = truncated eval artifact fails closed.

**Verification receipt:** include artifact path/hash, counts, thresholds, exact commands, and proof no default flag changed.

### P1-19l - `DOC-HANDOFF-AND-ROADMAP-CLOSURE`

**One invariant:** docs name the implemented dark contract, rollback flags, eval gate, and handoffs without claiming Item 13, Item 17, or default-on promotion complete.

**Preconditions/dependencies:** 19k green.

**Maximum file set (exhaustive):**

- `docs/r7-item19-ask-vs-act-contract.md`
- `docs/master-plan.md`
- `docs/ROADMAP-STATUS.md`
- `test/arch/ask-act-authority-guard.test.ts`

**Behavioral diff:** update roadmap/status only after implementation artifacts pass. Leave promotion/default-on as future work.

**Named tests:** `authority guard remains green`; `roadmap names default-off flags`; `docs do not mark Item13 or Item17 complete from Item19`.

**Fixtures:** success = doc state; failure = missing artifact or false completion claim; cancellation = N/A; injected crash = unreadable doc fixture fails test.

**Verification receipt:** `git diff --check && npx vitest run test/arch/ask-act-authority-guard.test.ts`.

## 10. Cross-slice acceptance and definition of done

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npx vitest run test/arch/provider-call-budget-guard.test.ts test/unit/global-call-budget-receipt.test.ts
```

The changed-file list must be a subset of that slice's maximum set. A Vitest pass with missing cancellation/crash fixtures, missing flag-off snapshots, or no eval artifact for enforcement is not acceptance.

Item 19 is implemented dark when 19k is green. It is not default-promoted by this contract. The implementation satisfies Item 19 only if all are simultaneously true:

- every enabled nonterminal foreground turn has one `AskActDecisionV1`;
- the action is one of the seven closed actions and exactly one action is authoritative under enforcement;
- no model/provider calls are added by the decision itself;
- ask-one is rare, specific, single-question, and capped per turn/intent/goal;
- critical/high destructive or sensitive work never acts without strict confirmation or decline;
- reversible, evidence-satisfied, allocated work usually acts rather than nags;
- stale work resumes only on explicit safe resume evidence;
- parking, resume, and review handoffs are structured for Item 13;
- expected completion/delivery obligations are structured for Item 17;
- flag-off rollback restores legacy behavior and receipts without migration;
- eval thresholds and authority guard are recorded and green.

## 11. Adversarial self-challenge and fixes

**Challenge 1: could this become another vague engagement layer that disagrees with `engagement.ts`?** Yes, if it reimplements fork quality and ask caps differently. Fix: 19b reuses the existing ask/generic-menu predicates and treats engagement as an input, while Item 19 only chooses the terminal professional action.

**Challenge 2: could this over-block useful work by requiring confirmation for every medium-risk code change?** Yes. Fix: only critical, high-risk mutation/external side effect, destructive/credential-sensitive command tiers, policy denial, or discovery/review escalation force confirm/decline. Reversible allocated work acts.

**Challenge 3: could this still nag the user under a different name?** Yes, if exhausted asks keep resurfacing after park/resume loops. Fix: caps are per turn, per intent version, and per goal before progress. After one useful question, act on assumption, park, confirm, or decline.

**Challenge 4: could stale goal resume accidentally run obsolete work?** Yes, if stale findings are treated as permission. Fix: `resume-stale-work` requires explicit user resume intent plus `safeToResume=true`; otherwise it parks/reviews or asks once for the missing user-owned decision.

**Challenge 5: could `answer-now` hide missing evidence?** Yes, if answer/action ignores Item 8 obligations. Fix: required before-answer evidence blocks `answer-now`, required before-work evidence blocks `act`, and Item 17 receives delivery obligations.

**Challenge 6: could a fail-soft default execute dangerous work?** Yes, if malformed inputs fall through to `act`. Fix: fail-soft selects the least environment-changing useful action and can choose `act` only when the input is valid, low-risk, reversible, evidence-satisfied, and plan-authorized.

## 12. North-star drift check

Does this move toward "one chat, elite pro" or add ceremony?

It moves toward the north-star if the user feels fewer generic questions, fewer silent overreaches, and more crisp professional defaults: answer simple things, investigate discoverable things, act on reversible authorized work, ask once when only the user can decide, confirm real risk, park stale work honestly, resume only when safe, and say no when policy requires it.

It adds ceremony if decisions are merely logged while legacy code keeps asking broad menus, if eval optimizes for fewer asks by over-acting, or if parking/resume becomes another hidden goal mutation path. The guardrail is concrete: one pure decision, one action, one ask cap, one eval gate, one rollback, and downstream consumers must stop guessing from prose.
