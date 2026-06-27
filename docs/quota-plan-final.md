# myshell-tools 10/10 Plan

## 1. Verdict On Prior Passes

**GPT-5.5 audit:** mostly right on repo facts, weak on mechanism. It correctly identified flat prompt subprocesses (`src/providers/port.ts:38`, `claude.ts:269`, `codex.ts:199`, `opencode.ts:186`, `grok.ts:236`), lossy cache accounting (`claude-parse.ts:38-70`, `port.ts:31`, `work-call.ts:1344`), cache-naive local pricing (`pricing.ts:219-225`), double preflight (`orchestrate.ts:358-399`), and under-ledgered aux calls (`route-classifier.ts:76-93`, `intent-extractor.ts:96-126`). Its bad recommendation was “add `cache_control` breakpoints.” Through these CLIs, myshell-tools does not own raw Anthropic/OpenAI/DeepSeek request JSON. That idea is mostly unbuildable unless you replace adapters with API-native clients.

**Opus v2:** right that measurement beats speculative caching; wrong/stale in places. Its “CLI subprocess means no `cache_control`” claim is true for current adapters. Its “we probably already get caching” claim is directionally true but overconfident: Claude Code emits cache read/write usage in real fixtures, OpenAI/Codex exposes cached input, OpenCode exposes cache read/write fields, and DeepSeek auto-caches prefixes. But DeepSeek’s 2026 docs no longer support the precise “token-0 / 1024-token unit” phrasing; they describe persisted prefix units, common-prefix detection, fixed intervals, and hit/miss usage fields. Also, native-session reuse is not just an idea: it is already wired through `ProviderRequest.sessionId/resume` (`port.ts:51-53`), Claude args (`claude.ts:151-155`), Codex resume (`codex.ts:127-128`), Grok resume (`grok.ts:117-121`), planning (`native-session.ts:92-114`), menu deps (`menu.ts:2185-2191`), and work-call history omission (`work-call.ts:1171-1239`). The plan should validate and promote this path, not rebuild it.

## 2. Caching Ground Truth Under CLI Constraint

