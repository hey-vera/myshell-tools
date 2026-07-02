# Item 18 contract - intent continuity and correction DAG

Status: delegation-ready implementation contract, grounded at repository head `893e8db` on 2026-07-02.

This document is controlling for Round-7 Item 18. It builds on the shipped intent-store and correction-fork scaffolding from commit `2268e74` (`MYSHELL_INTENT_STORE_V1`, append-only intent-version store) and commit `8075c68` (`MYSHELL_CORRECTION_FORK_V1`, correction fork plus blocked state). The goal is not to reinvent those slices. The goal is to make accepted intent the binding authority for turns, goals, work units, completion, canonical context, and corrections.

At document creation the worktree was clean.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_INTENT_CONTINUITY_V1` is explicitly enabled, every accepted user intent has a versioned id. Every foreground turn, goal node, work unit, provider ledger attempt, `CompletionResultV1`, and Item-11 canonical event that performs or settles work references that id. When the user corrects course, the system creates a correction DAG edge from the divergence point, preserves already-valid work, invalidates only stale descendants with proven intent ancestry, and re-derives new goals/work units from the corrected accepted intent.

This item does **not**:

- replace Item 8 semantic preflight. It consumes its objective, done condition, task shape, and evidence obligations when present;
- replace Item 11 canonical context. It stores intent authority in that log and keeps the existing `.myshell-tools/intent-versions.jsonl` as a compatibility/source feed until migration;
- implement Item 10's exactly-once execution state machine, but it requires every work-unit state to carry `intentVersionId`;
- implement Item 13's goal DAG scheduler, but it requires goal DAGs to be born from accepted intent versions;
- redefine `CompletionResultV1`. Item 17 remains the completion truth; Item 18 only makes `CompletionResultV1.upstream.intentVersionId` mandatory under the flag;
- delete the existing intent store, correction detection, or goal supersession helpers;
- default-promote behavior without the evaluation gate below.

The current code already has a useful dark spine. What is missing is binding. Today an intent id can correlate calls and some goals, but stale prose, stale goals, and stale completion can still look like continuous work unless every downstream authority refuses to proceed without the active accepted intent version.

## 2. Current-state evidence and invariants

All citations below are current at `893e8db`; workers must re-run `nl -ba` or equivalent before editing and record drift rather than silently relying on stale line ranges.

- Commit `2268e74` shipped `MYSHELL_INTENT_STORE_V1` as an append-only intent-version store and describes it as default-off in the commit subject.
- Commit `8075c68` shipped `MYSHELL_CORRECTION_FORK_V1` and `MYSHELL_BLOCKED_STATE_V1` and describes them as default-off in the commit subject.
- Current head's intent-store flag helper now defaults true and returns false only for explicit opt-out at `src/interface/ui/intent-store-flag.ts:5-23`. This is real drift from the default-off commit claim and must be handled by an Item-18 controlling gate, not ignored.
- Current head's correction-fork flag helper also defaults true and says it requires the intent store at the call site at `src/interface/ui/correction-fork-flag.ts:5-24`.
- `IntentVersion` already exists with `version`, `id`, `parentId`, `sessionId`, `createdAt`, raw user text, optional semantic preflight, and normalized intent fields at `src/core/intent-version.ts:14-32`.
- `IntentStoreWriter.append` and `IntentStoreReader.readAll` already exist at `src/core/intent-version.ts:34-42`.
- `buildIntentVersion(...)` already builds one version from settled turn data, requires nonempty id/session/time/raw text/objective, extracts assumptions from forks, preserves constraints/non-goals/done/risk/confidence/source, and never throws at `src/core/intent-version.ts:55-140`.
- `IntentFrame` is the normalized turn-intent artifact, not just raw prose: goal, kind, non-goals, constraints, forks, doneWhen, confidence, source, route hints, risk hints, freshness, and draft-goal skeleton are defined at `src/core/intent.ts:31-108`.
- `IntentExtractor` already accepts an optional `intentVersionId` and `stage` at `src/core/intent.ts:140-144`; `makeIntentExtractor(...)` forwards that id to aux ledger records at `src/core/intent-extractor.ts:147-154`.
- The extractor is fail-soft and read-only: it routes worker tier, builds an intent prompt, parses once, records usage, and returns null on provider/routing/stream/parse failure at `src/core/intent-extractor.ts:70-178`.
- The JSONL intent store writes one line per append, reads all versions, skips malformed rows, and can read by id at `src/infra/intent-store.ts:1-76`.
- The JSONL guard accepts `IntentVersion` rows with nonempty id/session/time/raw text/objective, optional parent id, optional normalized lists, risk/confidence/source enums, and optional semantic preflight payload at `src/infra/jsonl-guards.ts:294-327`.
- The orchestrator already mints a per-turn `turnIntentVersionId` whenever account aux or intent store is present at `src/core/orchestrate.ts:367-374`.
- Semantic preflight, legacy unified intent, and legacy route/intent calls already propagate `turnIntentVersionId` into extractor/router options at `src/core/orchestrate.ts:424-575`.
- The single intent-store write site runs after intent stabilization and before optional render events at `src/core/orchestrate.ts:1378-1467`.
- Correction fork wiring already reads prior intent versions, detects corrections, sets `parentIdForWrite`, computes goal invalidation, appends the child version, emits a notice, and best-effort supersedes goals at `src/core/orchestrate.ts:1388-1465`.
- The current correction parent choice is the latest prior intent for the session, sorted by `createdAt`, at `src/core/orchestrate.ts:1398-1407`; Item 18 must refine this into an explicit divergence-point rule rather than always assuming the latest prior intent is the right fork parent.
- `detectCorrectionFork(...)` is deliberately conservative: it requires prior intent and high-confidence triggers such as `/correct`, "that's not what I meant", "no, I meant", "wrong direction", and constrained `instead` phrasing at `src/core/correction-fork.ts:20-68`.
- `intentDescendantIds(...)` computes descendants by parent chain and can exclude the new child branch at `src/core/correction-fork.ts:74-130`.
- `planCorrectionGoalInvalidation(...)` currently computes old-branch intent ids, preserves terminal/sibling/unprovenanced/verified goals, and supersedes only live old-branch goals at `src/core/correction-fork.ts:136-255`.
- Goals already carry optional `intentVersionId` and correction supersession metadata at `src/core/goal-todo.ts:169-185`.
- Goal store already has `markSuperseded(...)`, which only updates live goals and leaves terminal/unrelated goals unchanged at `src/infra/goal-store.ts:449-456`.
- Work contracts already carry `intentVersionId`, `blocked`, `supersededByIntentId`, and `supersededReason` at `src/core/work-contract.ts:99-109`.
- `stampContractIntentVersion(...)` already preserves or adds an intent id onto work contracts at `src/core/work-contract.ts:557-564`.
- `LedgerEntry` already has optional `intentVersionId` at `src/core/types.ts:182-198`.
- `OrchestrateDeps` already has optional `intentVersionId`, `intentStore`, and correction-fork deps at `src/core/types.ts:355-402,1120-1133`.
- `CoreEvent.final` has no canonical event ref and no `CompletionResultV1` yet at `src/core/types.ts:1280-1346`; Item 17 owns that future shape.
- Menu composition creates the intent store from the current flag and composes correction fork only when both correction fork and intent store are on at `src/interface/menu.ts:1369-1375`.
- Interactive deps pass correction-fork reader/list/supersede methods only when the goal store and intent store exist at `src/interface/menu.ts:2752-2773`.
- Auto-stage already forwards the turn's intent id and links created goals when intent store is on at `src/interface/menu.ts:6438-6447`.
- One-shot CLI creates the intent store and pre-mints an `intentVersionId` when account aux or intent store is on at `src/cli.ts:318-350`.

Baseline at this head:

| surface | current state | Item-18 requirement |
|---|---|---|
| intent version | JSONL `IntentVersion`, raw text plus normalized intent | accepted-intent authority with canonical event refs, hashes, supersession, and active-state checks |
| correction fork | latest-prior parent, conservative trigger, goal supersession | explicit divergence point, correction DAG event, preserve/invalidate/rederive protocol |
| goals | optional `intentVersionId` | required under flag; Item 13 goal nodes born from accepted intent versions |
| work units/contracts | optional `intentVersionId` on contracts and ledgers | required on every Item 10 work-unit event/state/ledger attempt |
| completion | future `CompletionResultV1.upstream.intentVersionId` optional | mandatory under flag and checked against active accepted intent |
| durable context | Item 11 canonical log pending | intent version/supersession/correction events stored in canonical log |
| rollout | shipped flags currently default true in helpers | Item 18 adds a default-off controlling gate and rollback proof |

## 3. Shared typed contract

Slice 18a must export these names from `src/core/intent-continuity.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them.

