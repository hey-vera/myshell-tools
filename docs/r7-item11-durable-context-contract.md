# Item 11 contract - durable provider-neutral context

Status: delegation-ready implementation contract, grounded at repository head `7951d36` on 2026-07-02.

This document is controlling for Round-7 Item 11. Item 17 owns terminal completion truth through `CompletionResultV1`; this contract reuses that vocabulary by reference and must not redefine it. Item 11 owns the durable, append-only context substrate that every turn, work unit, completion, provider-native session, resume decision, and goal node references.

At document creation the worktree was not clean: `knip.json` and `src/core/evidence.ts` were modified. Those are pre-existing local changes for this authoring turn and are not part of this contract edit.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_DURABLE_CONTEXT_V1` is explicitly enabled, each conversation has one canonical append-only event log plus versioned compact snapshots. The log is the durable source of truth for context reconstruction. Native Claude/Codex/Grok/OpenCode session ids are acceleration metadata only; they are never the continuity authority.

The required outcome is narrow:

- every foreground turn, work unit, `CompletionResultV1`, exactly-once state transition, and goal DAG node references a canonical event id;
- cold resume reconstructs a bounded working context for roughly 500 turns from snapshots plus tail events without dumping the whole transcript into each provider prompt;
- switching providers proves continuity by replaying provider-neutral state, not by trusting one provider's native thread;
- Item 10 stores exactly-once work-unit state in this substrate;
- Item 13 links every goal node and edge to this substrate.

This item does **not**:

- implement Item 10's exactly-once state machine;
- implement Item 13's goal scheduler or multi-goal DAG;
- redefine `CompletionResultV1`, its `replayPolicy`, or its `goalSettlement`;
- make native provider sessions default or required;
- migrate old transcripts destructively;
- promote any default-on behavior without the eval gate in this contract.

The current code has useful pieces but no single durable authority. `SessionEntry` is an append-only message shape with optional provider session id and `workTrace`, but it is not a canonical event log. Item 11 makes the durable substrate explicit and keeps the old history transcript as a compatibility view until promotion.

## 2. Current-state evidence and invariants

All citations below are current at `7951d36`; workers must re-run `nl -ba` or equivalent before editing and record drift rather than silently relying on stale line ranges.

- `SessionEntry` contains timestamp, role, content, provider/model/cost fields, optional provider-native `sessionId`, optional `workTrace`, and `engineBehaviorVersion` at `src/core/types.ts:126-160`.
- `SessionWriter` is only `append(entry: SessionEntry)` at `src/core/types.ts:163-165`; there is no typed canonical event append with ids, hashes, snapshots, or compare-and-swap.
- Provider-native request continuity is optional metadata on `ProviderRequest.sessionId` and `ProviderRequest.resume` at `src/providers/port.ts:47-54`; provider terminal events may surface a provider-assigned `sessionId` at `src/providers/port.ts:129-134`.
- The current native-session planner is explicitly provider-specific and opt-in: comments say the default path replays compact history, Claude can use the conversation id, Codex can resume only after a captured id, and OpenCode/Grok are not durable authorities at `src/core/native-session.ts:4-20,81-90`.
- `planNativeSession(...)` returns no plan when disabled, without a conversation id, or when history replay must quarantine stale assistant prose; it plans Claude from the conversation id and Codex only from a prior captured id at `src/core/native-session.ts:92-114`.
- `compactHistory(...)` currently sends only the most recent bounded turns, defaults to 6,000 chars and 12 turns, strips assistant control envelopes, and drops oldest turns under pressure at `src/core/history.ts:23-26,131-204`.
- `historyTruncationInfo(...)` can honestly report dropped turns but does not reconstruct missing state at `src/core/history.ts:217-273`.
- `work-state.ts` already distinguishes durable work-state from user memory: it derives task/session continuity only from accepted prior `workTrace`, not profile memory, at `src/core/work-state.ts:6-10`.
- `WorkStateSnapshot` is a small truthful snapshot with objective, roadmap, checkpoints, evidence-backed `verifiedDone`, claimed next, and source at `src/core/work-state.ts:38-61`.
- `deriveWorkStateFromHistory(...)` scans accepted assistant entries, keeps the latest trace, treats `GOAL_COMPLETE` as explicit evidence, and never infers completion from silence at `src/core/work-state.ts:86-140`.
- Work-state reconstruction caps roadmap and verified-done rendering and keeps `Checkpoint.summary` as a claim, never done, at `src/core/work-state.ts:155-197`.
- `renderWorkStateBlock(...)` emits an honest compact prompt block and says "none yet" when no done evidence exists at `src/core/work-state.ts:201-242`.
- `orchestrate.ts` reconstructs work-state from `deps.history` without model calls at `src/core/orchestrate.ts:1134-1142`, but this is a best-effort reducer over loaded transcript entries, not a canonical event substrate.
- `orchestrate.ts` appends user messages before the work loop at `src/core/orchestrate.ts:2188-2194`; terminal-question paths append user plus assistant entries with `workTrace` at `src/core/orchestrate.ts:1821-1855`.
- `orchestrate.ts` builds replay history by filtering a local copy, then compacts it for prompt injection; the underlying store is untouched at `src/core/orchestrate.ts:1920-1955`.
- `CoreEvent.final` contains success, output, tier, total cost, session id, attempts, cancellation, provider, questions, memory proposal, best-effort, blocked record, optional receipt, account id, and optional goal id at `src/core/types.ts:1281-1345`; it does not yet carry a canonical context event id or snapshot reference.
- Additive multi-goal seams already exist as `goal-enqueue` and `goal-phase` events with stable ids and optional dependencies at `src/core/types.ts:1347-1373`; they are UI/runtime events, not durable DAG authority.
- `OrchestrateDeps.history` is described as prior conversation history compacted into the first provider prompt for stateless providers at `src/core/types.ts:406-412`; this is prompt continuity, not durable reconstruction.

Baseline at this head:

| surface | current source | Item-11 requirement |
|---|---|---|
| transcript | `SessionEntry` JSONL | compatibility view over canonical events |
| prompt context | last 12 turns / 6,000 chars plus work-state | bounded reconstruction from snapshot + tail events |
| provider continuity | optional native `sessionId`/`resume` | acceleration only; provider-neutral event log is authority |
| completion truth | fragmented final/receipt today; Item 17 `CompletionResultV1` pending | canonical event references exactly one completion result per terminal turn |
| exactly-once | not durable | work-unit state persisted as canonical events |
| goals | additive runtime seams | goal DAG nodes/edges reference canonical events |

## 3. Shared typed contract

Slice 11a must export these names from `src/core/durable-context.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them. `CompletionResultV1` is imported from Item 17's owning module once Item 17 lands; do not copy its fields here.

