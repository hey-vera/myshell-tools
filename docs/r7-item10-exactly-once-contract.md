# Item 10 contract - exactly-once execution and resume

Status: delegation-ready implementation contract, grounded at repository head `893e8db` on 2026-07-02.

This document is controlling for Round-7 Item 10. Item 17 owns terminal completion truth through `CompletionResultV1`; this contract consumes that type and must not redefine it. Item 11 owns the canonical event log; this contract persists work-unit state only through that substrate. Item 12 owns the provider generation; this contract records and consumes its generation ids, Retry-After facts, and cooldown facts rather than inventing provider state.

At document creation the worktree was clean before this file was added.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_EXACTLY_ONCE_V1` is explicitly enabled, every mutating foreground work attempt is represented by one durable work unit with an idempotency key, compare-and-swap state transitions, provider-generation evidence, mutation evidence, and a terminal replay decision. Crash/resume never blindly re-runs an opaque provider CLI after it may have mutated the repository.

The required outcome is narrow:

- a durable work-unit state machine: `parked -> claimed -> provider-started -> mutation-observed -> verifying -> settled`;
- every state transition is persisted as an Item 11 canonical `work-unit.state` event, never as chat prose, process memory, or provider-native session memory;
- idempotency and CAS decide whether a work unit may be claimed, resumed, verified, repaired, or left parked;
- after an opaque mutation boundary, replay of the original provider action is forbidden unless `CompletionResultV1.replayPolicy` and work-unit evidence make an idempotent replay explicit;
- Retry-After and provider cooldown facts survive crash/resume through Item 12 provider generation evidence;
- Item 13 receives a durable work-attempt settlement input before it can fan out goal execution.

This item does **not**:

- redefine `CompletionResultV1`, `CompletionReplayPolicy`, or goal settlement;
- implement the Item 11 canonical event log or snapshots;
- implement the Item 12 provider generation store;
- implement the Item 13 goal DAG scheduler;
- make native provider sessions a continuity authority;
- promise OS-level transactional rollback of provider CLI mutations;
- retry failed provider subprocesses after workspace mutation just because the last process crashed;
- make exactly-once default-on before the dark eval and authority guards pass.

The current system has useful state fragments but no durable execution authority. Item 10 binds them into one replay rule: before opaque mutation, replay can be safe; after opaque mutation, verify first and let `CompletionResultV1` decide whether the work is already settled, repair-only, idempotently replayable, needs user input, or unknown.

## 2. Current-state evidence and invariants

All citations below are current at `893e8db`; workers must re-run line numbering before editing and record drift rather than silently relying on stale ranges.

- `src/core/native-session.ts` is explicitly opt-in and says default continuity is compact history replay, while native provider sessions skip replay only for the same provider at `src/core/native-session.ts:4-20`.
- Native session planning is pure metadata: Claude uses the conversation id, Codex resumes only after a captured id, and no plan is returned when disabled or no conversation id exists at `src/core/native-session.ts:81-114`.
- `SessionEntry` can persist provider/model/cost metadata and a provider-assigned `sessionId`, but it is transcript shape rather than a work-unit authority at `src/core/types.ts:126-143`.
- `SessionWriter` only appends `SessionEntry` with no canonical event id, CAS, or work-unit transition API at `src/core/types.ts:163-165`.
- `OrchestrateDeps.cooldownUntil` is a receipt-facing in-memory map for rate-limit cooldown status, not durable retry evidence, at `src/core/types.ts:382-387`.
- `OrchestrateDeps.nativeSession` carries provider native-session plans that let orchestrate skip replayed history for matching providers, but it is absent for one-shot runs and is not exactly-once state at `src/core/types.ts:523-533`.
- `CoreEvent.final` carries success, output, session id, attempts, cancellation, error category, provider, receipt, account id, and goal id, but no versioned work-unit state or completion result authority at `src/core/types.ts:1281-1345`.
- Provider requests have `sessionId` and `resume` ports for native provider continuity at `src/providers/port.ts:35-54`; provider terminal events can surface a provider-assigned `sessionId` at `src/providers/port.ts:129-134`. Those ids are acceleration metadata, not replay authority.
- `work-state.ts` already rejects memory/prose as authority: work-state is derived only from persisted `workTrace` at `src/core/work-state.ts:6-10`, and "done" requires evidence rather than silence at `src/core/work-state.ts:12-23`.
- `WorkStateSnapshot` separates `verifiedDone` from `claimedNext` at `src/core/work-state.ts:43-61`, and reconstruction remains conservative at `src/core/work-state.ts:138-198`.
- `renderWorkStateBlock(...)` says "none yet" without evidence and labels next as model-stated, not verified, at `src/core/work-state.ts:215-242`.
- `cooldown.ts` is pure per-conversation rate-limit memory; comments explicitly name the gap that the next turn forgets throttle without that memory at `src/core/cooldown.ts:1-11`.
- Provider cooldown currently uses a fixed five-minute expiry at `src/core/cooldown.ts:25-33` and filters provider preference without ever returning an empty list at `src/core/cooldown.ts:35-60`.
- `scheduler.ts` bounds multi-goal concurrency and requeues rate-limited goals instead of hammering providers at `src/core/scheduler.ts:16-36`, but it is not durable exactly-once state.
- Scheduler cancellation fans out to child controllers at `src/core/scheduler.ts:25-28`, while parked-goal revalidation is explicitly owned by the caller at `src/core/scheduler.ts:62-65`.
- `planSchedule(...)` is pure queue/running partitioning at `src/core/scheduler.ts:169-195`; rate-limit requeue backoff is process-local bookkeeping at `src/core/scheduler.ts:540-559`.
- Scheduler treats a `final` as a phase boundary and unlocks/blocks dependents from `ev.success` at `src/core/scheduler.ts:782-813`; Item 13 must later consume durable Item 10/17 settlement instead.

Baseline gap:

| surface | current source | Item-10 requirement |
|---|---|---|
| execution attempt | provider stream + `CoreEvent.final` | durable work-unit state events |
| resume decision | transcript/workTrace/native session hints | CAS state + `CompletionResultV1.replayPolicy` |
| mutation boundary | inferred from provider run/final | explicit state transition and mutation evidence |
| Retry-After/cooldown | process maps and final error category | Item 12 generation facts referenced from canonical events |
| native session | `sessionId/resume` acceleration | never sufficient for replay safety |
| goals | scheduler `ev.success` | durable work-unit settlement for Item 13 |

## 3. Shared typed contract

Slice 10a must export these names from `src/core/exactly-once.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them. This module imports Item 11, Item 12, and Item 17 types by reference when those modules exist; it must not copy their schemas.

