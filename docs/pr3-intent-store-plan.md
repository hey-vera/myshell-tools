Read-only note: source was not edited in this session. Save this as `docs/pr3-intent-store-plan.md`.

# MYSHELL_INTENT_STORE_V1 PR Plan

## 1. Goal + OFF guarantee

Ship `MYSHELL_INTENT_STORE_V1`, default OFF, promoting the existing PR2 `intentVersionId` into an append-only persisted intent-version record.

OFF guarantee: when `MYSHELL_INTENT_STORE_V1` is absent, false, `0`, `off`, or `no`, no intent store is constructed, no `.myshell-tools/intent-versions.jsonl` file is created, no intent-version row is written, goal/work-contract records omit `intentVersionId`, and PR2 behavior remains unchanged. If `MYSHELL_ACCOUNT_AUX` is ON while this flag is OFF, `intentVersionId` remains only PR2’s per-turn ledger correlation id.

## 2. IntentVersion model

Add `src/core/intent-version.ts`:

```ts
export interface IntentVersion {
  readonly version: 1;
  readonly id: string;
  readonly parentId?: string | null;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly rawUserTurnText: string;
  readonly intent: {
    readonly objective: string;
    readonly assumptions?: readonly string[];
    readonly constraints?: readonly string[];
    readonly nonGoals?: readonly string[];
    readonly doneCriteria?: string;
    readonly risk?: import('./types.js').Risk;
    readonly confidence?: import('./intent.js').IntentConfidence;
    readonly source?: import('./intent.js').IntentFrame['source'];
  };
}
```

Minimal choices:
- `id` is the existing `intentVersionId`; do not mint a second id.
- `parentId` is written as `null` for roots; PR4 may write fork parent ids.
- `rawUserTurnText` preserves the exact user turn.
- `intent.objective = IntentFrame.goal`.
- `assumptions = frame.forks[].assumeIfUnasked` non-empty values.
- `doneCriteria = frame.doneWhen`.
- `risk = frame.operationRisk ?? frame.blastRadius ?? classification.risk`.

Also export `buildIntentVersion(input)` from this file. It must be pure, never throw, omit empty optional fields, and cap nothing beyond using already-capped `IntentFrame`.

## 3. File-by-file changes

### `src/interface/ui/intent-store-flag.ts` new
Mirror `src/interface/ui/account-aux-flag.ts:1-24`.

Export:

```ts
export function intentStoreV1Enabled(env: NodeJS.ProcessEnv | undefined): boolean
```

Use the same `ON = ['1','true','on','yes']`, `OFF = ['0','false','off','no']`, default false, catch-all false.

### `src/core/types.ts`
At `OrchestrateDeps` around `src/core/types.ts:347-360`, add optional:

```ts
readonly intentStore?: import('./intent-version.js').IntentStoreWriter;
```

At `SessionEntry` around `src/core/types.ts:125-160`, do not add intent fields; linkage lives in `workTrace`.

### `src/core/intent-version.ts`
Add:
- `IntentVersion`
- `IntentStoreWriter` with `append(version: IntentVersion): Promise<void>`
- `buildIntentVersion({ id, parentId, sessionId, createdAt, rawUserTurnText, frame, risk })`

Guard: require non-empty `id`, `sessionId`, `createdAt`, `rawUserTurnText`, and objective. If objective is empty, return `null`; caller skips the write.

### `src/infra/paths.ts`
After `getLedgerFile` at `src/infra/paths.ts:40`, add:

```ts
export function getIntentVersionsFile(cwd: string): string {
  return join(getStateDir(cwd), 'intent-versions.jsonl');
}
```

### `src/infra/jsonl-guards.ts`
After `isLedgerEntry` or near other JSONL guards, add `isIntentVersion(value): value is IntentVersion`.

Rules:
- require object, `version === 1`, non-empty string `id`, `sessionId`, `createdAt`, `rawUserTurnText`
- `parentId` may be absent, `null`, or non-empty string; blank fails
- require `intent.objective` non-empty string
- optional arrays must be arrays of strings
- optional `doneCriteria`, `confidence`, `source`, `risk` must match current unions
- tolerate old/minimal valid rows with optional fields absent

### `src/infra/intent-store.ts` new
Mirror `src/infra/ledger.ts:20-60`.

Add:
- `createIntentStore({ cwd }): IntentStoreWriter`
- `readIntentVersions(cwd): Promise<IntentVersion[]>`
- `readIntentVersionById(cwd, id): Promise<IntentVersion | null>`

Implementation:
- `append`: `await mkdir(getStateDir(cwd), { recursive: true }); await atomicAppendJSONL(getIntentVersionsFile(cwd), version);`
- `read`: return `[]` on `ENOENT`; skip malformed JSON and rows failing `isIntentVersion`
- `readIntentVersionById`: return the first matching id, else `null`
- Do not add locks or indexes. Do not invent a second persistence mechanism.
- Match ledger/session JSONL append convention. Current ledger/session append path does not set `0o600`; do not alter `atomicAppendJSONL` in this PR.

### `src/core/orchestrate.ts`
Import `buildIntentVersion` near `src/core/orchestrate.ts:48-51`.