```ts
export type DurableContextVersion = 1;

export type CanonicalEventKind =
  | 'turn.user'
  | 'turn.preflight'
  | 'work-unit.planned'
  | 'work-unit.state'
  | 'provider.native-session'
  | 'provider.observation'
  | 'completion.result'
  | 'goal.node'
  | 'goal.edge'
  | 'context.snapshot'
  | 'context.invalidation';

export type ContextSnapshotKind = 'turn-window' | 'work-state' | 'goal-dag' | 'resume-index' | 'full-compact';

export interface CanonicalEventRefV1 {
  readonly logId: string;
  readonly eventId: string;
  readonly sequence: number;
}

export interface CanonicalEventV1 {
  readonly version: 1;
  readonly logId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly priorEventId: string | null;
  readonly createdAt: string;
  readonly conversationId: string;
  readonly turnId?: string;
  readonly workUnitId?: string;
  readonly goalId?: string;
  readonly provider?: import('../providers/port.js').ProviderId;
  readonly kind: CanonicalEventKind;
  readonly invalidates?: readonly string[];
  readonly payload: unknown;
  readonly payloadHash: string;
}

export interface ContextSnapshotV1 {
  readonly version: 1;
  readonly snapshotId: string;
  readonly logId: string;
  readonly kind: ContextSnapshotKind;
  readonly coversThrough: CanonicalEventRefV1;
  readonly createdAt: string;
  readonly sourceEventIds: readonly string[];
  readonly invalidatedBy: string | null;
  readonly state: unknown;
  readonly stateHash: string;
  readonly tokenEstimate: number;
}

export interface ReconstructedContextV1 {
  readonly version: 1;
  readonly logId: string;
  readonly conversationId: string;
  readonly baseSnapshotId: string | null;
  readonly replayedEvents: readonly CanonicalEventRefV1[];
  readonly promptBlocks: readonly {
    readonly id: string;
    readonly kind: 'objective' | 'work-state' | 'goal-state' | 'recent-turns' | 'completion-tail' | 'resume-policy';
    readonly text: string;
    readonly tokenEstimate: number;
    readonly sourceEventIds: readonly string[];
  }[];
  readonly openLoops: readonly {
    readonly id: string;
    readonly kind: 'turn' | 'work-unit' | 'completion-obligation' | 'goal';
    readonly state: 'open' | 'blocked' | 'needs-user' | 'settled';
    readonly sourceEventId: string;
  }[];
  readonly tokenEstimate: number;
}
```

Event ids must match `/^[a-z][a-z0-9_-]{0,63}$/`. `logId`, `snapshotId`, `turnId`, `workUnitId`, and `goalId` use the same shape. `sequence` is strictly increasing per `logId`. `priorEventId` is the immediately preceding committed event or `null` for the first event. `payloadHash` and `stateHash` are stable hashes over canonical JSON. Unknown event kinds, unsupported versions, sequence gaps, duplicate ids, hash mismatches, or a wrong `priorEventId` fail reconstruction.

Payloads are typed by constructors, not by this open union. The required payload families are:

