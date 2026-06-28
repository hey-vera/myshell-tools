# The Intelligence Layer — Design

> How a chat turn becomes the wisest use of every connected provider. Disciplined,
> deterministic-first, free-byproduct-first, evidence-gated. Companion to
> `auto-mode-design.md` (decision policy) and `one-chat-redesign-plan.md` (spine).
>
> **The one rule this doc enforces:** the project's #1 documented failure mode is
> *flag-gated perfectionism — build substrate forever, never ship*
> (`direction-audit.md:52-68`). Almost everything below ALREADY EXISTS as pure,
> tested substrate. This layer's job is **consumption and reconciliation, not more
> building.** Every "v1" item is a wiring/turn-on, not a new module.

---

## 0. TL;DR

- Q1 difficulty, Q3 quota: **already strong and largely wired.** Ship them ON.
- Q2 capability, Q4 composition: **substrate exists but is competing with itself**
  (two brains: `fuseRung` vs `governor.allocate`). The work is to *pick one and delete*,
  not to add precision.
- Q5 orchestration: **the one genuinely-unfinished slice** — Layer B escalation is a
  wired-but-unconsumed stub. Finishing it is the highest-leverage work in the repo.
- The single first step is not code-shaped, it is **turn-it-on-for-yourself** so a
  feedback loop finally exists.

---

## 1. Honest current-state scorecard

| # | Question | Score | What EXISTS (file:line) | What's STUB / MISSING |
|---|----------|-------|--------------------------|------------------------|
| 1 | **Difficulty sensing** (cheap, no extra call) | **8/10** | Free byproduct: `IntentFrame.routeTier`/`operationRisk`/`blastRadius`/`confidence`/`kind` (`intent.ts:45-107`). Deterministic floor: `classify()` tier+risk multi-signal scorer with anti-overtrigger manager gate (`classify.ts:318-404`). Fusion: `intentShapeOf` + `floorFromClassification` + `fuseRung` (`auto-brain.ts:86-167,328-428`) — `predict-and-commit` on hard/big turns, no probe. This IS the upfront router, at zero marginal cost (`auto-mode-design.md:52-60`). | "Giant multi-step project" magnitude is only coarsely sensed pre-decompose (one shape: `big-build`). Real size resolves at `decompose()` (1 model call). Acceptable. |
| 2 | **Capability matching** (near-peers) | **5/10** | Deterministic tier→provider baseline order from capacity weights (`capacity-allocator.ts:97-121`). Opt-in capability-fit re-rank from a declared registry (`route.ts:60-69,208-215`; `model-capability-registry-5.6.md`). Declared `availableModels` per provider (`detect.ts:51,592,671`). | The registry is the **gold-plating attractor** — a hand-authored "who's better" table that rots and tempts micro-ranking GPT-5.5 vs Opus 4.8. Capability-fit is default-absent (off). Honest tier + load is solid; peer-strength oracle is not (and should not be) real. |
| 3 | **Quota-aware load spreading** (deterministic allocator) | **8/10** | Best-developed area. `classifyCapacity` plan→weight (`capacity-allocator.ts:42-95`); `deriveLiveProviderOrder` sorts by `normalizedLoad = sessionTokens / capacityWeight` with cooldown demotion (`:251-301`); `crossGoalCap` = `min` of every ceiling so no single high signal cancels a low quota (`:185-193`); governor `effectiveBudget = max(1, base − pressure)` shrinks honestly on 429 (`governor.ts:375-383`). Wired live (`menu.ts:2285-2291`). | `pressure` is **reactive only** — no signal until the first 429 (`governor.ts:309-314`). Cross-session quota persistence is session-scoped. Both acceptable for v1. |
| 4 | **Composition** (how many models / effort / combo) | **6/10 built, 3/10 coherent** | Rung tuple (level→effort/verifyDepth/modelRung) via `fuseRung`/`rungTupleForLevel` (`auto-brain.ts:328-428`). Intensity regimes focused/pair/fleet/panel (`capacity-allocator.ts:123-161`). Governor lever framework: critic/poll/tribunal/panel gated by `turnCallBudget` + `authedProviderCount≥2` (`governor.ts:192-272,400-403`). | **TWO COMPETING BRAINS.** `fuseRung` (per-turn rung) and `governor.allocate` (886-line policy engine) both decide composition. `direction-audit.md:78` calls Governor *"a second brain competing with `fuseRung` — pick one, Auto-brain should win."* This is the epicenter of the failure mode. |
| 5 | **Orchestration to completion** (never stuck) | **6/10** | Bounded multi-goal DAG scheduler, `BASE_ACTIVE_LIMIT=2` (`scheduler.ts`). `decompose()` — one model call, fail-soft to single-goal whole-plan fallback, cycle-breaking (`decompose.ts:267-331`). Fail-soft + honest-failure everywhere. | **Layer B is a stub.** `shouldEscalate`/`shouldDeEscalate` are pure, tested, BUT *"not yet wired into the live escalation path"* (`auto-brain.ts:35-42,540-541`). Decompose-on-timeout exists as a function but isn't driven by a stall/timeout supervisor. The "never stuck" loop is the missing piece. |

