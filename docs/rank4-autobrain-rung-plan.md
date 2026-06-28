Filesystem is read-only in this session, so I did not write the file. This is the exact content for `docs/rank4-autobrain-rung-plan.md`.

```markdown
# Rank 4 Auto-Brain Rung Plan

## 1. Goal

For a non-hard, low-risk turn where deterministic `classify()` returns `tier: 'worker'`, `fuseRung()` must keep the committed rung at `budget` / `modelRung: 'worker'` when there is no stronger explicit `routeTier`, byproduct difficulty, elevated risk, or escalation signal.

This is a default behavior change, not flag-gated. Do not lower hard, risky, `ic`, `manager`, explicit `routeTier`, or byproduct-difficult turns. Those must keep today’s up-rung behavior.

## 2. Root Cause Trace

Verified path:

- `src/core/orchestrate.ts:941-955` re-fuses auto-brain with full signals and assigns `autoBrainTier = autoBrainResult.rung.modelRung`.
- `src/core/orchestrate.ts:1945` uses `autoBrainTier` instead of `classification.tier` for `currentTier`.
- `src/core/orchestrate.ts:2086` passes that as `startTier` into `runWorkCall`.
- `src/core/auto-brain.ts:379-381` only derives `byproductLevel` from `frame?.routeTier`.
- With no `routeTier`, `src/core/auto-brain.ts:387-394` calls `resolveLevel({ chosen: 'auto' })` with no `routeHint`.
- `src/core/mode-levels.ts:497-514` falls through to the safety net `return 'balanced'`.
- `src/core/mode-levels.ts:374-378` maps `balanced` to `modelRung: 'ic'`; `src/core/mode-levels.ts:364-368` is the desired `budget` → `modelRung: 'worker'`.
- Once the rung is `ic`, `src/core/policy.ts:49-52` uses Claude-first IC order and `src/core/route.ts:463-470` picks the first authenticated provider.
- If the rung stays `worker`, `src/core/policy.ts:49-50` prefers `opencode` first for worker.

## 3. File-by-File Change

### `src/core/auto-brain.ts`

Anchor: non-hard branch at `src/core/auto-brain.ts:373-402`.

Make the change there only. Do not refactor `mode-levels.ts`.

Replace the current “only byproduct routeTier can create a routeHint” behavior with:

```ts
const byproductLevel =
  frame?.routeTier !== undefined ? tierToLevel(frame.routeTier) : undefined;

const hasElevatedByproductRisk =
  frame?.operationRisk === 'medium' ||
  frame?.operationRisk === 'high' ||
  frame?.operationRisk === 'critical' ||
  frame?.blastRadius === 'medium' ||
  frame?.blastRadius === 'high' ||
  frame?.blastRadius === 'critical';

const classifiedWorkerLevel =
  byproductLevel === undefined &&
  classifyTier === 'worker' &&
  classifyRisk === 'low' &&
  shape !== 'fix-bug' &&
  shape !== 'big-build' &&
  !hasElevatedByproductRisk
    ? 'budget'
    : undefined;

const suggestedLevel = byproductLevel ?? classifiedWorkerLevel;
```

Then pass `suggestedLevel` into `resolveLevel`:

```ts
...(suggestedLevel !== undefined
  ? { routeHint: { suggestedLevel, floor: 'budget' } }
  : {}),
```

Keep `reason = buildReason(shape, classifyTier, classifyRisk, byproductLevel, committed);` so receipts do not mislabel a classification-derived budget hint as a byproduct.

### `src/core/mode-levels.ts`

No code change. Keep `resolveLevel()`’s generic no-signal fallback to `balanced` at `src/core/mode-levels.ts:513-514`; the fix is that `fuseRung()` must supply a route hint for low-risk worker classifications.

## 4. Test Reconciliation

Update expectations, do not delete or weaken tests.

- `test/unit/auto-brain.test.ts:234-238`
  - Rename from “routes to budget or balanced” to “routes to budget”.
  - Assert `result.rung.level === 'budget'`.
  - Add `assert.equal(result.rung.modelRung, 'worker')`.

- Add a new unit test near `test/unit/auto-brain.test.ts:234`:
  - `fuseRung({ classifyTier: 'worker', classifyRisk: 'low' })`
  - Assert `rung.level === 'budget'`, `rung.modelRung === 'worker'`, and `predictAndCommit === false`.

- Add a boundary test in the same block:
  - `fuseRung({ frame: makeFrame({ kind: 'fix bug', source: 'model' }), classifyTier: 'worker', classifyRisk: 'low' })`
  - Assert it is not forced to worker/budget by the new fallback; expected `balanced` unless existing behavior says higher.

- `test/unit/auto-brain-routing.test.ts:79-91`
  - Change “budget or balanced” to exact `budget`.
  - Assert `result.rung.modelRung === 'worker'`.

- `test/unit/auto-brain-routing.test.ts:122`
  - Change receipt expectation from `cheap || moderate` to `cheap`.

Leave these unchanged:
- `test/unit/auto-brain-routing.test.ts:182-193` fix-bug with IC route/risk stays `balanced | high | max`, never `budget`.
- Hard-turn tests around `test/unit/auto-brain.test.ts:210-231` remain unchanged.
- `test/unit/auto-brain.test.ts:350-355` IC medium remains balanced.

## 5. Verification

Run:

```sh
npm run typecheck
node --import tsx/esm --test test/unit/auto-brain.test.ts test/unit/auto-brain-routing.test.ts test/unit/classify.test.ts test/unit/route.test.ts test/unit/policy-presets.test.ts
find test/unit test/arch test/contract -name '*.test.ts' | sort | xargs node --import tsx/esm --test
npm run build
node dist/cli.js run "Reply with exactly: SPINE_OK"
```

Success criteria:

- `tsc --noEmit` is clean.
- Full-suite name-diff against the existing Windows/flaky baseline shows zero new failures; raw count may still be about the existing ~33 failures.
- Empirical: after the smoke run, `.myshell-tools/ledger.jsonl` has the work entry for `Reply with exactly: SPINE_OK` with `provider: "opencode"` and `tier: "worker"`, near-zero cost. It must not be `provider: "claude"` / `tier: "ic"`.

## 6. Ordered Checklist

1. Read the existing tests above and confirm current expectations.
2. Patch only `src/core/auto-brain.ts` non-hard `fuseRung()` route-hint construction.
3. Update auto-brain tests from permissive `budget || balanced` to exact worker/budget where appropriate.
4. Add the no-frame worker/low regression test.
5. Add the byproduct-difficulty boundary test.
6. Run targeted tests.
7. Run `npm run typecheck`.
8. Run the full-suite name-diff command.
9. Build and run the empirical `SPINE_OK` smoke.
10. Inspect `.myshell-tools/ledger.jsonl` and confirm provider/tier/cost.

## 7. Risks and Safe Defaults

Main risk: accidentally making ambiguous or medium-risk worker classifications too cheap. Safe default: only synthesize `budget` when `classifyTier === 'worker'` and `classifyRisk === 'low'`, with no explicit `routeTier`, no `fix-bug` / `big-build` shape, and no medium/high/critical byproduct risk.

Do not change `resolveLevel()`’s global fallback. That fallback is still correct for callers with truly absent signals. This fix is specifically about `fuseRung()` failing to honor an already-known low-risk worker classification.
```