Read-only note: I did not edit the repo. Save the following as `docs/pr4-correction-fork-plan.md`.

```md
# PR4 Correction Fork + Blocked State Plan

## 1. Goal And Off Guarantees

Implement two independent, default-off capabilities:

- `MYSHELL_CORRECTION_FORK_V1`: reversible correction. A clear user correction creates a child `IntentVersion` whose `parentId` is the diverged prior intent version, then conservatively marks only invalid live descendants as `superseded`. No deletion.
- `MYSHELL_BLOCKED_STATE_V1`: honest blocking. A first-class terminal `blocked` state distinct from `failed`, carrying `{ reason, nextAction, preservedWork }`.

Off guarantees:

- If `MYSHELL_CORRECTION_FORK_V1` is off, runtime behavior is byte-identical to current main: no correction detection, no parent lookup, no fork parent assignment, no superseded status, no invalidation.
- If `MYSHELL_BLOCKED_STATE_V1` is off, runtime behavior is byte-identical to current main: no `blocked` goal state emitted, no blocked final record, no best-effort conversion, no render wording change.
- The flags are independent. Correction fork requires `MYSHELL_INTENT_STORE_V1` to already be on, but must not enable it implicitly.

## 2. Correction Detection

Use deterministic, conservative detection only. Do not add a model call.

A turn is a correction only when all are true:

1. `MYSHELL_CORRECTION_FORK_V1` is enabled.
2. `MYSHELL_INTENT_STORE_V1` is enabled.
3. A prior `IntentVersion` exists for the current `sessionId`.
4. The user text matches one high-confidence correction trigger.

High-confidence triggers:

- Explicit command form: `/correct <replacement intent>`.
- Literal correction phrases near the start of the turn:
  - `wait, you missed my point`
  - `that's not what I meant`
  - `that is not what I meant`
  - `you missed my point`
  - `no, I meant`
  - `actually, I meant`
  - `wrong direction`
  - `not what I asked`
  - `instead, ...` only when preceded by `no`, `wait`, or `actually`.

Safe default:

- If detection is uncertain, treat the turn as a fresh intent.
- Never invalidate work from classifier confidence alone.
- Never invalidate work from generic wording like `actually implement X` unless it matches the high-confidence correction grammar above.

## 3. Fork Write And Descendant Invalidation

### Fork Write

Verified anchor: `src/core/orchestrate.ts:1101` currently writes one intent version with `parentId: null` at `src/core/orchestrate.ts:1108`.

Change the existing single write site only:

- Before the write, compute `parentIdForWrite`.
- Default: `parentIdForWrite = null`.
- If correction detection succeeds, select the latest prior `IntentVersion` for `deps.session.id`; set `parentIdForWrite = prior.id`.
- Call existing `buildIntentVersion` from `src/core/intent-version.ts:56` with `parentId: parentIdForWrite`.
- Append exactly once. If append fails, do not invalidate anything.

No `IntentVersion` schema expansion is required. `parentId` is already reserved in `src/core/intent-version.ts:16`.

### Descendant Definition

Given correction parent `P` and new child `N`:

- `oldBranchIntentIds = { P.id } union all IntentVersion ids whose parent chain reaches P.id, excluding N.id and descendants of N.id`.
- A goal is an intent descendant when:
  - `goal.intentVersionId` is in `oldBranchIntentIds`, or
  - it has no `intentVersionId`, but its `parentGoalId` chain reaches a goal that is an intent descendant.
- A work contract is an intent descendant when `workContract.intentVersionId` is in `oldBranchIntentIds`.

### Still-Valid Definition

Preserve by default. A descendant is still valid when any of these is true:

- It is already terminal: `done`, `failed`, `blocked`, or `superseded`.
- It has a passing/reviewed verdict.
- It has no reliable intent provenance.
- It belongs to a sibling or unrelated intent branch.
- The invalidation helper cannot prove provenance from `intentVersionId` or `parentGoalId`.

Only live goals in `parked`, `queued`, or `running` can be moved to `superseded`.

### Reversibility

Invalidation is a status change only:

- Do not delete goals.
- Do not delete work contracts or history.
- Store `supersededByIntentId = N.id`.
- Store a short reason: `User corrected intent; superseded by <N.id>`.