| Provider | What We Already Get | What We Can Add | What Is Impossible/Low ROI |
|---|---|---|---|
| Claude Code / sub-auth | Claude Code has its own automatic prompt caching and auto-compaction for repeated context; docs say it “automatically optimizes costs through prompt caching” and compaction. CLI supports `--resume` and `--session-id`. The repo parses `cache_read_input_tokens` but drops `cache_creation_input_tokens` (`claude-parse.ts:38-70`); fixture proves both exist. | Record cache writes; price cache reads/writes; validate `nativeSessions` by measuring input-token drop and cache-read rise on resumed Claude turns. | Adding Anthropic API `cache_control` through `claude -p` stdin. The raw API supports top-level/block `cache_control`, but the current adapter cannot attach it. |
| Codex / OpenAI | Codex adapter is stdin plus optional `exec resume` (`codex.ts:127-199`). Parser already maps `cached_input_tokens` to `cachedInputTokens` (`codex-parse.ts:58-89`). OpenAI prompt caching is automatic for prompts >=1024 tokens, reports `cached_tokens`, and recommends static content first. Pricing shows cached input at roughly 10% of standard input for current GPT-5.x rows. | Preserve stable prompt prefix; record cache hit rate; use Codex native resume where captured thread IDs exist (`codex-parse.ts:136`, `native-session.ts:108-111`). | Setting OpenAI `prompt_cache_key` or retention unless Codex CLI exposes it. Current adapter does not. |
| OpenCode / DeepSeek | OpenCode parser sees `tokens.cache.write/read` but only records read (`opencode-parse.ts:53-55`, `104-114`). DeepSeek context caching is enabled by default and persists/reuses overlapping prefixes; usage includes `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. DeepSeek pricing makes cache hits radically cheaper than misses: V4 Flash hit $0.0028/M vs miss $0.14/M. | Map both cache write/read; audit prefix stability; do not disturb persona-at-start ordering (`prompt.ts:524-554`). | Fine-grained DeepSeek cache controls through OpenCode unless OpenCode exposes provider-specific request options. |
| Grok | Adapter writes full prompt to temp file and supports session flags (`grok.ts:117-121`, `236-237`). Parser explicitly says no usage/cost event types (`grok-parse.ts:10-16`). | Treat as unmetered/unknown except local estimates; measure only if future CLI emits tokens. | Any reliable cache accounting today. No usage stream means no proof. |
| Prompt structure | `buildPrompt` places tier persona first, then assembled context, then history, then task (`prompt.ts:524-554`). History and context are capped (`history.ts:23-25`, `prompt-context.ts:176`). | Keep static content first; add prefix-hash telemetry behind a flag to detect accidental leading-byte churn. | Persona shrink as a primary lever. On auto-cache providers, repeated persona tokens should be cheap after warmup; cutting it risks quality for small savings. |

## 3. Cost/Outcome Feedback Loop Verdict

**Verdict: reshape and demote. Do not make per-user RL/bandits the ground-shattering bet.** The owner is right.

The repo already has a local learning seed: provider outcome order ranks by observed `success` and `durationMs` with min 3 runs/provider (`routing-memory.ts:117-154`), and model/taskKind learning uses neutral-prior smoothing with min 5 runs/model (`routing-memory.ts:176-350`). That is fine as a conservative tie-breaker. It is not enough to beat strong static heuristics for an individual user.

Data math:

- To distinguish two arms with binary success rates around 70% vs 80%, a plain two-proportion test needs roughly 160 observations per arm for 95% confidence. For 70% vs 75%, roughly 650 per arm.
- myshell-tools has at least 6 `taskKind`s, 3 tiers, multiple providers/models, and reasoning efforts. Even if you collapse to two candidate arms per taskKind, useful learning needs hundreds to thousands of verified outcomes.
- A serious individual user may create 20-50 substantive turns/week. Spread across task kinds and model updates, the signal ages before it converges.
- Outcome labels are noisy: `success:true` means the provider run completed/was accepted, not necessarily “the code was correct.” Verified tests are better but sparse and task-specific.
- Costs are non-stationary: model prices, plan quotas, cache behavior, provider CLIs, and available models change faster than a single-user bandit can learn.

Online research matches this. Latent contextual bandit work says learning from scratch per new user can require “an enormous amount of interactions,” and successful cold-start systems borrow latent classes from prior users. Non-stationary bandit work exists because reward distributions shift in practice. That is exactly this product.

Cross-user aggregation would solve sample size but creates a privacy product. Even prompt-free aggregates leak work patterns: task kind, provider/model, timing, success, quota pressure, repo size, and maybe plan tier. It must be opt-in, coarse, local-aggregate-first, no prompt text, no filenames, no raw errors, with deletion/export. Worth considering later, not a core 10/10 claim for an individual CLI.

Keep this instead:

- Deterministic priors first: taskKind/risk/mode/capability registry decides route.
- Local Bayesian updates only as slow tie-breakers after high thresholds, with recency decay.
- Cost as a tie-breaker after quality, not the objective.
- Shadow-mode policy reports before any automatic reroute.
- Verified outcomes only get higher weight: passing targeted tests, no diff, user accepted, reviewer passed.

## 4. Current State To 10/10 Roadmap

All PRs default-off. Flag off means byte-identical behavior. Ship-green means `tsc --noEmit`, targeted tests, and zero NEW test failures by name-diff vs `main`; do not compare raw count because Windows/flaky failures are pre-existing.

| Rank | PR / Flag | Touch Points | Measurement | Risk |
|---|---|---|---|---|
| 1 | `MYSHELL_CACHE_ACCOUNTING_V2=1` | Add `cacheWriteInputTokens?` to `Usage` (`port.ts:28-31`) and `LedgerEntry` (`types.ts:167-201`); map Claude `cache_creation_input_tokens` (`claude-parse.ts:38-70`); map OpenCode `cache.write` (`opencode-parse.ts:53-55`, `104-114`); update `work-call.ts:1344`, `ensemble.ts:1510/1845`, `tribunal.ts:616`; add cache-aware pricing beside `calculateCost` (`pricing.ts:219-225`) and report lines (`cost.ts:59-67`). | Existing Claude fixture should show write=2201/read=13247; effective cost should match provider `total_cost_usd` better than naive list. | Low. Schema/report additive. |
| 2 | `MYSHELL_ACCOUNT_AUX=1` | Route classifier currently returns only parsed route (`route-classifier.ts:76-93`); intent extractor captures usage but orchestrate drops it at initial calls (`intent-extractor.ts:96-126`, `orchestrate.ts:329/399`). Add ledger stage entries for `route`, `intent`, `reextract-web`, `reextract-local`, `recap`, `understanding`, `autostage`. | Per turn: visible aux call count, tokens, cache reads/writes, and dollars/quota. Proves double preflight and background spend. | Low-medium. Avoid polluting work-call learning; use `stage`. |
| 3 | `MYSHELL_UNIFY_PREFLIGHT=1` hardening | Existing gate and path: `router.ts:248-263`, `orchestrate.ts:314-353`, menu wiring `menu.ts:3803-3808`. | On ambiguous substantial turns, aux ledger shows router call eliminated while route decision remains equal or more conservative. | Medium. Needs parity corpus by test name. |
| 4 | `nativeSessions=true` validation and promotion | Existing: config `nativeSessions` (`config.ts:55-60`), planner (`native-session.ts:92-114`), menu (`menu.ts:2185-2191`), work-call skip history (`work-call.ts:1171-1239`), provider flags (`claude.ts:151-155`, `codex.ts:127-128`, `grok.ts:117-121`). Add telemetry and fallback tests. | Same conversation, same provider: resumed turn input tokens drop by approximate history size; cache reads increase; no history block in prompt. | Medium-high. Session poisoning/stale state; current quarantine logic must stay. |
| 5 | `MYSHELL_PREFIX_STABILITY_AUDIT=1` | Instrument `buildPrompt` around `prompt.ts:524-554`; hash first N static bytes per tier/provider; report leading-prefix churn without changing prompt. | Cache hit rate correlates with stable prefix; any timestamp/volatile field before task is caught. | Low. Read-only telemetry. |
| 6 | `MYSHELL_PREFLIGHT_CACHE=1` | Exact hash cache for `buildRouterPrompt(task)` / `parseModelRoute` (`route-classifier.ts:78-93`) and `buildIntentPrompt(task)` / `parseIntentFrame` (`intent-extractor.ts:89-126`). | Repeated identical prompt produces zero aux provider calls. | Low ROI but cheap. Exact only; no semantic cache. |
| 7 | `MYSHELL_OUTCOME_PRIORS_SHADOW=1` | Use existing `routing-memory.ts:137-350` and deps fields (`types.ts:697-728`) in shadow mode. Raise effective thresholds for taskKind model learning: min 20 verified runs/cell or keep current 5 only for display. Add cache-adjusted cost stats after PR1. | Report “would route differently” plus realized outcome; no behavior change until calibrated. | Medium if promoted too early. Keep shadow for a long time. |
| 8 | `MYSHELL_EVIDENCE_RECEIPT=1` | Tie work final to evidence already available from verification/test/diff paths (`verify.ts`, `work-call.ts`, `orchestrate.ts:1971-1972`). Receipt includes changed files, commands run, pass/fail, cache-adjusted spend, aux spend. | User sees whether “done” means verified or merely answered. | Medium. UX honesty may expose uncomfortable failures, which is good. |
| 9 | `MYSHELL_GOVERNOR_RUNTIME_BUDGET=1` | Governor already models hard per-turn budgets (`governor.ts:215-258`, `659-879`); capability budget says many current caps are advisory (`capability-budget.ts:2-10`, `45-51`, `96-126`). Enforce against measured aux/work calls from PR1/2. | Optional levers stop when measured budget is consumed; answer path remains. | Medium-high. Can reduce quality if tuned badly; start log-only. |

## 5. Real 10/10 Differentiator

The differentiator is **verified work per quota unit**, not a per-user RL loop.

A 10/10 individual CLI does not win by pretending one user has enough data to train a policy. It wins by spending the user’s limited subscription/API quota on the only things that reliably improve outcomes in 2026: ground-truth verification, tight decomposition, tool feedback, durable state, and context/caching discipline. Anthropic’s agent guidance is explicit: add complexity only when it measurably improves outcomes, use ground truth from the environment, and rely on tests/human checkpoints for coding agents.

myshell-tools already has the skeleton: route/governor, native sessions, capped history/context, taskKind/effort, verification, panels/tribunals, goals, and ledgers. It is currently blind on real spend and too willing to count “successful response” as outcome. Fix that and it becomes categorically better:

**Product promise:** “I use native sessions and provider caches so I stop wasting quota replaying myself; I spend the saved budget on verification, scoped retries, and honest receipts.”

Smallest proof:

1. Ship PR1 + PR2.
2. Run the same representative coding task twice across Claude, Codex, OpenCode.
3. Show a receipt: work tokens, aux tokens, cache read/write tokens, effective spend, provider-reported spend when available, tests/commands run, and whether the answer was verified.
4. Then enable native sessions for Claude/Codex and prove follow-up turns use less input and preserve more context than compact-history replay.

That proof is concrete. The feedback-loop story is not.

## 6. Sources

- Anthropic prompt caching: `cache_control`, TTLs, full-prefix behavior, pricing multipliers, 0.1x cache reads.
- Claude Code costs/context: automatic prompt caching, auto-compaction, `/usage`, context management, tool/context cost advice.
- Claude Code CLI/SDK sessions: `--resume`, `--session-id`, SDK resume with full context.
- OpenAI prompt caching: cache lookup, retention, 1024-token requirement, `cached_tokens`, best practices.
- OpenAI pricing: cached input pricing rows for GPT-5.x/Codex.
- DeepSeek context caching: enabled by default, persisted prefix units, hit/miss fields; DeepSeek pricing hit vs miss.
- Anthropic “Building effective agents”: simple composable patterns, routing, decomposition, evaluator loops, ground-truth feedback, coding-agent verification.
- Latent contextual bandits cold-start: per-user-from-scratch learning can require enormous interactions; practical systems borrow prior-user latent structure.