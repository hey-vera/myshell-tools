# Vendor-Neutral Routing Plan — Adversarial Challenge

Reviewing `docs/vendor-neutral-routing-plan-final.md` against the real code on `main`.
Owner decisions (1–8) are treated as BINDING; this critique only asks whether the plan
robustly *achieves* them.

## Verdict

**Not 10/10-ready as written — a strong ~8/10 plan with the right architecture and five
real holes that will produce mis-routes or mid-sequence regressions if built verbatim.**
The control-flow design (inventory → candidates → hard filter → curated suitability →
quota/load tie → neutral tiebreak), the typed `NoCapableProvider`, the per-pool quota
measurement, and the soft web-search posture are all correct and match the owner's intent.
But the curated-baseline promise is unachievable for the very provider with the most churn
(OpenCode), the "unknown = neutral" honesty invariant becomes a *routing hazard* under the
alphabetical tiebreak, two slices regress the shipping default mid-sequence, and panel/
synthesizer/registry-correctness are under-specified. Proceed to build **after** folding in
the must-fixes below — most are cheap and several change slice ordering.

## What's strong (keep as-is)

- **Cost = quota, never dollars; no fabricated "remaining quota."** Correct and honest. The
  per-pool session-token load + 429 cooldown as *measurement* (not learning) is the right
  proxy and is consistent with 2026 multi-key practice (token-aware TPM pools, reroute on
  exhaustion).
- **Typed `NoCapableProvider`** replacing the `route.ts:166-170` throw — matches the
  best-practice "deterministic, well-tested fallback chain."
- **Web search soft + fail-soft**, never a hard gate. Correct.
- **Honest collapse of `opencode/*` Zen-vs-free** into one pool when undistinguishable. Good
  intellectual honesty; do not let anyone "fix" it by guessing.
