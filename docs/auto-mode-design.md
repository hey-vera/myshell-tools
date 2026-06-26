# myshell-tools — "Auto" Mode Design

> Goal: the smartest possible **Auto** mode — an adaptive mode that automatically chooses
> models / reasoning effort / verification depth / decomposition / agent orchestration per
> task, so 80%+ of users happily never leave it. Provider-agnostic, quota-first, "it just
> works," and legible.
>
> Companion to `one-chat-redesign-plan.md` (which owns the spine/manager architecture). This
> doc owns ONLY the Auto decision policy. Where they touch, this defers to that doc's
> principles (byproduct intelligence, quota lever = frequency not dumber-per-call,
> provider-agnostic role collapse, always-confirm-before-spend).

---

## 1. Verdict on the draft: **KEEP the philosophy, REPLACE the framing as "start-low / escalate-on-evidence."**

The draft's five pillars are individually correct and most of them are *already built* in this
repo (see §3). But the headline — "**start cheap, escalate on objective evidence**" — is the
wrong primitive for *this* product, and the research backs that up. Three brutal points:

**(a) Pure cascades buy their savings with latency and double-spend — exactly the two
resources myshell is trying to protect.** FrugalGPT-style cascades reach GPT-4-class accuracy
at up to ~98% lower *dollar* cost ([FrugalGPT](https://arxiv.org/pdf/2305.05176)), but they do
it by running a weak model first and *re-running* a strong one on the fraction that fails its
scorer. On a flat-rate subscription myshell's scarce resources are **rate-limit headroom and
wall-clock latency**, not dollars. A cascade that fails and escalates spends *two* calls and
*two* round-trips for the hard turns — the precise turns users care about most. "Start low and
escalate" silently optimizes the wrong cost function here.

**(b) The escalation *trigger* the draft leans on — model self-report / confidence — is the
single most miscalibrated signal in the literature.** LLM confidence (verbalized or logprob /
entropy) is "typically miscalibrated and sensitive to prompt wording, causing threshold
choices that work in one workload to fail in another"
([UCCI](https://arxiv.org/html/2605.18796), [Overconfidence in LLM-as-a-Judge](https://arxiv.org/html/2508.06225v1)).
Miscalibrated confidence "unnecessarily escalates straightforward cases and fails to escalate
genuinely ambiguous ones" — i.e. it produces *both* waste and misses. The draft is right to
"weight objective signals over model self-report"; the research says we must go further and
treat self-report as **near-worthless as an escalation trigger**, admissible only as a tie-breaker.

**(c) The best production systems are *predict-and-route upfront*, not cascade.** GPT-5's
real-time router decides *before generating* based on "conversation type, complexity, tool
needs, and explicit intent" ([OpenAI](https://openai.com/index/introducing-gpt-5/),
[DataCamp on 5.1](https://www.datacamp.com/blog/gpt-5-1)). NotDiamond / OpenRouter Auto score
the prompt with a learned function *upfront* and route once
([OpenRouter Auto](https://openrouter.ai/docs/guides/routing/routers/auto-router)). Cursor Auto
and Windsurf Adaptive both *classify request complexity upfront* and route
([Cursor/Windsurf](https://www.clawrouters.com/blog/reduce-cursor-windsurf-costs)). The
consensus from the routing surveys is explicit: **"route first to avoid obviously mismatched
tiers, then cascade *within* a tier"** is what works in practice
([TianPan](https://tianpan.co/blog/2025-11-03-llm-routing-model-cascades)).

**So the recommended primitive is a HYBRID, and — critically — myshell can get the
predict-upfront half almost for free** in a way the SaaS routers cannot. Those products pay a
*separate* classifier call (extra latency + a model invocation) to predict difficulty. myshell
already emits **intent + risk + tier + plan hints as a structured byproduct of the turn the
user is already paying for** (`IntentFrame.routeTier` / `routePlan` / `operationRisk` /
`blastRadius`, `core/intent.ts`). That byproduct *is* the upfront classifier — at zero marginal
cost and zero added latency. The draft buried this as pillar (1) "sets the starting rung." It
is not the starting rung of a cascade; **it is the whole upfront routing decision.** Escalation
becomes the rare *exception path*, not the spine.

> **Net verdict:** Keep all five draft instincts. Re-found the architecture as
> **"predict-and-commit from free byproduct signals; reserve evidence-based escalation for the
> minority of turns that produce hard objective failure; learn the user; stay legible; bound
> spend."** The difference from the draft is not cosmetic: it flips the *default* from
> "tentatively start cheap and climb" to "commit to the right rung once, and only climb on a
> failed test / typecheck / explicit pushback." That commits fewer calls, adds zero routing
> latency, and stops leaning on the one signal (self-confidence) the research says is broken.

---

## 2. Recommended Auto architecture

Auto is a **policy layer**, not a new model and not a new call. Every decision below is a pure
function of signals myshell already has or gets for free.

### 2.0 The two-layer mental model

```
            ┌──────────────────────────────────────────────────────────┐
  USER TURN │  the ONE strong-model turn the user is already paying for │
            └──────────────────────────────────────────────────────────┘
                        │ emits, as structured BYPRODUCT (no extra call):
                        ▼
   intent.goal · kind · routeTier · routePlan · operationRisk · blastRadius · forks · doneWhen
                        │
        ┌───────────────┴────────────────┐
        ▼  (deterministic, ~0 cost)       ▼
   LAYER A: PREDICT & COMMIT          LAYER B: ESCALATE ON EVIDENCE (exception path)
   pick rung NOW from byproduct       only fires on OBJECTIVE failure after work runs:
   + deterministic classify() +       failed tests / typecheck / lint, growing scope,
   plan tier + user-memory bias       explicit user pushback, verifier reject, stall
        │                                  │  (hysteresis: must clear a margin to move)
        └───────────────┬──────────────────┘
                        ▼
            LEGER + RECEIPT (what was chosen, why, what it cost) — always auditable
```

Layer A handles ~90% of turns with a single committed call at the right rung. Layer B is the
minority correction loop. The draft treated Layer A as "rung 0 of a ladder you climb"; here it
is the **decision**, and Layer B is a guarded exception.

### 2.1 What Auto actually controls (the dials)

Auto resolves, per turn, a tuple. Note that **most dials work even with one model** — model
choice is only one of seven levers:

| Dial | Many-model | One-model |
|---|---|---|
| **Model rung** (worker/ic/manager) | pick provider+model per `route()` | *collapses* — only lever is reasoning effort below |
| **Reasoning effort / thinking budget** | per-provider (`reasoning_effort` low/med/high; Anthropic adaptive-thinking / budget) | **primary lever** — modulate think depth |
| **Verification depth** | none / self-check / cross-vendor review | none / self-check / **second pass same model** |
| **Decomposition depth** | shallow vs JIT-decomposed goal hierarchy | same — decomposition is provider-free |
| **Concurrency / agent fan-out** | panel / hedge / parallel goals (`autoIntensityForTurn`) | sequential only — fan-out across *time*, not providers |
| **Context budget** | how much manager state to inject | same — curated-state lane |
| **Planning passes** (`planningDepthCap`) | 1 grounded vs 2 + cross-model selection | 1 vs 2 passes on the same model |

This table is the heart of the **1-model answer**: see §2.6.

### 2.2 Layer A — predict & commit (the spine, ~0 marginal cost)

For each turn, **before** committing the working call, resolve the rung from signals that are
already in hand:

1. **Deterministic floor** from `classify()` — tier (worker/ic/manager) and risk
   (low/med/high/critical). Pure, free, already exists. Risk stays 100% deterministic and the
   model can only *raise* it (`operationRisk`/`blastRadius` are "may raise, never lower" — keep
   that invariant; it is the anti-overconfidence guard the research demands).

2. **Byproduct routing hints** from the *previous* turn's `IntentFrame` (`routeTier`,
   `routePlan`) — the model's own upfront read, used as a *hint that can lift but not lower* the
   deterministic floor (mirrors how SaaS routers use a learned scorer, but free).

3. **Intent/task-shape detection — done cheaply, mostly without a model.** The "it just works"
   requirement (paste-code vs fix-bug vs vague-discussion vs big-build) is largely a *cheap
   structural* problem, and only the residue needs the model:
   - **Pasted code** → detect by structure (multi-line, brace/indent density, fenced blocks,
     diff markers, stack-trace shape). Structural, zero model cost. Routes to *understand-this*
     posture (read-first, low decomposition).
   - **"find this bug and fix it"** → `classify()` already scores fix/debug verbs; pair with
     "verification available?" → this is the canonical *escalate-on-evidence* shape (run, see
     the test fail, fix, re-run). Start mid, let Layer B drive.
   - **Vague discussion** → low tier + no build intent in byproduct → cheapest rung, no
     decomposition, no goal staging (the existing `judgment: 'none'` frictionless path).
   - **Big build request** → byproduct `judgment: 'stage'` + multi-goal → JIT decomposition
     (skeleton now, todos later), confirm-before-spend, *not* a single monster call.

   This is exactly the "intent is a byproduct, not a classifier call" principle in
   `one-chat-redesign-plan.md` — Auto consumes it, never duplicates it.

4. **User-memory bias** (taste / `memoryBias: -1|0|1`, already plumbed through the planner).
   A user who repeatedly downgrades ("just do it, don't over-think") biases the floor down; one
   who repeatedly asks for more rigor biases it up. Per-user, persisted, legible.

5. **Capacity/quota reality** (`classifyCapacity`, `currentPressure`, cooldown). The committed
   rung is **min(want, can-afford-right-now)**. Under rate-limit pressure the rung is clamped
   and the receipt says so honestly.

**Commit once** at `rung = clamp(floor ⊔ byproduct-hint ⊔ memory-bias, capacity-ceiling)`.
No tentative cheap probe, no speculative second call. This is the predict-and-route half of the
hybrid, paid for entirely by signals the turn already produced.

### 2.3 Layer B — escalate on OBJECTIVE evidence (the exception path)

Escalation is **not** the spine. It fires only when post-execution reality contradicts the
commitment, and **only on objective, machine-checkable signals** (the research's core lesson):

**Admissible escalation triggers (objective, ranked):**
1. **Verification failure** — tests fail, typecheck/lint errors, build breaks, a verifier
   (`tribunal`/`verify`) rejects. *Strongest signal; the ground truth.*
2. **Scope growth** — the plan materially grew vs the committed skeleton (more files/goals than
   the rung assumed). Structural, observable.
3. **Explicit user pushback** — "that's wrong," "no, the other way," a correction, a re-ask.
   Observable from the user's literal next line (and `meta-decision.ts` already parses this).
4. **Stall / timeout** — a run that should have completed didn't (Phase 3 recovery already
   detects this). A timeout is treated as *evidence of bad decomposition first* (re-decompose),
   *then* as an escalation trigger — never just "throw a bigger model at it."

**Inadmissible as a *primary* trigger (research-mandated):**
- Model self-reported low confidence / verbalized uncertainty.
- Raw logprob / token-entropy thresholds.
These are kept ONLY as **tie-breakers** when two objective signals are ambiguous, never as the
sole reason to spend a second call. (UCCI / overconfidence findings.)

**Escalation mechanics:**
- **Hysteresis / margin** (draft pillar 3, kept). A single failing test does not ping-pong the
  rung. Escalate only after the cheaper attempt *demonstrably* failed its objective check; once
  escalated, do not de-escalate within the same goal until a clean run is observed. This is the
  literature's fix for **escalation thrash**.
- **Bounded by `maxAttempts` + provider pool** (already in `policy.ts`). Escalation cannot loop
  unboundedly; after the ceiling, Auto stops and gives an honest "here's exactly what happened"
  (Phase 3 principle), it does not silently keep burning.
- **Speculative hedge** is the *latency* answer to the cascade's *latency* problem: on a turn
  predicted hard (`autoIntensityForTurn` → 4/5) Auto may *overlap* the strong attempt instead of
  waiting for a weak one to fail first (`hedgePolicy` already exists). This is a deliberate,
  disclosed quota spend on the *rare* hard turn — the inverse of a cascade's "always start weak."

### 2.4 De-escalation (kept from draft, pillar 3)

When a goal turns out mechanical (repetitive edits, all-green verification, no forks), Auto
*lowers* the rung for subsequent todos within that goal — but with the same hysteresis: it must
observe sustained mechanical success (≥N clean todos) before dropping. This is what keeps a
20-page build from running every trivial page at manager tier.

### 2.5 Legibility & trust (draft pillar 5 — load-bearing for "80% stay in Auto")

Users only live in Auto if they can audit it. Every committed turn writes a **one-line
receipt** (extends the existing ledger + the `formatGoalPlanSelectionDisclosure` /
`trust-receipt` pattern):

```
Auto · ic · medium effort · self-check · (risk: medium, byproduct hint: ic) · ~X tokens
↑ escalated to manager — typecheck failed twice (objective)        [only on Layer B]
```

Requirements:
- **Choice + reason + cost, always.** Reason cites the *objective* signal, never "the model
  felt unsure."
- **Pre-spend confirmation on real spend** (draft pillar: budget ceiling). Confirm before
  executing a *staged build*, and before any escalation that crosses into manager/panel on a
  high-cost plan. Remember the per-user preference (manual / semi-auto / auto) — already in
  `decideGoalActivation` / `GoalActivationOverride`.
- **One honest knob to leave Auto**, and a "why did you do that?" that replays the receipt.
- **Never bill concurrency/panel as free** (existing panel-notice discipline).

### 2.6 The 1-model case (explicitly designed, not an afterthought)

With a single provider/model, `route()` cannot switch rungs — so Auto **drops model-choice from
the tuple and drives the other six dials** (§2.1 table). Concretely:

- **Reasoning effort becomes the primary intelligence dial.** Trivial turn → minimal/no
  thinking; hard turn → high effort / larger thinking budget (Anthropic adaptive-thinking;
  `reasoning_effort` high for OpenAI/Grok). This is the research's L2 adaptive-test-time-compute
  result: easy inputs degrade under overthinking, hard inputs benefit disproportionately
  ([Reasoning on a Budget survey](https://arxiv.org/abs/2507.02076)) — so adapting *effort* on
  one model recovers much of what model-switching would buy.
- **Verification depth substitutes for cross-vendor panel.** No second vendor to disagree with,
  so on hard turns Auto runs a **second self-review pass** (same model, fresh context) or a
  structured self-critique — bounded, disclosed.
- **Escalation becomes effort-escalation, not model-escalation.** A failed test re-runs the fix
  at *higher reasoning effort* / with a verification pass, not a bigger model (there is none).
- **Quota is protected by frequency, context reuse, and local-first**, exactly as the north star
  mandates — never by "thinking dumber," because on one model there is nothing to downgrade to.
- **Decomposition and JIT planning are fully available** (provider-free) and do more of the work:
  on one model, *small well-scoped units at the right effort* is the main quality lever.

The mapping is clean: every dial in §2.1 has a defined 1-model behavior, and the *policy logic
is identical* — only the resolution of "rung" changes from (model×effort) to (effort alone).

### 2.7 The many-model case

`route()` + `deriveLiveProviderOrder` already pick provider/model per tier under live capacity.
Auto adds nothing new mechanically here; it just supplies the *rung* and lets the existing
provider-order + capacity allocator resolve it, plus unlocks panel/hedge on hard turns when ≥2
providers are signed in (`panelPolicy`, `planningSelectionEntitlement`). The "smartest" addition
is cross-vendor *verification* on genuinely hard turns (independent judgment beats self-judgment
— the multi-agent-debate / panel evidence), reserved for high/critical risk so it stays cheap.

---

## 3. Mapping onto myshell's EXISTING machinery

**The single most important finding: ~80% of this Auto design already exists in the repo as
separate mechanisms.** Auto is mostly a *unifying policy + a receipt*, not new subsystems.

| Auto capability | Existing machinery | New work? |
|---|---|---|
| Upfront difficulty/intent (free byproduct) | `core/intent.ts` `IntentFrame` (`routeTier`, `routePlan`, `operationRisk`, `blastRadius`, `forks`, `doneWhen`) | **Exists.** Auto *consumes* it. |
| Deterministic floor (tier + risk) | `core/classify.ts` | **Exists.** |
| Rung → policy thresholds | `core/policy.ts` (`POLICY_PRESETS`, `escalateBelowConfidence`, `flagshipAdmission`) | **Exists** — Auto sets the active preset *per turn* instead of per session. |
| Flagship (manager) admission, 1-pass earned | `core/flagship.ts` `authorizeTier` / `flagshipAdmission: 'adaptive'` | **Exists** — this IS predict-and-commit-with-guarded-escalation already. |
| Evidence-based escalation ceiling | `policy.maxAttempts`, provider-failover budget | **Exists.** |
| Reasoning-effort / mode → effort | Phase 0 "Mode dial → normalized effort + rung" (substrate) | **Partly exists / planned.** Auto needs effort to be a *per-turn* output, not just a static mode. |
| Confidence-gated escalation thresholds | `escalateBelowConfidence` per risk | **Exists** — but **re-weight**: per research, drive escalation off *objective verification*, not the confidence number. This is the main *behavioral* change. |
| Auto-intensity (concurrency/panel/hedge) | `capacity-allocator.ts` `autoIntensityForTurn`, `regimeForIntensity` | **Exists.** |
| Planning depth / JIT decomposition | `core/autonomy.ts` (`planningDepthCap`, `chooseInitialPlanningDepth`, `shouldRunPlanningSelection`) | **Exists.** |
| Goal staging / activation / confirm-before-spend | `interface/auto-stage.ts`, `decideGoalActivation`, `GoalActivationOverride` | **Exists.** |
| Capacity/quota clamp | `classifyCapacity`, `deriveLiveProviderOrder`, `currentPressure`, cooldown | **Exists.** |
| Per-user personalization | `core/taste.ts`, `memoryBias`, `memory-injection.ts`, `detectActivationOverride` | **Exists.** |
| Cost visibility / receipt | `infra/ledger.ts`, `trust-receipt.ts`, `formatGoalPlanSelectionDisclosure`, Phase 6 | **Exists** — Auto adds a per-turn *rung receipt* line. |
| Mode-from-plan defaulting | `policy.ts` `autoModeForPlans`, `defaultModeForPlan` | **Exists** — pick Auto's *default posture* from the detected plan. |

**What is genuinely NEW (small surface):**
1. **A per-turn rung resolver** that fuses (deterministic floor ⊔ byproduct hint ⊔ memory bias),
   clamps to capacity, and outputs `{modelRung, effort, verifyDepth, decompDepth, concurrency,
   contextBudget}` — i.e. promote the existing *session-level* `Mode` to a *per-turn* decision.
   Most of the inputs already exist; this is the missing **fusion function**.
2. **Reframe escalation to be verification-driven, not confidence-driven.** Mechanically small
   (re-point what feeds the escalate decision), behaviorally the biggest change.
3. **Per-turn rung receipt** + the "why did you do that" replay (extends ledger/trust-receipt).
4. **The 1-model dial collapse**: ensure effort/verify substitute cleanly when model rung can't
   move (depends on Phase 0 effort normalization landing).
5. **Memory bias → rung** wiring (taste already exists; the *bias-the-floor* hook is new).

Everything else is composition. This is the strongest argument for the design: it is mostly
*turning existing parts into one legible policy*, which is cheap to ship behind a flag and easy
to make green on both the 1-model and multi-model test matrix.

---

## 4. Open design questions for the lead

1. **Default posture of Auto.** Should Auto's *default floor* track the detected plan
   (`defaultModeForPlan`: Max→aggressive, Free→frugal), or always start at a fixed "balanced"
   and let memory drift it? (Plan-tracking is friendlier day-1; fixed-start is more legible.)

2. **Confirm-before-spend granularity.** Today confirmation gates *goal execution*. Should
   Auto *also* confirm before a Layer-B escalation that crosses into manager/panel on an
   expensive plan, or is the receipt-after-the-fact enough? (Trade: trust vs friction. My lean:
   confirm only when crossing into panel/manager on a *substantial* goal; silent + receipted
   otherwise.)

3. **How aggressively to trust the byproduct `routeTier` hint.** Lift-only (can raise floor,
   never lower) is the safe default. Do we ever let it *lower* the deterministic floor for
   obviously-trivial turns, to save the most quota? (Risk: the one signal we're distrusting
   elsewhere leaking back in.)

4. **1-model verification cost.** A second self-review pass on hard turns *doubles* the call on
   exactly the turns a 1-model user can least afford under quota pressure. Cap it at
   high/critical only? Make it a user toggle? Skip entirely under pressure and just disclose
   "single pass — quota-limited"?

5. **Self-report as tie-breaker — in or out entirely?** The research says self-confidence is
   broken as a *primary* trigger. Do we admit it as a *tie-breaker* at all (slightly smarter,
   slightly less legible), or ban it outright for a fully objective, fully auditable escalation
   story? (My lean: ban it from the trigger; it's fine as *displayed context*.)

6. **Memory bias scope.** Per-user-global, or per-project? A user may want rigor on their
   payments repo and speed on a scratch project. (Per-project is smarter, more storage + a
   colder start.)

7. **Escalation hysteresis constants.** How many clean todos before de-escalating a goal's rung;
   how many objective failures before escalating. These want tuning on the eval harness
   (`core/eval/`) before promotion to stable.

8. **Does Auto ever *predict hard* and skip the cheap attempt entirely** (pure predict-route),
   vs always committing the predicted rung? (The hedge already half-answers this; the question
   is whether to make upfront "go straight to manager" a first-class Auto decision for
   byproduct-flagged hard turns, accepting occasional over-spend to kill latency.)

---

## 5. Sources

- RouteLLM (preference-data router; classifier vs cascade framing): https://arxiv.org/pdf/2406.18665 · https://github.com/lm-sys/RouteLLM
- FrugalGPT (cascade, cost savings, escalate-on-failure): https://arxiv.org/pdf/2305.05176
- LLM routing vs cascades, "route first then cascade within tier": https://tianpan.co/blog/2025-11-03-llm-routing-model-cascades · https://tianpan.co/blog/2025-10-19-llm-routing-production
- GPT-5 real-time router (predict upfront on complexity/intent/tool-need): https://openai.com/index/introducing-gpt-5/ · https://www.datacamp.com/blog/gpt-5-1
- OpenRouter Auto Router (NotDiamond, upfront prompt analysis, cost-quality tradeoff): https://openrouter.ai/docs/guides/routing/routers/auto-router · https://openrouter.ai/blog/insights/model-routing/
- NotDiamond / Martian / Unify (neural upfront scoring, awesome-ai-model-routing): https://github.com/Not-Diamond/awesome-ai-model-routing
- Cursor Auto / Windsurf Adaptive (upfront complexity classification, ~80% of tasks): https://www.clawrouters.com/blog/reduce-cursor-windsurf-costs
- Claude Code model selection / Opus-orchestrator + Sonnet-workers / adaptive reasoning / Max fallback: https://code.claude.com/docs/en/model-config · https://www.mindstudio.ai/blog/smart-orchestrator-cheaper-sub-agent-models-claude-code
- Adaptive test-time compute / reasoning effort (overthinking on easy, underthinking on hard): https://arxiv.org/abs/2507.02076 · https://arxiv.org/pdf/2511.02130
- Confidence miscalibration / overconfidence (why self-report is a bad escalation trigger): https://arxiv.org/html/2508.06225v1 · https://arxiv.org/pdf/2410.09724
- UCCI: calibrated uncertainty for cost-optimal cascade routing (confidence thresholds don't transfer): https://arxiv.org/html/2605.18796
- Uncertainty/embedding-based difficulty estimation; self-consistency / semantic entropy cost: https://arxiv.org/abs/2410.22685 · https://arxiv.org/html/2502.11021
- Cascade failure under adversarial input (cascades' robustness failure mode): https://arxiv.org/html/2605.17288
