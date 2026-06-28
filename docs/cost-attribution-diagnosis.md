Read-only prevented writing `docs/cost-attribution-diagnosis.md`. Markdown content:

```markdown
# Cost Attribution Diagnosis

## TL;DR

The single biggest lever is to stop letting Claude `done.costUsd` blindly override token-derived cost in `src/core/work-call.ts:1366-1377`. Today `usd = providerCostUsd ?? calculateCost(...)`, and Claude sets `providerCostUsd` from top-level CLI `total_cost_usd` at `src/providers/claude-parse.ts:230`. For the observed `3 in / 42 out` turn, token math says Sonnet is `$0.000639`, but the ledger recorded `$0.0883` because provider cost won. Fix: for Claude, prefer token-derived `calculateEffectiveCost`/`calculateCost` unless the provider dollar figure is proven marginal and agrees with usage within a sane tolerance. Expected effect: ledger/evidence-receipt dollars drop by ~138x for the Sonnet case and ~150-188x for the Haiku case.

## Root Cause

Inflated Claude dollars come from provider-reported cost, not the pricing table.

Evidence:

- `src/providers/claude-parse.ts:53` defines `total_cost_usd`.
- `src/providers/claude-parse.ts:214-230` maps terminal `result.usage` to `usage`, then copies `ev.total_cost_usd` into `done.costUsd`.
- `src/core/work-call.ts:242-249` captures `ev.costUsd` into `providerCostUsd`.
- `src/core/work-call.ts:1366-1377` records `providerCostUsd` first, before token math.
- `src/core/work-call.ts:1400-1413` writes that `usd` to the ledger.

Arithmetic:

- Sonnet table: `src/infra/pricing.ts:62-70`, `$3/M` input, `$15/M` output.
- Token cost: `3*3/1e6 + 42*15/1e6 = $0.000639`.
- Observed ledger: `$0.0883`.
- Ratio: `0.0883 / 0.000639 = 138.18x`.

Haiku:

- Haiku table: `src/infra/pricing.ts:74-82`, `$0.8/M` input, `$4/M` output.
- Token cost: `3*0.8/1e6 + 42*4/1e6 = $0.0001704`.
- Observed ledger: `$0.0320`.
- Ratio: `187.79x`.
- Using the user’s approximate `$1/M` / `$5/M`: `$0.000213`, ratio `150.23x`.

Pricing units are correct:

- `src/infra/pricing.ts:22-23` names rates `inputPer1M` / `outputPer1M`.
- `src/infra/pricing.ts:241-248` divides by `1_000_000`.
- `src/infra/pricing.ts:264-291` does the same for cache-aware pricing.

The Claude CLI top-level cost is not guaranteed to mean “marginal cost for exactly these `usage.input_tokens` / `usage.output_tokens`”. The fixture proves top-level `total_cost_usd` can include more than the main visible model usage:

- `test/fixtures/claude-pong.stream-json.jsonl:10` has `total_cost_usd=0.02929775`.
- Same fixture has main `claude-opus-4-8` `modelUsage.costUSD=0.02878475`.
- Difference is `$0.000513`, matching the extra internal Haiku `modelUsage` line.
- `docs/pr1-cache-accounting-plan.md:214` explicitly notes the fixture total includes an extra internal Haiku model usage line.

For the observed `$0.0883`, Sonnet token-equivalent spend would be about `29,433` input tokens at `$3/M` or `5,887` output tokens at `$15/M`, not `3 + 42` tokens. So the provider cost is either cumulative/session-level or includes hidden/internal work not represented by the ledger token fields. In either case it is not compatible with the recorded per-call token counts.

## Is `inputTokens=3` Wrong?

Probably yes as a “full prompt cost basis”, but it may be correctly parsed from Claude’s terminal JSON.

Evidence:

- `src/providers/claude-parse.ts:61-75` maps only `result.usage.input_tokens`, `output_tokens`, and cache buckets.
- `src/providers/claude-parse.ts:214-230` emits that terminal usage on `done`.
- `src/core/work-call.ts:1407-1408` writes those parsed fields directly to the ledger.
- `src/core/work-call.ts:1212-1239` uses native Claude session mode by omitting `historyContext` when `nativePlan` exists.
- `src/core/work-call.ts:1295-1297` passes `sessionId` / `resume` to the provider.
- `src/providers/claude.ts:151-156` turns that into `--resume` or `--session-id`.

So `3` may be Claude’s marginal resumed-turn input, not a local count of the full prompt/context basis. The second bug is that ledger tokens and provider dollars can be from different accounting scopes.

## Ranked Fixes

| Rank | Finding | Evidence | Fix sketch | Risk | Impact | Gate |
|---|---|---|---|---|---|---|
| 1 | Claude provider cost wins even when it wildly diverges from token math. | `src/core/work-call.ts:1366-1377`, `src/providers/claude-parse.ts:230` | For Claude work/review ledger rows, compute token-derived cost and ignore provider `total_cost_usd` when ratio exceeds a threshold, or default Claude to token-derived ledger cost. | Low/medium: changes historical meaning of `usd` from CLI-reported to API-equivalent estimate. | Biggest: fixes ~100x ledger and receipt inflation. | Safe-direct if documented as API-equivalent estimate; flag-gated if preserving old “provider reported” semantics matters. |
| 2 | Claude parser treats top-level `total_cost_usd` as per-call marginal cost. | `src/providers/claude-parse.ts:226-230`; fixture at `test/fixtures/claude-pong.stream-json.jsonl:10`; note at `docs/pr1-cache-accounting-plan.md:214` | Parse `modelUsage` and prefer the selected model’s `costUSD`, or compute marginal delta per session if CLI exposes cumulative totals. Do not use top-level total as the ledger row’s marginal cost. | Medium: needs raw JSON shape handling and model alias/version matching. | High, but less robust than token-derived fallback if CLI semantics vary. | Flag-gated until validated on live Claude outputs. |
| 3 | Ledger token fields may undercount full prompt/accounting basis in resumed Claude sessions. | `src/core/work-call.ts:1234-1239`, `src/core/work-call.ts:1295-1297`, `src/providers/claude-parse.ts:61-75` | Add separate fields for `providerInputTokens` vs `ledgerEstimatedPromptTokens`, or record native-session/marginal scope explicitly. Do not compare provider cumulative dollars to marginal tokens. | Medium: schema/report changes. | Medium: fixes diagnostics and ratios; does not by itself stop inflated dollars. | Flag-gated schema/report migration. |
| 4 | Tests encode trust in provider `costUsd`. | `test/contract/claude-parse.test.ts:91-100`, `test/unit/work-call-prior-cost.test.ts:70-74` | Add regression: provider cost `0.0883` with usage `3/42` must not become ledger `usd` for Claude unless explicitly marked trusted/marginal. | Low. | Prevents recurrence. | Safe-direct. |
```