- `turn.user`: normalized user text, input attachments by reference, and intent/preflight refs when available.
- `turn.preflight`: Item 8 semantic objective, evidence obligations, and done condition by value or event ref.
- `work-unit.planned`: work unit id, objective, allowed mutation scope, and idempotency key.
- `work-unit.state`: Item 10 state names when Item 10 lands; until then a dark no-op fixture vocabulary is used.
- `provider.native-session`: provider id, native session id, resume flag, and the canonical event it accelerates.
- `provider.observation`: provider/tool/usage/ledger references, never raw unbounded transcript.
- `completion.result`: a `CompletionResultV1` reference or value produced by Item 17, not a redefined schema.
- `goal.node` and `goal.edge`: Item 13 node/edge ids, dependencies, and event refs.
- `context.snapshot`: metadata for a committed `ContextSnapshotV1`.
- `context.invalidation`: reason and target ids.

Caps are part of the contract: individual event payload canonical JSON <= 32 KiB unless it is a snapshot metadata event; snapshot state <= 96 KiB; reconstructed prompt context target <= 12,000 tokens and hard max <= 16,000 estimated tokens; recent-turn prose <= 8 turns or 4,000 tokens; work-state block <= 1,500 tokens; goal DAG block <= 2,000 tokens; completion-tail block <= 2,000 tokens; resume-policy block <= 1,000 tokens. The transcript compatibility view may remain larger on disk, but provider prompts use `ReconstructedContextV1`, not a whole-transcript dump.

## 4. Canonical event log and invalidation rules

The canonical log is append-only. No event or snapshot is edited in place. Corrections, supersession, compaction, and schema repair are represented by new events.

The log is the one durable substrate:

- every turn receives a `turn.user` event before any work unit starts;
- every semantic preflight, execution plan, work-unit state transition, provider-native session observation, completion result, and goal node/edge references an existing event id;
- every `CompletionResultV1.id` has exactly one `completion.result` event for a given `turnId`;
- every Item 10 work-unit state transition references the previous work-unit event;
- every Item 13 goal node references its creating turn/preflight/work-unit event and its settling `completion.result` event when settled.

Invalidation is explicit:

- A `context.invalidation` event can invalidate snapshots, prompt blocks, provider-native sessions, stale summaries, or goal edges; it cannot delete source events.
- A snapshot is invalid when `invalidatedBy` is non-null, when any event in its covered prefix is invalidated by a later event with a matching target, when its `stateHash` mismatches, when its `coversThrough` is not on the current log chain, or when its version is unsupported.
- A provider-native session is invalid for reconstruction when its provider differs from the selected provider, when a later `context.invalidation` targets it, when the history policy quarantines the covered assistant prose, or when a canonical open loop depends on an event after the native session's covered event.
- A compact summary is invalid when it omits an unsettled open loop, drops an unmet `CompletionResultV1` obligation, drops an active work-unit state, drops a goal dependency, or exceeds token caps.
- A goal edge is invalid only by an explicit goal-edge invalidation or by invalidating either endpoint node; it is not invalidated by provider switches.

Reconstruction reads the newest valid snapshot whose `coversThrough` is on the log chain, then folds later events in sequence. If no valid snapshot exists, reconstruction folds events from genesis but may stop and return `needs-repair` when the event count exceeds the cold-resume hard cap; it must not fabricate state from transcript prose.

## 5. Provider-neutral reconstruction rule

The proof obligation is simple: an open loop survives a switch from Claude to Codex to Grok to OpenCode when the loop can be reconstructed without reading any provider-native server memory.

Provider-neutral reconstruction is valid only when all of these are true:

1. The selected `ReconstructedContextV1` was built from canonical snapshots plus canonical tail events.
2. Every open loop has a source event id and a current state derived from event payloads, not from provider-native memory.
3. The prompt blocks contain enough bounded state for a stateless provider request to continue the loop.
4. The provider request may include `sessionId/resume` only when the native session matches the selected provider and is not invalidated.
5. If the provider changes, `sessionId/resume` is omitted and the same `ReconstructedContextV1` prompt blocks are sent.

Therefore:

- Claude continuity may use its native session id, but the canonical log must still reconstruct the same open loops when the next turn routes to Codex.
- Codex continuity may capture a provider-generated thread id, but absence of that id cannot make resume impossible.
- Grok/OpenCode may ignore native session metadata entirely and still receive the bounded reconstructed context.
- A provider-native session can reduce prompt tokens; it cannot be the only place an active objective, unmet completion obligation, work-unit state, or goal dependency lives.

Tests must prove this with a four-provider fixture: start an open work-unit on Claude, observe a native session event, switch to Codex, switch to Grok, switch to OpenCode, and show that the same open-loop ids and done conditions are present while all mismatched provider-native resume fields are omitted.

## 6. Bounded cold resume and compaction cadence

Target: cold resume stays useful around 500 turns without sending the whole transcript to each provider.

Cadence:

- append events for every foreground turn and terminal result;
- create `turn-window` and `work-state` snapshots every 10 turns or 50 canonical events, whichever comes first;
- create `goal-dag` snapshots after every goal DAG structural change and at least every 20 goal events;
- create `resume-index` snapshots after every `CompletionResultV1` and every Item 10 terminal work-unit state;
- create `full-compact` snapshots every 50 turns or 250 canonical events, whichever comes first;
- create an immediate snapshot before a default-on promotion eval run and after any snapshot schema migration.