```ts
export type ExactlyOnceVersion = 1;

export type WorkUnitState =
  | 'parked'
  | 'claimed'
  | 'provider-started'
  | 'mutation-observed'
  | 'verifying'
  | 'settled';

export type WorkUnitMutationMode =
  | 'read-only'
  | 'workspace-write'
  | 'full-access'
  | 'unknown';

export type WorkUnitReplayClass =
  | 'replay-safe'
  | 'replay-forbidden'
  | 'verify-only'
  | 'repair-only'
  | 'already-settled'
  | 'needs-user'
  | 'unknown';

export type WorkUnitTransitionReason =
  | 'planned'
  | 'claimed'
  | 'provider-stream-opening'
  | 'provider-first-event'
  | 'workspace-diff-observed'
  | 'opaque-mutation-boundary'
  | 'verify-started'
  | 'completion-result'
  | 'retry-after'
  | 'cooldown'
  | 'resume-reconstruction'
  | 'cancelled'
  | 'failed-closed';

export interface WorkUnitIdempotencyKeyV1 {
  readonly version: 1;
  readonly key: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly objectiveHash: string;
  readonly doneConditionHash: string | null;
  readonly mutationScopeHash: string;
}

export interface WorkUnitProviderEvidenceV1 {
  readonly provider: import('../providers/port.js').ProviderId;
  readonly model: string;
  readonly providerGenerationId: string;
  readonly providerGenerationEventId?: string;
  readonly nativeSessionId?: string;
  readonly nativeResume?: boolean;
  readonly openedAt?: string;
  readonly firstEventAt?: string;
  readonly terminalEventAt?: string;
}

export interface WorkUnitCooldownEvidenceV1 {
  readonly provider: import('../providers/port.js').ProviderId;
  readonly providerGenerationId: string;
  readonly cooldownSourceEventId: string;
  readonly reason: 'rate-limit' | 'retry-after' | 'correlated-429';
  readonly observedAtMs: number;
  readonly untilMs: number;
  readonly retryAfterMs?: number;
}

export interface WorkUnitMutationEvidenceV1 {
  readonly mode: WorkUnitMutationMode;
  readonly opaqueSubprocessStarted: boolean;
  readonly firstMutationPossibleAt: string | null;
  readonly changedPaths: readonly string[];
  readonly diffHash?: string;
  readonly detection: 'none' | 'provider-event' | 'worktree-diff' | 'tool-event' | 'completion-result';
}

export interface WorkUnitCasV1 {
  readonly expectedPriorEventId: string | null;
  readonly expectedState: WorkUnitState | null;
  readonly claimToken?: string;
}

export interface WorkUnitStateEventPayloadV1 {
  readonly version: 1;
  readonly workUnitId: string;
  readonly turnId: string;
  readonly idempotency: WorkUnitIdempotencyKeyV1;
  readonly state: WorkUnitState;
  readonly reason: WorkUnitTransitionReason;
  readonly priorWorkUnitEventId: string | null;
  readonly claimToken?: string;
  readonly provider?: WorkUnitProviderEvidenceV1;
  readonly mutation: WorkUnitMutationEvidenceV1;
  readonly cooldowns: readonly WorkUnitCooldownEvidenceV1[];
  readonly completionResultId?: string;
  readonly completionResultEventId?: string;
  readonly replayClass: WorkUnitReplayClass;
  readonly replayReason: string;
}
```

