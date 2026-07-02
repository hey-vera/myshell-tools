# Item 13 contract - goal stewardship and multi-goal DAG

Status: delegation-ready implementation contract, grounded at repository head `893e8db` on 2026-07-02.

This document is controlling for Round-7 Item 13. It is the capstone over Item 17 completion, Item 11 durable context, Item 12 provider generation, Item 10 exactly-once work units, Item 18 intent continuity, and Item 19 ask-vs-act. It reuses those vocabularies by reference and must not redefine them. Item 13 owns only the goal stewardship lifecycle and multi-goal DAG policy that consumes those substrates.

Required-reading drift at authoring time: `docs/r7-item10-exactly-once-contract.md`, `docs/r7-item18-intent-continuity-contract.md`, and `docs/r7-item19-ask-vs-act-contract.md` were not present under the requested paths. Workers must re-run the required reading when those files land and record any vocabulary drift before implementation. This contract still names the upstream edges `10->13`, `18->13`, and `19->13`; it does not invent their schemas.

At document creation the worktree was not clean: `docs/pty-integration-diagnosis-5.6.md` was untracked. That is pre-existing local work and is not part of this contract edit.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_GOAL_STEWARDSHIP_DAG_V1` is explicitly enabled, every goal is stewarded by one durable execution lineage:

- accepted Item 18 intent-version id is the goal execution id;
- Item 10 work-unit ids are child attempts under that execution id;
- Item 17 `CompletionResultV1` settles each launched node;
- Item 11 canonical events store every node, edge, work-unit state, and settlement;
- Item 12 provider generation gates every launch;
- Item 19 `AskActDecisionV1` decides resume, park, cancel, ask, or act for stale/live goals.

The required outcome is narrow:

- no parallel goal truth beside intent-version, work-unit state, canonical events, and completion result;
- stale parked/running/queued/blocked goals are owned by a live stewardship loop, not merely audited;
- multi-goal DAG nodes unlock only from real Item 17 completion evidence;
- goals born from accepted intent versions are revalidated before launch;
- cancellation ownership is explicit and preserves already-settled descendants;
- default remains off until the eval and authority guards pass.

This item does **not**:

- build multi-goal autonomy before Items 17, 11, 12, 10, 18, and 19 are contracted and green;
- redefine `CompletionResultV1`, `CanonicalEventV1`, `ProviderGenerationV1`, Item 10 work-unit ids/state machine, Item 18 intent-version, or Item 19 `AskActDecisionV1`;
- treat `GOAL_COMPLETE`, final prose, `CoreEvent.final.success`, or UI action keys as completion truth;
- allow auto-stage to execute staged work;
- make provider generation, durable context, completion result, exactly-once, intent continuity, ask-vs-act, or goal stewardship default-on;
- convert a stale goal into work without revalidation and a current provider generation snapshot.

Vision alignment says Item 13 is necessary but downstream: goals, store, scheduler, decompose, manager, steward, and UI seams exist, but stale parked/running goals are audited rather than owned and multi-goal evidence/cancellation/revalidation are not one contract. Building multi-goal autonomy before completion, durable context, provider generations, and exactly-once are contracted is explicitly called out as the wrong order in `docs/vision-alignment-5.6.md:133-148,186-203,215-222`.

## 2. Current-state evidence and invariants

All citations below are current at `893e8db`; workers must re-run line numbering before editing and record drift.

- `/goal` currently trusts a trailing model marker as the loop signal, not the orchestrate completion path, and stops honestly on missing/unclear signals at `src/core/goal.ts:1-16,200-241`. Item 13 must demote this to progress input only; Item 17 settlement is the done authority.
- Goal labels and progress are pure, capped, and real measured values at `src/core/goal.ts:43-79,122-197`; keep that display discipline.
- `goal-todo.ts` already states one construct: a goal owns its roadmap, with lifecycle `parked|queued|running|done|failed|blocked|superseded` at `src/core/goal-todo.ts:1-25,39-57`.
- Goal-level verdicts come only from real `VerifyOutcome`, and verified done is only `passing|reviewed` at `src/core/goal-todo.ts:59-97`.
- Persisted goals already carry `goalAcceptance`, `goalVerdict`, `parentGoalId`, `intentVersionId`, blocked metadata, and supersession fields at `src/core/goal-todo.ts:104-180`; `capGoal` preserves only non-empty `intentVersionId` and valid evidence fields at `src/core/goal-todo.ts:287-390`.
- Goal prompt context is bounded and includes live goals, roadmap status, dependency hints, verdict tag, and approach at `src/core/goal-todo.ts:646-697`.
- The manager cycle is pure and evidence-bound: to-dos are verified done only by `passing|reviewed`; dependencies must be verified before action; blocked items are not worker-actionable at `src/core/goal-manager.ts:1-17,25-130`.
- Block reasons are deterministic over existing roadmap fields, and fix-it depth is capped at two at `src/core/goal-manager.ts:137-180,300-362`.
- The current steward is an audit engine only: it classifies `fresh|stale|inactive|blocked|verified-complete` and recommends `none|review|resolve-done` at `src/core/goal-steward.ts:1-53,97-180`.
- The current scheduler already has a bounded concurrent executor, requeue backoff, per-goal child cancellation, and DAG gating, but its success path keys off `CoreEvent.final.success` rather than `CompletionResultV1` at `src/core/scheduler.ts:1-45,58-105,297-327,562-619,782-814`.
- Scheduler comments correctly state that parked/inactive goals must be brain-revalidated before reaching the scheduler at `src/core/scheduler.ts:58-65,323-326`; Item 13 makes that gate typed and testable.
- Decomposition is fail-soft, cost-honest, capped at eight goals, validates deps, breaks cycles, and falls back to one goal at `src/core/decompose.ts:1-32,47-61,162-245,254-339`.
- `IntentVersion` is an append-only snapshot keyed by `intentVersionId`, with parent links, semantic preflight, objective, done criteria, risk, and confidence at `src/core/intent-version.ts:1-42,55-140`.
- Auto-stage can pass `intentVersionId` into planning and goal creation, dedups against live goals, persists born-parked goals, and explicitly never auto-executes them at `src/interface/auto-stage.ts:71-88,500-553,556-607`.
- `menu-goal-review.ts` renders action-key prompts for stale/inactive/blocked/verified-complete findings but performs no decision, mutation, or model call at `src/interface/menu-goal-review.ts:1-45,47-112`.
- Item 17 says every terminal foreground turn under its flag produces exactly one `CompletionResultV1`, and goals must settle from `goalSettlement.allowed` rather than prose at `docs/r7-item17-completion-contract.md:11-19,210-249,535-558,661-667`.
- Item 11 says every goal node/edge references canonical context and dependents advance only from durable completion/settlement evidence at `docs/r7-item11-durable-context-contract.md:5-19,73-117,160-176,266-272,520-536`.
- Item 12 says goal launch requires a current provider generation snapshot and generation-change behavior at `docs/r7-item12-provider-registry-contract.md:11-29,141-165,229-234,562-578`.

Baseline gap:

| surface | current source | Item-13 requirement |
|---|---|---|
| goal lifecycle | `Goal.state` plus UI/status events | one durable execution lineage from accepted intent-version to work-unit states to completion settlement |
| stale work | deterministic audit + prompt actions | live stewardship loop using `AskActDecisionV1` |
| DAG unlock | scheduler `final.success` | `CompletionResultV1.goalSettlement.allowed=true` and `state='done'` |
| goal birth | user/auto-stage source plus optional `intentVersionId` | accepted Item 18 intent-version required for launchable nodes |
| cancellation | cascade helpers and abort signals | explicit cancellation owner, canonical events, and preserved settled descendants |
| provider facts | scheduler receives provider list | launch requires current Item 12 generation snapshot |

## 3. Shared typed contract

Slice 13a must export these names from `src/core/goal-stewardship.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them.