Cold resume algorithm:

1. Load log metadata and the newest valid `full-compact` snapshot.
2. Load the newest valid specialized snapshots that cover the same or later sequence.
3. Fold tail events after the newest covering snapshot.
4. Build prompt blocks from structured state: active objective, work-state, active goal DAG, unresolved completion obligations, replay policy, and recent user/assistant turns.
5. Include recent prose only as a tail window; older prose is available in the UI transcript but not dumped into provider prompts.

Token bound:

- target prompt reconstruction <= 12,000 estimated tokens;
- hard max <= 16,000 estimated tokens;
- if pressure exceeds target, reduce recent prose first, then completion-tail detail, then goal DAG render detail;
- never drop active work-unit state, unmet completion obligations, active goal dependencies, or the current user turn;
- if the hard max would still be exceeded, return a typed `needs-user`/`blocked` reconstruction result that names the excessive state rather than silently truncating authority state.

The existing `compactHistory` limits at 6,000 chars and 12 turns remain the flag-off baseline. Under Item 11, compact history becomes one prompt block derived from the canonical context, not the source of continuity.

## 7. Named upstream and downstream contract edges

### Edge `8k->11` - semantic objective and obligations into durable context

Producer: Item 8 semantic preflight.

Consumer: canonical events `turn.preflight` and derived snapshots.

Rule: Item 11 stores the semantic objective, done condition, and evidence obligations as durable context. It does not settle them; Item 17 settles completion.

### Edge `17->11` - completion truth into durable context

Producer: Item 17 `CompletionResultV1`.

Consumer: canonical event `completion.result`, resume-index snapshots, work-state snapshots, and goal DAG snapshots.

Rule: Item 11 stores exactly one completion result reference/value per terminal foreground turn and exposes `replayPolicy` and `goalSettlement` to downstream consumers. It does not reinterpret those fields.

### Edge `11->10` - durable substrate for exactly-once state

Producer: Item 11 canonical log and snapshots.

Consumer: Item 10 exactly-once execution/resume state machine.

Rule: Item 10 persists every work-unit state transition as `work-unit.state` events and reconstructs replay safety from the canonical log plus `CompletionResultV1.replayPolicy`. It must not store exactly-once authority only in provider-native sessions, process memory, or transcript prose.

### Edge `11->13` - durable context linkage for goal DAG

Producer: Item 11 canonical log, goal-node/goal-edge events, and snapshots.

Consumer: Item 13 goal stewardship and multi-goal DAG.

Rule: every goal node has a creating event, dependency edges, current state, and settlement event reference. Dependent nodes advance only from durable `completion.result` / goal-settlement evidence, not from final prose or UI runtime events.

## 8. Shared rollout, fixture, and worktree rules

The single runtime flag is `MYSHELL_DURABLE_CONTEXT_V1`; the config mirror is `experimentalDurableContextV1?: boolean`. Both default false. Prior slices are unreachable pure/test code or use explicit dependency injection.

When the flag is off, existing session JSONL, `compactHistory`, native-session planning, work-state reconstruction, final events, and goal UI events remain byte-for-byte current. When the flag is on, canonical events are written alongside compatibility `SessionEntry` records until promotion. The compatibility transcript is derived from or kept in sync with canonical events; the canonical log is the authority.

Rollback is: unset `MYSHELL_DURABLE_CONTEXT_V1`, set `experimentalDurableContextV1:false`, restart the process, and confirm provider prompts and session JSONL match legacy snapshots. Do not delete canonical logs during rollback. Old readers ignore the additive files; new readers can rebuild from old `SessionEntry` only in explicit migration tests.

Every worker slice must begin with:

```bash
git status --short
git diff --name-only
npm run typecheck
```

Record pre-existing paths and do not edit them. At document creation, `knip.json` and `src/core/evidence.ts` were pre-existing dirty paths. A slice is rejected if `git diff --name-only` contains a path outside its exhaustive maximum set. No slice may weaken Item 17 completion authority, Item 9 ledger accounting, or native-session fallback safety.

For async fixtures, "injected crash" means a dependency throws at the named boundary. Do not use `process.exit`, kill the test runner, or add sleeps. Pure slices explicitly mark cancel/crash N/A.

## 9. Evaluation and acceptance gate

Default-on is forbidden until a dark eval artifact passes and is recorded in this document by a later promotion slice.

Eval fixture set:

- 500-turn synthetic conversation with mixed small talk, code work, questions, blocked turns, cancellations, and completions;
- provider-switch chain Claude -> Codex -> Grok -> OpenCode with an open work unit and an unmet completion obligation;
- stale native-session invalidation fixture;
- snapshot corruption/hash mismatch fixture;
- active goal DAG with at least 20 nodes and 35 edges;
- Item 10 work-unit transition fixture once Item 10 exists;
- Item 17 completion-result fixture once Item 17 exists.

Hard thresholds:

- zero lost open loops in reconstruction;
- zero provider-native-session-only continuities;
- zero accepted invalid snapshots;
- prompt reconstruction <= 12,000 estimated tokens p95 and <= 16,000 max on the 500-turn fixture;
- cold resume p95 <= 150 ms on fake storage and <= 750 ms on local JSONL/file storage;
- flag-off transcript/prompt snapshots unchanged;
- rollback restores legacy prompt construction without deleting canonical files.

The eval writes a JSON artifact under `.tmp/durable-context-v1/` with git head, fixture count, hashes, token stats, timings, and provider-switch proof. The promotion slice records artifact paths and hashes before changing defaults.

## 10. Ordered slices

### P1-11a - `DURABLE-CONTEXT-DOMAIN`

**One invariant:** canonical events and snapshots are versioned, hashable, capped, append-only values that fail closed on unsupported versions, duplicate ids, sequence gaps, and invalid hashes.

**Preconditions/dependencies:** existing `SessionEntry`, `WorkStateSnapshot`, and provider ids. Item 17 may not be implemented yet; represent completion payload as opaque `unknown` plus a type-only TODO import note, not a copied schema.

**Maximum file set (exhaustive):**

- `src/core/durable-context.ts` (new)
- `test/unit/durable-context.test.ts` (new)

**Behavioral diff:** add shared types, constructors, cap helpers, stable canonical JSON hashing, validators, and pure append-chain verification. No runtime caller.

**Named tests:** `valid event chain verifies`, `duplicate event id fails`, `sequence gap fails`, `wrong prior event fails`, `hash mismatch fails`, `snapshot caps are enforced`, `unsupported version fails closed`, `completion payload stays opaque and does not redefine CompletionResultV1`.

**Fixtures:** success = valid five-event chain; failure = each invalid chain case; cancellation = N/A pure; injected crash = validators receive proxies/primitives/throwing getters and return rejected results without throwing.

**Verification receipt:** commands run, changed files, and assertions above. Required:

```bash
npm run typecheck && npm run lint -- src/core/durable-context.ts test/unit/durable-context.test.ts && npx vitest run test/unit/durable-context.test.ts
```

### P1-11b - `SNAPSHOT-REDUCERS`

**One invariant:** snapshots are deterministic reductions of event prefixes and cannot drop active work, unmet completion obligations, or active goal nodes.

**Preconditions/dependencies:** 11a.

**Maximum file set (exhaustive):**

- `src/core/durable-context.ts`
- `src/core/durable-context-snapshot.ts` (new)
- `test/unit/durable-context-snapshot.test.ts` (new)

**Behavioral diff:** add pure reducers for `turn-window`, `work-state`, `goal-dag`, `resume-index`, and `full-compact`; add invalidation checking over snapshots.

**Named tests:** `full compact preserves open work unit`, `work-state snapshot preserves claimed next but not prose done`, `resume-index preserves replay policy reference`, `goal snapshot preserves dependencies`, `invalidated snapshot is skipped`, `corrupt covered event invalidates snapshot`.

**Fixtures:** success = mixed event prefix; failure = invalidated/corrupt snapshots; cancellation = N/A pure; injected crash = malformed event payload cannot create positive state.

**Verification receipt:** include before/after reducer table and exact command output for targeted tests.

### P1-11c - `RECONSTRUCTION-ENGINE`

**One invariant:** reconstructed context is built from newest valid snapshots plus ordered tail events and respects the token budget without dropping authority state.

**Preconditions/dependencies:** 11a-11b.

**Maximum file set (exhaustive):**

- `src/core/durable-context.ts`
- `src/core/durable-context-reconstruct.ts` (new)
- `test/unit/durable-context-reconstruct.test.ts` (new)
- `test/unit/history.test.ts`
- `test/unit/work-state.test.ts`

**Behavioral diff:** add pure `reconstructContextV1(...)`, prompt-block assembly, token budgeting, and authority-state pressure handling. Existing `compactHistory` and work-state tests remain unchanged off-flag.

**Named tests:** `uses newest valid full snapshot plus tail`, `falls back to genesis when event count is small`, `rejects reconstruction on sequence gap`, `drops old prose before authority state`, `hard max returns blocked reconstruction instead of truncating obligations`, `recent turns block matches compactHistory for simple history`.

**Fixtures:** success = 60-event chain; failure = gap/hash/corrupt snapshot; cancellation = N/A pure; injected crash = prompt-block renderer throws and reconstruction fails closed.

**Verification receipt:** include token-count table proving authority state is preserved under pressure.

### P1-11d - `PROVIDER-NEUTRAL-SWITCH-PROOF`

**One invariant:** provider switches never lose open loops because native sessions are optional acceleration, not durable context.

**Preconditions/dependencies:** 11c and current `planNativeSession`.

**Maximum file set (exhaustive):**

- `src/core/durable-context-reconstruct.ts`
- `src/core/native-session.ts`
- `test/unit/native-session.test.ts`
- `test/unit/durable-context-provider-switch.test.ts` (new)

**Behavioral diff:** add pure helper that decides whether a native session may accelerate a reconstructed context. It omits `sessionId/resume` on provider mismatch or invalidation. `planNativeSession` behavior remains snapshot-equal for flag-off tests.

