Read-only note: I could not write `docs/pr2-account-aux-plan.md` in this session. Use the following as the exact file content.

# MYSHELL_ACCOUNT_AUX PR Plan

## 1. Goal

Ship `MYSHELL_ACCOUNT_AUX` default-off. When ON, ledger auxiliary model calls that are currently invisible and stamp ledger entries with `stage` plus a first `intentVersionId` correlation seam.

OFF guarantee: when `MYSHELL_ACCOUNT_AUX` is absent, false, `0`, `off`, or `no`, no auxiliary ledger entries are written, existing work ledger entries do not include `stage` or `intentVersionId`, route/intent/generator return shapes stay compatible, and routing-memory input is unchanged. Do not set optional keys to `undefined`; omit them.

## 2. File-by-file changes

### `src/interface/ui/account-aux-flag.ts` new

Mirror `src/interface/ui/cache-accounting-flag.ts:9-24`.

Add:
```ts
const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export function accountAuxEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  try {
    const raw = env?.['MYSHELL_ACCOUNT_AUX'];
    if (typeof raw === 'string') {
      const cleaned = raw.trim().toLowerCase();
      if (ON.has(cleaned)) return true;
      if (OFF.has(cleaned)) return false;
    }
    return false;
  } catch {
    return false;
  }
}
```

Off guard: default false.

### `src/core/types.ts`

At `LedgerEntry` (`src/core/types.ts:167-203`), add:
```ts
export type LedgerStage =
  | 'work'
  | 'route'
  | 'intent'
  | 'reextract-web'
  | 'reextract-local'
  | 'recap'
  | 'understanding'
  | 'autostage'
  | 'review'
  | 'judgment'
  | 'tribunal'
  | 'escalation';
```

Add optional fields to `LedgerEntry` after `cacheWriteInputTokens?: number`:
```ts
readonly stage?: LedgerStage;
readonly intentVersionId?: string;
```

At `OrchestrateDeps` (`src/core/types.ts:331-343`), add:
```ts
readonly accountAux?: boolean;
readonly intentVersionId?: string;
```

Off guard: type-only unless composition roots set `accountAux: true`.

### `src/infra/jsonl-guards.ts`

At `isLedgerEntry` (`src/infra/jsonl-guards.ts:134-193`), accept absent new fields and validate present values:
```ts
const stage = value['stage'];
if (
  stage !== undefined &&
  stage !== 'work' &&
  stage !== 'route' &&
  stage !== 'intent' &&
  stage !== 'reextract-web' &&
  stage !== 'reextract-local' &&
  stage !== 'recap' &&
  stage !== 'understanding' &&
  stage !== 'autostage' &&
  stage !== 'review' &&
  stage !== 'judgment' &&
  stage !== 'tribunal' &&
  stage !== 'escalation'
) return false;

const intentVersionId = value['intentVersionId'];
if (
  intentVersionId !== undefined &&
  (typeof intentVersionId !== 'string' || intentVersionId.trim().length === 0)
) return false;
```

Also fix verified drift in the same guard: `TaskKind` includes `'judgment'` at `src/core/model-capabilities.ts:126-141`, but `jsonl-guards.ts:180-190` does not. Add `taskKind !== 'judgment'` to the accepted list.

### `src/core/aux-ledger.ts` new

Create one helper to avoid duplicated cost logic.

Inputs:
```ts
recordAuxLedger({
  enabled: boolean;
  ledger?: LedgerWriter;
  clock?: Clock;
  sessionId?: string;
  cacheAccountingV2?: boolean;
  intentVersionId?: string;
  stage: LedgerStage;
  provider: ProviderId;
  model: string;
  tier: Tier;
  usage?: Usage;
  providerCostUsd?: number;
  durationMs: number;
  success: boolean;
}): Promise<void>
```

Behavior:
- Return immediately unless `enabled === true && ledger && clock && sessionId`.
- `usd = providerCostUsd ?? effective/local estimate ?? 0`.
- Use `calculateEffectiveCost` only when `cacheAccountingV2 === true`; otherwise use `calculateCost`.
- Record:
  - `timestamp: clock.isoNow()`
  - `sessionId`
  - `taskId: clock.uuid()`
  - provider/model/tier
  - `inputTokens/outputTokens/cachedInputTokens` from usage, defaulting to `0`
  - `cacheWriteInputTokens` only when `cacheAccountingV2 === true && usage?.cacheWriteInputTokens !== undefined`
  - `stage`
  - `intentVersionId` only when present
  - `durationMs`, `success`, `usd`

### `src/core/router.ts`

