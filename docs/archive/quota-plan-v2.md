# Quota / Efficiency Plan v2 — adversarial review of the GPT‑5.5 audit + "beyond 10/10" bets

Scope: design only. No source edited. Every recommendation is grounded in the real code
(file:line) and cited online evidence, behind a DEFAULT‑OFF flag (off ⇒ byte‑identical),
ship‑green (zero NEW test failures by name‑diff vs `main`; ~57 pre‑existing Windows/flaky
failures — compare by NAME not count; gate with `tsc --noEmit` + targeted tests).

---

## 1. Verdict on GPT‑5.5's audit

**Largely correct on the facts, wrong on the headline mechanism.** Verified true:

- **Caching is not request‑wired** — `ProviderRequest` is a flat `prompt` string (`src/providers/port.ts:34‑38`); Claude delivers it via STDIN (`src/providers/claude.ts:269`); no `cache_control` is ever emitted. ✔
- **Cache accounting is lossy** — `claude-parse.ts` parses `cache_creation_input_tokens` into `WireUsage` (`src/providers/claude-parse.ts:39`) but `mapUsage` returns **only** reads (`claude-parse.ts:61‑73`); `Usage` has no write field (`port.ts:28‑32`); `LedgerEntry.cachedInputTokens` stores reads only (`src/core/types.ts:176`, written at `src/core/work-call.ts:1344`); local `calculateCost` prices **all** input at full list price, ignoring the cache‑read discount (`src/infra/pricing.ts:219‑227`). ✔
- **Double preflight is real and unify is default‑off** — non‑unified branch calls `decideRoute` (route‑classifier model) then may call the intent extractor (`src/core/orchestrate.ts:354‑421`); unify collapses to ONE call but only when `depsArg.unifyPreflight === true` (`orchestrate.ts:317‑319`), gated by `MYSHELL_UNIFY_PREFLIGHT` (`src/core/router.ts:263`, `src/interface/menu.ts:3803‑3808`). The unified path is **already built and unit‑tested** (`test/unit/orchestrate-unify-preflight.test.ts`). ✔
- **Aux calls under‑accounted** — route‑classifier has no usage/ledger path at all (`src/core/route-classifier.ts:84‑93`); the extractor captures usage (`src/core/intent-extractor.ts:96‑106`) but orchestrate consumes only `.frame` (`orchestrate.ts:329,399`). Only work/review/poll/tribunal hit `ledger.record` (`work-call.ts:1335`). ✔

So PR2/PR3 (account aux, unify) are sound. **The trap is PR "MYSHELL_PROMPT_CACHE = add cache_control breakpoints."** That cannot work as written: the providers are CLI subprocesses, not the raw Messages API. There is no place to attach `cache_control` to a `claude -p` / `codex` / `opencode` / `grok` invocation. The audit even hedged this in its risk column but still made it PR3. Building a "structured prompt parts + cache markers" layer would be **pure gold‑plating** — the markers go nowhere.

---

## 2. What the audit missed or got wrong

