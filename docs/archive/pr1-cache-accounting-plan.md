I could not save `docs/pr1-cache-accounting-plan.md` because this session is read-only. Below is the exact plan content.

# MYSHELL_CACHE_ACCOUNTING_V2 PR Plan

Goal: ship `MYSHELL_CACHE_ACCOUNTING_V2` default-off so the live intelligence layer records cache-write tokens and can report cache-aware effective cost without changing today’s behavior when the flag is off. Off guarantee: with the flag absent, false, `0`, `off`, or `no`, provider parsing may expose the optional field internally, but ledger entries omit `cacheWriteInputTokens`, local `usd` estimation keeps using today’s `calculateCost(inputTokens, outputTokens, pricing)`, and `myshell-tools cost` output is byte-identical to current output. Step 0 is a no-flag source-comment truth fix only.

## File-By-File Changes

### Step 0: comment-truth fixes, no behavior changes

- `src/core/auto-brain.ts`
  - Lines 35-42, 48-50, 492, 540-541, 584-585: remove claims that Layer B is “stubbed, not yet wired” or default-off in production. State that the pure legacy helpers remain tested helpers, and the live within-turn Layer B path is `decideLayerBEscalation`, wired through `src/core/work-call.ts:1012-1064` when Auto Brain committed a rung.
  - Off guard: comment-only.

- `src/interface/ui/auto-brain-flag.ts`
  - Lines 7-18 and 30-33: keep function behavior unchanged, but clarify this pure helper is default-false for neutrality tests and is composed by `experimentalEnabledByDefault` in production, making Auto Brain default-on unless explicitly disabled/basic-mode.
  - Off guard: comment-only.

- `src/interface/menu.ts`
  - Lines 2392-2406: replace “DEFAULT OFF” and “SCAFFOLDING ONLY: orchestrate does NOT read” with current truth: menu injects `autoBrainRungTuple` by default via `experimentalEnabledByDefault`; `orchestrate` reads it at `src/core/orchestrate.ts:898`; Layer B is threaded at `orchestrate.ts:1950-1953`.
  - Lines 2440-2447, 5904-5908, 6200-6205: update draft-goals comments to say production composition is default-on, the post-turn slot reads the captured intent frame and creates parked draft goals, and explicit off/basic-mode restores absence.
  - Off guard: comment-only.

- `src/core/orchestrate.ts`
  - Lines 880-893: update Auto Brain comment from default-off/Layer-B-not-wired to production default-on composition and Layer B threaded into `runWorkCall`.
  - Off guard: comment-only.

- `src/infra/config.ts`
  - Lines 491-502 and 506-520: clarify `experimentalDraftGoals` and `experimentalAutoBrain` are config opt-in fields consumed by default-on composition; absent config no longer means production-off because `experimentalEnabledByDefault` supplies the default-on value.
  - Off guard: comment-only.

- `src/core/types.ts`
  - Lines 925-937 and 953-968: update `autoBrainRungTuple` and `draftGoals` comments. Auto Brain is read by orchestrate now; draft goals are consumed by the menu post-turn slot. Leave still-true `roleMapping` and `levelProfile` comments unchanged unless only adjacent wording references Auto Brain or draft goals incorrectly.
  - Off guard: comment-only.

- `src/core/intent.ts`
  - Lines 101-104: replace “default-OFF draftGoalsEnabled” with “pure helper is default-false; production menu composes it default-on; field is absent when explicitly off/basic-mode.”
  - Off guard: comment-only.

- `src/core/governor.ts`
  - Lines 27-39, 227, 663-670: remove stale claims that verification, judgment poll, and Tribunal are inactive or `verify` is always `none`. State verification/poll/Tribunal are active levers; concurrency remains `1`.
  - Off guard: comment-only.

### Flag and types

- `src/interface/ui/cache-accounting-flag.ts`
  - Add new pure helper:
    - `const ON = new Set(['1', 'true', 'on', 'yes'])`
    - `const OFF = new Set(['0', 'false', 'off', 'no'])`
    - `export function cacheAccountingV2Enabled(env: NodeJS.ProcessEnv | undefined): boolean`
    - Trim and lowercase env value from `MYSHELL_CACHE_ACCOUNTING_V2`.
    - Return true only for ON. Return false for OFF, absent, ambiguous values, or exceptions.
  - Off guard: default false.