```ts
export type GoalStewardshipVersion = 1;

export type GoalNodeState =
  | 'born-parked'
  | 'parked'
  | 'queued'
  | 'running'
  | 'needs-user'
  | 'blocked'
  | 'settled'
  | 'cancelled'
  | 'superseded';

export type GoalStewardshipReason =
  | 'accepted-intent'
  | 'auto-staged'
  | 'manual-park'
  | 'stale-review'
  | 'dependency-unlocked'
  | 'provider-generation-changed'
  | 'completion-settled'
  | 'completion-unmet'
  | 'user-cancel'
  | 'intent-superseded'
  | 'work-unit-replay-policy'
  | 'ask-act-decision';

export interface GoalExecutionRefV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly acceptedIntentVersionId: string;
  readonly creatingCanonicalEventId?: string;
}

export interface GoalDagNodeV1 {
  readonly version: 1;
  readonly nodeId: string;
  readonly goalId: string;
  readonly execution: GoalExecutionRefV1;
  readonly title: string;
  readonly state: GoalNodeState;
  readonly source: 'user-explicit' | 'auto-staged' | 'decomposed' | 'blocked-item' | 'resumed';
  readonly parentNodeId?: string;
  readonly workUnitIds: readonly string[];
  readonly currentWorkUnitId?: string;
  readonly completionResultId?: string;
  readonly canonicalEventId?: string;
  readonly providerGenerationId?: string;
  readonly reason: GoalStewardshipReason;
}

export interface GoalDagEdgeV1 {
  readonly version: 1;
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly state: 'waiting' | 'unlocked' | 'blocked' | 'cancelled' | 'invalidated';
  readonly unlockedByCompletionResultId?: string;
  readonly blockedByCompletionResultId?: string;
  readonly canonicalEventId?: string;
}

export interface GoalNodeEvidenceV1 {
  readonly version: 1;
  readonly nodeId: string;
  readonly completionResult?: import('./accept-stage.js').CompletionResultV1;
  readonly satisfied: boolean;
  readonly reason: string;
}

export interface GoalCancellationV1 {
  readonly version: 1;
  readonly rootNodeId: string;
  readonly owner:
    | 'user'
    | 'ask-act-decision'
    | 'intent-supersession'
    | 'dependency-failed'
    | 'provider-unavailable'
    | 'work-unit-terminal';
  readonly cancelledNodeIds: readonly string[];
  readonly preservedSettledNodeIds: readonly string[];
  readonly reason: string;
  readonly canonicalEventId?: string;
}

export interface StewardshipLoopDecisionV1 {
  readonly version: 1;
  readonly nodeId: string;
  readonly finding: import('./goal-steward.js').GoalFinding;
  readonly askActDecision: import('./ask-act.js').AskActDecisionV1;
  readonly action:
    | 'resume'
    | 'park'
    | 'cancel'
    | 'ask-user'
    | 'mark-settled'
    | 'do-nothing';
  readonly reason: string;
}
```