```ts
export type IntentContinuityVersion = 1;

export type IntentVersionState =
  | 'accepted'
  | 'superseded'
  | 'invalidated'
  | 'archived';

export type IntentSupersessionReason =
  | 'user-correction'
  | 'user-replacement'
  | 'goal-replanned'
  | 'schema-repair'
  | 'manual-rollback';

export interface AcceptedIntentV1 {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly state: IntentVersionState;
  readonly parentId: string | null;
  readonly supersedes: readonly string[];
  readonly supersededBy: string | null;
  readonly canonicalEventRef?: import('./durable-context.js').CanonicalEventRefV1;
  readonly sourceTurnEventRef?: import('./durable-context.js').CanonicalEventRefV1;
  readonly rawUserTurnText: string;
  readonly accepted: {
    readonly objective: string;
    readonly kind?: string;
    readonly constraints: readonly string[];
    readonly nonGoals: readonly string[];
    readonly assumptions: readonly string[];
    readonly forks: readonly import('./intent.js').IntentFork[];
    readonly doneCriteria: string | null;
    readonly risk?: import('./types.js').Risk;
    readonly confidence?: import('./intent.js').IntentConfidence;
    readonly source: 'semantic-preflight' | 'intent-frame' | 'rules-fallback' | 'manual-correction';
  };
  readonly acceptedIntentHash: string;
  readonly semanticPreflightRef?: import('./durable-context.js').CanonicalEventRefV1;
  readonly legacyIntentVersion?: import('./intent-version.js').IntentVersion;
}

export interface IntentVersionRefV1 {
  readonly version: 1;
  readonly intentVersionId: string;
  readonly acceptedIntentHash: string;
  readonly state: IntentVersionState;
  readonly eventRef?: import('./durable-context.js').CanonicalEventRefV1;
}

export type IntentBoundEntityKind =
  | 'turn'
  | 'goal'
  | 'work-unit'
  | 'provider-ledger'
  | 'completion-result'
  | 'canonical-event';

export interface IntentBindingV1 {
  readonly version: 1;
  readonly entityKind: IntentBoundEntityKind;
  readonly entityId: string;
  readonly intentVersionId: string;
  readonly acceptedIntentHash: string;
  readonly eventRef?: import('./durable-context.js').CanonicalEventRefV1;
  readonly createdAt: string;
}

export type CorrectionPreservationReason =
  | 'verified-or-reviewed'
  | 'terminal'
  | 'sibling-branch'
  | 'unprovenanced'
  | 'user-provided'
  | 'still-satisfies-corrected-intent';

export type CorrectionInvalidationReason =
  | 'live-old-branch-goal'
  | 'live-old-branch-work-unit'
  | 'stale-completion-obligation'
  | 'stale-provider-native-session'
  | 'stale-derived-summary'
  | 'stale-goal-edge';

export interface CorrectionForkV1 {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly trigger: string;
  readonly divergenceIntentId: string;
  readonly replacementIntentId: string;
  readonly oldBranchIntentIds: readonly string[];
  readonly preserved: readonly {
    readonly kind: 'goal' | 'work-unit' | 'completion-result' | 'canonical-event';
    readonly id: string;
    readonly reason: CorrectionPreservationReason;
  }[];
  readonly invalidated: readonly {
    readonly kind: 'goal' | 'work-unit' | 'completion-obligation' | 'provider-native-session' | 'snapshot' | 'goal-edge';
    readonly id: string;
    readonly reason: CorrectionInvalidationReason;
  }[];
  readonly rederive: readonly {
    readonly kind: 'goal-node' | 'work-unit' | 'evidence-obligation' | 'turn-plan';
    readonly fromIntentVersionId: string;
    readonly reason: string;
  }[];
  readonly eventRef?: import('./durable-context.js').CanonicalEventRefV1;
}
```