Caps are part of the contract: ids match `/^[a-z][a-z0-9_-]{0,63}$/`; idempotency key matches `/^wu_[a-z0-9_-]{16,96}$/`; replay reason is capped at 180 characters; at most 64 changed paths; path strings are repo-relative POSIX paths; cooldown list is capped at 8; provider evidence records only ids/timestamps/model strings, never raw provider transcript. Hashes use stable canonical JSON. Unknown enum values are rejected. Extra keys are ignored only by the parser; constructors must not accept unknown fields silently.

Work-unit state is persisted through Item 11 as:

- `work-unit.planned` event for the idempotency key and parked work unit;
- `work-unit.state` event for every state transition;
- optional `provider.observation` event for provider generation/cooldown evidence;
- `completion.result` event from Item 17 for terminal truth.

The canonical event log is not redefined here. Item 10 callers receive and return Item 11 canonical event refs.

## 4. Durable state machine and CAS rules

Legal transitions:

| from | to | CAS requirement | replay class after commit |
|---|---|---|---|
| none | parked | no existing idempotency key | `replay-safe` |
| parked | claimed | expected latest event id + unexpired claim token | `replay-safe` |
| claimed | provider-started | expected claimed event + selected provider generation id | depends on mutation mode |
| provider-started | mutation-observed | expected provider-started event + mutation evidence | `replay-forbidden` unless read-only |
| mutation-observed | verifying | expected mutation event + verification reservation | `verify-only` |
| verifying | settled | expected verifying event + `CompletionResultV1` event | from completion replay policy |
| claimed | parked | claim abandoned before provider start | `replay-safe` |
| provider-started | verifying | no mutation observed but mutation cannot be disproven | `verify-only` |
| any non-settled | settled | cancellation/blocked/failed completion result | from completion replay policy |

Forbidden transitions:

- `parked -> provider-started` without `claimed`;
- `claimed -> mutation-observed` without `provider-started`;
- `mutation-observed -> provider-started` replay of the original provider action;
- any transition out of `settled`;
- duplicate terminal settlement for the same work-unit id;
- claiming a work unit when the latest canonical event for its idempotency key is not the expected prior event;
- using provider-native `sessionId/resume` as proof that a transition happened.

CAS is over the Item 11 canonical event chain plus the latest event for the work-unit id. A transition append succeeds only when:

1. the canonical log prior event matches the expected log head;
2. the latest work-unit event id equals `expectedPriorEventId`;
3. the current work-unit state equals `expectedState`;
4. claim token matches for claimed-or-later transitions;
5. idempotency key payload hash matches the original planned event.

CAS failure is not retried blindly. The worker reloads the canonical log, reconstructs the latest work-unit state, and applies the replay table below.

## 5. Idempotency and replay safety

The idempotency key is deterministic for the authorized unit of work, not for one provider process. It is derived from conversation id, turn id, accepted objective, done condition, allowed mutation scope, and route/execution plan identity. It excludes timestamps, provider-native session ids, and raw prompt text.

Replay classes:

- `replay-safe`: no provider stream opened, or the provider request was read-only and no workspace mutation can occur.
- `replay-forbidden`: a mutation-capable opaque subprocess started and completion has not authorized idempotent replay.
- `verify-only`: workspace mutation may have happened; run inspection/verification only.
- `repair-only`: `CompletionResultV1.replayPolicy.replay='repair-only'`; do not re-run original provider attempt.
- `already-settled`: `CompletionResultV1.replayPolicy.replay='forbidden-already-settled'`; do not mutate.
- `needs-user`: completion or work-unit state requires user decision before any mutation.
- `unknown`: evidence is corrupt/missing; fail closed.

Opaque mutation boundary:

- A provider stream opened with `workspace-write`, `full-access`, or unknown sandbox is an opaque subprocess mutation risk.
- If the process crashes after this boundary, Item 10 must not re-run the original provider call.
- If no diff is observed but the boundary was crossed, resume enters `verify-only`, not `replay-safe`.
- Read-only provider calls may remain `replay-safe` only when the request sandbox and provider adapter prove read-only execution.

`CompletionResultV1` is terminal truth:

- `forbidden-already-settled` -> `already-settled`;
- `allowed-idempotent` -> `replay-safe` only when the work-unit idempotency key and mutation scope match;
- `repair-only` -> `repair-only`;
- `needs-user` -> `needs-user`;
- `unknown` or missing completion after mutation -> `unknown` or `verify-only`, never original replay.

Item 10 may use worktree diff/test evidence to decide what to verify. It may not use final prose, native provider memory, or the presence of a `sessionId` to declare replay safety.

## 6. Retry-After and provider cooldown durability

Retry-After and cooldown are execution evidence, not UI hints.

Rules:

1. Before a rate-limit retry or fallback route is planned, the current Item 12 provider generation must contain the observed cooldown/Retry-After fact.
2. The work-unit state event records `providerGenerationId` and a cooldown source event id.
3. Crash/resume reconstructs cooling providers from the canonical event log plus the latest provider generation facts, not from the old in-memory `Map`.
4. A provider still cooling at resume cannot be selected for replay or repair unless no other provider is routable and the policy returns `needs-user` or wait.
5. Cooldown expiry is itself a provider generation change; work-unit resume must compare the generation used at provider start with the current generation before opening any repair stream.
6. Retry-After duration is preserved exactly from the provider observation. Fixed fallback cooldown may remain five minutes only when no Retry-After was observed.
7. Native session resume never overrides a cooldown fact.