`executionId` is the accepted Item 18 `intent-version` id. It is the one durable execution id for the goal node lineage. Item 10 `workUnitId` values are attempt/state-machine children under that id; they never replace it and Item 13 must not mint a second goal-run id. A goal node cannot become launchable without `acceptedIntentVersionId === executionId`, at least one canonical event ref once Item 11 is enabled, and a current Item 12 provider generation id at launch time.

Caps are part of the contract: node title 160; reason 180; at most 64 nodes per DAG, 128 edges, 16 work-unit ids per node, and 64 cancelled/preserved node ids per cancellation record. Ids must match the owning upstream format when upstream defines one; otherwise they must match `/^[a-z][a-z0-9_-]{0,63}$/`. Extra keys are ignored only by parsers. Constructors must reject unknown enum values.

## 4. Lifecycle and settlement rules

The lifecycle has one durable axis:

1. `accepted-intent`: Item 18 accepts or forks an intent version. This id becomes `GoalExecutionRefV1.executionId`.
2. `born-parked`: a user explicit goal, auto-staged goal, or decomposed node is persisted as parked and linked to the accepted intent version. Auto-stage remains parked-only.
3. `revalidation-before-launch`: before any parked/inactive/stale node launches, Item 13 obtains an Item 19 `AskActDecisionV1` and revalidates against the accepted intent version, current canonical context, current provider generation, and dependency evidence.
4. `queued`: dependencies are satisfied, provider generation is current, and Item 10 can create/claim the next work-unit child.
5. `running`: exactly one Item 10 work unit owns the live attempt for that node. Restart/resume reads Item 10 state plus `CompletionResultV1.replayPolicy`; Item 13 does not replay from prose.
6. `settled`: Item 17 returns `CompletionResultV1`. The node settles only when `goalSettlement.allowed=true` and `goalSettlement.state='done'`.
7. `blocked|needs-user|parked|cancelled|superseded`: every non-done terminal or pause state records the owning `AskActDecisionV1`, completion result, work-unit state, or intent supersession event.

There is no parallel `GoalVerdict` authority under the flag. Existing `GoalVerdict` may be populated as a compatibility projection, but only from `CompletionResultV1.goalSettlement` and verification evidence. `GOAL_COMPLETE` and `CoreEvent.final.success` are progress signals, not settlement.

## 5. Live stewardship loop

The current `auditGoals(...)` remains the deterministic finder, but Item 13 adds an owning loop:

- load active, parked, queued, running, blocked, and stale goals from the goal store and Item 11 context;
- derive `GoalFinding` from existing audit rules;
- call or consume Item 19 `AskActDecisionV1` for every finding requiring action;
- execute only the structured action: resume, park, cancel, ask-user, mark-settled, or do-nothing;
- persist the decision and resulting node state as canonical events;
- never show action keys that encode policy not backed by `AskActDecisionV1`.

The loop is not a background worker by default. It runs at conversation open, goal board open, explicit `/goal review`, before launch, after terminal completion, and after provider-generation or intent-supersession invalidation. Later always-on background cadence requires a separate promotion artifact.

## 6. Multi-goal DAG rules

Node completion evidence:

- every launched node must receive a `CompletionResultV1`;
- `GoalNodeEvidenceV1.satisfied=true` only when `completionResult.goalSettlement.allowed=true`, `goalSettlement.state='done'`, and no unmet completion obligations block that node;
- reviewed-only is acceptable only when Item 17 allowed it for the goal settlement;
- answered, needs-user, blocked, failed, cancelled, unverified, dirty-overlap, or unmet-obligation results do not unlock dependents.

Dependency unlock:

- an edge starts `waiting`;
- it becomes `unlocked` only by the upstream node's satisfying `CompletionResultV1`;
- it becomes `blocked` when the upstream completion says blocked/failed/needs-user and Item 19 decides not to ask/resume immediately;
- it becomes `cancelled` only from a cancellation owner;
- it becomes `invalidated` only from Item 11 context invalidation or Item 18 supersession.

Cancellation ownership:

- user cancellation owns live descendants not yet settled;
- intent supersession owns nodes derived from the superseded intent branch;
- dependency failure owns downstream never-started nodes;
- provider unavailable owns parked/queued deferral, not cancellation, unless Item 19 decides cancel;
- settled descendants are preserved and listed in `preservedSettledNodeIds`.

Revalidation-before-launch:

- every node launched from `parked`, `born-parked`, `stale`, `inactive`, or `superseded`-adjacent state must revalidate against the accepted intent version, current canonical context, current provider generation, dependency evidence, and `AskActDecisionV1`;
- a decomposed node inherits the accepted intent version of the parent unless Item 18 creates a child accepted version;
- a node with missing or superseded intent lineage may remain parked or ask-user, but may not launch.

## 7. Named upstream contract edges

### Edge `17->13` - completion settlement into goal nodes

Producer: Item 17 `CompletionResultV1.goalSettlement`, verification, obligations, worktree, and replay policy.

Consumer: `GoalNodeEvidenceV1`, node settlement, edge unlock, and goal-store projection.

Rule: a node may settle done or unlock dependents only from `goalSettlement.allowed=true` and `state='done'`. Item 13 must not infer done from final prose, legacy `GoalVerdict`, `GOAL_COMPLETE`, or `CoreEvent.final.success`.

### Edge `11->13` - canonical event log for goal DAG

Producer: Item 11 canonical event log, goal-node/goal-edge constructors, snapshots, and invalidation.

Consumer: every `GoalDagNodeV1`, `GoalDagEdgeV1`, stewardship decision, cancellation, and settlement event.

Rule: Item 13 stores no independent durable DAG authority. Goal store fields are compatibility projections from canonical node/edge events when Item 11 is enabled.

### Edge `12->13` - provider generation for launch

Producer: Item 12 `ProviderGenerationV1` and goal-facing snapshot view.

Consumer: launch gating, provider capability selection, cooldown parking, and generation-change revalidation.

Rule: enqueue and park may use stale facts with an honest reason. Launch requires current generation and a one-time reroute/redecision if the generation changed before stream open.

### Edge `10->13` - exactly-once work-unit state

Producer: Item 10 work-unit id/state machine, idempotency key, replay state, terminal transition, and safe retry decision.

Consumer: `workUnitIds`, `currentWorkUnitId`, running ownership, resume/repair/park decisions, and crash recovery.

Rule: Item 13 may create/queue/claim work only through Item 10. A node with an open or ambiguous work unit cannot start another work unit until Item 10 settles, repairs, or returns an ask/blocked state.

### Edge `18->13` - accepted intent versions

Producer: Item 18 accepted intent-version, parent/fork lineage, correction/supersession, objective, non-goals, done criteria, and acceptance state.

Consumer: `GoalExecutionRefV1`, goal birth, revalidation-before-launch, cancellation on supersession, and preserved valid descendants.

Rule: launchable goal nodes are born from accepted intent versions, not transient prose. Correction forks invalidate only dependent goal nodes and preserve settled nodes whose evidence still belongs to the new lineage.

### Edge `19->13` - ask/resume/park/cancel/act judgment

Producer: Item 19 `AskActDecisionV1`.

Consumer: stewardship loop decisions, stale-goal ownership, blocked-goal questions, risk escalation, cancellation, resume, park, and refusal.

Rule: Item 13 must not use ad hoc action-key policy for stale or blocked goals. UI may render choices, but the decision record must be `AskActDecisionV1` and the resulting action must be one of the typed stewardship actions.

## 8. Rollout, eval gate, and rollback

The single runtime flag is `MYSHELL_GOAL_STEWARDSHIP_DAG_V1`; the config mirror is `experimentalGoalStewardshipDagV1?: boolean`. Both are default false.

When off:

- existing `/goal`, goal manager, scheduler, auto-stage, goal board, and menu review behavior remain byte-for-byte current;
- Item 17/11/12/10/18/19 fields may exist but Item 13 does not consume them as authority.

When on:

- goal settlement, edge unlock, resume, cancellation, and stale ownership use the typed upstream contracts;
- compatibility goal-store rows and UI events are projections;
- legacy action-key prompts cannot mutate goal state without a `StewardshipLoopDecisionV1`.

Eval gate before default-on:

- 100 fixture DAGs with roots, chains, diamonds, fan-in, cancellation, supersession, and provider cooldowns;
- 100 stale-goal stewardship fixtures covering parked/running/queued/blocked/done-without-evidence;
- crash/restart fixture at every boundary: before work-unit claim, after claim before provider open, after provider open before completion, after completion before edge unlock, after edge unlock before next launch;
- no fixture unlocks from prose or `CoreEvent.final.success`;
- no duplicate work-unit launch for one node;
- p95 stewardship decision pass <= 25 ms over pure fixtures; launch gate <= 10 ms excluding upstream calls;
- flag-off snapshot parity for existing goal tests.

Rollback is: unset `MYSHELL_GOAL_STEWARDSHIP_DAG_V1`, set `experimentalGoalStewardshipDagV1:false`, restart, and confirm goal store/UI behavior returns to legacy projections. Canonical events and Item 13 records are additive and must remain readable; rollback may ignore them but must not delete them.

## 9. Ordered slices

Every slice begins with:

```bash
git status --short
git diff --name-only
npm run typecheck
```

Record pre-existing dirty paths. A slice is rejected if `git diff --name-only` contains a path outside its maximum set. Every verification receipt must include changed files, exact commands, named assertions, cancellation/crash disposition, and flag-off parity when runtime wiring exists.

### P1-13a - `GOAL-STEWARDSHIP-DOMAIN`

**One invariant:** the V1 node, edge, evidence, cancellation, and loop-decision types are complete, capped, parseable, and cannot express node completion without `CompletionResultV1`.

**Maximum file set:** `src/core/goal-stewardship.ts` (new), `test/unit/goal-stewardship.test.ts` (new).

**Verification receipt:** `npm run typecheck && npm run lint -- src/core/goal-stewardship.ts test/unit/goal-stewardship.test.ts && npx vitest run test/unit/goal-stewardship.test.ts`; assertions cover caps, invalid enums, ids, extra-key parsing, and completion-required settlement.

### P1-13b - `EXECUTION-ID-LINEAGE`

**One invariant:** `executionId` is the accepted intent-version id and is never replaced by a goal-run id.

**Maximum file set:** `src/core/goal-stewardship.ts`, `src/core/goal-todo.ts`, `test/unit/goal-stewardship.test.ts`, `test/unit/goal-todo.test.ts`.

**Verification receipt:** tests prove blank/missing intent ids keep nodes unlaunchable, auto-stage/user goals can project existing `intentVersionId`, and work-unit ids are children only.

### P1-13c - `COMPLETION-EVIDENCE-GATE`

**One invariant:** node settlement and edge unlock read `CompletionResultV1.goalSettlement`, not final prose or legacy verdicts.

**Maximum file set:** `src/core/goal-stewardship.ts`, `test/unit/goal-stewardship-completion.test.ts` (new), `test/unit/goal-manager.test.ts`.

**Verification receipt:** fixtures cover done/answered/needs-user/blocked/failed/cancelled/unverified/dirty-overlap; only allowed done unlocks.

### P1-13d - `DAG-EDGE-REDUCER`

**One invariant:** edges move waiting->unlocked only from satisfying completion, and failed upstream blocks transitively.

**Maximum file set:** `src/core/goal-stewardship.ts`, `test/unit/goal-stewardship-dag.test.ts` (new), `test/unit/scheduler.test.ts`.

**Verification receipt:** chain, diamond, fan-in, unknown dep, cycle-broken, and failed-root fixtures; no prose unlock.

### P1-13e - `CANCELLATION-OWNERSHIP`

**One invariant:** cancellation records owner, cancelled live descendants, and preserved settled descendants.

**Maximum file set:** `src/core/goal-stewardship.ts`, `src/core/goal-todo.ts`, `test/unit/goal-stewardship-cancel.test.ts` (new), `test/unit/goal-todo.test.ts`.

**Verification receipt:** user, dependency, intent-supersession, provider-unavailable, and work-unit-terminal fixtures; settled nodes remain preserved.

### P1-13f - `ASK-ACT-STEWARD-DECISION`

**One invariant:** stale/blocked/inactive stewardship actions are derived from `AskActDecisionV1`.

**Maximum file set:** `src/core/goal-stewardship.ts`, `src/core/goal-steward.ts`, `test/unit/goal-stewardship-ask-act.test.ts` (new), `test/unit/goal-steward.test.ts`.

**Verification receipt:** fixtures map ask/resume/park/cancel/act/noop decisions; malformed Item 19 payload fails closed to ask-user or park, never act.