1. **The real caching lever is provider‑native, and it is two different mechanisms, not one.** (See §3.) The audit treated "prompt caching" as one knob; under the CLI constraint it splits cleanly by provider.
2. **A large amount of caching is ALREADY happening and is simply invisible.** Claude Code requests a **1‑hour TTL automatically on a subscription auth** and caches its own system prompt + tool defs out of the box [Claude Code docs]. DeepSeek/OpenAI do **automatic prefix caching from token 0** with no opt‑in [DeepSeek, OpenAI docs]. The honest #1 action is to **measure the caching we already get** before "adding" any — the audit's finding #2 is mis‑ranked as second when it is the foundation everything else is validated against.
3. **The prompt is already ordered correctly for automatic prefix caching — and that's a latent, unmeasured win.** `buildPrompt` puts the stable per‑tier persona at **token 0**, then volatile context → history → task last (`src/core/prompt.ts:524‑554`). DeepSeek and OpenAI cache the longest byte‑identical prefix from the 0th token in ≥1024‑token units. So **worker‑tier turns on the opencode‑go/DeepSeek pool are very likely already getting ~10× cheaper persona tokens** — we just never recorded it. The audit said "the stable prefix is probably resent at full cost on most stateless turns." For the Claude path that's true; **for the DeepSeek/OpenAI pool it is probably false.** Verify, don't assume.
4. **Native session reuse is the token‑REPLAY killer, and the audit barely mentions it.** The port already supports it (`port.ts:51‑53`; `claude.ts:151‑157` `--resume`/`--session-id`; capture at `port.ts:120`). Resuming a Claude session means (a) you stop replaying the compacted history block (`src/core/prompt.ts:546‑552`) AND (b) the server‑side prefix cache covers the whole prior turn at read price. One change fixes both the "no caching" and the "history re‑sent every turn" problems for Claude — the audit listed history bounding under "Already Good" and moved on.
5. **Cheapest aux call is a model call that often needs no model at all.** Route/intent prompts are deterministic functions of the task text (`buildRouterPrompt(task)`, `buildIntentPrompt(task)`). An exact‑hash response cache (same task ⇒ reuse parsed frame, **zero** tokens) is a real, simple win the audit didn't list. Modest hit rate, but it is the only "100% off" lever and it's near‑free to build.
6. **Counterfactual math is already cache‑naive in `cost.ts`.** `src/commands/cost.ts:65,67` prices everything at full list — once writes/reads are recorded this report can finally tell the truth (and it already correctly avoids comparing billed‑with‑caching vs list‑price flagship — `cost.ts:50‑52`).

---

## 3. Corrected caching mechanism under the CLI constraint

There is **no `cache_control` lever** through the CLIs. The reachable levers, by provider:

| Provider (pool) | Native caching reality | Reachable lever | Reached how |
|---|---|---|---|
| **Claude CLI** (`claude -p`) | Anthropic does NOT auto‑cache; Claude Code sets breakpoints on its OWN system+tools+history, auto 1h TTL on sub auth. Across **stateless** `-p` calls only Claude Code's own prefix is cached — our persona+task lives in the user message at the tail and is recomputed every turn. [Claude Code docs] | **Native session reuse** (`--resume`): persona+history move server‑side; prior prefix billed at cache‑read (~10%); stop replaying the history block. | `req.sessionId`+`resume` already plumbed (`port.ts:51`, `claude.ts:151‑157`); stop injecting `historyContext` on resumed turns (`prompt.ts:546`). |
| **opencode‑go / DeepSeek** (worker/most turns) | **Automatic** disk prefix cache from token 0, ≥1024 tok, byte‑exact; cache hit = 1/10 price (V4‑Flash hit ~$0.0028/M). [DeepSeek docs] | **Preserve the byte‑identical persona prefix** (already at token 0) + **measure hits**. | No code change to earn it; PR1 makes it visible. Risk = anything that perturbs the leading bytes (per‑turn timestamp/uuid in persona) silently destroys it — audit for prefix stability. |
| **codex / OpenAI** | **Automatic** prefix cache, ≥1024 tok, 50% off cached prefix. [OpenAI docs] | Same as DeepSeek: stable prefix + measurement. | Same. |
| **grok** | Writes full prompt to a temp file (`src/providers/grok.ts:236`); caching behavior unverified. | Stable prefix; treat as no‑cache until measured. | — |

**Net:** the #1 lever is **(a) record the caching we already get + price it correctly (measurement), then (b) Claude native‑session reuse to win the one pool that has no automatic prefix cache.** "Add cache_control" is deleted.