- `src/providers/port.ts`
  - At `Usage` lines 28-32 add `readonly cacheWriteInputTokens?: number;`.
  - Off guard: optional type only.

- `src/core/types.ts`
  - At `LedgerEntry` lines 167-202 add optional `readonly cacheWriteInputTokens?: number;` after `cachedInputTokens`.
  - At `OrchestrateDeps` after `ledger` or near other optional feature seams add `readonly cacheAccountingV2?: boolean;` with a comment: absent/false means no ledger cache-write field and old cost math.
  - Off guard: optional fields only.

- `src/infra/jsonl-guards.ts`
  - In `isLedgerEntry` after lines 149-153, accept absent `cacheWriteInputTokens`; if present require finite number.
  - Off guard: old ledger rows still pass.

### Parser mapping

- `src/providers/claude-parse.ts`
  - In `mapUsage` lines 61-74, include both optional fields with conditional spreads:
    - `cachedInputTokens` from `cache_read_input_tokens`
    - `cacheWriteInputTokens` from `cache_creation_input_tokens`
  - Do not set either key when the wire value is missing.
  - Off guard: field is optional and unused by ledger/report unless flag is on.

- `src/providers/opencode-parse.ts`
  - `WireStepFinishTokens` already has `tokens.cache.write` at lines 53-55.
  - In `mapUsage` lines 104-117, conditionally include `cacheWriteInputTokens` from `tokens.cache?.write` and `cachedInputTokens` from `tokens.cache?.read`.
  - In `createOpencodeParser` add `accumulatedCacheWriteInputTokens` beside line 157, accumulate it beside lines 235-238, include it in the empty-output check near line 271, and conditionally include it in final `usage` near lines 287-296.
  - Off guard: optional parser field only.

### Pricing and cost report

- `src/infra/pricing.ts`
  - In `ModelPricing` lines 17-25 add optional:
    - `readonly cacheReadInputPer1M?: number;`
    - `readonly cacheWriteInputPer1M?: number;`
    - `readonly cacheInputTokensIncludedInInput?: boolean;`
  - For Claude rows lines 47-70 set read rate to `inputPer1M * 0.1`, write rate to `inputPer1M * 1.25`, and `cacheInputTokensIncludedInInput: false`.
  - For Codex/OpenAI rows lines 76-117 set read rate to `inputPer1M * 0.1` and `cacheInputTokensIncludedInInput: true`. Do not add write rate unless Codex parser gains a write bucket.
  - Add `calculateEffectiveCost` beside `calculateCost` lines 219-227:
    - If no cache rates are present, return `calculateCost`.
    - Let `read = cache.cachedInputTokens ?? 0`, `write = cache.cacheWriteInputTokens ?? 0`.
    - If `cacheInputTokensIncludedInInput === true`, normal input is `Math.max(0, inputTokens - read - write)`.
    - Otherwise normal input is `inputTokens`.
    - Price normal input at `inputPer1M`, reads at `cacheReadInputPer1M ?? inputPer1M`, writes at `cacheWriteInputPer1M ?? inputPer1M`, output at `outputPer1M`.
  - Off guard: existing `calculateCost` unchanged; callers use effective function only when flag is on.

- `src/commands/cost.ts`
  - Import `cacheAccountingV2Enabled` and `calculateEffectiveCost`.
  - Change `formatCostReport(entries, color = false)` to `formatCostReport(entries, color = false, opts?: { cacheAccountingV2?: boolean })`; default preserves current output.
  - Lines 58-68: keep existing routed/flagship list-price ratio logic unchanged.
  - When `opts.cacheAccountingV2 === true`, add a separate “Cache accounting” section after usage/per-model lines that shows total cache reads, total cache writes, cache-aware effective estimate, and naive list estimate. Label dollar figures as “list-pricing estimate, not a subscription bill.”
  - `runCost` line 145 should call `formatCostReport(entries, out.color, { cacheAccountingV2: cacheAccountingV2Enabled(process.env) })`.
  - Off guard: default `formatCostReport` call emits exactly current lines.