## 7. Shared rollout, fixture, and worktree rules

The single runtime flag is `MYSHELL_EXACTLY_ONCE_V1`; the config mirror is `experimentalExactlyOnceV1?: boolean`. Both are default false. Before dark production composition, slices are pure/test-only or injected through explicit deps.

Flag-off behavior must remain byte-for-byte compatible for finals, session transcript append, provider calls, scheduler events, cooldown filtering, and native-session planning. Additive canonical events may exist only when Item 11 and the Item 10 flag are enabled.

Rollback:

```bash
unset MYSHELL_EXACTLY_ONCE_V1
# or set experimentalExactlyOnceV1:false
```

Then restart the process and confirm no new work-unit canonical events are appended. Do not delete existing canonical events; they are additive audit data and old readers ignore them.

Every worker slice must begin with:

```bash
git status --short
git diff --name-only
npm run typecheck
```

Record pre-existing paths and do not edit them. A slice is rejected if `git diff --name-only` contains a path outside that slice's maximum set. Injected crash means a dependency throws at the named boundary; do not use `process.exit`, kill the runner, or add sleeps.

## 8. Eval and acceptance gate

Default-on is blocked until a dark eval artifact passes on the exact merge candidate.

Minimum eval set:

- 20 no-mutation resume fixtures: crash before claim, after claim, before provider open, and read-only provider open;
- 30 opaque-mutation fixtures: crash after provider open, after first event, after partial diff, during verification, during completion append;
- 20 cooldown fixtures: Retry-After, fixed cooldown, all providers cooling, expiry, provider generation change before repair;
- 20 completion replay-policy fixtures: already settled, idempotent allowed, repair-only, needs-user, unknown;
- 10 native-session fixtures: Claude, Codex captured id, provider switch, invalidated session, cooldown with native session;
- 10 scheduler/goal fixtures: dependency blocked, rate-limit requeue, cancellation, fan-out gate.

Hard gates:

- zero original-provider replays after opaque mutation boundary unless completion explicitly says `allowed-idempotent` and the idempotency key matches;
- zero duplicate `settled` events per work unit;
- zero state transitions outside the legal table;
- 100% crash fixtures reconstruct from canonical events without transcript prose;
- 100% cooldown fixtures preserve Retry-After/cooldown evidence across restart;
- flag-off snapshots remain unchanged;
- p95 pure reconstruction and replay decision below 5 ms on 1,000-event fake logs;
- dark runtime overhead before provider open below 25 ms p95 on fake store fixtures.

Promotion requires artifact path, hash, git head, host info, exact commands, fixture counts, and rollback proof. Default remains off in this contract.

## 9. Named upstream and downstream contract edges

### Edge `17->10` - completion replay policy into exactly-once resume

Producer: Item 17 `CompletionResultV1.replayPolicy`.

Consumer: Item 10 work-unit replay classifier and settlement transition.

Rule: after mutation risk, Item 10 may mark original replay forbidden, already settled, repair-only, idempotently allowed, needs-user, or unknown only from `CompletionResultV1.replayPolicy` plus durable work-unit state. It must not infer replay safety from final prose, tests alone, or native session ids.

### Edge `11->10` - canonical log as work-unit state substrate

Producer: Item 11 canonical event log and snapshots.

Consumer: Item 10 state machine.

Rule: every `parked`, `claimed`, `provider-started`, `mutation-observed`, `verifying`, and `settled` transition is a canonical `work-unit.state` event with CAS. Process memory, `SessionEntry`, `workTrace`, and provider-native sessions are compatibility or acceleration surfaces only.

### Edge `12->10` - provider generation and cooldown evidence into retry safety

Producer: Item 12 provider generation.

Consumer: Item 10 provider-start, retry, repair, and resume decisions.

Rule: Item 10 records the provider generation used to start work and consumes current generation/cooldown facts before any retry or repair stream opens. A stale generation, active Retry-After, or cooling provider can park or ask; it cannot be ignored.

### Edge `10->13` - durable work attempts into goal scheduling

Producer: Item 10 work-unit state and settlement.

Consumer: Item 13 goal stewardship and multi-goal DAG.

Rule: Item 13 may enqueue or park from intent, but it may launch/fan out mutating goal work only through a current work-unit claim. Dependencies unlock from durable settled work units plus `CompletionResultV1.goalSettlement`, not from scheduler `ev.success` alone.

## 10. Ordered slices

### P1-10a - `EXACTLY-ONCE-DOMAIN`

**One invariant:** work-unit payloads are complete, capped, parseable, and cannot encode illegal replay classes.

**Maximum file set:** `src/core/exactly-once.ts` (new), `test/unit/exactly-once.test.ts` (new).

**Behavioral diff:** add shared types, parsers, caps, state-order helpers, replay-class derivation from state plus imported completion replay policy shape.