Change the PR2 id seam at `src/core/orchestrate.ts:271-276` to:

```ts
const wantsIntentVersionId = depsArg.accountAux === true || depsArg.intentStore !== undefined;
const turnIntentVersionId =
  wantsIntentVersionId ? (depsArg.intentVersionId ?? depsArg.clock.uuid()) : undefined;
```

Single write point: after final `intentFrame` is settled, after possible web/local re-extraction updates at `src/core/orchestrate.ts:674` and `src/core/orchestrate.ts:844`, and before the render-optional `intent` event at `src/core/orchestrate.ts:1102-1103`.

Insert before `src/core/orchestrate.ts:1097`:

```ts
if (depsArg.intentStore !== undefined && turnIntentVersionId !== undefined && intentFrame !== undefined) {
  const version = buildIntentVersion({
    id: turnIntentVersionId,
    parentId: null,
    sessionId: depsArg.session.id,
    createdAt: depsArg.clock.isoNow(),
    rawUserTurnText: task,
    frame: intentFrame,
    risk: classification.risk,
  });
  if (version !== null) {
    await depsArg.intentStore.append(version).catch(() => undefined);
  }
}
```

This is the only store write. Do not write inside `intent-extractor.ts`; it records aux usage only. Do not write from UI event capture; `CoreEvent('intent')` is render-optional.

### `src/core/work-contract.ts`
At `WorkContract` around `src/core/work-contract.ts:97-104`, add:

```ts
readonly intentVersionId?: string;
```

In `capContract` around `src/core/work-contract.ts:373-452`, preserve only a non-empty string. Add helper:

```ts
export function stampContractIntentVersion(c: WorkContract | undefined, id: string | undefined): WorkContract | undefined
```

Return `c` unchanged when `id` is undefined/blank; otherwise return `capContract({ ...c, intentVersionId: id })`.

### `src/core/engagement.ts`
Extend `seedFromIntentAndPlan` at `src/core/engagement.ts:502` with optional `intentVersionId?: string`. Include it in the seed only when passed.

### `src/core/orchestrate.ts` work-contract linkage
At `src/core/orchestrate.ts:1141-1157`, stamp contracts only when store is on:

```ts
const intentStoreLinkId = depsArg.intentStore !== undefined ? turnIntentVersionId : undefined;
```

Pass `intentStoreLinkId` to `seedFromIntentAndPlan`. Include `{ intentVersionId: intentStoreLinkId }` in fallback `capContract({ version: 1, objective: task })` only when defined. Preserve incoming contracts by stamping them with `stampContractIntentVersion(incoming, intentStoreLinkId)`.

### `src/core/ensemble.ts` and `src/core/hedge.ts`
At `src/core/ensemble.ts:1688-1707` and `src/core/hedge.ts:557-570`, use `stampContractIntentVersion` when `deps.intentStore !== undefined`. Generated `capContract({ version: 1, objective: task })` must include `intentVersionId` only on that condition. Review-only contracts at `src/core/work-call.ts:1845-1848` should receive the same treatment.

### `src/core/goal-todo.ts`
At `Goal` around `src/core/goal-todo.ts:102-166`, add:

```ts
readonly intentVersionId?: string;
```

In `capGoal` around `src/core/goal-todo.ts:342-369`, preserve only non-empty string `intentVersionId`.

### `src/infra/goal-store.ts`
At `CreateGoalInput` around `src/infra/goal-store.ts:237-268`, add optional `intentVersionId?: string`.

At create object around `src/infra/goal-store.ts:499-520`, spread it only when present:

```ts
...(input.intentVersionId !== undefined ? { intentVersionId: input.intentVersionId } : {}),
```

No migration. Old goal files omit the field and continue loading.

### `src/interface/auto-stage.ts`
Change `resolveAutoStage` signature at `src/interface/auto-stage.ts:74` and implementation at `src/interface/auto-stage.ts:493` to accept:

```ts
opts?: { intentVersionId?: string; linkIntentVersion?: boolean }
```

Pass `opts?.intentVersionId` to the planner at `src/interface/auto-stage.ts:525` for PR2 aux accounting. Add `intentVersionId` to `goalStore.create` at `src/interface/auto-stage.ts:577` only when `opts?.linkIntentVersion === true`.

### `src/interface/menu.ts`
Import `intentStoreV1Enabled` and `createIntentStore`.

Near `accountAuxOn` at `src/interface/menu.ts:1355-1356`, add:

```ts
const intentStoreOn = intentStoreV1Enabled(process.env);
const intentStore = intentStoreOn ? createIntentStore({ cwd: ctx.cwd }) : undefined;
```

At `buildDeps` around `src/interface/menu.ts:2368`, mint with:

```ts
const intentVersionId = accountAuxOn || intentStoreOn ? ctx.clock.uuid() : undefined;
```

Return:
- PR2 fields exactly when `accountAuxOn`
- `intentVersionId` when minted
- `intentStore` only when `intentStoreOn`

At `src/interface/menu.ts:6248`, call:

```ts
void resolveAutoStage(line, {
  ...(deps.intentVersionId !== undefined ? { intentVersionId: deps.intentVersionId } : {}),
  ...(intentStoreOn ? { linkIntentVersion: true } : {}),
});
```

At draft goal create `src/interface/menu.ts:6275-6285`, add goal `intentVersionId` only when `intentStoreOn && deps.intentVersionId !== undefined`.

Do not populate explicit `/goal` command creates unless an `OrchestrateDeps` with store-backed `intentVersionId` is already in scope.

### `src/cli.ts`
Import `intentStoreV1Enabled` and `createIntentStore`.

At `buildDeps` around `src/cli.ts:298-309`:

```ts
const accountAuxOn = accountAuxEnabled(process.env);
const intentStoreOn = intentStoreV1Enabled(process.env);
const intentStore = intentStoreOn ? createIntentStore({ cwd }) : undefined;
const intentVersionId = accountAuxOn || intentStoreOn ? systemClock.uuid() : undefined;
```

Return `intentStore` only when on. Keep `accountAux: true` only when `accountAuxOn`.

## 4. Tests

Add/update:

- `test/unit/intent-store-flag.test.ts`
  - `intentStoreV1Enabled absent env returns false`
  - `intentStoreV1Enabled accepts trimmed case-insensitive opt-in values`
  - `intentStoreV1Enabled returns false for opt-out and ambiguous values`
  - `intentStoreV1Enabled never throws and defaults false on hostile env`

- `test/unit/intent-store.test.ts`
  - `createIntentStore writes and readIntentVersionById returns the matching version`
  - `readIntentVersions returns empty for missing file`
  - `readIntentVersions skips malformed and wrong-shape rows`

- `test/unit/jsonl-guards.test.ts`
  - `valid intent version passes`
  - `minimal old intent version row passes`
  - `intent version with blank id fails`
  - `intent version with malformed parentId fails`
  - `intent version with malformed intent payload fails`

- `test/unit/orchestrate-intent-store.test.ts`
  - `intent store on writes exactly one version for a captured turn intent`
  - `intent store on uses the same id threaded through deps`
  - `intent store off writes no versions and leaves PR2 account-aux behavior unchanged`
  - `re-extraction still writes one final intent version`

- `test/unit/goal-store.test.ts`
  - `create preserves intentVersionId when provided`
  - `create omits absent intentVersionId`
  - `capGoal drops blank intentVersionId`

- `test/unit/work-contract.test.ts`
  - `capContract preserves valid intentVersionId`
  - `capContract drops blank intentVersionId`
  - `stampContractIntentVersion adds id only when provided`

- `test/unit/goal-plan-autostage.test.ts`
  - `auto-stage links created goal intentVersionId when linkIntentVersion is true`
  - `auto-stage omits goal intentVersionId when linkIntentVersion is false but still passes id to planner`

## 5. Verification

Run:

```powershell
npm run typecheck
node --import tsx/esm --test test/unit/intent-store-flag.test.ts test/unit/intent-store.test.ts
node --import tsx/esm --test test/unit/jsonl-guards.test.ts test/unit/orchestrate-intent-store.test.ts
node --import tsx/esm --test test/unit/goal-store.test.ts test/unit/work-contract.test.ts test/unit/goal-plan-autostage.test.ts
node --import tsx/esm --test test/unit/orchestrate-account-aux.test.ts test/unit/ledger.test.ts test/unit/session.test.ts
```

Success criteria:
- `npm run typecheck` passes.
- Targeted tests pass.
- If broader suites run, compare exact failing test names against `main`; zero NEW failures by name diff. Do not compare raw failure count.

## 6. Ordered checklist

1. Add `intent-store-flag.ts` and flag tests.
2. Add `IntentVersion`, builder, and writer interface in `src/core/intent-version.ts`.
3. Add `getIntentVersionsFile`.
4. Add `isIntentVersion`.
5. Add `src/infra/intent-store.ts`.
6. Add optional `intentStore` to `OrchestrateDeps`.
7. Change `orchestrate` id mint condition to `accountAux || intentStore`.
8. Add the single store write before the `intent` event.
9. Add work-contract `intentVersionId` support and stamping helper.
10. Stamp orchestrate, hedge, ensemble, and review contracts only when store is on.
11. Add goal `intentVersionId` support in type, cap, and store create.
12. Update auto-stage signature so aux id passing and goal linkage are separate.
13. Wire menu and CLI composition roots.
14. Add focused tests.
15. Run verification commands and name-diff any broader failures.

## 7. Risks and safe defaults

- Single-write point: write only in `orchestrate` after final `intentFrame` stabilization and before descendants run. Never write in extractor or UI event capture.
- Store ON + account-aux OFF: mint id, write store, link goals/contracts; do not stamp ledger entries because `accountAux` remains false.
- Store OFF + account-aux ON: preserve PR2 exactly; id is correlation-only, no store or goal/contract linkage.
- Store write failure: swallow after attempted append; the turn must continue.
- Parentage: write `parentId: null` only; PR4 owns forks/corrections.
- No backfill: old sessions, goals, contracts, and ledgers remain valid with absent fields.