Preserved work is reused by leaving it visible and eligible for future planning. Superseded work is excluded from future active work selection but remains inspectable.

## 4. BLOCKED Terminal Design

Add structured blocked data:

```ts
type BlockedRecord = {
  reason: string;
  nextAction: string;
  preservedWork: string;
  code?:
    | 'missing_authority'
    | 'intent_unclear'
    | 'verification_failed'
    | 'environment_unavailable'
    | 'quota_exhausted'
    | 'risk_requires_approval'
    | 'dependency_blocked';
};
```

Rules:

- `reason`, `nextAction`, and `preservedWork` must be non-empty strings.
- `blocked` is terminal and distinct from `failed`.
- Do not invent new model calls. Reuse existing failure, verification, scheduler, auth, and risk signals.

Decision points when `MYSHELL_BLOCKED_STATE_V1` is on:

- Verification cannot pass after bounded repair: `verification_failed`.
- Provider auth or credential failure prevents work: `missing_authority`.
- Rate limit or quota exhaustion prevents work: `quota_exhausted`.
- Environment/tool unavailable or timeout prevents work: `environment_unavailable`.
- Risk requires approval before proceeding: `risk_requires_approval`.
- Scheduler skips a goal because a prerequisite failed/blocked: `dependency_blocked`.
- Existing best-effort success caused by exhausted verification/repair budget becomes `success: false` with `blocked`, while preserving the partial output in `output` and `preservedWork`.

When the flag is off, all existing failed and best-effort finals remain unchanged.

## 5. File-By-File Changes

### `src/interface/ui/correction-fork-flag.ts`

Mirror `src/interface/ui/intent-store-flag.ts:12`.

Export:

```ts
export function correctionForkV1Enabled(env: EnvLike = process.env): boolean
```

Default false. Accept only explicit on values: `1`, `true`, `on`, `yes`. Explicit off values return false. Errors return false.

### `src/interface/ui/blocked-state-flag.ts`

Mirror `src/interface/ui/intent-store-flag.ts:12`.

Export:

```ts
export function blockedStateV1Enabled(env: EnvLike = process.env): boolean
```

Same default-off behavior.

### `src/core/blocked.ts`

New pure helper module.

Export:

- `BlockedReasonCode`
- `BlockedRecord`
- `buildBlockedRecord(input): BlockedRecord | null`
- `isBlockedRecord(value): value is BlockedRecord`

Validation: all required strings must trim non-empty.

### `src/core/correction-fork.ts`

New pure helper module.

Export:

- `detectCorrectionFork({ text, hasPriorIntent }): CorrectionDetection`
- `intentDescendantIds(versions, parentId): Set<string>`
- `latestIntentVersionForSession(versions, sessionId): IntentVersion | null`
- `planCorrectionGoalInvalidation({ goals, versions, parentIntentId, newIntentId }): CorrectionInvalidationPlan`

`CorrectionInvalidationPlan` contains:

```ts
{
  oldBranchIntentIds: readonly string[];
  supersedeGoalIds: readonly string[];
  preserveGoalIds: readonly string[];
}
```

No filesystem access in this file.

### `src/core/intent-version.ts`

Verified anchors:

- `IntentVersion` at `src/core/intent-version.ts:13`
- `IntentStoreWriter` at `src/core/intent-version.ts:33`
- `buildIntentVersion` at `src/core/intent-version.ts:56`

Add optional reader capability without changing append semantics:

```ts
export interface IntentStoreReader {
  readAll(): Promise<readonly IntentVersion[]>;
}
```

Do not change `IntentVersion`.

### `src/infra/intent-store.ts`

Verified anchors:

- `createIntentStore` at `src/infra/intent-store.ts:22`
- `readIntentVersions` at `src/infra/intent-store.ts:39`

Return an object that still satisfies `IntentStoreWriter`, plus:

```ts
readAll(): Promise<readonly IntentVersion[]> {
  return readIntentVersions(cwd);
}
```

Existing callers that only use `append` must remain unchanged.

### `src/core/goal-todo.ts`

Verified anchors:

- `GoalState` at `src/core/goal-todo.ts:41`
- `Goal.intentVersionId` at `src/core/goal-todo.ts:172`
- `NON_TERMINAL_STATES` at `src/core/goal-todo.ts:789`
- `cascadeTerminate` at `src/core/goal-todo.ts:815`