Caps are part of the contract: objective 120 characters; kind 32; constraints/non-goals/assumptions 6 each and 160 characters each; forks 3 with existing `IntentFork` caps; done criteria 240; correction reason strings 180; preserved/invalidated/rederive arrays 128 each. IDs must match `/^[a-z][a-z0-9_-]{0,63}$/`; compatibility with existing ids that do not match is handled by a mapper that stores the legacy id under `legacyIntentVersion.id` and emits a stable mapped id. `acceptedIntentHash` is a stable hash over canonical JSON of `accepted`, not over `rawUserTurnText`.

An intent version is made from accepted intent, not raw prose. Raw prose is audit evidence only. The accepted intent is derived in priority order:

1. Item 8 `SemanticPreflightV1` when present and parsed: objective, task shape, evidence obligations, and done condition are authoritative inputs.
2. Settled `IntentFrame` when no semantic preflight exists.
3. Deterministic `rulesIntentFrame` when extraction/preflight is skipped or failed.
4. Manual `/correct` replacement text only after it has been converted into a normalized accepted intent by the same parser/capper.

An accepted intent version is superseded only by an append-only event. No stored version is edited in place. Supersession requires `replacementIntentId`, `reason`, a correction/replacement event id, and a preservation/invalidation plan. An active work surface may bind only to an `accepted` intent version. It may display archived/superseded versions for audit, but it may not plan new work from them.

## 4. Canonical event-log storage

Item 18 extends the Item-11 canonical event log vocabulary. If Item 11 has not landed, the existing `intent-versions.jsonl` remains the compatibility store and all new constructors must be pure/test-only. Once `MYSHELL_DURABLE_CONTEXT_V1` and `MYSHELL_INTENT_CONTINUITY_V1` are both enabled, the canonical log is authority and JSONL is compatibility output.

Add these canonical event kinds to Item 11:

```ts
export type IntentContinuityCanonicalEventKind =
  | 'intent.version'
  | 'intent.supersession'
  | 'correction.fork'
  | 'intent.binding';
```

Storage rules:

- A foreground user turn gets `turn.user` first, then exactly one `intent.version` event once accepted intent is settled. The current JSONL append may occur after the canonical event as compatibility output.
- `intent.version.payload` is `AcceptedIntentV1` without `canonicalEventRef` self-reference; the event ref is returned to consumers after append.
- `intent.supersession.payload` names old id, replacement id, reason, preserving event refs, and invalidating event refs. It does not delete or rewrite old versions.
- `correction.fork.payload` is `CorrectionForkV1`.
- `intent.binding.payload` is `IntentBindingV1` for entities that do not already carry the intent id in their own typed canonical event payload.
- A canonical `turn.preflight`, `work-unit.planned`, `work-unit.state`, `goal.node`, `goal.edge`, `completion.result`, and `provider.observation` event under the flag must carry `intentVersionId` and `acceptedIntentHash` either in its payload or in a sibling `intent.binding` event.
- Reconstruction fails closed when an active turn/work-unit/goal/completion references an unknown, superseded, invalidated, or hash-mismatched intent version.
- Snapshots may summarize intent DAG state, but they are invalid if they omit the active accepted intent, a supersession affecting an active entity, or an unresolved correction fork.

The existing JSONL store remains useful:

- `src/core/intent-version.ts` stays the compatibility model for shipped callers.
- New code may wrap existing `IntentVersion` into `AcceptedIntentV1`; it must not break old rows.
- `rawUserTurnText` remains in the compatibility row for audit, but no consumer may derive active work from raw text when an accepted intent hash is present.
- Malformed JSONL rows continue to be skipped; canonical reconstruction must report a repair/incompatibility receipt rather than silently fabricating intent state.

## 5. Binding rules

Binding is the load-bearing part of Item 18.

Every enabled foreground turn:

- must have one active `intentVersionId` before any work unit, goal auto-stage, provider work call, or completion result starts;
- may have zero model preflight calls for trivial turns, but still gets a rules-derived accepted intent if the turn performs or settles work;
- may bypass intent versioning only for pure social/no-op turns that produce no goal, work unit, completion result, provider ledger entry, or durable event beyond transcript display.

Every enabled goal:

- is born from an accepted `intentVersionId`;
- stores the id on the existing `Goal.intentVersionId` field and on the Item-13 `goal.node` canonical event;
- may depend only on nodes whose intent versions are active or preserved under a correction fork;
- is re-derived, not patched in place, when its creating intent is superseded and it remains live.

Every enabled work unit:

- is planned from an accepted `intentVersionId`;
- stores the id on the work contract and every Item-10 `work-unit.planned` / `work-unit.state` event;
- records provider ledger attempts with the same id;
- must stop or re-plan when its intent version becomes superseded before mutation starts;
- may complete after supersession only when it is already terminal, verified/reviewed, or explicitly preserved by the correction fork.

Every enabled `CompletionResultV1`:

- must set `upstream.intentVersionId`;
- must compare its objective/done condition to the accepted intent and record any mismatch as delivery-quality failure or `bestEffort`;
- must not settle a goal whose current goal node is bound to a different active intent version;
- may settle preserved old-branch work only when the correction fork says that work still satisfies the corrected intent.

Every enabled provider/native session/resume decision:

- carries the active `intentVersionId`;
- is invalidated for active reconstruction if the referenced intent is superseded and not preserved;
- cannot use provider-native memory to override the canonical active intent.

## 6. Correction DAG

The correction DAG is a graph of accepted intent versions plus explicit correction/supersession edges. It is not a transcript heuristic.

Nodes:

- one node per `AcceptedIntentV1`;
- root node when `parentId=null`;
- correction child when the user corrects an earlier accepted intent;
- replacement child when the user intentionally changes scope for ongoing work.

Edges:

- `parentId` is the structural fork parent;
- `supersedes[]` names old-branch nodes made inactive by the new node;
- canonical `intent.supersession` events name the reason and affected entities;
- canonical `correction.fork` events name divergence, replacement, preserved work, invalidated work, and re-derived work.

Divergence point:

- The current helper selects the latest prior session intent. Item 18 keeps that as a fallback only.
- Preferred divergence point is the newest prior active intent whose accepted objective/done/goal/work binding is contradicted by the correction turn.
- `/correct <replacement>` without a target selects the current active intent.
- `/correct <intent-id> <replacement>` may target an older active or superseded intent; if the target is unknown, no fork occurs.
- Natural-language correction triggers select the current active intent unless the text names a specific goal/work unit whose binding points to an older intent.
- Uncertain detection returns no correction. It may create a fresh root or child intent, but it must not invalidate.

Preserved:

- source events, raw transcript, and old intent versions are always preserved for audit;
- completed, failed, blocked, superseded, verified, or reviewed goals/work units;
- work with `CompletionResultV1.goalSettlement.allowed=true`;
- disjoint sibling branches;
- user-provided artifacts and attachments;
- unprovenanced work whose ancestry cannot be proven;
- old-branch work explicitly judged still satisfying the corrected accepted intent.

Invalidated:

- live old-branch goals in `parked`, `queued`, or `running`;
- live old-branch work units that have not reached a terminal Item-10 state;
- stale completion obligations derived from superseded objective/done/evidence;
- provider-native sessions whose covered context depends on superseded active intent;
- snapshots and summaries that present superseded intent as current;
- goal edges whose source or target is superseded and not preserved.

Re-derived:

- Item 13 goal nodes from the replacement accepted intent;
- Item 10 work units from the replacement accepted intent and preserved valid outputs;
- Item 17 before-completion obligations from current semantic/evidence fields;
- Item 5 turn plan from the replacement intent, not from the correction prose.

Relationship to existing `correction-fork.ts`:

- Reuse `detectCorrectionFork(...)` as the conservative first-pass trigger.
- Reuse `intentDescendantIds(...)` for old-branch computation.
- Reuse and extend `planCorrectionGoalInvalidation(...)`; do not widen it to invalidate unprovenanced or terminal work.
- Add work-unit, completion-obligation, snapshot, provider-session, and goal-edge planning beside the existing goal planner.
- Preserve the existing "fail closed by preserving" behavior on read/list/append/supersede errors.

## 7. Named upstream and downstream contract edges

### Edge `8k->18` - semantic accepted intent

Producer: Item 8 semantic preflight.

Consumer: `AcceptedIntentV1` and `intent.version`.

Rule: Item 18 versions the accepted objective, task shape, done condition, risk, assumptions, and evidence obligations after Item 8 has parsed them. It does not treat raw user prose or model chain-of-thought as intent.

### Edge `18->11` - intent authority into canonical context

Producer: Item 18 intent versions, bindings, supersession, and correction forks.

Consumer: Item 11 canonical log and snapshots.

Rule: canonical context reconstruction exposes the active accepted intent and refuses stale/superseded bindings for active work.

### Edge `18->10` - intent-bound work units

Producer: active `IntentVersionRefV1`.

Consumer: Item 10 work-unit state machine.

Rule: every work unit is born from an accepted intent version and stops/replans on supersession unless preserved by the correction fork.

### Edge `18->13` - goal DAGs from accepted intent

Producer: active `IntentVersionRefV1`.

Consumer: Item 13 goal DAG nodes and edges.