At `ModelClassifier` (`src/core/router.ts:59-62`), add optional context:
```ts
opts?: { readonly stage?: LedgerStage; readonly intentVersionId?: string }
```

At `decideRoute` (`src/core/router.ts:202-218`), extend opts with `intentVersionId?: string` and call:
```ts
suggestion = await opts.classifier(task, opts.signal, {
  stage: 'route',
  ...(opts.intentVersionId !== undefined ? { intentVersionId: opts.intentVersionId } : {}),
});
```

Off guard: no caller passes `intentVersionId` unless account-aux is on.

### `src/core/route-classifier.ts`

At `RouteClassifierDeps` (`src/core/route-classifier.ts:26-34`), add optional:
```ts
readonly accountAux?: boolean;
readonly ledger?: LedgerWriter;
readonly clock?: Clock;
readonly sessionId?: string;
readonly cacheAccountingV2?: boolean;
```

At provider loop (`src/core/route-classifier.ts:84-93`):
- Capture `const startMs = deps.clock?.now();` before `provider.run`.
- Capture `usage`, `providerCostUsd`, and terminal success.
- Parse after loop into `suggestion`.
- Call `recordAuxLedger` with stage `opts?.stage ?? 'route'`, `success: suggestion !== null`, duration from clock when available.
- Keep returning `parseModelRoute(finalText)` behavior. On caught errors, record a failed route entry with zero usage only if a provider run was attempted and aux deps are present.

### `src/core/intent.ts`

At `IntentUsage` (`src/core/intent.ts:114-117`), add optional cache fields:
```ts
readonly cachedInputTokens?: number;
readonly cacheWriteInputTokens?: number;
```

At `IntentExtractor` (`src/core/intent.ts:137-140`), add optional context:
```ts
opts?: { readonly stage?: LedgerStage; readonly intentVersionId?: string }
```

### `src/core/intent-extractor.ts`

At `IntentExtractorDeps` (`src/core/intent-extractor.ts:29-37`), add the same optional aux deps as route-classifier.

At `usage` capture (`src/core/intent-extractor.ts:96-106`), keep full usage:
```ts
let usage: Usage | undefined;
```
Return it structurally as `IntentUsage`.

After parsing (`src/core/intent-extractor.ts:112-129`), call `recordAuxLedger` with:
- `stage: opts?.stage ?? 'intent'`
- `success: frame !== null`
- provider/model/tier `INTENT_TIER`
- provider cost from `done.costUsd` when present.

### `src/core/orchestrate.ts`

Near orchestrate entry before preflight (`src/core/orchestrate.ts:204-220`), create the seam:
```ts
const turnIntentVersionId =
  depsArg.accountAux === true ? (depsArg.intentVersionId ?? depsArg.clock.uuid()) : undefined;
```

Use it in preflight calls:
- Unified path `src/core/orchestrate.ts:329`:
```ts
await depsArg.intentExtractor(task, signal, { stage: 'intent', intentVersionId: turnIntentVersionId })
```
- `decideRoute` call `src/core/orchestrate.ts:358-360`: pass `intentVersionId: turnIntentVersionId`.
- Non-unified intent `src/core/orchestrate.ts:399`: same `{ stage: 'intent', ... }`.
- Web re-extract `src/core/orchestrate.ts:635`: pass `{ stage: 'reextract-web', intentVersionId: turnIntentVersionId }`.
- Local re-extract `src/core/orchestrate.ts:777`: pass `{ stage: 'reextract-local', intentVersionId: turnIntentVersionId }`.

After the existing `const deps: OrchestrateDeps = ...` block around `src/core/orchestrate.ts:1082`, wrap:
```ts
const depsWithIntent =
  turnIntentVersionId !== undefined ? { ...deps, intentVersionId: turnIntentVersionId } : deps;
```
Use `depsWithIntent` for `runJudgmentPoll`, `runTribunal`, `runPanel`, `runHedged`, and `runWorkCall`.

### Work ledger stamping

In every existing ledger write, add:
```ts
...(deps.accountAux === true ? { stage: '<stage>' as const } : {}),
...(deps.accountAux === true && deps.intentVersionId !== undefined
  ? { intentVersionId: deps.intentVersionId }
  : {}),
```

Exact stages:
- `src/core/work-call.ts`: main provider attempts at `:948` and `:1360` use `work`; critic/reviewer entries at `:794` and `:1926` use `review`.
- `src/core/ensemble.ts`: candidate/synth/repair entries at `:1508`, `:1853`, `:2141` use `work`; critic entry at `:2020` uses `review`.
- `src/core/hedge.ts`: primary/speculative/repair entries at `:611`, `:875` use `work`; critic entry at `:724` uses `review`.
- `src/core/judgment-poll.ts:512` use `judgment`.
- `src/core/tribunal.ts:614` use `tribunal`.