**Named tests:** `parses complete work unit state payload`, `rejects unknown state replay class and reason`, `caps paths cooldowns and reasons`, `completion replay policy maps to replay class`, `opaque mutation without completion is not replay safe`.

**Verification receipt:** `npm run typecheck && npm run lint -- src/core/exactly-once.ts test/unit/exactly-once.test.ts && npx vitest run test/unit/exactly-once.test.ts`.

### P1-10b - `IDEMPOTENCY-KEYS`

**One invariant:** the same authorized work produces the same key, while changed objective/done/scope produces a different key.

**Maximum file set:** `src/core/exactly-once.ts`, `test/unit/exactly-once.test.ts`.

**Behavioral diff:** add canonical idempotency-key builder and hash verifier.

**Named tests:** `stable key excludes timestamp provider session and raw prompt`, `changed mutation scope changes key`, `malformed key fails closed`.

**Verification receipt:** targeted tests plus a table of input fields included/excluded.

### P1-10c - `STATE-TRANSITION-TABLE`

**One invariant:** only the legal state transitions in section 4 can be constructed.

**Maximum file set:** `src/core/exactly-once.ts`, `test/unit/exactly-once-state.test.ts` (new).

**Behavioral diff:** add pure transition validator and constructor helpers for planned/claimed/provider-started/mutation/verifying/settled.

**Named tests:** `planned to parked is genesis only`, `claimed requires parked`, `settled has no outgoing transition`, `mutation cannot precede provider started`.

**Verification receipt:** transition matrix with every allowed and forbidden edge asserted.

### P1-10d - `CAS-PROTOCOL`

**One invariant:** a state append is accepted only against the expected latest work-unit event and canonical log head.

**Maximum file set:** `src/core/exactly-once.ts`, `test/unit/exactly-once-cas.test.ts` (new).

**Behavioral diff:** add pure CAS request/decision helpers over Item 11 event refs.

**Named tests:** `stale prior work-unit event rejects`, `wrong expected state rejects`, `claim token mismatch rejects`, `canonical head mismatch reloads`.

**Verification receipt:** CAS fixture table with accepted/rejected reason codes.

### P1-10e - `CANONICAL-EVENT-CONSTRUCTORS`

**One invariant:** Item 10 writes only Item 11 `work-unit.planned` and `work-unit.state` payloads.

**Maximum file set:** `src/core/exactly-once.ts`, `src/core/types.ts`, `test/unit/exactly-once-canonical-event.test.ts` (new).

**Behavioral diff:** add typed constructor seams that return Item 11 payloads/refs without adding storage.

**Named tests:** `planned event contains idempotency key`, `state event references prior work-unit event`, `completion event id is reference only`.

**Verification receipt:** event-kind table proving no new canonical schema is redefined.

### P1-10f - `MUTATION-BOUNDARY-CLASSIFIER`

**One invariant:** mutation-capable provider start is never classified as replay-safe after crash.

**Maximum file set:** `src/core/exactly-once.ts`, `test/unit/exactly-once-mutation.test.ts` (new).

**Behavioral diff:** add mutation-mode and opaque-boundary classifier from sandbox/request/provider evidence.

**Named tests:** `workspace-write provider start becomes opaque risk`, `read-only without diff remains replay safe`, `unknown sandbox is forbidden`, `diff observation moves to mutation observed`.

**Verification receipt:** replay-class table for read-only/workspace-write/full-access/unknown.

### P1-10g - `COMPLETION-REPLAY-EDGE`

**One invariant:** `CompletionResultV1.replayPolicy` is the only terminal replay authority.

**Maximum file set:** `src/core/exactly-once.ts`, `test/unit/exactly-once-completion-edge.test.ts` (new).

**Behavioral diff:** add completion-to-settlement mapper by imported type reference.

**Named tests:** `forbidden already settled maps already settled`, `repair only forbids original replay`, `allowed idempotent requires matching key`, `unknown fails closed`.

**Verification receipt:** explicit `17->10` matrix.

### P1-10h - `COOLDOWN-EVIDENCE-EDGE`

**One invariant:** Retry-After/cooldown evidence is copied from Item 12 provider generation facts, not recomputed from prose.

**Maximum file set:** `src/core/exactly-once.ts`, `test/unit/exactly-once-cooldown-edge.test.ts` (new).

**Behavioral diff:** add cooldown evidence selector from imported provider generation shape.

**Named tests:** `retry after duration is preserved`, `cooling provider blocks replay launch`, `expired generation removes cooldown`, `native session cannot override cooldown`.

**Verification receipt:** explicit `12->10` matrix.

### P1-10i - `RESUME-DECISION-PURE`

**One invariant:** resume decision is a pure function of canonical work-unit events, completion result, and provider generation.

**Maximum file set:** `src/core/exactly-once.ts`, `test/unit/exactly-once-resume.test.ts` (new).

**Behavioral diff:** add `decideWorkUnitResume(...)` with outcomes `resume-claim`, `verify-only`, `repair-only`, `already-settled`, `wait-cooldown`, `needs-user`, `blocked-unknown`.