**The shape of the truth:** difficulty + quota are done; capability is fine if you resist the
oracle; composition is over-built and self-competing; orchestration has one real gap (Layer B
wiring). The repo's problem is not too little intelligence — it is intelligence that has never
been turned on, so it has never been corrected (`direction-audit.md:56-58`).

---

## 2. v1 design — the line that ships

Bias: deterministic + free-byproduct + evidence-gating. Almost entirely composition of
existing parts. **Ship it ON for the dogfooder.**

| # | v1 mechanism (simplest that delivers the vision) | Built from |
|---|---|---|
| 1 | **Difficulty = `fuseRung` exactly as-is.** Byproduct hint → classify floor → memory-bias nudge → ceiling clamp. Hard/big turns predict-and-commit (no probe, no cascade). No new model call, no new module. **Just flip it default-on.** | `auto-brain.ts:328-428` (done) |
| 2 | **Capability = tier-order + HARD-requirement gates only.** Pick the provider by deterministic tier baseline order (already load-aware). Use the registry for **binary must-haves only** (needs vision? needs 1M context? → exclude providers that can't) — never for "who's smarter among peers." Near-peer ties break by **load, not by a strength score** (already how `deriveLiveProviderOrder` behaves). | `capacity-allocator.ts:97-121,251-301`; `route.ts` capability-fit restricted to hard requirements |
| 3 | **Quota = the existing allocator, turned on and persisted.** `deriveLiveProviderOrder` + `crossGoalCap` + `effectiveBudget`. The only addition: **persist `sessionTokensByProvider` across the day** so spreading survives restarts. Still 100% deterministic, zero thinking cost. | `capacity-allocator.ts:185-301`; `governor.ts:375-383` |
| 4 | **Composition = ONE brain (`fuseRung`).** The rung tuple decides effort + verifyDepth + modelRung. Map `rung.level → intensity` through the existing pure mappers and **stop running `governor.allocate` as a parallel decider.** Multi-model is reached for in exactly ONE shape: `verifyDepth: 'cross-vendor'`, which v1 fires ONLY on high/critical turns with ≥2 vendors and budget headroom — i.e. a single evidence-gated second opinion, never a default panel. | `fuseRung` + `legacyModeToIntensity`/`autoIntensityForTurn` (`capacity-allocator.ts:195-241`); governor demoted to a budget gate |
| 5 | **Orchestration = wire Layer B + a stall supervisor.** (a) Feed `shouldEscalate`/`shouldDeEscalate` the **objective evidence already collected** (test/typecheck/lint failures from verify, scope growth, explicit pushback). (b) On goal **timeout/stall**, call `decompose()` ONCE to break it down, else fail honestly. Hysteresis constants stay conservative until real data tunes them. | `auto-brain.ts:511-608` (wire the stub); `decompose.ts:267-331`; `scheduler.ts` |

**What v1 deliberately does NOT do:** no learned routing, no panels-by-default, no peer-capability
oracle, no second classifier call, no governor policy engine running alongside `fuseRung`.

---

## 3. Above-and-beyond north star (kept SEPARATE from v1)

What "wise orchestration across many providers" looks like at its best — **only after v1 has run
live long enough to produce outcomes worth learning from.**

| Capability | North-star shape | Seed already in repo |
|---|---|---|
| **Learned routing from outcomes** | Re-rank providers per tier *and per task-kind* from the real outcome ledger (success/latency/retry), feeding the allocator's optional learned-order slot. | `routing-memory.ts` (`learnProviderOrder`, `learnModelOutcomeOrder`, `computeTierStats`) already PRODUCES `learnedOutcomeOrderByTier`; `deriveLiveProviderOrder` already CONSUMES it (`capacity-allocator.ts:261-301`; `menu.ts:1326-1329,2285-2289`). The pipe exists — it just needs live data. |
| **Cross-vendor panels / debate** | On high/critical decisions, two vendors build/critique the same fork in isolation; reconcile. | `governor.ts` levers (critic/poll/tribunal/panel) + `tribunal.ts`. **Demote from standalone subsystem to a `verifyDepth` Auto reaches for** (`direction-audit.md:79`), never default-on. |
| **Adaptive load-balancing** | Predictive (not just reactive) quota modeling: learn each plan's real refill cadence, pre-emptively spread before a 429. | `effectiveBudget` + `pressure` (today reactive-only) become a learned curve. |
| **Capability registry that learns** | Replace the hand-authored "who's good at what" table with one inferred from outcomes per task-kind — kills the rot/false-precision problem at the source. | `model-capability-registry-5.6.md` + `learnModelOutcomeOrder`. |

The through-line: **every north-star item is the *learned* version of a v1 *deterministic*
mechanism.** Ship deterministic, log outcomes, let learning replace heuristics one slot at a time —
never build the learned version first.

---

## 4. Gold-plating traps (name them loudly)

1. **The peer-capability oracle.** A precise "GPT-5.5 vs Opus 4.8, who's secretly best at X" table
   (the temptation latent in `model-capability-registry-5.6.md`). **Why it's a trap:** near-peer
   micro-ranking is noise, the table rots the day a model updates, and it manufactures false
   precision the user pays for in maintenance and wrong picks. **Do instead:** tier + hard-requirement
   gates + load-based tie-break. Models within a tier are *interchangeable on purpose.*

2. **The model-as-router.** A dedicated classifier call to predict difficulty (what Cursor/NotDiamond
   pay for). **Why it's a trap:** extra call + latency every turn, AND models are miscalibrated at
   predicting their own difficulty (`auto-mode-design.md:30-38`). The byproduct `IntentFrame` already
   IS the router, free. **Anchoring principle — do not relitigate.**

3. **Two composition brains.** Continuing to grow `governor.ts` (886 lines) alongside `fuseRung`.
   **Why it's a trap:** an 886-line policy engine is the antithesis of "the user never thinks about
   models," and it directly competes with the per-turn decider (`direction-audit.md:78`). **Pick one
   (`fuseRung`), demote the governor to a thin budget gate, delete the rest.**

4. **Always-on / default-off panels & tribunal.** The 1,200-line cross-vendor deliberation subsystem
   (`tribunal.ts` + `verify.ts`) as a standalone architecture. **Why it's a trap:** it's justified ONLY
   on high/critical turns (`auto-mode-design.md:251-257`); as a default-off subsystem it's pure
   substrate-sprawl that burns customer quota when it does fire. **Demote to a `verifyDepth` Auto
   reaches for, evidence-gated, high/critical only.**

5. **Tuning before living.** Hardening Layer B's hysteresis constants on the synthetic eval harness
   before any real session data flows (`auto-brain.ts:526-530`). **Why it's a trap:** you cannot
   calibrate thresholds against a workload you have never run. This is the failure mode in miniature —
   perfecting the part that *needs* real data while withholding the real data
   (`direction-audit.md:62-64`).

---

## 5. The single smallest thing to build first (to start LEARNING)

**Turn `fuseRung` default-ON for your own sessions and surface its receipt — that's the whole step.**

- It is **one flag flip + receipt render**, not a feature. `buildAutoBrainReceipt` already produces the
  legible one-line surface (`auto-brain.ts:471-480`). The fusion is already orchestrate-wired behind
  `autoBrainEnabled` (`auto-brain.ts:48-50`; `direction-audit.md:75`).
- **Why this and nothing else first:** the repo has 123 commits of substrate and *zero feedback loop*
  (`direction-audit.md:56`). Every deeper answer to Q1–Q5 — does byproduct routing feel like magic or
  noise? where does `fuseRung` pick wrong? is the load-spread invisible or annoying? — is **only
  knowable by living in it.** Design has hit diminishing returns; dogfood has not started.
- **The compounding follow-on (same week, not before):** log each turn's `{receipt, committed rung,
  objective outcome}`. That log is simultaneously (a) the dataset that finally lets Layer B's
  hysteresis constants be tuned on *real* evidence, and (b) the outcome ledger that feeds the
  north-star learned router (`routing-memory.ts`, already built, currently starved).

> The hard, scary, irreversible act the project has been avoiding is turning it on for yourself and
> finding out it isn't magic yet (`direction-audit.md:66-68`). Everything in §2 is ready. The first
> commit is the flip.