Off guard: spreads are gated by `deps.accountAux === true`.

### Aux generators

Update these deps interfaces with optional aux deps and call `recordAuxLedger` around `provider.run`:
- `src/core/recap-generator.ts:30-39`, provider loop `:103-112`, stage `recap`.
- `src/core/understanding-generator.ts:93-150`, stage `understanding`.
- `src/core/goal-plan-generator.ts:31-53`, provider loop `:135-150`, stage `autostage`.

For `goal-plan-generator`, extend returned planner functions to accept optional `{ intentVersionId?: string }`.

Do not include goal-objective, replanner, or strong-meta critique in this PR unless tests show a direct compile requirement. They are real future aux-accounting work, but not required for PR2’s named scope.

### `src/interface/menu.ts`

Import `accountAuxEnabled`.

After `accountingLedger` (`src/interface/menu.ts:1307-1310`), compute per-call helper fields where needed:
```ts
const accountAuxOn = accountAuxEnabled(process.env);
const cacheAccountingOn = cacheAccountingV2Enabled(process.env);
```

Thread optional aux deps into:
- `makeRouteClassifier` at `src/interface/menu.ts:2200-2208`.
- `makeIntentExtractor` at `src/interface/menu.ts:2221-2233`.
- `makeRecapGenerator` at `src/interface/menu.ts:740-744`.
- `makeUnderstandingPass` at `src/interface/menu.ts:990-1000`.
- `makeGoalPlanner` / `makeGoalPlannerAttempt` at `src/interface/menu.ts:837-849` and `:879-890`.

Only include aux deps when `accountAuxOn`:
```ts
...(accountAuxOn
  ? {
      accountAux: true,
      ledger: accountingLedger,
      clock: ctx.clock,
      sessionId: convId,
      ...(cacheAccountingOn ? { cacheAccountingV2: true } : {}),
    }
  : {})
```

In per-turn `buildDeps` (`src/interface/menu.ts:2074` and return `:2310-2315`), if `accountAuxOn`, mint:
```ts
const intentVersionId = ctx.clock.uuid();
```
and include:
```ts
...(accountAuxOn ? { accountAux: true, intentVersionId } : {})
```

At post-turn auto-stage call (`src/interface/menu.ts:6185`), pass the completed turn id:
```ts
void resolveAutoStage(line, deps.intentVersionId);
```

Update `src/interface/auto-stage.ts`:
- `AutoStageEngine.resolveAutoStage` signature at `:74` to `(line: string, intentVersionId?: string) => Promise<void>`.
- `GoalPlanner` type at `:77` to accept optional opts.
- Planner calls at `:233`, `:371`, `:524` pass `{ intentVersionId }` when available.
- Understanding warm calls may omit `intentVersionId`; they are cache-ahead and not necessarily attributable to a specific accepted turn.

### `src/cli.ts`

Import `accountAuxEnabled`.

In `buildDeps` (`src/cli.ts:220-301`), avoid inline session/ledger construction:
```ts
const ledger = createLedger({ cwd });
const session = createSessionWriter({ cwd, id: systemClock.uuid() });
const accountAuxOn = accountAuxEnabled(process.env);
const intentVersionId = accountAuxOn ? systemClock.uuid() : undefined;
```
Return `session`, `ledger`, and:
```ts
...(accountAuxOn ? { accountAux: true, intentVersionId } : {})
```

In REPL extractor construction (`src/cli.ts:1012-1031`), pass aux deps from `baseDeps` only when `baseDeps.accountAux === true`.

## 3. Stage vocabulary and learner guard

Vocabulary:
`work`, `route`, `intent`, `reextract-web`, `reextract-local`, `recap`, `understanding`, `autostage`, `review`, `judgment`, `tribunal`, `escalation`.

Routing-memory exact exclusion:
- In `computeTierStats` loop (`src/core/routing-memory.ts:76-94`), add before tier check:
```ts
if (entry.stage !== undefined && entry.stage !== 'work') continue;
```
- In `computeModelOutcomeStats` loop (`src/core/routing-memory.ts:238-248`), add the same guard before `taskKindOf(entry)`.

This preserves old rows with absent `stage` and excludes new aux/non-work rows.

## 4. IntentVersionId seam

No stable intent id exists today; `IntentFrame.version` at `src/core/intent.ts:45-46` is a schema version only.