**Named tests:** `claude native session accelerates only claude`, `codex captured id accelerates only codex`, `grok and opencode receive provider-neutral prompt blocks`, `provider switch preserves same open loop ids`, `invalidated native session is not resumed`, `quarantined history withholds native sessions`.

**Fixtures:** success = Claude->Codex->Grok->OpenCode chain; failure = invalidated/mismatched session; cancellation = N/A pure; injected crash = malformed native-session event is ignored.

**Verification receipt:** include open-loop id matrix for all four providers.

### P1-11e - `STORAGE-PORT-AND-COMPAT-LOG`

**One invariant:** canonical events append durably with compare-and-swap ordering while legacy `SessionEntry` JSONL remains readable and unchanged off-flag.

**Preconditions/dependencies:** 11a-11d.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/infra/conversations.ts`
- `src/infra/conversation-store.ts`
- `src/infra/jsonl-guards.ts`
- `test/unit/conversations.test.ts`
- `test/unit/jsonl-guards.test.ts`
- `test/unit/durable-context-storage.test.ts` (new)

**Behavioral diff:** add `DurableContextStore` port, JSONL guard for canonical events/snapshots, append-CAS semantics, and a compatibility loader that can read legacy session entries and expose them as migration input. No orchestration wiring yet.

**Named tests:** `append assigns next sequence only after prior matches`, `stale prior event is rejected`, `legacy conversation load remains unchanged`, `canonical malformed line is skipped with receipt`, `snapshot file corruption does not corrupt event log`, `compat migration reads old SessionEntry without writing`.

**Fixtures:** success = append chain and snapshot write; failure = stale CAS/malformed JSONL; cancellation = abort before append; injected crash = write throws after temp file and leaves no partial committed snapshot.

**Verification receipt:** include exact file names touched and rollback note: remove new canonical files, keep old transcript.

### P1-11f - `DARK-ORCHESTRATE-WRITES`

**One invariant:** under injected flag, every foreground turn writes canonical turn/work/completion-reference events in addition to legacy session entries; flag off is event-for-event legacy.

**Preconditions/dependencies:** 11e. Item 17 may be absent; completion event is emitted only when a completion result exists.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/orchestrate.ts`
- `test/unit/orchestrate-durable-context.test.ts` (new)
- `test/unit/run.test.ts`

**Behavioral diff:** add optional durable-context deps, append `turn.user` before work, write preflight/work-unit placeholder events where already available, and attach canonical event refs to terminal final events only under injection.

**Named tests:** `flag off final and session append snapshots unchanged`, `flag on user turn writes one canonical turn event`, `terminal question writes canonical turn and question refs`, `completion result when present writes completion event once`, `append failure fails closed before provider work`, `receipt callback crash cannot duplicate canonical event`.

**Fixtures:** success = normal turn/question turn; failure = append rejection; cancellation = abort before provider work; injected crash = durable store throws.

**Verification receipt:** include event count by fixture and proof zero provider calls occur after failed turn-event append.

### P1-11g - `DARK-RECONSTRUCTED-PROMPTS`

**One invariant:** under injected flag, provider prompts use `ReconstructedContextV1` prompt blocks; legacy compact-history prompts are unchanged when off.

**Preconditions/dependencies:** 11f.

**Maximum file set (exhaustive):**

- `src/core/orchestrate.ts`
- `src/core/history.ts`
- `src/core/work-state.ts`
- `test/unit/orchestrate-durable-context.test.ts`
- `test/unit/resume-transcript.test.ts`
- `test/unit/history.test.ts`
- `test/unit/work-state.test.ts`

**Behavioral diff:** replace prompt-context source under flag with reconstructed blocks; retain transcript UI scrollback separately. Existing `compactHistory` remains used by flag-off and by compatibility block construction where appropriate.

**Named tests:** `flag on prompt contains reconstructed objective work state and recent turns`, `500-turn fixture does not dump full transcript`, `unmet completion obligation survives prose pressure`, `flag off compactHistory prompt snapshot unchanged`, `UI resume transcript can still show full scrollback`.

**Fixtures:** success = 500-turn synthetic log; failure = over-budget authority state; cancellation = N/A pure/orchestrate fake; injected crash = reconstruction failure yields safe blocked final and zero work calls.

**Verification receipt:** include token estimates and prompt snapshot hashes.

### P1-11h - `SNAPSHOT-CADENCE-AND-COMPACTION`

**One invariant:** snapshot creation follows the cadence and compaction never invalidates source events.

**Preconditions/dependencies:** 11g.

**Maximum file set (exhaustive):**

- `src/core/durable-context-snapshot.ts`
- `src/infra/conversations.ts`
- `test/unit/durable-context-snapshot.test.ts`
- `test/unit/durable-context-storage.test.ts`

**Behavioral diff:** add cadence planner and snapshot writer integration behind injected flag. Snapshot events are append-only metadata; snapshot files are replace-by-id immutable.