### Flag wiring

- `src/cli.ts`
  - Import `cacheAccountingV2Enabled` near existing UI flag imports around lines 86-88.
  - In `buildDeps` return object lines 296-324, add `...(cacheAccountingV2Enabled(process.env) ? { cacheAccountingV2: true } : {})`.
  - Off guard: absent field when flag is off.

- `src/interface/menu.ts`
  - Import `cacheAccountingV2Enabled` near line 231.
  - In `buildDeps` return object starting line 2309, add `...(cacheAccountingV2Enabled(process.env) ? { cacheAccountingV2: true } : {})` near `ledger`/`policy`.
  - Off guard: absent field when flag is off.

### Ledger writes and local cost fallback

Update every current core ledger write found by `rg -n "cachedInputTokens:" src/core`:

- `src/core/work-call.ts`
  - Imports line 54: include `calculateEffectiveCost`.
  - Cost fallbacks at lines 778, 930, 1311, 1878: if `deps.cacheAccountingV2 === true`, call `calculateEffectiveCost(..., { cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens })`; otherwise keep `calculateCost`.
  - Ledger writes at lines 794, 948, 1344, 1892: add conditional spread for `cacheWriteInputTokens` only when flag is on and usage has the property.

- `src/core/ensemble.ts`
  - Imports line 44: include `calculateEffectiveCost`.
  - Cost fallbacks at lines 1490, 1825, 1986, 2096: flag-on effective cost, flag-off old cost.
  - Ledger writes at lines 1510, 1845, 2002, 2113: conditional cache-write spread.

- `src/core/tribunal.ts`
  - Imports line 46: include `calculateEffectiveCost`.
  - Cost fallback line 603: flag-on effective cost, flag-off old cost.
  - Ledger write line 616: conditional cache-write spread.

- `src/core/judgment-poll.ts`
  - Imports line 49: include `calculateEffectiveCost`.
  - Cost fallback line 501: flag-on effective cost, flag-off old cost.
  - Ledger write line 514: conditional cache-write spread.

- `src/core/hedge.ts`
  - Imports line 47: include `calculateEffectiveCost`.
  - Change `costOf(result: RunResult)` line 467 to accept `cacheAccountingV2: boolean`.
  - Calls at lines 602 and 927 pass `deps.cacheAccountingV2 === true`.
  - Cost fallbacks at lines 704 and 844 use flag-on effective cost, flag-off old cost.
  - Ledger writes at lines 613, 716, 857 add conditional cache-write spread.

Use this exact ledger spread shape everywhere:
```ts
...(deps.cacheAccountingV2 === true && usage?.cacheWriteInputTokens !== undefined
  ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
  : {})
```
Adjust `usage` variable name per site.

## Tests

- `test/unit/cache-accounting-flag.test.ts`
  - `cacheAccountingV2Enabled absent env returns false`
  - `cacheAccountingV2Enabled accepts trimmed case-insensitive opt-in values`
  - `cacheAccountingV2Enabled returns false for opt-out and ambiguous values`
  - `cacheAccountingV2Enabled never throws and defaults false on hostile env`

- `test/contract/claude-parse.test.ts`
  - Add: `done event has usage.cacheWriteInputTokens === 2201`.
  - Existing fixture target remains read `13247`, input `1661`, output `4`, provider `costUsd=0.029297749999999997`.

- `test/contract/opencode-parse.test.ts`
  - Add fixture assertion: `done event has usage.cacheWriteInputTokens === 0`.
  - Add synthetic test: two `step_finish` lines with `cache.write` and `cache.read` accumulate into both usage events and final done usage.
  - Update absent-cache test to assert both optional keys are absent when cache object/fields are missing.