**Named tests:** `parked resumes claim`, `claimed stale token parks`, `provider started workspace write verifies only`, `settled returns already settled`.

**Verification receipt:** before/after crash-point table.

### P1-10j - `WORKTREE-MUTATION-OBSERVATION`

**One invariant:** observed workspace changes are recorded as evidence but never treated as completion.

**Maximum file set:** `src/core/exactly-once.ts`, `src/core/types.ts`, `test/unit/exactly-once-mutation.test.ts`.

**Behavioral diff:** add optional injected worktree observation port type and pure evidence builder over changed paths/diff hash.

**Named tests:** `empty diff after opaque boundary remains verify only`, `changed path records mutation observed`, `diff observer throw fails closed`.

**Verification receipt:** fixture table for no diff, diff, observer unavailable, observer throws.

### P1-10k - `DURABLE-CONTEXT-SEAM`

**One invariant:** Item 10 can persist only through Item 11 append-CAS store seams.

**Maximum file set:** `src/core/types.ts`, `src/core/exactly-once.ts`, `test/unit/exactly-once-durable-context.test.ts` (new).

**Behavioral diff:** add optional `exactlyOnceStore`/append-CAS dependency types without runtime wiring.

**Named tests:** `append failure prevents provider start`, `duplicate planned event rejected`, `reconstruction ignores transcript prose`.

**Verification receipt:** explicit `11->10` evidence table.

### P1-10l - `ORCHESTRATE-PARKED-AND-CLAIMED`

**One invariant:** under injected flag, mutating foreground work parks and claims before provider planning can open a stream.

**Maximum file set:** `src/core/orchestrate.ts`, `src/core/types.ts`, `test/unit/orchestrate-exactly-once.test.ts` (new).

**Behavioral diff:** append planned/claimed events before mutating work. Flag off snapshots remain unchanged.

**Named tests:** `flag off final stream snapshot unchanged`, `flag on parks then claims before provider call`, `claim CAS failure yields zero provider calls`.

**Verification receipt:** event/provider-call ordering trace.

### P1-10m - `PROVIDER-STARTED-BEFORE-STREAM`

**One invariant:** `provider-started` is durable before `provider.run(...)` is invoked.

**Maximum file set:** `src/core/orchestrate.ts`, `src/core/types.ts`, `test/unit/orchestrate-exactly-once.test.ts`.

**Behavioral diff:** insert provider-started CAS append immediately before provider stream open, carrying provider generation id and native-session metadata.

**Named tests:** `provider started event precedes stream open`, `append failure prevents stream open`, `provider generation id recorded`.

**Verification receipt:** fake provider asserts no run until append resolves.

### P1-10n - `MUTATION-OBSERVED-WIRING`

**One invariant:** first mutation evidence after provider start moves the work unit to `mutation-observed`.

**Maximum file set:** `src/core/orchestrate.ts`, `src/core/exactly-once.ts`, `test/unit/orchestrate-exactly-once.test.ts`.

**Behavioral diff:** append mutation-observed after first provider event for mutating sandbox or after diff observation, whichever is earlier.

**Named tests:** `first provider event on workspace write records opaque mutation`, `read only text event does not record mutation`, `diff records changed paths`.

**Verification receipt:** stream timeline with state events.

### P1-10o - `VERIFYING-AND-SETTLED-WIRING`

**One invariant:** verification and completion settlement are durable before final replay state is exposed.

**Maximum file set:** `src/core/orchestrate.ts`, `src/core/accept-stage.ts`, `src/core/types.ts`, `test/unit/orchestrate-exactly-once.test.ts`, `test/unit/accept-stage.test.ts`.

**Behavioral diff:** append verifying before accept-stage verification and settled after `CompletionResultV1` exists.

**Named tests:** `verifying precedes completion result`, `settled references completion event`, `settled append failure fails closed`.

**Verification receipt:** completion/event ordering trace.

### P1-10p - `CRASH-RESUME-ENGINE`

**One invariant:** crash recovery reconstructs the latest work-unit state from canonical events and chooses a replay class without provider memory.

**Maximum file set:** `src/core/exactly-once-resume.ts` (new), `src/core/exactly-once.ts`, `test/unit/exactly-once-resume.test.ts`.

**Behavioral diff:** add reconstruction helper over Item 11 event list plus completion/provider-generation refs.

**Named tests:** `crash after claimed reclaims safely`, `crash after provider started verifies only`, `crash after settled does not replay`, `corrupt event blocks unknown`.

**Verification receipt:** 1,000-event reconstruction p95 and crash-point table.

### P1-10q - `NATIVE-SESSION-NON-AUTHORITY`

**One invariant:** native sessions may accelerate repair/resume prompts but cannot prove replay safety.

**Maximum file set:** `src/core/native-session.ts`, `src/core/exactly-once.ts`, `test/unit/native-session.test.ts`, `test/unit/exactly-once-resume.test.ts`.

**Behavioral diff:** add helper that filters native-session plans through work-unit replay decision and provider generation.

**Named tests:** `matching native session does not allow original replay`, `provider switch omits native resume`, `invalidated session is ignored`.