**How to MEASURE the saving (this is the unlock):**
- Extend `Usage` with `cacheCreationInputTokens?` and have `mapUsage` return both read+write (`claude-parse.ts:61`); thread to `LedgerEntry` (`types.ts:167`, `work-call.ts:1344`). DeepSeek/OpenAI report cache‑hit token counts in their CLIs' usage too — capture in the respective `*-parse.ts`.
- Add a cache‑aware figure to `myshell-tools cost`: `cached_read_tokens`, `cache_write_tokens`, and `effective input $ = (input‑cached)×list + cached×readRate + writes×writeRate` vs naive list (`cost.ts:54‑68`). The CLI's own `total_cost_usd` (`port.ts:112`, captured `claude-parse.ts:226`) is the ground‑truth check — if our cache‑aware estimate tracks `total_cost_usd` and the naive one overshoots, caching is proven and quantified.
- **Saving estimate to expect:** persona ≈ 2.5–3.5k tokens/turn. On the DeepSeek worker pool a warm prefix turn should show ~90% of persona tokens as cache hits (1/10 price) — i.e. the persona stops mattering. On Claude, session reuse turns each follow‑up turn's prior prefix from full‑price into ~10% read price AND removes the replayed history block (bounded 6k chars ≈ 1.5k tokens) entirely.

---

## 4. Ranked PR sequence (verified win × low risk)

Ordered so each PR de‑risks the next. All default‑off; off ⇒ byte‑identical.

### PR1 — `MYSHELL_ACCOUNT_AUX` + honest cache accounting  ★ ship first
**Win: high (makes everything measurable). Risk: low (additive schema + report).**
Combine the audit's findings #2 and #4 — they share the ledger surface.
- Add `cacheCreationInputTokens?` to `Usage` (`src/providers/port.ts:28‑32`); return it from `mapUsage` (`src/providers/claude-parse.ts:61‑73`); capture DeepSeek/OpenAI cache‑hit fields in `src/providers/opencode-parse.ts` / `codex-parse.ts`.
- Add `cacheWriteInputTokens?` to `LedgerEntry` (`src/core/types.ts:167‑202`); populate at `src/core/work-call.ts:1344` (absent ⇒ old behavior).
- When flag on, ledger **stage entries** for route‑classifier (`src/core/route-classifier.ts:86‑93` — currently no usage path; surface usage like the extractor does) and intent extractor (usage already captured at `src/core/intent-extractor.ts:104`; stop discarding via `.frame` at `orchestrate.ts:329,399`). Tag entries with a `stage` so they don't pollute work‑call learning.
- Extend `myshell-tools cost` with cached‑read / cache‑write / effective‑$ lines (`src/commands/cost.ts:54‑68`), validated against `total_cost_usd`.
- **Measure:** run an identical task twice within 5 min on each pool; PR proves it if turn‑2 shows cache‑read tokens > 0 and effective‑$ < naive‑$.
- **Flag‑off invariant:** no new ledger rows, no new report lines, `Usage`/`LedgerEntry` new keys absent.

### PR2 — `MYSHELL_UNIFY_PREFLIGHT` (flip the already‑built path)
**Win: high (removes 1 model call per ambiguous substantial turn). Risk: medium (routing parity).**
Logic + tests already exist (`orchestrate.ts:317‑353`, `test/unit/orchestrate-unify-preflight.test.ts`). This PR is *measurement + default flip*, not new code.
- With PR1 landed, quantify the saved route‑classifier call across a representative turn set.
- Keep `MYSHELL_UNIFY_PREFLIGHT` opt‑in; add a name‑diff test proving the unified vs non‑unified route decision is identical on the corpus (it can only raise risk, never change tier silently — `orchestrate.ts:340`).
- **Measure:** aux ledger (PR1) shows route‑classifier calls → 0 on unified turns, intent calls unchanged.
- **Risk control:** ship behind flag; promote default only after the parity corpus is green.