- `test/unit/pricing.test.ts`
  - `calculateEffectiveCost returns calculateCost when no cache buckets are supplied`.
  - `calculateEffectiveCost prices Claude-style separate cache buckets`: with input `1661`, output `4`, read `13247`, write `2201`, pricing `$5/M input`, `$25/M output`, `$0.50/M read`, `$6.25/M write`, `cacheInputTokensIncludedInInput:false`, assert `0.02878475`.
  - `calculateEffectiveCost discounts included cached input for Codex-style rows`.
  - `calculateEffectiveCost falls back to list input price for cache buckets when row lacks cache rates`.

- `test/unit/cost.test.ts`
  - `formatCostReport default output omits cache accounting even when entries have cacheWriteInputTokens`.
  - `formatCostReport with cacheAccountingV2 shows cache reads, cache writes, effective estimate, and naive estimate`.

- `test/unit/ledger.test.ts`
  - Extend “preserves all LedgerEntry fields round-trip” with `cacheWriteInputTokens: 2201`.

- `test/unit/jsonl-guards.test.ts`
  - Valid ledger with `cacheWriteInputTokens` passes.
  - Ledger with non-number `cacheWriteInputTokens` fails.
  - Ledger without `cacheWriteInputTokens` still passes.

- `test/unit/work-call-prior-cost.test.ts`
  - Add fake provider usage containing `cachedInputTokens: 30` and `cacheWriteInputTokens: 20`.
  - `cacheAccountingV2 off omits cacheWriteInputTokens from work-call ledger entry`.
  - `cacheAccountingV2 on records cacheWriteInputTokens from provider usage`.

## Verification Commands

Run these from repo root:

```powershell
npm run typecheck
node --import tsx/esm --test test/unit/cache-accounting-flag.test.ts
node --import tsx/esm --test test/contract/claude-parse.test.ts test/contract/opencode-parse.test.ts
node --import tsx/esm --test test/unit/pricing.test.ts test/unit/cost.test.ts test/unit/ledger.test.ts test/unit/jsonl-guards.test.ts test/unit/work-call-prior-cost.test.ts
```

Success criteria:
- `tsc --noEmit` passes through `npm run typecheck`.
- All targeted tests above pass with zero failures.
- No broad-suite failure is acceptable unless it already exists on `main` by exact test name. Compare failure names, not counts.
- Claude fixture measurement: write `2201`, read `13247`, input `1661`, output `4`. Effective Claude Opus model cost test returns `0.02878475`, which is much closer to fixture `total_cost_usd=0.029297749999999997` than the current naive `calculateCost(1661, 4) = 0.008405`. Do not force exact equality to `total_cost_usd`; the fixture total includes an extra internal Haiku model usage line.

## Ordered Checklist

1. Apply Step 0 comment-only fixes.
2. Add `cacheAccountingV2Enabled` and its unit test.
3. Add optional `cacheWriteInputTokens` to `Usage`, `LedgerEntry`, and JSONL guard.
4. Map Claude and OpenCode cache-write parser fields and update parser tests.
5. Add pricing row cache fields plus `calculateEffectiveCost`; update pricing tests.
6. Thread `cacheAccountingV2` through `cli.ts` and `menu.ts`.
7. Update every ledger write and local cost fallback in `work-call`, `ensemble`, `tribunal`, `judgment-poll`, and `hedge`.
8. Add ledger round-trip, JSON guard, cost report, and work-call off/on tests.
9. Run the verification commands.
10. Run `rg -n "cachedInputTokens:" src/core` and confirm every ledger write also handles `cacheWriteInputTokens` behind the flag.

## Ambiguities And Safe Defaults

- Parser mapping is unconditional; ledger recording and cost-report display are flag-gated. This keeps provider contract tests meaningful while preserving off-path user behavior.
- Do not set `cacheWriteInputTokens: undefined`. Omit the key. When flag is on and provider reports `0`, record `0`.
- Do not update live provider prices from the internet in this PR. Only add cache-rate metadata to existing rows using documented multipliers already assumed by the plan.
- Do not edit still-true `roleMapping` or `levelProfile` scaffolding comments. Verified current code does not consume them.
- If another `cachedInputTokens:` ledger write appears during implementation, update it too. Partial cache-write threading is not acceptable.