**Verification receipt:** native-session matrix for Claude/Codex/provider switch.

### P1-10r - `SCHEDULER-GOAL-SEAM`

**One invariant:** scheduler fan-out can start mutating work only through a claimed work unit.

**Maximum file set:** `src/core/scheduler.ts`, `src/core/types.ts`, `test/unit/scheduler.test.ts`, `test/unit/exactly-once-goal-seam.test.ts` (new).

**Behavioral diff:** add optional goal-facing work-unit launch seam; flag off scheduler snapshots unchanged.

**Named tests:** `goal launch requires claim when seam enabled`, `claim failure parks goal`, `rate-limit requeue records cooldown evidence`.

**Verification receipt:** explicit `10->13` matrix.

### P1-10s - `COOLDOWN-RESUME-WIRING`

**One invariant:** resume/repair route checks current provider generation and cooldown before opening a stream.

**Maximum file set:** `src/core/orchestrate.ts`, `src/core/exactly-once.ts`, `test/unit/orchestrate-exactly-once.test.ts`.

**Behavioral diff:** compare provider-start generation with current generation before repair/replay. Park or ask on active cooldown.

**Named tests:** `cooling provider parks instead of replaying`, `new generation reroutes repair once`, `all providers cooling returns wait decision`.

**Verification receipt:** current-vs-planned generation table.

### P1-10t - `CANCELLATION-AND-ABANDON`

**One invariant:** cancellation before provider start returns to parked; cancellation after opaque start becomes verify-only or settled-cancelled.

**Maximum file set:** `src/core/orchestrate.ts`, `src/core/exactly-once.ts`, `test/unit/orchestrate-exactly-once.test.ts`.

**Behavioral diff:** append abandoned/parked or settled-cancelled transitions according to boundary crossed.

**Named tests:** `cancel before provider start is replay safe`, `cancel after provider start is verify only`, `abort append failure fails closed`.

**Verification receipt:** cancellation timing table.

### P1-10u - `DARK-FLAG-COMPOSITION`

**One invariant:** one explicit default-off flag composes the exactly-once machinery across interactive, one-shot, and REPL entry points.

**Maximum file set:** `src/infra/config.ts`, `src/interface/ui/exactly-once-flag.ts` (new), `src/interface/menu.ts`, `src/interface/run.ts`, `src/interface/repl.ts`, `src/cli.ts`, `test/unit/exactly-once-flag.test.ts` (new), `test/unit/menu-flow.test.ts`, `test/unit/run.test.ts`, `test/unit/repl.test.ts`.

**Behavioral diff:** parse `MYSHELL_EXACTLY_ONCE_V1`, pass exactly-once deps only when explicit env/config true, keep old paths when absent/false/garbage.

**Named tests:** `flag defaults false`, `explicit env or config true enables`, `flag off snapshots match legacy`, `unset flag rollback restores legacy`.

**Verification receipt:** flag-off snapshot hashes and flag-on event counts by entry point.

### P1-10v - `AUTHORITY-GUARDS`

**One invariant:** enabled mutating provider streams cannot bypass parked/claimed/provider-started events.

**Maximum file set:** `test/arch/exactly-once-authority-guard.test.ts` (new), `test/unit/orchestrate-exactly-once.test.ts`.

**Behavioral diff:** add architecture guard for flag-on provider stream opens and goal scheduler launches.

**Named tests:** `provider run under flag references work-unit provider-started`, `goal launch under flag references claim`, `native session only resume is rejected`.

**Verification receipt:** guard output with synthetic bypass failure.

### P1-10w - `EVAL-HARNESS`

**One invariant:** default-on is blocked by recorded crash/resume and cooldown artifacts.

**Maximum file set:** `src/core/exactly-once-eval.ts` (new), `test/unit/exactly-once-eval.test.ts` (new), `docs/r7-item10-exactly-once-contract.md`.

**Behavioral diff:** add fake-store eval runner for section 8 fixtures and document artifact requirements.

**Named tests:** `opaque mutation replay fixture fails if original reopens`, `cooldown fixture preserves retry after`, `completion replay fixture maps every policy`.

**Verification receipt:** artifact path/hash, fixture counts, p95 table, no-default-change proof.

### P1-10x - `RESUME-UI-AND-RECEIPTS`

**One invariant:** user-visible resume status names verify/repair/wait/needs-user without claiming done from prose.

**Maximum file set:** `src/interface/render.ts`, `src/interface/menu-render.ts`, `src/core/types.ts`, `test/unit/menu-render.test.ts`, `test/unit/resume-transcript.test.ts`.

**Behavioral diff:** render work-unit replay class and cooldown wait receipts when present; flag off unchanged.

**Named tests:** `verify only renders verify not replay`, `already settled renders completion result`, `wait cooldown names provider and until`.

**Verification receipt:** renderer snapshot table.

### P1-10y - `DARK-INTEGRATION-ACCEPTANCE`

**One invariant:** all enabled surfaces consume Item 11/12/17 authority and default remains off.