### PR3 — `MYSHELL_SESSION_REUSE` (the real Claude caching lever)
**Win: highest token saving on the Claude pool. Risk: medium‑high (behavioral; needs PR1 to prove).**
- On a multi‑turn conversation that stays on one provider+tier, pass `req.sessionId`/`resume` (`port.ts:51‑53`; `claude.ts:151‑157`) and, when resuming, **omit** the replayed `historyContext` block (`src/core/prompt.ts:546‑552`) — the session carries it.
- Guard rails: only reuse when provider AND tier are unchanged (persona differs per tier — `prompt.ts:566‑570`); fall back to stateless on any session error (the adapter already classifies errors — `claude.ts:302‑345`). Cross‑turn session id state is the hard part — store it on the conversation, not the goal model.
- **Measure (PR1):** resumed turn shows cache‑read tokens ≫ 0 and input tokens drop by ≈ the history‑block size; `total_cost_usd` falls.
- **Why after PR1/PR2:** without honest cache accounting you cannot prove it helps or detect a silent prefix break.

### PR4 — `MYSHELL_PREFLIGHT_CACHE` (exact‑hash aux response cache)
**Win: low‑moderate (only verbatim‑repeated tasks). Risk: low.**
- Memoize `parseModelRoute`/`parseIntentFrame` results keyed by a hash of the exact task string within a session (`route-classifier.ts:93`, `intent-extractor.ts:113`). Hit ⇒ zero tokens.
- **Measure (PR1):** aux ledger call count drops on repeats.
- Honest call: low hit rate in practice; build only because it's near‑free and composes with PR1.

**Explicitly NOT doing (traps):**
- ✗ `cache_control` breakpoint wiring (audit PR3) — unreachable through CLIs.
- ✗ "Structured prompt parts" refactor — pure churn with no caching payoff under CLI constraint.
- ✗ Prompt‑shrinking the persona — the persona is the product's voice AND (on auto‑cache pools) ~free after the first hit; cutting it trades quality for a saving caching already gives you.

---

## 5. Ground‑shattering bets (ranked, honest)

The brief asks: what makes myshell‑tools categorically better, not incrementally? Brutally honest framing: today the intelligence stack (auto‑brain Layer A/B, governor, draft goals, curated‑state) is **architecturally ahead but evidentially blind** — it routes, escalates, and parks goals without a closed‑loop record of *what those decisions actually cost and whether they paid off*. Efficiency work is the weapon that turns that blindness into a moat. Bets are ranked by (step‑change × feasibility on THIS code).

### Bet 1 — The cost/outcome feedback loop ("the agent that learns its own economics"). ★ highest leverage
- **The bet:** PR1's honest per‑decision accounting (work + aux + cache reads/writes + `taskKind` + `reasoningEffort`, all already on `LedgerEntry`) becomes the training signal for routing, escalation, and goal‑parking. The agent learns "this *kind* of turn, at this tier, with caching, succeeds at $X" and routes on **realized cost‑adjusted value**, not static rules.
- **Why a step‑change:** every competing CLI routes on heuristics or a fixed model. None close the loop on *measured outcome × measured cost per task kind*. "Think once, cache, gate, decompose, never a dumber model" becomes a *learned policy*, not a slogan — provably both cheaper and smarter.
- **Enabled by current code:** `LedgerEntry` already carries `taskKind`, `reasoningEffort`, `success`, tokens (`types.ts:167‑202`); a `learnProviderOrder`‑style learner already exists (referenced in route comments). The only missing inputs are aux + cache columns — **exactly PR1**.
- **Blocked by:** today the learner sees only work calls and full‑price input; it cannot reason about cache economics or aux overhead. PR1 removes the blocker.
- **Smallest first proof:** after PR1, add a read‑only `myshell-tools cost --by-taskkind` view showing $/success per (taskKind, tier). If the ranking is non‑trivial (some tier is clearly over‑ or under‑used for a kind), the learning signal is real.
- **Risk/ROI:** low risk (read‑only analytics first), high ROI. This is the one bet where the quota work and the "smarter" work are *the same work*.