Rule: goal DAG nodes must be born from accepted intent versions, not transient prose, final assistant wording, or parked-goal titles. Dependent goal nodes may advance only when their source completion is bound to the same active or explicitly preserved intent branch.

### Edge `18->17` - completion bound to intent

Producer: active `IntentVersionRefV1`.

Consumer: `CompletionResultV1.upstream.intentVersionId`.

Rule: Item 17 completion construction must reject or degrade terminal truth when the result is missing an intent id, references a stale/superseded id, or claims an objective inconsistent with the accepted intent.

## 8. Shared rollout, fixture, and worktree rules

The controlling runtime flag is `MYSHELL_INTENT_CONTINUITY_V1`; config mirror is `experimentalIntentContinuityV1?: boolean`. It is default false. Existing `MYSHELL_INTENT_STORE_V1` and `MYSHELL_CORRECTION_FORK_V1` are reused as substrate flags but are not sufficient to enable Item 18 authority.

Because current head's helper functions default true, Slice 18p must add explicit composition tests proving:

- absent `MYSHELL_INTENT_CONTINUITY_V1` means no Item-18 canonical binding, no correction DAG authority checks, and no default-on behavior change;
- explicit `MYSHELL_INTENT_CONTINUITY_V1=true` enables Item-18 behavior only when required substrate dependencies exist;
- explicit `MYSHELL_INTENT_STORE_V1=0` disables compatibility JSONL output but cannot cause active work to proceed without canonical intent when Item 18 is on;
- explicit `MYSHELL_CORRECTION_FORK_V1=0` disables correction DAG invalidation while still allowing basic intent binding;
- rollback is: unset `MYSHELL_INTENT_CONTINUITY_V1`, set `experimentalIntentContinuityV1:false`, optionally set `MYSHELL_CORRECTION_FORK_V1=0` and `MYSHELL_INTENT_STORE_V1=0`, restart, and confirm legacy final/session/goal snapshots.

Every worker slice must begin with:

```bash
git status --short
git diff --name-only
npm run typecheck
```

Record pre-existing paths and do not edit them. A slice is rejected if `git diff --name-only` contains a path outside its exhaustive maximum set. No slice may broaden correction detection without a false-positive fixture. No slice may invalidate work lacking reliable intent ancestry.

## 9. Evaluation and acceptance gate

Default-on is out of scope until the eval gate passes on the exact merge candidate.

Minimum dark acceptance artifact under `.tmp/intent-continuity-v1/`:

- 100 turn fixtures: trivial, normal work, goal creation, work-unit planning, completion, provider switch, resume, and correction;
- 40 correction fixtures with at least 20 negative controls for ambiguous "actually" / "instead" wording;
- zero false-positive invalidations on negative controls;
- zero active work units, active goals, or completion results without `intentVersionId`;
- zero completions referencing superseded intent unless preserved by correction fork;
- provider-neutral reconstruction preserves the active intent across at least two provider switches;
- 500-turn synthetic log reconstructs active intent DAG within Item-11 token/time caps;
- flag-off snapshots match legacy event/final/goal behavior;
- rollback command restores legacy behavior without deleting intent/correction records.

Promotion receipt must include artifact path, hash, fixture counts, false-positive/false-negative correction counts, stale-binding guard count, runtime p95 for pure reconstruction, git head, date, and exact commands.

## 10. Ordered slices

### P1-18a - `INTENT-CONTINUITY-DOMAIN`

**One invariant:** accepted intent is versioned from normalized intent fields, not raw prose.

**Maximum file set:** `src/core/intent-continuity.ts` (new), `test/unit/intent-continuity.test.ts` (new).

**Behavioral diff:** add shared types, caps, stable accepted-intent hash, mapper from `IntentVersion`/`SemanticPreflightV1`/`IntentFrame`, parse guards, and active-state helpers. No runtime wiring.

**Verification receipt:** typecheck, lint, unit tests proving caps, hash stability, raw-prose changes do not alter accepted hash, malformed ids fail closed, and legacy rows map losslessly.

### P1-18b - `LEGACY-INTENT-VERSION-ADAPTER`

**One invariant:** shipped `IntentVersion` rows remain readable while new code sees `AcceptedIntentV1`.

**Maximum file set:** `src/core/intent-version.ts`, `src/core/intent-continuity.ts`, `test/unit/intent-store.test.ts`, `test/unit/intent-continuity.test.ts`.

**Behavioral diff:** add adapter helpers only; do not change append semantics.

**Verification receipt:** existing intent-store tests pass; new fixtures convert old rows with parentId/null/semantic preflight.

### P1-18c - `CANONICAL-INTENT-EVENT-CONSTRUCTORS`

**One invariant:** intent versions, supersession, correction forks, and bindings can be represented as Item-11 canonical events.

**Maximum file set:** `src/core/intent-continuity.ts`, `src/core/durable-context.ts`, `test/unit/intent-continuity-canonical.test.ts` (new), `test/unit/durable-context.test.ts`.

**Behavioral diff:** add pure constructors and validators for `intent.version`, `intent.supersession`, `correction.fork`, and `intent.binding`.

**Verification receipt:** canonical hashes stable; unsupported event kind/version fails reconstruction; no Item-11 existing fixture regresses.

### P1-18d - `ACTIVE-INTENT-RESOLVER`

**One invariant:** active intent resolution cannot return superseded, invalidated, unknown, or hash-mismatched intent for new work.