- **GO pool derivation is genuinely reliable** (see Hole #2): `opencode-go/*` model-id prefix
  is parsed today at `detect.ts:809-823` and carried in verbose `providerID`, so the GO pool
  is real, not guesswork. Only Zen-vs-free is ambiguous, which the plan already concedes.

## Holes / risks, ranked, with fixes

### H1 (CRITICAL) — The curated baseline cannot exist for OpenCode; slice 5 contradicts itself
`DECLARATIVE_MODEL_CAPABILITIES.opencode = []` (`model-capabilities.ts:287`) and OpenCode's
real models arrive at runtime via `opencode models` with **no tier, no suitability, no
effort** (`model-capability-refresh.ts:186-199`, source `['detect']`). Slice 5 says "replace
`selectOpencodeModel` string heuristic with **registry-backed** selection" — but there is no
curated registry to back it, and there cannot be (the roster — Kimi/GLM/DeepSeek/big-pickle/
mimo/…free — churns constantly). So OpenCode cold-start (the owner's #1 quota-preservation
provider, #4/#5) is graded on a *different, weaker basis* than Claude/Codex/Grok: the same
keyword heuristic in `opencode-model.ts:29-55` that scores any unknown family `3` ("mid").
A new family it doesn't recognize can be mis-picked as worker *or* manager.

This is the plan's own warning ("a bad/absent score is worse than no score") landing exactly
where it hurts most. **Fix:** stop pretending OpenCode is curated. Define a first-class,
deterministic `opencodeTierRank(model, verboseFacts)` that ranks from *objective* refresh
facts already available — `contextWindow`/`maxOutputTokens` (`extractOpencodeFacts`),
`capabilities.reasoning`, variant depth — plus a small maintained family table, and make the
registry validator assert that ranking function runs (not that curated rows exist per model,
which is impossible). Document OpenCode as "deterministically ranked from live facts," not
"curated." Without this, slices 5/9 ship a false invariant.

### H2 (HIGH) — Pool derivation rests on auth.json *key names* the code never proves
`parseOpencodeCredentialPools` (§3) assumes the auth.json credential key for GO is literally
`opencode-go` and for Zen is `opencode` with `type:"api"`. The actual code
(`detect.ts:723-736`) only counts `type:"oauth"|"api"` over *any* key and never inspects key
names; `opencodePlanFromAuthJson` iterates keys generically. The real keys are likely the
underlying account provider (`anthropic`, `openai`, `opencode`, …), so the GO-vs-Zen split by
*credential key* is an unverified guess. **Fix:** do not pin pool identity to credential-key
strings. Derive pool **from the model-id prefix** (`opencode-go/*` → GO; `opencode/*` →
Zen-or-free), which IS proven in code, and use credential presence only as a soft "Zen API
key seen" hint. This makes `parseOpencodeCredentialPools` largely redundant — fold it into a
thin `poolForModelId()`. Verify against one real `auth.json` before writing slice 3 tests, or
the tests encode a fiction.

### H3 (HIGH) — "Unknown = neutral" + alphabetical tiebreak silently promotes unknown models and re-creates Claude-first
Two coupled facts: (a) `findCapability` returns `undefined` for any model not in the registry,
and `scoreModel` treats unknown as **neutral 0** (`route.ts:528-532`) — correct for honesty,
dangerous for routing; (b) the final tiebreak is alphabetical on `${provider}:…`
(§1.8, §5). Consequences:
- A brand-new CLI model id (registry not yet updated) scores neutral at **every tier**, so on
  a manager route it is a co-equal candidate and the tiebreak can hand it the manager slot.
  An unknown model must never be *promoted* by absence of data.
- "claude" < "codex" < "grok" < "opencode" alphabetically. On any genuine suitability tie
  (the common all-provider cold start the plan describes in §5), the tiebreak deterministically
  picks **Claude** and systematically deprioritizes **opencode** — i.e. it reproduces the very
  Claude-first bias being removed *and* fights the owner's quota-preservation goal (#6). The
  plan calls this "a documented neutral tie," but a *systematic* lexical bias toward one vendor
  is not neutral.

**Fix:** (1) unknown/uncurated models default to a conservative `worker`-only candidacy
(never manager) until a fact or curated row admits them. (2) Replace the lexical tiebreak with
a neutral deterministic one that does not encode vendor alphabet: break ties toward the
lowest normalized pool-load (already a signal), and when that is also equal (turn 1) use a
stable per-session rotation (hash of session id + candidate key) so first-turn choice spreads
across providers/pools over many sessions instead of always Claude. This directly serves
#5/#6 load-spread.

### H4 (HIGH) — Slices 7 & 8 regress the *shipping default* before the new router is on
Slices 7 (remove learned-outcome ordering from `deriveLiveProviderOrder`,
`capacity-allocator.ts:247-272`) and 8 (stop feeding routing-memory from `cli.ts`/`menu.ts`)
mutate the **flag-off, default-on-main** path. Between slice 8 and graduation (slice 16), the
default product loses its adaptive ordering while still running the old static Claude-first
engine — a real regression for current users, shipped "green" because typecheck/tests pass.
Slice 5 likewise rewrites `selectOpencodeModel`, used by the *current* `route.ts:201`, before
the flag flips. **Fix:** gate all learning-removal behind the same flag (apply only when the
new router is active), or reorder so 7/8 land *after* slice 16. The owner decision "no runtime
learning" is about the *end state*; it must not silently degrade the interim default.

### H5 (MEDIUM-HIGH) — Registry validation checks presence/consistency, not *correctness*; "self-test" is named but undefined
The plan's validators (§2) catch missing rows and adapter mismatches, but a typo'd
`tierSuitability` (e.g. `worker:90` on Opus) passes every check and deterministically
mis-routes *every* turn — the deterministic router's worst failure mode, with no learning to
self-correct. `validation.source: 'curated-self-test'` is listed as a value but the self-test
is never defined. **Fix:** define it concretely: (a) a *monotonicity* invariant cross-checking
suitability against objective facts — a model may not score above a same-provider sibling that
has a larger context window / deeper effort support unless an explicit `override+reason` field
is present; (b) an optional live smoke that runs one trivial known prompt per authed model and
asserts tier *ordering* sanity. This is what turns "deterministic" from "confidently wrong" to
"trustworthy."

### H6 (MEDIUM) — Panel/synthesizer/reviewer neutrality is under-specified (slice 15)
`planPanel` takes `authenticatedProviders.slice(0, cap)` and sets synthesizer
`= candidates[0]` (`ensemble.ts:148-155`); `pickReviewer` returns the first *different*
provider (`escalate.ts:52-57`). Both are pure functions of the **order** of the provider list,
which is almost certainly the `ProviderId` enum order (`claude, codex, opencode, grok`,
`port.ts:26`). So even after `route()` is neutral, panels always seat Claude+Codex and Claude
always synthesizes, and reviews are vendor-ordered. Slice 15 says "wire neutral selection" but
names no ordering source. **Fix:** feed the curated suitability ranking into panel candidate
selection, and make the **synthesizer the highest manager-tier-suitability authed model**, not
`candidates[0]`. Pick the reviewer as the highest-suitability *cross-vendor* candidate. State
this explicitly in slice 15's acceptance.

### H7 (MEDIUM) — Claude web-search capability is missing from the registry → capability-driven search will never pick Claude
`port.ts:74-77` documents that the Claude adapter appends `--allowedTools WebSearch WebFetch`
(LIVE-VERIFIED), i.e. Claude *does* native search. But the registry's Claude rows have **no**
`supportsSearchTool` (`model-capabilities.ts:186-227`); only Codex and Grok declare it. Under
slice 13's capability-driven routing, a Claude-only or Claude-preferred user needing facts
would never be soft-preferred for search even though Claude can do it. `understanding-
generator.ts:90-92` also still hardcodes `id === 'codex'`. **Fix:** add `searchMode:'native'`/
`supportsSearchTool:true` to Claude rows (and audit Grok/OpenCode against real adapter
behavior) as part of slice 4, before slice 13 consumes it.

### H8 (MEDIUM) — Per-pool cooldown is coarse on the placeholder path; pool accounting needs ledger model→pool mapping
`sessionConsumption` is keyed by `entry.provider` (`menu.ts:1346-1354`) and cooldown is
provider-keyed (`cooldown.ts`). Re-keying to `QuotaPoolId` (slice 6) requires mapping
`entry.model` → pool at record time — feasible for `opencode-go/*` vs `opencode/*`, but when
`route()` falls back to the bare `opencode` placeholder (empty model list → adapter omits
`-m`, `opencode.ts:92`), the model has no slash and **the pool is unknowable**, so a 429 there
cools *both* GO and Zen. Acceptable as a documented fail-safe, but the plan should state it and
ensure the placeholder fallback is rare (it only triggers when `opencode models` returned
nothing). Also confirm the ledger entry carries `model` (it does) so pool attribution at
record time is possible.

### H9 (LOW) — Codex pricing rows diverge from registry/detect for the *extra* models
The main three (`gpt-5.5/5.4/5.4-mini`) align across pricing (`pricing.ts:88-119`), registry,
and `detect.ts:671`. But pricing also carries `gpt-5.4-nano` and `gpt-5.2-codex` that are in
neither detect's `availableModels` nor the capability registry. `candidateModelsFor` reads the
**pricing table** (`route.ts:235`), so with no `allowedSet` those orphan rows become neutral-
scored candidates. Minor today, but slice 12 should reconcile pricing ↔ registry ↔ detect to a
single source of candidate ids, not just "validate Codex IDs."

### H10 (LOW) — The audit this plan builds on is stale vs `main`
`provider-agnostic-sanity.md`'s headline "Confirmed Drift" is worker = `['opencode',
'claude',…]` (opencode-first). Current `policy.ts:47-51` is **Claude-first for all tiers**
(`['claude','codex','opencode','grok']`). The plan's §1 correctly says Claude-first, but
anyone cross-reading the two docs will be confused, and the audit's central example no longer
exists in code. Add a one-line note that the audit predates the worker→Claude-first revert; the
bias to remove today is Claude-first everywhere, not OpenCode-first worker.

## On the owner decision to remove learning entirely (is cooldown-only enough?)
Mostly yes, *given the existing safety nets* — but call it out. Cooldown catches hard
429s/errors; it does **not** catch a provider silently degrading (truncated/low-quality output
that still returns `done`). 2026 routing guidance (registries tracking *recent error rates*,
not just availability) treats health as a routing signal. The owner bans **quality learning** —
fine — but the plan should explicitly lean on the downstream `verify → escalate (Layer B) →
cross-vendor review` loop as the silent-degradation backstop, and state that routing will not
adapt to soft quality regressions by design. That is an honest 10/10 stance; leaving it
unstated is an 8/10 gap.

## What to ADD or reorder for true 10/10

1. **Reorder:** move learning-removal (slices 7, 8) to *after* graduation (slice 16), or gate
   them behind the flag (H4). Keep `selectOpencodeModel`/registry changes backward-compatible
   while the flag is off (H1/H4).
2. **Add** a defined `opencodeTierRank()` deterministic function + validator (H1), and a
   `poolForModelId()` that derives pools from model-id prefix, demoting
   `parseOpencodeCredentialPools` to a soft hint (H2).
3. **Add** an unknown-model floor (worker-only candidacy, never promoted by absence) and
   replace the alphabetical tiebreak with load-then-session-hash rotation (H3).
4. **Add** a concrete registry correctness self-test: fact-monotonicity invariant + optional
   per-model smoke (H5).
5. **Specify** suitability-driven panel candidates, synthesizer, and reviewer in slice 15
   (H6); add Claude (and audited Grok/OpenCode) search capability in slice 4 (H7).
6. **Document** the placeholder-path coarse cooldown (H8), reconcile Codex id sources (H9),
   note the stale audit (H10), and state the verify/escalate backstop for silent degradation.

## Sources
- [LLM Model Routing 2026 best practices](https://www.digitalapplied.com/blog/llm-model-routing-2026-cost-quality-optimization-engineering-guide) — registries should track latency + recent error rates; deterministic, well-tested fallback chains.
- [Multi-model routing orchestration 2026](https://mindra.co/blog/multi-model-routing-llm-orchestration-2026) — design axes: when decided / what info / how computed; pure rules sit at the weaker end without any past-performance signal.
- [INFERENCEDYNAMICS: routing via structured capability profiling](https://arxiv.org/pdf/2505.16303) — capability + knowledge profiles as routing basis (supports a fact-derived, not name-derived, registry).
- [liteLLM load balancing](https://docs.litellm.ai/docs/routing) and [Portkey failover routing](https://portkey.ai/blog/failover-routing-strategies-for-llms-in-production/) — treat multiple keys as one weighted logical pool; reroute on exhaustion; token-aware (TPM) limits — supports per-pool token-load measurement and load-spread.