### P1-13g - `LIVE-STEWARDSHIP-LOOP-PORT`

**One invariant:** a loop pass owns findings and emits decisions, without provider calls or mutations in the pure domain.

**Maximum file set:** `src/core/goal-stewardship-loop.ts` (new), `src/core/goal-stewardship.ts`, `test/unit/goal-stewardship-loop.test.ts` (new).

**Verification receipt:** stale parked/running/queued/blocked/done findings each produce exactly one decision; fresh findings do nothing; cancellation/crash N/A pure.

### P1-13h - `REVALIDATION-BEFORE-LAUNCH`

**One invariant:** a parked/stale/inactive node cannot launch until accepted intent, current context, current provider generation, dependencies, and ask-act decision are current.

**Maximum file set:** `src/core/goal-stewardship.ts`, `src/core/scheduler.ts`, `test/unit/goal-stewardship-launch.test.ts` (new), `test/unit/scheduler.test.ts`.

**Verification receipt:** missing intent, superseded intent, stale generation, invalidated context, unmet dependency, and ask-required fixtures all block launch.

### P1-13i - `ITEM10-WORK-UNIT-SEAM`

**One invariant:** running ownership is an Item 10 work-unit state, not scheduler memory.

**Maximum file set:** `src/core/goal-stewardship.ts`, `src/core/types.ts`, `test/unit/goal-stewardship-work-unit.test.ts` (new).

**Verification receipt:** open work unit blocks duplicate launch; terminal work unit accepts completion; replay-policy repair-only does not start a fresh unit.

### P1-13j - `ITEM11-CANONICAL-GOAL-EVENTS`

**One invariant:** node, edge, decision, cancellation, and settlement records reference canonical events when Item 11 is enabled.

**Maximum file set:** `src/core/goal-stewardship.ts`, `src/core/durable-context.ts`, `test/unit/goal-stewardship-context.test.ts` (new), `test/unit/durable-context-goal-dag.test.ts`.

**Verification receipt:** every node/edge has creating event, settlement event, invalidation event, and snapshot reducer proof.

### P1-13k - `ITEM12-GENERATION-LAUNCH-GATE`

**One invariant:** launch requires a current provider generation and reacts before stream open if generation changed.

**Maximum file set:** `src/core/goal-stewardship.ts`, `src/core/provider-generation.ts`, `test/unit/goal-stewardship-provider-generation.test.ts` (new), `test/unit/provider-generation-goal-seam.test.ts`.

**Verification receipt:** stale generation parks, cooldown parks, capability loss asks/parks, new ready provider wakes schedulable goal.

### P1-13l - `INTENT-SUPERSESSION-INVALIDATION`

**One invariant:** Item 18 correction/supersession invalidates only dependent nodes and preserves valid settled evidence.

**Maximum file set:** `src/core/goal-stewardship.ts`, `src/core/intent-version.ts`, `test/unit/goal-stewardship-intent.test.ts` (new), `test/unit/orchestrate-correction-fork.test.ts`.

**Verification receipt:** parent/child intent fixtures preserve unaffected settled nodes, cancel invalid live nodes, and block missing accepted intent.

### P1-13m - `AUTO-STAGE-BIRTH-LINK`

**One invariant:** auto-stage creates born-parked nodes linked to accepted intent and never launches them.

**Maximum file set:** `src/interface/auto-stage.ts`, `src/core/goal-stewardship.ts`, `test/unit/auto-stage-engine.test.ts`, `test/unit/goal-stewardship-intent.test.ts`.

**Verification receipt:** auto-staged goals include intent lineage when provided, remain parked, dedup live titles, and produce no work-unit claim.

### P1-13n - `DECOMPOSE-TO-DAG-NODES`

**One invariant:** decompose output becomes goal DAG nodes/edges without forced fan-out and with accepted intent lineage.

**Maximum file set:** `src/core/decompose.ts`, `src/core/goal-stewardship.ts`, `test/unit/decompose.test.ts`, `test/unit/goal-stewardship-dag.test.ts`.

**Verification receipt:** one-goal fallback, capped eight nodes, unknown deps dropped, cycles drainable, parent intent inherited.

### P1-13o - `SCHEDULER-CONSUMES-SETTLEMENT`

**One invariant:** scheduler dependency outcomes are driven by node evidence, not `CoreEvent.final.success`.

**Maximum file set:** `src/core/scheduler.ts`, `src/core/goal-stewardship.ts`, `test/unit/scheduler.test.ts`, `test/unit/goal-stewardship-dag.test.ts`.

**Verification receipt:** final success without completion does not unlock; allowed completion unlocks; failed completion cascades blocked; rate-limit requeue unchanged.