**Maximum file set:** `src/core/intent-continuity.ts`, `test/unit/intent-continuity-active.test.ts` (new).

**Behavioral diff:** add pure active-intent resolver over event/log rows plus compatibility rows.

**Verification receipt:** fixtures for root, child, superseded, invalidated, duplicate id, hash mismatch, and mapped legacy id.

### P1-18e - `DIVERGENCE-POINT-SELECTION`

**One invariant:** correction fork parent selection is explicit and conservative; latest-prior is only fallback.

**Maximum file set:** `src/core/correction-fork.ts`, `src/core/intent-continuity.ts`, `test/unit/correction-fork.test.ts`.

**Behavioral diff:** add pure `selectCorrectionDivergencePoint(...)` over active intent, named goal/work binding, explicit `/correct <id>`, and latest-prior fallback.

**Verification receipt:** tests for explicit id, current active, named old goal, unknown id no-op, and ambiguous natural language no invalidation.

### P1-18f - `CORRECTION-DAG-PLAN`

**One invariant:** correction planning preserves by default and invalidates only proven stale descendants.

**Maximum file set:** `src/core/correction-fork.ts`, `src/core/intent-continuity.ts`, `test/unit/correction-fork.test.ts`, `test/unit/intent-continuity-correction.test.ts` (new).

**Behavioral diff:** extend existing goal invalidation planning into `CorrectionForkV1` with preserved/invalidated/rederive arrays.

**Verification receipt:** old goal fixtures still pass; new fixtures cover work units, completion obligations, provider sessions, snapshots, and goal edges.

### P1-18g - `INTENT-BINDING-GUARDS`

**One invariant:** no enabled active entity can bind to stale or unknown intent.

**Maximum file set:** `src/core/intent-continuity.ts`, `test/unit/intent-continuity-binding.test.ts` (new).

**Behavioral diff:** add pure `validateIntentBinding(...)` and `requireActiveIntentBinding(...)`.

**Verification receipt:** every entity kind succeeds with active id and fails with missing/stale/hash-mismatched id.

### P1-18h - `ORCHESTRATE-INTENT-AUTHORITY-INJECTION`

**One invariant:** under injected flag, orchestrate creates one accepted intent version before work starts and binds the turn to it.

**Maximum file set:** `src/core/types.ts`, `src/core/orchestrate.ts`, `test/unit/orchestrate-intent-continuity.test.ts` (new), `test/unit/orchestrate-intent-store.test.ts`.

**Behavioral diff:** add optional injected intent-continuity deps; preserve current intent-store write path off flag.

**Verification receipt:** flag-off snapshots match; flag-on nontrivial and work-producing trivial turns get one active intent id before provider work; pure social no-op can omit.

### P1-18i - `CANONICAL-WRITES-AND-COMPAT-JSONL`

**One invariant:** canonical intent event append is authority under the flag; JSONL is compatibility output.

**Maximum file set:** `src/core/orchestrate.ts`, `src/infra/intent-store.ts`, `test/unit/orchestrate-intent-continuity.test.ts`, `test/unit/intent-store.test.ts`.

**Behavioral diff:** append canonical `intent.version` when durable context is present; write JSONL compatibility row after canonical success.

**Verification receipt:** canonical append failure stops before work; JSONL failure does not corrupt canonical authority; flag-off JSONL behavior unchanged.

### P1-18j - `CORRECTION-FORK-RUNTIME-WIRING`

**One invariant:** runtime correction creates a DAG fork only after replacement intent append succeeds.

**Maximum file set:** `src/core/orchestrate.ts`, `src/core/correction-fork.ts`, `test/unit/orchestrate-correction-fork.test.ts`, `test/unit/orchestrate-intent-continuity.test.ts`.

**Behavioral diff:** replace latest-prior-only parent selection with divergence resolver; emit `correction.fork` and `intent.supersession` events.

**Verification receipt:** existing correction-fork tests pass; new tests prove append failure invalidates nothing and notice names preserved/invalidated counts.

### P1-18k - `GOAL-BIRTH-BINDING-SEAM`

**One invariant:** enabled goals and future Item-13 goal nodes are born from accepted intent versions.

**Maximum file set:** `src/core/goal-todo.ts`, `src/infra/goal-store.ts`, `src/interface/auto-stage.ts`, `test/unit/goal-store.test.ts`, `test/unit/goal-plan-autostage.test.ts`.

**Behavioral diff:** require/pass active `IntentVersionRefV1` under injected flag; preserve optional old field off flag.

**Verification receipt:** goal create without active id fails under injection; auto-stage links id; off flag existing tests unchanged.

### P1-18l - `WORK-UNIT-BINDING-SEAM`

**One invariant:** Item-10 work-unit state can only be planned from accepted intent under the flag.

**Maximum file set:** `src/core/work-contract.ts`, `src/core/types.ts`, `test/unit/work-contract.test.ts`, `test/unit/intent-continuity-work-unit.test.ts` (new).

**Behavioral diff:** add work-unit binding helper and contract guard; no Item-10 state machine.

**Verification receipt:** planned/claimed/settled fixture all carry id; stale id blocks planning; off flag contract caps unchanged.

### P1-18m - `PROVIDER-LEDGER-BINDING`

**One invariant:** provider/model attempts serving work carry the active intent id.

**Maximum file set:** `src/core/types.ts`, `src/core/aux-ledger.ts`, `src/core/intent-extractor.ts`, `src/core/work-call.ts`, `test/unit/work-call-prior-cost.test.ts`, `test/unit/route-classifier.test.ts`.