**Named tests:** `10 turns schedules turn-window and work-state snapshots`, `50 turns schedules full compact`, `completion schedules resume index`, `goal structural change schedules goal snapshot`, `compaction writes snapshot event but does not delete events`, `snapshot write failure leaves log usable`.

**Fixtures:** success = cadence table; failure = snapshot write rejection; cancellation = abort during snapshot write; injected crash = serializer throws.

**Verification receipt:** include cadence matrix and file-count proof.

### P1-11i - `ITEM10-PERSISTENCE-SEAM`

**One invariant:** Item 10 can persist exactly-once state transitions only through canonical `work-unit.state` events.

**Preconditions/dependencies:** 11h. Item 10 implementation is not required.

**Maximum file set (exhaustive):**

- `src/core/durable-context.ts`
- `src/core/types.ts`
- `test/unit/durable-context-work-unit.test.ts` (new)

**Behavioral diff:** add typed work-unit event constructors, idempotency-key validation, transition-chain validation, and Item 10 consumer examples in tests. No runtime state machine.

**Named tests:** `work unit planned event creates idempotency key`, `state transition references prior work-unit event`, `duplicate terminal transition rejected`, `completion replay policy reference is preserved`, `provider-native session cannot satisfy exactly-once state`.

**Fixtures:** success = planned->claimed->provider-started->settled chain; failure = duplicate terminal/missing prior; cancellation = N/A pure; injected crash = malformed transition fails closed.

**Verification receipt:** include explicit edge `11->10` evidence table.

### P1-11j - `ITEM13-GOAL-DAG-SEAM`

**One invariant:** goal DAG nodes and edges link to canonical events and advance only through durable completion/settlement references.

**Preconditions/dependencies:** 11h and Item 17 vocabulary by reference.

**Maximum file set (exhaustive):**

- `src/core/durable-context.ts`
- `src/core/durable-context-snapshot.ts`
- `test/unit/durable-context-goal-dag.test.ts` (new)

**Behavioral diff:** add typed goal-node and goal-edge event constructors, dependency validation, settlement reference validation, and goal-DAG snapshot reducer.

**Named tests:** `goal node references creating turn event`, `goal edge references existing nodes`, `dependent node waits for completion goalSettlement allowed`, `prose done cannot settle node`, `invalidated edge blocks dependent advance`, `goal snapshot preserves 20 node dag`.

**Fixtures:** success = DAG with settlement; failure = missing node/prose-only done; cancellation = N/A pure; injected crash = malformed DAG event fails closed.

**Verification receipt:** include explicit edge `11->13` evidence table.

### P1-11k - `DARK-PRODUCTION-COMPOSITION`

**One invariant:** one explicit default-off flag composes canonical writes, snapshotting, reconstruction, and native-session acceleration rules across interactive, one-shot, and REPL entry points.

**Preconditions/dependencies:** 11a-11j.

**Maximum file set (exhaustive):**

- `src/infra/config.ts`
- `src/interface/ui/durable-context-flag.ts` (new)
- `src/interface/menu.ts`
- `src/interface/run.ts`
- `src/interface/repl.ts`
- `src/cli.ts`
- `test/unit/durable-context-flag.test.ts` (new)
- `test/unit/menu-flow.test.ts`
- `test/unit/run.test.ts`
- `test/unit/resume-transcript.test.ts`

**Behavioral diff:** add `experimentalDurableContextV1?: boolean`, parse `MYSHELL_DURABLE_CONTEXT_V1`, build the durable store only when explicit env/config true, and pass it to core. Keep old session JSONL and prompt path when absent/false/garbage.

**Named tests:** `flag defaults false for absent false zero and garbage`, `explicit env or config true enables durable context`, `interactive one-shot and REPL flag off snapshots match legacy`, `flag on writes canonical events and compatibility entries`, `rollback by unsetting flag restores legacy prompts`, `old native session flag cannot bypass provider-neutral reconstruction`.

**Fixtures:** success = each entry point; failure = store unavailable; cancellation = user interrupt; injected crash = flag parser/store constructor throws and degrades to legacy only when no canonical write has started.

**Verification receipt:** include flag-off hashes, flag-on event counts, and rollback command.

### P1-11l - `EVAL-AND-AUTHORITY-GUARDS`

**One invariant:** default-on, resume, exactly-once, and goal-DAG consumers cannot bypass the canonical context substrate when the flag is on.

**Preconditions/dependencies:** 11k.

**Maximum file set (exhaustive):**

- `src/core/durable-context.ts`
- `test/arch/durable-context-authority-guard.test.ts` (new)
- `test/unit/durable-context-reconstruct.test.ts`
- `test/unit/orchestrate-durable-context.test.ts`
- `docs/r7-item11-durable-context-contract.md`

**Behavioral diff:** add authority guard and eval runner for the fixtures in section 9. Record dark implementation acceptance receipt in this document only after artifacts pass. Default remains off.

**Named tests:** `flag on prompt reconstruction reads canonical context`, `flag on work-unit state references canonical event`, `flag on goal DAG references canonical event`, `provider native session only continuity is rejected`, `500-turn eval meets token and timing thresholds`, `flag off snapshots remain unchanged`.

