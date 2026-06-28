I could not write `docs/routing-cost-diagnosis.md` because this session is read-only. Exact report content:

```markdown
# Routing Cost Diagnosis

## TL;DR

The biggest lever is to fix the trivial/no-evidence route before model selection: this `run` path never wires menu smart routing or auto-brain, so `classify()` defaulted `Reply with exactly: SPINE_OK` to `ic` at `src/core/classify.ts:359`, which sent the work call to Claude Sonnet. Lowest-risk direct fix: classify exact-output/reply-only prompts as `worker` in `src/core/classify.ts:91`. Expected effect: this class of throwaway one-shot turns stops starting on `ic`/Sonnet. To make it near-free rather than merely cheaper, also change worker provider preference because `opencode` is currently behind Claude at `src/core/policy.ts:48`.

## Root-Cause Chain

- Turn entry: `src/cli.ts:711` builds the `run` task, `src/cli.ts:756` builds deps, and `src/cli.ts:822` calls `runTask(...)`.
- `runTask` path: `src/interface/run.ts:85` calls `orchestrate(task, deps, signal)`.
- Missing menu spine: `buildDeps` does not add `routeClassifier`, `intentExtractor`, or `autoBrainRungTuple`; `src/cli.ts:787` only adds verify/trust. Menu does wire these at `src/interface/menu.ts:2275`, `src/interface/menu.ts:2297`, and `src/interface/menu.ts:2498`.
- Intent extraction: `orchestrate` gates extraction at `src/core/orchestrate.ts:397`. With no extractor on `run`, it falls into the skipped rules frame at `src/core/orchestrate.ts:449`.
- Persisted intent: `rulesIntentFrame(...)` stores `source: "skipped"` at `src/core/intent.ts:626`; `ic` maps to `confidence: "low"` at `src/core/intent.ts:602`.
- Tier decision: `classify()` has no matching worker/IC keyword for “Reply with exactly...”, so it defaults to `ic` at `src/core/classify.ts:359`; the rationale says this explicitly at `src/core/classify.ts:367`.
- Auto-brain: not applied for `run`; `orchestrate` only fuses when `depsArg.autoBrainRungTuple !== undefined` at `src/core/orchestrate.ts:921`. Since it is absent, `currentTier` remains `classification.tier` at `src/core/orchestrate.ts:1945`.
- If `fuseRung` had run, no-intent/no-routeTier does not default to “high”; it falls back through `resolveLevel(...)` to `balanced` at `src/core/mode-levels.ts:513`, whose model rung is `ic` at `src/core/mode-levels.ts:374`.
- Work call: `orchestrate` passes `startTier: currentTier` at `src/core/orchestrate.ts:2086`; `work-call` routes that tier at `src/core/work-call.ts:1139`.
- Model selection: policy orders `ic` providers as Claude, Codex, opencode, Grok at `src/core/policy.ts:48`; `route()` returns the first authenticated preferred provider at `src/core/route.ts:463`.
- Price: Claude Sonnet IC pricing is `$3/M` input and `$15/M` output at `src/infra/pricing.ts:62`; provider-reported Claude cost is accepted at `src/core/work-call.ts:1365` from `src/providers/claude-parse.ts:226`.

## Ranked Fixes

| Rank | Finding | Evidence | Fix sketch | Risk | Est. impact |
|---|---|---|---|---|---|
| 1 | Trivial exact-output prompts fall through to `ic` on `run`. | `src/core/classify.ts:359`, `src/core/classify.ts:367` | Add scoped worker signals for `reply/respond/say/answer exactly` or equivalent format-only/no-file-change rule at `src/core/classify.ts:91`. | Low if scoped. | Moves observed run off Sonnet. |
| 2 | `run` skips menu smart routing and auto-brain wiring. | `src/cli.ts:756`, `src/cli.ts:787`, `src/interface/menu.ts:2275`, `src/interface/menu.ts:2498` | Wire `routeClassifier`/intent/auto-brain into `run` under existing config gates. | Medium: adds preflight behavior/latency to scripted mode. | Fixes broader no-keyword one-shots. |
| 3 | Worker tier still prefers Claude over near-free opencode. | `src/core/policy.ts:48`, `src/core/route.ts:463`, `src/infra/pricing.ts:153` | Put `opencode` first for `worker`, or add a cost-first worker policy. | Medium/high: changes quality/provider semantics. | Turns worker-tier tasks near-free. |
| 4 | Auto-brain can up-rung skipped/no-routeTier trivial turns to balanced/IC. | `src/core/auto-brain.ts:379`, `src/core/mode-levels.ts:513`, `src/core/mode-levels.ts:374` | When non-hard and classify tier is `worker`, keep `budget` unless an explicit routeTier/byproduct says otherwise. | Medium. | Protects interactive/menu parity. |

## Honest Scope

This is both a default/wiring bug and a pricing/order bug.

The observed `$0.0883` leak is primarily default/wiring: one-shot `run` skipped menu smart routing/auto-brain, intent extraction was skipped, and raw classification defaulted the trivial command to `ic`.

The “should route to near-free opencode-go” expectation is separately blocked by pricing/order: even real `worker` tier prefers Claude before opencode because of `src/core/policy.ts:48`.

## Path Impact

- One-shot `run`: definitely affected.
- Plain REPL: likely affected for this exact short prompt; it wires an intent extractor at `src/cli.ts:1056`, but no route classifier or auto-brain, and short trivial prompts still skip extraction.
- Interactive menu: not the same path. It has smart routing and auto-brain, but can still be affected by the auto-brain balanced fallback and by worker-provider ordering.

## Flag-Gated vs Direct

Safe direct fix: classify exact-output/reply-only prompts as `worker`.

Flag-gated/default-off: opencode-first or cost-first worker routing, because current policy deliberately keeps opencode behind Claude/Codex. Wiring extra classifier/model preflights into noninteractive `run` should respect existing config gates.
```