**Behavioral diff:** guard that work/provider ledger entries under Item 18 include active `intentVersionId`; preflight-only legacy paths remain compatible.

**Verification receipt:** all work-call ledger entries under injection have id; stale/missing id fails closed before provider work.

### P1-18n - `COMPLETION-BINDING-SEAM`

**One invariant:** `CompletionResultV1` under Item 17 cannot settle without a valid active or preserved intent id.

**Maximum file set:** `src/core/accept-stage.ts`, `src/core/intent-continuity.ts`, `test/unit/completion-result.test.ts`, `test/unit/intent-continuity-completion.test.ts` (new).

**Behavioral diff:** add helper consumed by Item 17 when available; no redefinition of completion schema.

**Verification receipt:** done/answered/needs-user fixtures carry upstream id; stale id becomes blocked/failed/bestEffort per Item 17 rules.

### P1-18o - `RECONSTRUCTION-ACTIVE-INTENT-BLOCK`

**One invariant:** Item-11 reconstructed context exposes the active accepted intent and correction DAG state.

**Maximum file set:** `src/core/durable-context-reconstruct.ts`, `src/core/intent-continuity.ts`, `test/unit/durable-context-reconstruct.test.ts`, `test/unit/intent-continuity-reconstruct.test.ts` (new).

**Behavioral diff:** add prompt block/state reducer for active intent and unresolved correction forks.

**Verification receipt:** 500-turn fixture retains active intent while dropping old prose first; superseded intent cannot render as current.

### P1-18p - `DARK-FLAG-COMPOSITION`

**One invariant:** one explicit default-off flag composes Item-18 authority; existing store/fork flags are substrate controls only.

**Maximum file set:** `src/infra/config.ts`, `src/interface/ui/intent-continuity-flag.ts` (new), `src/interface/menu.ts`, `src/cli.ts`, `test/unit/intent-continuity-flag.test.ts` (new), `test/unit/menu-flow.test.ts`, `test/unit/run.test.ts`.

**Behavioral diff:** add `MYSHELL_INTENT_CONTINUITY_V1` and config mirror default false; wire injected deps only when explicit true.

**Verification receipt:** absent/false/garbage are off; explicit true is on; flag-off snapshots match legacy despite current substrate helper defaults.

### P1-18q - `CORRECTION-FALSE-POSITIVE-EVAL`

**One invariant:** ambiguous language never invalidates work.

**Maximum file set:** `src/core/correction-fork.ts`, `test/unit/correction-fork.test.ts`, `test/fixtures/intent-continuity/corrections.json` (new).

**Behavioral diff:** add fixture runner for positive/negative correction phrases.

**Verification receipt:** zero negative-control invalidations; explicit correction positives still fork.

### P1-18r - `PRESERVED-WORK-REUSE`

**One invariant:** valid preserved work is carried forward, not hidden or redone as stale.

**Maximum file set:** `src/core/intent-continuity.ts`, `src/core/work-state.ts`, `test/unit/work-state.test.ts`, `test/unit/intent-continuity-correction.test.ts`.

**Behavioral diff:** expose preserved work references for rederived plans/context.

**Verification receipt:** corrected intent prompt names preserved verified work and excludes invalidated live work.

### P1-18s - `SNAPSHOT-INVALIDATION`

**One invariant:** snapshots/summaries cannot present superseded intent as current.

**Maximum file set:** `src/core/durable-context-snapshot.ts`, `src/core/intent-continuity.ts`, `test/unit/durable-context-snapshot.test.ts`.

**Behavioral diff:** invalidate intent-sensitive snapshots on supersession/correction.

**Verification receipt:** stale summary skipped; source events remain inspectable; no deletion.

### P1-18t - `PROVIDER-NATIVE-SESSION-INVALIDATION`

**One invariant:** provider-native resume never overrides corrected accepted intent.

**Maximum file set:** `src/core/native-session.ts`, `src/core/intent-continuity.ts`, `test/unit/native-session.test.ts`, `test/unit/durable-context-provider-switch.test.ts`.

**Behavioral diff:** native session acceleration is omitted when its covered event depends on superseded intent.

**Verification receipt:** provider switch preserves active intent; stale native session omitted.

### P1-18u - `AUTHORITY-GUARDS`

**One invariant:** under the flag, goals/work/completion/resume cannot bypass accepted intent.

**Maximum file set:** `test/arch/intent-continuity-authority-guard.test.ts` (new), `src/core/intent-continuity.ts`.

**Behavioral diff:** add architecture/static guard for active surfaces and test helper exceptions.

**Verification receipt:** synthetic bypass fails; existing allowed legacy paths pass only when flag off.

### P1-18v - `EVAL-RUNNER`

**One invariant:** dark implementation acceptance is artifact-backed, not asserted.

**Maximum file set:** `src/cli.ts`, `src/core/intent-continuity.ts`, `test/unit/intent-continuity-eval.test.ts` (new), `docs/r7-item18-intent-continuity-contract.md`.

**Behavioral diff:** add eval runner that writes `.tmp/intent-continuity-v1/*.json`; record no acceptance receipt until it passes.

**Verification receipt:** artifact hash, fixture counts, stale-binding count, correction false-positive count, and rollback proof.

### P1-18w - `ROLLBACK-AND-REPAIR`

**One invariant:** disabling Item 18 restores legacy behavior without deleting intent/correction records.

**Maximum file set:** `src/interface/ui/intent-continuity-flag.ts`, `src/infra/intent-store.ts`, `test/unit/intent-continuity-flag.test.ts`, `test/unit/intent-store.test.ts`.