**Maximum file set:** `test/unit/orchestrate-exactly-once.test.ts`, `test/unit/exactly-once-resume.test.ts`, `test/arch/exactly-once-authority-guard.test.ts`, `docs/r7-item10-exactly-once-contract.md`.

**Behavioral diff:** record dark acceptance receipt after guards/eval pass. No product default change.

**Named tests:** `all crash points reconstruct`, `all cooldown points survive restart`, `flag off snapshots remain unchanged`.

**Verification receipt:** exact commands, artifact hashes, changed files, and no-default-change proof.

### P1-10z - `PROMOTION-CANDIDATE-ONLY`

**One invariant:** default-on is considered only after human gate, dark eval, and downstream Item 13 readiness on the exact merge candidate.

**Maximum file set:** `src/interface/ui/exactly-once-flag.ts`, `src/infra/config.ts`, `test/unit/exactly-once-flag.test.ts`, `docs/r7-item10-exactly-once-contract.md`.

**Cancel conditions:** missing eval artifact, any duplicate settlement, any opaque replay violation, stale artifact head, flag-off drift, missing rollback proof, Item 11/12/17 edge missing, Item 13 launch seam not consuming work units, or human gate absent.

**Exact behavioral diff:** if and only if a human-approved promotion gate exists, absent env/config may select V1 while explicit false remains rollback for one release. This slice may cancel with no edits.

**Named tests:** `absent flag defaults V1 only after recorded promotion gate`, `explicit false restores legacy execution`, `promotion artifact head matches tree`.

**Verification receipt:** human gate reference, eval artifact hashes, rollback command, before/after default table.

## 11. Cross-slice acceptance and definition of done

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npm run typecheck
npx vitest run test/unit/exactly-once.test.ts test/unit/exactly-once-resume.test.ts test/unit/native-session.test.ts test/unit/scheduler.test.ts
```

The changed-file list must be a subset of that slice's maximum set. A test pass with no crash fixture, no CAS failure fixture, no flag-off snapshot, no cooldown/retry-after case, or no completion replay-policy mapping is not acceptance.

Item 10 is implemented dark when 10y is green. It is promoted only if 10z's prerequisites and human gate are satisfied. The implementation satisfies Item 10 only if all of the following are simultaneously true:

- every enabled mutating foreground attempt has a durable work-unit id and idempotency key;
- every state transition is persisted in the Item 11 canonical event log with CAS;
- provider streams cannot open before a durable `provider-started` event;
- opaque mutation boundary makes original replay forbidden until completion policy permits otherwise;
- `CompletionResultV1.replayPolicy` is the only terminal replay authority;
- Retry-After/cooldown facts are recorded from Item 12 provider generations and survive crash/resume;
- native provider sessions are acceleration only and never replay proof;
- cancellation before provider start is replay-safe, while cancellation after opaque start is verify-only or terminally settled;
- scheduler/goal launch paths consume durable work-unit claims before mutating work;
- flag-off rollback restores legacy behavior without deleting additive canonical events.

## 12. Adversarial self-challenge and fixes

**Challenge 1: could this block useful retry after a provider crash even when no files changed?** Yes, if opaque mutation risk is treated too broadly. Fix: read-only requests with proven no-mutation capability remain replay-safe; mutation-capable subprocesses become verify-only because absence of observed diff is not proof.

**Challenge 2: could `CompletionResultV1` be missing after a crash, leaving the user stuck?** Yes. Fix: the resume decision is `verify-only` or `needs-user`, not blind replay. Verification can produce a new completion result, but the original provider action is not re-run after mutation risk.

**Challenge 3: could native provider resume quietly double-apply changes?** Yes, if `sessionId/resume` is treated as continuity authority. Fix: native sessions are filtered by replay class and provider generation; they can accelerate a permitted repair/verification prompt, never authorize original replay.

**Challenge 4: could cooldown evidence disappear on restart?** Yes with today's maps. Fix: Item 10 records Item 12 generation/cooldown source event ids in work-unit state and reconstructs wait/reroute decisions from canonical events.

**Challenge 5: could CAS make concurrent goals brittle?** Yes, if every conflict is a hard failure. Fix: stale CAS triggers reload and reclassification. Parked/claimed conflicts can safely requeue; post-mutation conflicts fail closed to verify/needs-user.

**Challenge 6: could this become ceremony while scheduler still unlocks dependents from `ev.success`?** Yes. Fix: edge `10->13` and slices 10r/10v require goal launch and dependency unlock to consume work-unit settlement plus completion goal settlement under the flag.

## 13. North-star drift check

Does this make "one chat" more trustworthy, or add ceremony?

It moves toward the north-star only if crash/resume becomes boringly safe: the assistant knows what work was parked, what was claimed, what provider started, whether mutation may have happened, what verification found, and whether replay is allowed. A professional assistant does not double-run destructive work or forget Retry-After after restart.

It adds ceremony if work-unit events are written but provider streams can still bypass them, if native sessions remain replay authority, if cooldowns stay in memory, or if goals unlock from final prose. The guardrail is concrete: one durable state machine, one idempotency key, one CAS append path, one completion replay policy, one provider generation, dark flag, eval artifact, rollback.