### P1-13p - `GOAL-MANAGER-COMPAT-PROJECTION`

**One invariant:** existing `GoalVerdict` and roadmap item status are projections of completion evidence under the flag.

**Maximum file set:** `src/core/goal-manager.ts`, `src/core/goal-todo.ts`, `src/core/goal-stewardship.ts`, `test/unit/goal-manager.test.ts`, `test/unit/goal-todo.test.ts`.

**Verification receipt:** flag-on projection cannot upgrade unverified/failing; flag-off manager tests remain snapshot-equal.

### P1-13q - `MENU-GOAL-REVIEW-ASK-ACT`

**One invariant:** goal review UI renders decisions but does not encode stewardship policy itself.

**Maximum file set:** `src/interface/menu-goal-review.ts`, `src/core/goal-stewardship.ts`, `test/unit/menu-goal-review.test.ts` (new), `test/unit/goal-stewardship-ask-act.test.ts`.

**Verification receipt:** prompts include only actions permitted by `AskActDecisionV1`; invalid decision renders ask/skip; legacy off snapshots unchanged.

### P1-13r - `ORCHESTRATE-GOAL-SETTLEMENT-WIRING`

**One invariant:** terminal goal work writes exactly one node settlement from the foreground completion result.

**Maximum file set:** `src/core/orchestrate.ts`, `src/core/types.ts`, `src/core/goal-stewardship.ts`, `test/unit/orchestrate-goal-stewardship.test.ts` (new), `test/unit/completion-result.test.ts`.

**Verification receipt:** completion result attaches to node, canonical event written once when available, receipt callback crash cannot duplicate settlement.

### P1-13s - `CRASH-RECOVERY-AUDIT`

**One invariant:** restart reconstructs open/running/settled nodes from Item 11 and Item 10, not in-memory scheduler state.

**Maximum file set:** `src/core/goal-stewardship-loop.ts`, `src/core/goal-stewardship.ts`, `test/unit/goal-stewardship-recovery.test.ts` (new).

**Verification receipt:** injected crashes at every boundary produce park/repair/ask exactly once; duplicate work-unit launch is rejected.

### P1-13t - `GOAL-BOARD-PROJECTION`

**One invariant:** UI goal rows/cards display state from stewardship projection while keeping legacy display off-flag.

**Maximum file set:** `src/core/goal-todo.ts`, `src/interface/menu.ts`, `test/unit/menu-flow.test.ts`, `test/unit/goal-todo.test.ts`.

**Verification receipt:** parked/running/needs-user/blocked/settled/cancelled/superseded labels match node state; flag-off snapshots unchanged.

### P1-13u - `CONVERSATION-OPEN-STEWARDSHIP`

**One invariant:** opening a conversation runs one bounded stewardship pass before suggesting goal work.

**Maximum file set:** `src/interface/menu.ts`, `src/interface/menu-goal-review.ts`, `src/core/goal-stewardship-loop.ts`, `test/unit/menu-flow.test.ts`.

**Verification receipt:** one pass per open, stale owned decision persisted, no provider call unless decision is act/resume and launch gates pass.

### P1-13v - `CANCEL-RESUME-COMMANDS`

**One invariant:** explicit goal cancel/resume commands produce the same typed records as automatic stewardship.

**Maximum file set:** `src/interface/menu.ts`, `src/core/goal-stewardship.ts`, `test/unit/menu-flow.test.ts`, `test/unit/goal-stewardship-cancel.test.ts`.

**Verification receipt:** cancel preserves settled descendants, resume revalidates, superseded goal asks, malformed id no-ops safely.

### P1-13w - `AUTHORITY-GUARDS`

**One invariant:** enabled code cannot settle, unlock, launch, or cancel goals outside Item 13 authority.

**Maximum file set:** `test/arch/goal-stewardship-authority-guard.test.ts` (new), `test/unit/goal-stewardship.test.ts`, `docs/r7-item13-goal-stewardship-contract.md`.

**Verification receipt:** guard rejects `GOAL_COMPLETE` settlement, `final.success` unlock, direct stale resume, duplicate work-unit launch, and goal-store done writes without completion result.

### P1-13x - `EVAL-HARNESS`

**One invariant:** the dark eval proves stewardship, DAG unlock, cancellation, recovery, and rollback before composition.

**Maximum file set:** `src/core/eval/goal-stewardship-harness.ts` (new), `test/unit/goal-stewardship-eval.test.ts` (new), `docs/r7-item13-goal-stewardship-contract.md`.

**Verification receipt:** `.tmp/goal-stewardship-v1/*.json` artifact path/hash, fixture counts, p95 tables, false-unlock count zero, duplicate-launch count zero.

### P1-13y - `DARK-PRODUCTION-COMPOSITION`