Change:

```ts
export type GoalState =
  | 'parked'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'superseded';
```

Add optional fields to `Goal`:

```ts
blocked?: BlockedRecord;
supersededByIntentId?: string;
supersededReason?: string;
```

Update `capGoal` to preserve valid blocked/superseded metadata only.

Keep `NON_TERMINAL_STATES` as `parked`, `queued`, `running`.

Extend `CascadeTerminal` to include `superseded`, but do not use cascade supersession for correction unless ids are explicitly planned by `planCorrectionGoalInvalidation`.

### `src/infra/goal-store.ts`

Verified anchors:

- `GoalStore` at `src/infra/goal-store.ts:296`
- `setState` at `src/infra/goal-store.ts:316`
- `patchGoal` at `src/infra/goal-store.ts:325`
- `cancelGoalTree` at `src/infra/goal-store.ts:429`

Add method:

```ts
markSuperseded(
  ids: readonly string[],
  meta: { supersededByIntentId: string; reason: string }
): Promise<readonly string[]>;
```

Implementation requirements:

- Re-read current goals before writing.
- Only update goals currently in `parked`, `queued`, or `running`.
- Set `state: 'superseded'`, `supersededByIntentId`, `supersededReason`, `lastTouched`.
- Leave done/failed/blocked/superseded/unrelated goals unchanged.
- Return ids actually changed.

### `src/core/work-contract.ts`

Verified anchors:

- `RoadmapStatus` at `src/core/work-contract.ts:12`
- `WorkContract.intentVersionId` at `src/core/work-contract.ts:104`
- `VALID_STATUSES` at `src/core/work-contract.ts:138`
- `stampContractIntentVersion` at `src/core/work-contract.ts:541`

Change `RoadmapStatus` to include `superseded`.

Add optional fields to `WorkContract`:

```ts
blocked?: BlockedRecord;
supersededByIntentId?: string;
supersededReason?: string;
```

Update caps to preserve only valid blocked/superseded metadata.

Do not mark done roadmap items superseded.

### `src/core/types.ts`

Verified anchors:

- `OrchestrateDeps` at `src/core/types.ts:347`
- `CoreEvent.final` at `src/core/types.ts:1123`

Add dependency ports:

```ts
correctionFork?: {
  enabled: true;
  readIntentVersions(): Promise<readonly IntentVersion[]>;
  listGoals(): Promise<readonly Goal[]>;
  markGoalsSuperseded(
    ids: readonly string[],
    meta: { supersededByIntentId: string; reason: string }
  ): Promise<readonly string[]>;
};

blockedStateV1?: boolean;
```

Add to `CoreEvent.final`:

```ts
blocked?: BlockedRecord;
```

The optional field must never be populated unless `blockedStateV1 === true`.

### `src/core/orchestrate.ts`

Verified anchors:

- Intent version id minted at `src/core/orchestrate.ts:278`
- Intent store write at `src/core/orchestrate.ts:1101`
- Current `parentId: null` at `src/core/orchestrate.ts:1108`
- Contract intent stamp at `src/core/orchestrate.ts:1170`

Change flow:

1. Before the existing intent store write, initialize `parentIdForWrite = null`.
2. If `depsArg.correctionFork?.enabled === true`:
   - call `readIntentVersions()`;
   - find latest prior intent for `depsArg.session.id`;
   - run `detectCorrectionFork`;
   - if correction detected, set `parentIdForWrite = prior.id`;
   - compute `CorrectionInvalidationPlan` from current goals and versions.
3. Pass `parentId: parentIdForWrite` to `buildIntentVersion`.
4. Append once.
5. Only after append succeeds, call `markGoalsSuperseded` with planned ids.
6. Emit a notice summarizing fork id, parent id, superseded count, preserved count.
7. If any step is uncertain or throws, log/notice best-effort but do not invalidate.

Off guard: if `depsArg.correctionFork` is absent, the code path must be skipped entirely and current behavior preserved.

### `src/interface/menu.ts`

Verified anchors:

- Intent store imports/build deps area around existing `intentStoreOn`
- `buildDeps` currently mints `intentVersionId` at `src/interface/menu.ts:2372`

Add imports for both flags.

Composition:

```ts
const correctionForkOn =
  correctionForkV1Enabled(process.env) && intentStoreOn;

const blockedStateOn = blockedStateV1Enabled(process.env);
```

When building `OrchestrateDeps`:

- Pass `blockedStateV1: true` only when `blockedStateOn`.
- Pass `correctionFork` only when `correctionForkOn` and a goal store is available.
- Do not create or pass correction fork deps when off.
- Do not enable intent store because correction fork is on.

### `src/cli.ts`

Apply the same composition rule for one-shot CLI paths:

- `correctionForkOn = correctionForkV1Enabled(process.env) && intentStoreOn`
- Pass correction deps only when goal store and intent store reader exist.
- Pass `blockedStateV1` only when on.

### `src/core/accept-stage.ts`

Verified anchors:

- `CandidateResult.disposition` at `src/core/accept-stage.ts:35`
- Failing verification final at `src/core/accept-stage.ts:326`

When `blockedStateV1` is on:

- Repeated verification failure emits `success: false` with `blocked.code = 'verification_failed'`.
- `bestEffort` disposition emits `success: false` with `blocked`, not `success: true`.
- Preserve candidate output in `final.output`.
- Set `preservedWork` to a concise statement of the kept output/artifacts.

When off, keep current failed and best-effort shapes exactly.

### `src/core/work-call.ts`

Verified anchors:

- `runWorkCall` at `src/core/work-call.ts:574`
- Candidate gate call at `src/core/work-call.ts:1043`
- Best-effort loop exhaustion final at `src/core/work-call.ts:2216`
- Hard failure final at `src/core/work-call.ts:2241`

Add blocked final construction behind `blockedStateV1`.

Map existing terminal causes:

- auth/credential exhaustion -> `missing_authority`
- rate limit/quota -> `quota_exhausted`
- timeout/tool unavailable -> `environment_unavailable`
- unresolved high-risk approval -> `risk_requires_approval`
- verification/repair exhaustion -> `verification_failed`

Off guard: no blocked helper called and no final shape change when flag is off.

### `src/core/scheduler.ts`

Verified anchors:

- `GoalSpec` at `src/core/scheduler.ts:66`
- Dependency skip failure finals around `src/core/scheduler.ts:555`

Add optional scheduler dep `blockedStateV1?: boolean`.

When on, dependency skip finals include:

```ts
blocked: {
  code: 'dependency_blocked',
  reason: 'Prerequisite goal <id> did not complete.',
  nextAction: 'Resolve the prerequisite goal or revise the dependency.',
  preservedWork: 'No work was started for this goal; prior completed work is preserved.'
}
```

When off, current failed final remains unchanged.

### `src/interface/render.ts`

Verified anchors:

- Final handling at `src/interface/render.ts:884`
- Failed rendering at `src/interface/render.ts:907`
- Best-effort warning at `src/interface/render.ts:959`

When `final.blocked` exists:

- Render terminal label as `Blocked`, not `Failed`.
- Show reason, next action, preserved work.
- Do not show best-effort success wording for blocked finals.
- Off path is unchanged because `final.blocked` is absent.

## 6. New Tests

### `test/unit/correction-fork-flag.test.ts`

- `correctionForkV1Enabled defaults false`
- `correctionForkV1Enabled accepts explicit on values`
- `correctionForkV1Enabled treats explicit off values as false`
- `correctionForkV1Enabled returns false for hostile env access`

### `test/unit/blocked-state-flag.test.ts`

- `blockedStateV1Enabled defaults false`
- `blockedStateV1Enabled accepts explicit on values`
- `blockedStateV1Enabled treats explicit off values as false`
- `blockedStateV1Enabled returns false for hostile env access`

### `test/unit/correction-fork.test.ts`

- `detectCorrectionFork returns correction for slash correct with prior intent`
- `detectCorrectionFork returns none when no prior intent exists`
- `detectCorrectionFork returns none for uncertain actually phrasing`
- `intentDescendantIds includes descendants and excludes siblings`
- `planCorrectionGoalInvalidation supersedes only live old-branch goals`
- `planCorrectionGoalInvalidation preserves done failed blocked superseded and unrelated goals`
- `planCorrectionGoalInvalidation preserves goals without provenance`

### `test/unit/orchestrate-correction-fork.test.ts`