**Fixtures:** success = eval set; failure = synthetic bypass/corrupt snapshot; cancellation = cancelled turn fixture; injected crash = truncated artifact fails closed.

**Verification receipt:** artifact path/hash, fixture counts, token/timing stats, guard output, and no-default-change proof.

### P1-11m - `PROMOTION-CANDIDATE-ONLY`

**One invariant:** default-on is considered only after the dark eval passes on the exact merge candidate and rollback remains explicit.

**Preconditions/dependencies:** 11l plus Item 17 dark completion result and Item 10/13 integration seams green where implemented. Missing Item 10/13 implementation blocks default-on but not dark completion.

**Cancel conditions:** missing eval artifact, any lost open loop, any provider-native-only continuity, token hard max miss, cold-resume threshold miss, flag-off snapshot drift, missing rollback proof, stale artifact head, or human gate absent.

**Maximum file set (exhaustive):**

- `src/interface/ui/durable-context-flag.ts`
- `src/infra/config.ts`
- `docs/r7-item11-durable-context-contract.md`
- `test/unit/durable-context-flag.test.ts`

**Exact behavioral diff:** if and only if a human-approved promotion gate exists, absent env/config may select V1 while explicit false remains rollback for one release. This slice may also cancel with no code edits; cancellation is correct when downstream Item 10/13 authority is not ready.

**Named tests:** `absent flag defaults V1 only after recorded promotion gate`, `explicit false restores legacy context path`, `default provider switch still reconstructs from canonical context`, `promotion receipt artifact head matches tree`.

**Verification receipt:** include human gate reference, eval artifact hashes, rollback command, and before/after default table.

## 11. Cross-slice acceptance and definition of done

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npm run typecheck
npx vitest run test/unit/history.test.ts test/unit/work-state.test.ts test/unit/native-session.test.ts
```

The changed-file list must be a subset of that slice's maximum set. A Vitest pass with no provider-switch proof, no corrupt-snapshot case, no flag-off snapshot, or no rollback note is not acceptance.

Item 11 is implemented dark when 11l is green. It is promoted only if 11m's prerequisites and human gate are satisfied. The implementation satisfies Item 11 only if all of the following are simultaneously true:

- every enabled turn has canonical event ids for user turn and terminal result;
- every enabled `CompletionResultV1`, work-unit transition, and goal node/edge references the canonical log;
- provider-native sessions are optional acceleration and are omitted on provider mismatch or invalidation;
- a Claude/Codex/Grok/OpenCode switch preserves open loops from reconstructed context;
- 500-turn cold resume uses snapshots plus tail events and stays within token/timing bounds;
- invalid snapshots, corrupt events, and stale native sessions fail closed;
- flag-off rollback restores legacy transcript and prompt behavior without deleting canonical files;
- authority guards prevent resume/exactly-once/goal consumers from bypassing canonical context when the flag is on.

## 12. Adversarial self-challenge and fixes

**Challenge 1: could this just add another log beside the old transcript?** Yes, if prompts and downstream consumers keep using `SessionEntry` as authority. Fix: 11g makes reconstructed prompt blocks the flag-on prompt source; 11l adds authority guards for prompt, work-unit, and goal consumers.

**Challenge 2: could native sessions quietly remain the real continuity mechanism?** Yes, if `sessionId/resume` is required for open loops. Fix: 11d proves provider switches across Claude, Codex, Grok, and OpenCode preserve the same open-loop ids with native resume omitted.

**Challenge 3: could compaction summarize away the important unfinished work?** Yes, if snapshots are prose summaries. Fix: active work units, unmet completion obligations, replay policy, and goal dependencies are authority state and are never dropped under token pressure.

**Challenge 4: could the 500-turn target make every prompt huge?** Yes, if cold resume means transcript replay. Fix: recent prose is only a prompt block tail; older continuity lives in structured snapshots. The hard cap blocks instead of silently dumping or truncating authority state.

**Challenge 5: could invalidation become a delete button?** Yes, if invalidation mutates history. Fix: invalidation is itself append-only. Source events remain inspectable; only derived snapshots/sessions/edges are marked unusable for reconstruction.

**Challenge 6: could Item 10 or Item 13 invent parallel durable state?** Yes, if their stores become independent authorities. Fix: named edges `11->10` and `11->13` require their state transitions and DAG links to reference canonical event ids, with guard tests.

## 13. North-star drift check

Does this make "one chat" durable, or add ceremony?

It moves toward the north-star only if the canonical log becomes the quiet substrate behind the single chat: the user keeps one conversation, provider choice can change, resume is bounded, goals know what they depend on, and completion/replay truth is not trapped in one model's native thread.

It adds ceremony if the app keeps sending compacted transcript prose while writing unused canonical files, if snapshots become vague summaries, or if native sessions remain required to continue work. The guardrail is concrete: one append-only log, versioned snapshots, bounded reconstruction, provider-neutral switch proof, dark flag, eval artifact, rollback, and downstream authority guards.