Minimal seam:
- Per turn, `buildDeps` may pre-mint `intentVersionId` when `MYSHELL_ACCOUNT_AUX` is on so menu post-turn auto-stage can reuse it.
- `orchestrate` owns the fallback: if `depsArg.accountAux === true` and no id was provided, generate `depsArg.clock.uuid()` at entry.
- Stamp all ledger entries generated during that turn with the same id.
- Recap/cache-ahead understanding may omit `intentVersionId` when not tied to a live turn.

PR3 will replace this correlation id with a durable intent store id.

## 5. Tests

Add or update:

- `test/unit/account-aux-flag.test.ts`
  - `accountAuxEnabled absent env returns false`
  - `accountAuxEnabled accepts trimmed case-insensitive opt-in values`
  - `accountAuxEnabled returns false for opt-out and ambiguous values`
  - `accountAuxEnabled never throws and defaults false on hostile env`

- `test/unit/route-classifier.test.ts`
  - `MYSHELL_ACCOUNT_AUX off records no route ledger entry`
  - `MYSHELL_ACCOUNT_AUX on records route stage usage cost and intentVersionId`

- `test/unit/intent-extractor.test.ts`
  - `MYSHELL_ACCOUNT_AUX on records intent stage with usage`
  - `intent extractor records caller-provided reextract stage`

- `test/unit/orchestrate-account-aux.test.ts`
  - `account aux on correlates intent and work ledger entries with one intentVersionId`
  - `account aux off leaves work ledger entries without stage or intentVersionId`

- `test/unit/routing-memory.test.ts`
  - `learnProviderOrder ignores non-work staged entries`
  - `learnModelOutcomeOrder ignores non-work staged entries`

- `test/unit/jsonl-guards.test.ts`
  - `valid ledger with stage and intentVersionId passes`
  - `ledger without stage and intentVersionId still passes`
  - `ledger with unknown stage fails`
  - `ledger with blank intentVersionId fails`
  - `ledger with taskKind judgment passes`

- `test/unit/ledger.test.ts`
  - extend `preserves all LedgerEntry fields round-trip` with `stage: 'intent'` and `intentVersionId`.

- `test/unit/work-call-prior-cost.test.ts`
  - `accountAux off omits stage and intentVersionId from work-call ledger entry`
  - `accountAux on stamps work stage and intentVersionId on work-call ledger entry`

- `test/unit/recap-generator.test.ts`
  - `accountAux on records recap stage`
  - `accountAux off records no recap entry`

- New `test/unit/understanding-generator.test.ts`
  - `accountAux on records understanding stage`

## 6. Verification

Run from repo root:

```powershell
npm run typecheck
node --import tsx/esm --test test/unit/account-aux-flag.test.ts
node --import tsx/esm --test test/unit/route-classifier.test.ts test/unit/intent-extractor.test.ts
node --import tsx/esm --test test/unit/orchestrate-account-aux.test.ts test/unit/orchestrate-brain.test.ts
node --import tsx/esm --test test/unit/routing-memory.test.ts test/unit/jsonl-guards.test.ts test/unit/ledger.test.ts test/unit/work-call-prior-cost.test.ts
node --import tsx/esm --test test/unit/recap-generator.test.ts test/unit/understanding-generator.test.ts
```

Success criteria:
- `npm run typecheck` passes.
- All targeted tests pass.
- If running broader suites, zero NEW failures by exact test-name diff vs `main`; do not compare raw failure counts because Windows/flaky failures pre-exist.

## 7. Ordered checklist

1. Add `account-aux-flag.ts` and flag tests.
2. Add `LedgerStage`, `stage`, `intentVersionId`, `accountAux`, and guard validation.
3. Add `src/core/aux-ledger.ts`.
4. Update router/classifier and intent extractor signatures.
5. Ledger route and intent extractor calls behind optional aux deps.
6. Mint/thread `intentVersionId` through orchestrate.
7. Stamp work/review/judgment/tribunal ledger entries behind `accountAux`.
8. Add routing-memory non-work exclusion guard.
9. Add recap, understanding, and goal-plan autostage aux ledger support.
10. Wire menu and CLI composition roots.
11. Add focused tests.
12. Run verification commands.

## 8. Risks and safe defaults

- If a model call returns no usage, record `0` token fields rather than fabricating estimates; prefer provider `costUsd` when present.
- If `ledger`, `clock`, or `sessionId` is missing, do not record aux entries.
- Old ledger rows without `stage` remain valid and continue feeding routing memory.
- New rows with any stage other than `work` must never feed routing-memory learning.
- Do not expand this PR into the full intent store. `intentVersionId` is only a turn correlation id for now.
- Do not ledger goal-objective, replanner, or strong-meta critique unless needed for compile/test fallout; note them as future aux stages.