**Behavioral diff:** add repair/read-only diagnostics for malformed/mismatched intent rows; no destructive migration.

**Verification receipt:** rollback command table; corrupt row skipped with diagnostic; legacy run works.

### P1-18x - `DOWNSTREAM-EDGE-TESTS`

**One invariant:** edges `18->10`, `18->13`, and `18->17` are represented even before those items are default-on.

**Maximum file set:** `test/unit/intent-continuity-work-unit.test.ts`, `test/unit/intent-continuity-completion.test.ts`, `test/unit/intent-continuity-goal-dag.test.ts` (new).

**Behavioral diff:** fixture-only consumers for Item 10/13/17 contracts.

**Verification receipt:** tests prove work-unit, goal node, and completion fixtures reject missing/stale id.

### P1-18y - `DARK-IMPLEMENTATION-ACCEPTANCE`

**One invariant:** Item 18 is implemented dark only when all authority, correction, and rollback guards are green.

**Maximum file set:** `docs/r7-item18-intent-continuity-contract.md`, `test/arch/intent-continuity-authority-guard.test.ts`, `test/unit/intent-continuity-eval.test.ts`.

**Behavioral diff:** record dark acceptance receipt in this document after artifacts pass. Default remains off.

**Verification receipt:** exact commands, artifact hash, head, fixture table, no-default-change proof.

### P1-18z - `PROMOTION-CANDIDATE-ONLY`

**One invariant:** default-on is considered only after human gate and downstream Item 10/11/13/17 integration readiness.

**Maximum file set:** `src/interface/ui/intent-continuity-flag.ts`, `src/infra/config.ts`, `docs/r7-item18-intent-continuity-contract.md`, `test/unit/intent-continuity-flag.test.ts`.

**Behavioral diff:** may change absent env/config to default-on only with recorded human gate; explicit false remains rollback for one release. This slice may cancel with no edits.

**Verification receipt:** human gate reference, eval artifact hashes, downstream readiness matrix, rollback command, before/after default table.

## 11. Cross-slice acceptance and definition of done

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npm run typecheck
npx vitest run test/unit/intent-store.test.ts test/unit/correction-fork.test.ts test/unit/orchestrate-intent-store.test.ts test/unit/orchestrate-correction-fork.test.ts
```

The changed-file list must be a subset of that slice's maximum set. A pass with no stale-binding fixture, no correction negative controls, no flag-off snapshot, or no rollback note is not acceptance.

Item 18 is implemented dark when 18y is green. It is promoted only if 18z's prerequisites and human gate are satisfied. The implementation satisfies Item 18 only if all of the following are simultaneously true:

- every enabled work-producing foreground turn has one accepted intent version before work starts;
- every enabled goal, work unit, provider ledger attempt, canonical event, and `CompletionResultV1` references an active or explicitly preserved intent version;
- raw prose is retained for audit but never used as the active work authority when accepted intent exists;
- correction forks select an explicit divergence point and preserve by default;
- live old-branch work is invalidated only with proven ancestry;
- already-valid work is preserved and available to rederived plans;
- Item 13 goal DAG nodes are born from accepted intent versions, not transient prose;
- stale/superseded intent cannot masquerade as continuous work in completion, resume, or goals;
- flag-off rollback restores legacy behavior without deleting JSONL or canonical records;
- the eval gate records zero false-positive invalidations and zero stale active bindings.

## 12. Adversarial self-challenge and fixes

**Challenge 1: could this duplicate Item 11 with another log?** Yes, if JSONL remains the authority after canonical context lands. Fix: JSONL is compatibility output; canonical `intent.version`/`intent.supersession`/`correction.fork` events become authority when Item 11 is enabled.

**Challenge 2: could corrections invalidate useful user work?** Yes, if trigger detection or ancestry is too broad. Fix: detection stays conservative, divergence selection fails closed, and invalidation requires proven old-branch ancestry. Unprovenanced and terminal work is preserved.

**Challenge 3: could stale intent still settle goals through final prose?** Yes, if Item 17 or Item 13 consumes output text without checking intent binding. Fix: `CompletionResultV1.upstream.intentVersionId` is mandatory under the flag, and goal DAG nodes advance only from same-branch or preserved completion.

**Challenge 4: could every casual message get ceremony?** Yes, if no-op/social turns always produce durable intent. Fix: pure social/no-op turns can omit intent versions when they create no work, goal, completion result, provider ledger entry, or durable authority event.

**Challenge 5: could latest-prior parent selection fork the wrong intent?** Yes. Fix: latest-prior becomes fallback only; explicit target, active goal/work binding, and current active intent resolve divergence first.

**Challenge 6: could current default-true substrate flags accidentally promote Item 18?** Yes. Fix: a new default-off `MYSHELL_INTENT_CONTINUITY_V1` gate controls authority; existing flags are substrate controls and rollback levers.

## 13. North-star drift check

Does this make "one chat" coherent across corrections, or add ceremony?

It moves toward the north-star only if accepted intent becomes the quiet spine behind the chat: the user corrects direction, valid work remains visible, stale work stops driving goals/completion, and provider switches/resume keep the corrected objective.

It adds ceremony if the app writes intent ids that downstream systems ignore, if correction forks become broad invalidation events, or if raw transcript prose still decides what work is current. The guardrail is concrete: accepted intent hash, active binding, correction DAG, canonical event storage, eval gate, and rollback.