- `correction fork on writes child IntentVersion with parentId set`
- `correction fork on supersedes descendant goals and leaves siblings untouched`
- `correction fork off writes normal root intent and changes no goal state`
- `intent store off makes correction fork inert`
- `uncertain correction performs no invalidation`

### `test/unit/goal-store.test.ts`

Add cases:

- `markSuperseded moves live goals to superseded with metadata`
- `markSuperseded preserves done failed blocked superseded and unrelated goals`
- `capGoal drops malformed blocked and superseded metadata`

### `test/unit/work-contract.test.ts`

Add cases:

- `capContract preserves blocked record`
- `capContract drops incomplete blocked record`
- `capContract preserves superseded metadata`
- `capRoadmapItem accepts superseded status`

### `test/unit/accept-stage.test.ts`

Add cases:

- `blocked flag converts repeated verification failure into blocked final`
- `blocked flag converts bestEffort into blocked final preserving output`
- `blocked flag off preserves existing failed final`
- `blocked flag off preserves existing bestEffort success`

### `test/unit/work-call-blocked-state.test.ts`

- `auth exhaustion emits missing_authority blocked final when flag on`
- `timeout emits environment_unavailable blocked final when flag on`
- `blocked flag off auth and timeout finals are unchanged`

### `test/unit/scheduler.test.ts`

Add case:

- `blocked flag annotates dependency skip final with blocked prerequisite reason`

## 7. Verification Commands

Run:

```powershell
npm run typecheck
node --import ./test/register.mjs --test test/unit/correction-fork-flag.test.ts
node --import ./test/register.mjs --test test/unit/blocked-state-flag.test.ts
node --import ./test/register.mjs --test test/unit/correction-fork.test.ts
node --import ./test/register.mjs --test test/unit/orchestrate-correction-fork.test.ts
node --import ./test/register.mjs --test test/unit/goal-store.test.ts
node --import ./test/register.mjs --test test/unit/work-contract.test.ts
node --import ./test/register.mjs --test test/unit/accept-stage.test.ts
node --import ./test/register.mjs --test test/unit/work-call-blocked-state.test.ts
node --import ./test/register.mjs --test test/unit/scheduler.test.ts
node --import ./test/register.mjs --test test/unit/orchestrate-intent-store.test.ts
```

Success criteria:

- TypeScript passes with `tsc --noEmit`.
- All targeted tests pass.
- Full-suite comparison against main shows zero new failing test names. Count is not enough because main has known flaky/Windows failures.

## 8. Ordered Implementation Checklist

1. Add the two flag helpers and flag unit tests.
2. Add `BlockedRecord` helper module and tests.
3. Add correction fork pure helper module and tests.
4. Extend `IntentStoreReader` and `createIntentStore().readAll`.
5. Extend goal statuses and metadata caps.
6. Add `GoalStore.markSuperseded`.
7. Extend work contract statuses and metadata caps.
8. Extend core types for optional correction fork deps and optional blocked final record.
9. Wire correction fork in `orchestrate.ts`, guarded by `depsArg.correctionFork`.
10. Wire correction deps in `menu.ts` and `cli.ts`, guarded by both correction and intent-store flags.
11. Wire blocked finals in `accept-stage.ts` and `work-call.ts`, guarded by `blockedStateV1`.
12. Wire scheduler blocked dependency annotation, guarded by `blockedStateV1`.
13. Update renderer to display `final.blocked`.
14. Add orchestration and blocked-state tests.
15. Run verification commands.
16. Run broader suite and compare failing test names to main.

## 9. Risks And Safe Defaults

- Highest risk: wrongly invalidating user work. Default to preserve. Only supersede live work with explicit old-branch provenance.
- If intent ancestry cannot be read, do not fork and do not invalidate.
- If the new child intent append fails, do not invalidate.
- If correction detection is uncertain, treat as a fresh intent.
- If a goal/work item is done, failed, blocked, superseded, reviewed, or lacks reliable provenance, preserve it.
- If `MYSHELL_INTENT_STORE_V1` is off, correction fork is inert even when `MYSHELL_CORRECTION_FORK_V1` is on.
- If `MYSHELL_BLOCKED_STATE_V1` is off, do not emit or persist blocked state anywhere.
- Do not refactor unrelated state machines, render paths, or planner behavior.
```