**One invariant:** one explicit default-off flag composes stewardship across interactive, one-shot, and REPL entry points.

**Maximum file set:** `src/infra/config.ts`, `src/interface/ui/goal-stewardship-flag.ts` (new), `src/interface/menu.ts`, `src/interface/run.ts`, `src/interface/repl.ts`, `src/cli.ts`, `test/unit/goal-stewardship-flag.test.ts` (new), `test/unit/menu-flow.test.ts`, `test/unit/run.test.ts`, `test/unit/repl.test.ts`.

**Verification receipt:** flag defaults false, explicit true enables V1, flag-off snapshots match legacy, flag-on emits exactly one decision/settlement per affected node, unset flag rollback restores legacy goal behavior.

### P1-13z - `PROMOTION-CANDIDATE-ONLY`

**One invariant:** default-on is considered only after all upstream substrates, authority guards, eval artifacts, and human gate are green on the exact merge candidate.

**Maximum file set:** `src/interface/ui/goal-stewardship-flag.ts`, `src/infra/config.ts`, `test/unit/goal-stewardship-flag.test.ts`, `docs/r7-item13-goal-stewardship-contract.md`.

**Cancel conditions:** missing Item 10/18/19 landed contracts, missing eval artifact, any false unlock, any duplicate work-unit launch, stale provider launch, flag-off drift, missing rollback proof, stale artifact head, or absent human gate.

**Verification receipt:** promotion artifact hashes, human gate reference, before/after default table, rollback command, and explicit proof that Items 17/11/12/10/18/19 are consuming/producing the named edges.

## 10. Cross-slice acceptance and definition of done

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npm run typecheck
npx vitest run test/unit/goal-steward.test.ts test/unit/goal-manager.test.ts test/unit/goal-todo.test.ts test/unit/scheduler.test.ts test/unit/decompose.test.ts
```

Item 13 is implemented dark when 13y and 13x are green. It is promoted only if 13z's prerequisites and human gate are satisfied. The implementation satisfies Item 13 only if all of the following are simultaneously true:

- every launchable goal node is linked to an accepted intent-version execution id;
- every running node is owned by exactly one Item 10 work unit at a time;
- every settled node has exactly one `CompletionResultV1`;
- every edge unlock comes from satisfying completion evidence;
- stale parked/running/queued/blocked goals are owned by a live `AskActDecisionV1` loop;
- cancellation has an owner and preserves settled descendants;
- launch uses current provider generation and revalidates before stream open;
- canonical context is the durable DAG authority when Item 11 is enabled;
- flag-off rollback restores legacy goal behavior without deleting additive records;
- eval artifacts prove no false unlocks, duplicate launches, stale launches, or prose settlements.

## 11. Adversarial self-challenge and fixes

**Challenge 1: could this add busy-ness by waking old goals users do not care about?** Yes, if every stale finding becomes a prompt or launch. Fix: Item 19 owns ask/resume/park/cancel/act; the default loop may park or do nothing, and launch still needs accepted intent, current context, provider generation, dependencies, and work-unit claim.

**Challenge 2: could a successful-looking final still unlock a DAG edge?** Yes, if scheduler keeps reading `CoreEvent.final.success`. Fix: 13c, 13o, and the authority guard require `CompletionResultV1.goalSettlement.allowed=true`.

**Challenge 3: could exactly-once be bypassed by scheduler retries or restart recovery?** Yes, if node state lives in memory. Fix: Item 10 owns work-unit state; Item 13 cannot launch a second work unit while one is open or ambiguous.

**Challenge 4: could intent correction wipe out valid work?** Yes, if supersession cancels entire trees. Fix: cancellation records preserve settled descendants and invalidate only nodes whose accepted intent lineage no longer applies.

**Challenge 5: could auto-stage quietly become auto-execution?** Yes, because it already creates useful parked goals. Fix: born-parked is explicit, auto-stage never claims a work unit, and launch requires revalidation plus AskActDecisionV1.

**Challenge 6: could provider readiness make goals flaky?** Yes, if launch reads mutable provider state. Fix: Item 12 generation id is captured and rechecked before stream open; stale generation parks or asks instead of launching.

## 12. North-star drift check

Does this make the one chat a coherent multi-goal partner, or add busy-ness?

It moves toward the north-star only if goal stewardship becomes quiet ownership: the assistant remembers accepted intent, preserves evidence, resumes only when justified, asks when needed, cancels with ownership, and never advances dependent work without real completion.

It adds busy-ness if it turns every parked note into a notification, treats stale as permission to act, or writes DAG records while scheduler and UI still read prose. The guardrail is concrete: one execution id, one work-unit owner, one completion settlement, one canonical DAG, one ask-vs-act decision, dark flag, eval gate, rollback.