### Bet 2 — Session‑native continuity as a first‑class product mode
- **The bet:** promote PR3's session reuse from a token optimization into the default conversational substrate — the agent holds a live provider session per conversation, so context is *server‑resident*, not re‑marshaled. Cheaper (cache) AND more coherent (no lossy 6k‑char history compaction — `src/core/history.ts`).
- **Why a step‑change:** removes the stateless‑replay tax that every "wrap a CLI" tool pays, and kills the quality loss of history truncation in long sessions.
- **Enabled by:** `--resume` plumbing + native‑session import already exist (`native-sessions.ts`, `port.ts:51`).
- **Blocked by:** tier/provider switching mid‑conversation (persona differs); cross‑turn session‑id state management.
- **Smallest first proof:** PR3 on single‑tier conversations; measure coherence (does turn N reference turn 1 detail that compaction would have dropped?) + cost.
- **Risk/ROI:** medium risk, high ROI — but strictly downstream of PR1's measurement.

### Bet 3 — Cache‑aware decomposition / "compute budget" for the governor
- **The bet:** give the governor (the live brain) a real **runtime** token/$ budget per turn‑class — today its limits are advisory, not enforced (`src/core/capability-budget.ts:44`, audit finding #5). With PR1's real numbers it can gate poll/tribunal/panel by *expected marginal value per dollar*, decomposing only when the cache‑adjusted budget allows.
- **Why a step‑change:** "spend more only when it pays" becomes enforceable, not aspirational — the expensive multi‑agent levers stop being all‑or‑nothing.
- **Enabled by:** governor gates already exist and are conservative (`src/core/governor.ts:520,590`; ensemble `137`).
- **Blocked by:** no enforced runtime budget and (until PR1) no honest cost to budget against.
- **Smallest first proof:** a default‑off advisory mode that *logs* "would have shed X" decisions; compare to outcomes before enforcing.
- **Risk/ROI:** medium risk (can degrade answer quality if mis‑tuned), medium‑high ROI. Sequence LAST — it needs both PR1 numbers and a tuning corpus.

### Honest non‑bets
- **Semantic (embedding) response cache for user turns:** vaporware ROI here — coding turns are rarely semantically duplicate, and a wrong fuzzy hit is worse than a miss. Exact‑hash (PR4) only.
- **Request batching:** the Anthropic Batch API is async/offline; this is an interactive CLI — wrong tool. Skip.
- **Context distillation/compression of the persona:** low ROI given auto‑caching already amortizes it; trades the product's differentiated voice for pennies.

---

## 6. Sources

- Anthropic prompt caching (cache_control ephemeral, 4 breakpoints, 5m/1h TTL, write 1.25×/2×, read 0.1×): https://platform.claude.com/docs/en/build-with-claude/prompt-caching ; pricing: https://platform.claude.com/docs/en/about-claude/pricing
- How Claude Code uses prompt caching (auto breakpoints on system+tools+history; 1h TTL auto on subscription; exact‑prefix match, "prefix is the entire previous request"): https://code.claude.com/docs/en/prompt-caching
- Claude Code headless/`--print` single‑turn semantics: https://amux.io/guides/claude-code-headless/
- Persistent‑session caching for Claude Code provider (confirms session = the lever): https://github.com/cline/cline/discussions/9892
- OpenAI automatic prompt caching (≥1024 tok, 128‑tok increments, 50% off, static‑first ordering): https://openai.com/index/api-prompt-caching/ ; https://developers.openai.com/api/docs/guides/prompt-caching
- DeepSeek context caching on disk (auto, prefix from token 0, ≥1024 tok byte‑exact, hit = 1/10 price): https://api-docs.deepseek.com/news/news0802 ; https://api-docs.deepseek.com/guides/kv_cache
- Cross‑provider caching comparison: https://www.prompthub.us/blog/prompt-caching-with-openai-anthropic-and-google-models
