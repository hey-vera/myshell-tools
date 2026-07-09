# Adaptive Partner Engine — design 5.5

Status: **DESIGN ONLY.** This document specifies the **Adaptive Partner Engine (APE)** for
`myshell-tools` — an external, **subscription-auth** end-user CLI that wraps Claude / Codex /
OpenCode for ANY work, ANY user. It does **not** modify `src/` or `test/`. It is the
behavioral-judgment layer that decides *how the partner engages each turn* — when to just do
the work, when to ask, when to reflect, when to plan, when to investigate, when to research,
when to discuss — **and in what order and how deep.**

It coexists with and explicitly reconciles the sibling 5.5 corpus:

- **`docs/intent-engine-5.5.md`** — the `IntentFrame` (goal/scope/constraints/forks/doneWhen/
  confidence). **This is APE's primary input signal.** APE is the *consumer* of the frame that
  the intent doc *produces*.
- **`docs/partner-and-memory-design-5.5.md`** — the `partnerStyle` enum and the persona/
  ask_user posture. **APE supersedes the fixed `partnerStyle` mode** (§2): it becomes at most a
  soft bias on an adaptive default, never a hard mode.
- **`docs/memory-architecture-5.5.md`** (read its binding **Red-Team Corrections RC-1..RC-6**)
  — memory is both a **signal INTO** APE's judgment and a thing APE's judgment **decides to
  write** (§5). APE must not regress any RC fix.
- **`docs/chat-ux-audit-5.5.md`** — ask/question rendering, the post-turn slot, the queue.
- **`docs/final-gate-5.5.md`** — the binding master phase order (§7), the shared
  `assembleContextBlocks` seam, the **panel-prompt bypass must-fix** (§2.3). APE respects all
  of it.

**Hard product constraint (load-bearing for every decision):** subscription-auth (the user's
own OAuth logins), NOT API-key. **No embeddings, no vector DB, no metered service, no API
key.** Every model touch reuses the exact injected-port machinery the router already uses
(`ModelClassifier` `src/core/router.ts:59-62`, realized in `src/core/route-classifier.ts:45-94`).
APE spends a model call only when it earns its keep, exactly as `router.ts` does — and, on the
overwhelming majority of turns, **spends none.**

---

## 0. The mandate, made concrete

The product owner's intent, verbatim: *"A super smart partner can do it all and knows exactly
what order or how and when."* A fixed `partnerStyle` (direct / balanced / collaborative) is too
crude — it sets one global posture and applies it identically to "what time is it?" and "rebuild
my whole frontend." A real senior professional doesn't *have a mode*; they have **judgment**:
they read the task, and they choose — efficiently on trivial things, thoroughly on consequential
or ambiguous ones.

This document turns that aspiration into a **bounded, deterministic, table-testable policy** over
the signals myshell already computes, driving the **real levers** myshell already has. It is
not a new brain; it is the **conductor** that finally consumes the signals (`route.plan`, the
`IntentFrame`, `classify`'s tier/risk, memory) and orchestrates the levers
(`route.plan`, tier/escalation, ask_user, work-contract seeding, panel vs single, and — above
all — *how myshell instructs the vendor turn*).

**Key realization about "investigate" and "research."** myshell does not need a new HTTP client
or a code-search engine to investigate the codebase or do web research. The vendor models it
drives (Claude / Codex / OpenCode) **already do tool use** — they read files, grep, and (where
the provider supports it) web-search *inside their own turn*. So "INVESTIGATE_CONTEXT" and
"WEB_RESEARCH" are not new subsystems; they are **instructions APE injects into the vendor turn**
plus, where it matters, a **sandbox/tier choice** that *permits* that tool use. APE's job is to
decide *whether to ask for it, how forcefully, and in what order* — and to **bound it** so the
vendor doesn't over-investigate a trivial turn (the SMART tool-overuse failure, §1).

---

## 1. Research — what makes a senior professional efficient *and* thorough

Focused review of adaptive-agent metacognition, with the transferable tactic pulled out of each.
I kept only what helps a general-purpose subscription CLI partner, and I weighted **efficiency
failure modes equally with capability** (the mandate's explicit ask).

1. **The reasoning–action dilemma / overthinking is a *calibration* problem, not a reasoning
   problem.** Reasoning models overthink ~3× as often as non-reasoning models, and *more
   overthinking correlated with **lower** success* (~7.9% less successful per unit of
   overthinking). Three patterns: excessive internal reasoning, repeated action attempts,
   cyclical exploration. Mitigations that worked: **selecting the lowest-overthinking-score
   solution** (−23..31% overthinking, success preserved), **native function-calling to bypass
   deliberation chains** (−40% tokens), and **explicit action-confidence thresholds**
   (−35% unnecessary deliberation steps)
   [[Danger of Overthinking, arXiv 2502.08235](https://arxiv.org/pdf/2502.08235)].
   **Transfer:** APE's default action must be **EXECUTE_NOW**, and every *more-than-execute*
   action (plan, investigate, research, discuss) must clear an explicit threshold to be added.
   "Thorough" is opt-in per signal, never the default. Decisiveness is a feature.

2. **Tool overuse is the dominant efficiency leak; fix it with metacognitive calibration of a
   *knowledge boundary*.** LLMs invoke tools >30% of the time unnecessarily; SMART teaches a
   model to assess "can I answer from what I already know / can cheaply re-derive?" before
   reaching for a tool — yielding **−24% unnecessary tool calls with +37% performance**
   [[SMART, arXiv 2502.11435](https://arxiv.org/pdf/2502.11435);
   [MarkTechPost summary](https://www.marktechpost.com/2025/02/24/optimizing-llm-reasoning-balancing-internal-knowledge-and-tool-use-with-smart/)].
   **Transfer:** APE's INVESTIGATE_CONTEXT and WEB_RESEARCH actions are gated by a **knowledge-
   boundary / re-derivability test**: don't investigate what's cheaply re-derivable in the turn
   anyway; don't web-research what the model plainly knows. This is the *same predicate family*
   the memory doc already ships as `isCheaplyReDerivable` (`memory-architecture-5.5.md:316-323`)
   — APE reuses that judgment, it does not reinvent it.

3. **Ask-vs-assume should be uncertainty-aware and *decoupled* from execution.** "Ask or Assume?"
   decouples *underspecification detection* from *code execution*, with calibrated uncertainty
   that **conserves queries on simple tasks and only asks on genuinely complex/ambiguous ones**
   — closing most of the gap to fully-specified instructions without interrogating the user
   [[Ask or Assume?, arXiv 2603.26233](https://arxiv.org/abs/2603.26233)]. Active Task
   Disambiguation frames question *selection* as maximizing information gain (Bayesian
   experimental design) [[Structured Uncertainty, arXiv 2511.08798](https://arxiv.org/html/2511.08798v1)].
   **Transfer:** APE keys ASK_CLARIFYING off the **`IntentFrame.forks` + `confidence`** that the
   intent engine already extracts (the detection is *already decoupled* from execution in our
   architecture — the frame is computed before the work turn). Ask only at forks that
   *materially change the result*; **state the rest as assumptions and proceed** (the
   `assumeIfUnasked` field, `intent-engine-5.5.md:202`).

4. **Self-evaluation drives escalation, not a fixed ladder.** AgentCollab escalates to a stronger
   tier **only when the self-reflection signal says the current trajectory isn't making
   progress**; fallback routing escalates on low confidence/error
   [[AgentCollab, arXiv 2603.26034](https://arxiv.org/pdf/2603.26034);
   [Routing/Cascades survey, arXiv 2602.09902](https://arxiv.org/pdf/2602.09902)].
   **Transfer:** myshell *already does this* — the review→escalate loop
   (`orchestrate.ts`) and the assess-envelope confidence. APE's ESCALATE_DEPTH lever is just
   *biasing that existing machinery up* (lower the escalation bar) on high-stakes turns and
   *down* on trivial ones, never adding a new ladder.

5. **Plan adaptively, and don't commit to static plans for simple work.** AdaPlanner / Plan-and-
   Act show value in separating a planner from an executor for *long-horizon* tasks, but the
   same line warns greedy-vs-static is a false binary: plan only when horizon/complexity warrants
   [[Plan-and-Act, arXiv 2503.09572](https://arxiv.org/html/2503.09572v3);
   [AdaPlanner, arXiv 2305.16653](https://arxiv.org/pdf/2305.16653)].
   **Transfer:** PLAN_FIRST/DECOMPOSE maps directly onto the **latent, unconsumed
   `RouteDecision.plan`** (`router.ts:36-41`) + the work-contract `roadmap`. APE is the thing
   that *finally consumes* `route.plan` — but only when the frame/route agree the horizon is
   real.

6. **The Agent System Trilemma — performance vs cost vs latency is irreducible; route to a
   Pareto point per turn.** [[xRouter, arXiv 2510.08439](https://arxiv.org/html/2510.08439v1);
   [EvoRoute, arXiv 2601.02695](https://arxiv.org/pdf/2601.02695)]. **Transfer:** on a flat-rate
   subscription the *monetary* axis is ~$0; the real budgets are **quota + latency + user
   attention**. APE's guardrails (§3) are explicitly written to protect those three, because
   that is where a subscription CLI actually pays for over-engagement.

**Net.** The literature converges on the senior-professional shape the mandate asks for:
**a strong default to act**, a small set of *opt-in* deeper engagements each behind an explicit
threshold, **uncertainty-keyed asking that prefers stated assumptions**, **self-evaluation-
driven escalation reusing existing machinery**, and **calibrated tool/research use against a
knowledge boundary**. All of it is implementable as a *pure policy over signals myshell already
has*, with **zero added model calls on the common path**.

---

## 2. Reconciling `partnerStyle`: from hard mode to soft bias

The intent and partner docs treat `partnerStyle ∈ {direct, balanced, collaborative}` as a dial
that gates the intent pass and the ask aggressiveness. **APE supersedes that role.** The explicit
reconciliation:

| Before (partner doc) | After (APE) |
|---|---|
| `partnerStyle` is a **fixed posture** applied to every turn identically. | The **per-turn engagement plan** is computed adaptively from the turn's signals (§4). |
| `direct`/`balanced`/`collaborative` are **three modes** the user picks between. | `partnerStyle` is **one soft bias** that **shifts the thresholds** of the adaptive policy up or down. It can never *force* an action that the signals contradict, and can never *suppress* a safety-driven action (risk-gated ask/discuss). |
| Default resolved from `mode` (cost-saver→direct, etc.). | Same default resolution still happens — but it now seeds a **bias parameter**, not a mode. |
| The dial decides "how many questions." | The dial **nudges the ask threshold and the depth caps**; the *adaptive policy* decides whether a fork even exists (from the frame). |

Concretely, `partnerStyle` becomes a single signed scalar **`engagementBias ∈ {-1, 0, +1}`**
(`direct = -1`, `balanced = 0`, `collaborative = +1`) that is *added into the thresholds* of the
deterministic policy (§4.3). `direct` makes the partner lean harder toward EXECUTE_NOW and prefer
stated assumptions; `collaborative` lowers the bar for REFLECT_VISION / DISCUSS_OPTIONS / a fork
question. **Neither overrides the signals; both modulate them.** A `direct` user on a genuinely
irreversible, ambiguous, high-stakes turn *still* gets one discuss/ask, because the
reversibility/stakes signals dominate the bias (the safety floor, §3). A `collaborative` user on
"what time is it?" *still* gets an instant answer, because the triviality fast-path (§2 of
ordering) dominates the bias. This is the whole point: **judgment, not mode.**

The `/style` command and Settings row from the partner doc are kept verbatim — they now set
`engagementBias` instead of a hard mode. No new user-facing surface is required for v1.

---

## 3. The Engagement Decision Model

### 3.1 The discrete ENGAGEMENT ACTIONS

APE chooses an **ordered subset** of a small, closed set of actions. Closed by design (a senior
pro has a finite, well-worn repertoire; an open set would be the "over-build" the intent doc
warns against). Each action names *exactly how it is expressed through a real myshell lever* —
no action exists without a mechanism.

| Action | What it means | Real lever it drives | Cost |
|---|---|---|---|
| **EXECUTE_NOW** | Just do the work. The default; ~most turns. | The normal sequential run (`orchestrate.ts:514-552`) with the standard persona prompt. | 0 (baseline) |
| **REFLECT_VISION** | One-line "here's what I understand…" before/while acting. | A **prompt instruction** + the `IntentFrame.goal`/`doneWhen` rendered into the INTENT block (via `assembleContextBlocks`). No extra turn. | 0 |
| **ASK_CLARIFYING** | Ask 1–N structured forks, then stop and wait. | **`ask_user`** (`questions.ts`, short-circuit at `orchestrate.ts:637-664`), seeded from `IntentFrame.forks`. | 0 (in-turn) |
| **PLAN_FIRST / DECOMPOSE** | Produce a short plan/roadmap before heavy execution. | **`route.plan`** (finally consumed, `router.ts:36-41`) → work-contract `roadmap` seed + a prompt instruction to plan-then-act. | 0–1 turn |
| **INVESTIGATE_CONTEXT** | Inspect the codebase/files before committing to an approach. | A **prompt instruction** ("inspect X before acting") + ensuring the **sandbox permits reads**; the vendor model does the actual file tool-use in-turn. | 0 (in-turn) |
| **WEB_RESEARCH** | Look things up online before answering. | A **prompt instruction** to web-search (only on providers that support it); APE never makes the HTTP call itself. | 0 (in-turn) |
| **DISCUSS_OPTIONS** | Present 2–3 approaches/tradeoffs and recommend one, *without* yet committing. | A **prompt instruction** to present options-then-recommend; pairs with REFLECT_VISION. For genuine user-preference forks it may *escalate into* ASK_CLARIFYING. | 0 |
| **ESCALATE_DEPTH** | Bias the existing escalation/review/panel machinery toward more firepower. | Lower the **escalation bar** (`escalate.ts`/review loop), or admit a **panel** (`ensemble.ts` via `planPanel`) on high-stakes ambiguous turns. | 1+ turns (bounded) |

Two structural notes:

- **EXECUTE_NOW is not mutually exclusive with the zero-cost actions.** A typical "substantial"
  turn is `[REFLECT_VISION, EXECUTE_NOW]` — one extra sentence, same single turn. Only
  PLAN_FIRST, ASK_CLARIFYING, and ESCALATE_DEPTH change the *turn structure* or *cost*; the rest
  are prompt-shape changes inside one turn.
- **ASK_CLARIFYING is terminal for the turn** (it short-circuits, by the existing ask_user
  semantics). So it is the one action with a hard "at most once before acting" budget (§3 of
  guardrails).

### 3.2 The SIGNALS that select among them

Every signal is *already computed* or *cheaply derivable* — APE adds **no new extraction** beyond
what the intent engine already runs. The signals, their source, and which actions they push:

| Signal | Source (real) | Pushes toward |
|---|---|---|
| **ambiguity** | `IntentFrame.forks.length` + `IntentFrame.confidence` (`intent-engine-5.5.md:198-220`) | ASK_CLARIFYING / DISCUSS_OPTIONS / REFLECT_VISION |
| **stakes / risk** | `Classification.risk` (`classify.ts`, never downgraded `router.ts:224`) + irreversibility words | ESCALATE_DEPTH / DISCUSS_OPTIONS / ASK (raise care) |
| **novelty / knowability** | `IntentFrame.kind` + whether the goal is re-derivable (SMART knowledge-boundary, reuse `isCheaplyReDerivable`) | INVESTIGATE_CONTEXT / WEB_RESEARCH (only if NOT re-derivable) |
| **scope size / horizon** | `route.plan` + `Classification.tier==='manager'` + frame multi-clause length heuristic | PLAN_FIRST / DECOMPOSE |
| **reversibility** | irreversibility lexicon over the task (`deploy`, `delete`, `send`, `migrate`, `pay`, `publish`, `rm`, `force-push`) + risk tier | DISCUSS_OPTIONS / ASK before acting (don't just-do irreversible) |
| **user-confidence / specificity** | frame `doneWhen`/`constraints` present (specific) vs absent; explicit vision phrases ("as I envisioned") | REFLECT_VISION (vision phrase) vs EXECUTE_NOW (fully specified) |
| **engagementBias** | `partnerStyle` → `{-1,0,+1}` (§2) | shifts all thresholds, never decisive alone |
| **memory** | injected `memoryContext` facts (e.g. "prefers direct execution") | biases thresholds (a stored "just do it" preference acts like `engagementBias=-1` for this user) |

### 3.3 The POLICY: a **deterministic policy over the frame**, with a thin optional model assist

**Decision: hybrid, weighted toward deterministic.** The engagement plan is computed by a
**pure, table-testable deterministic function** over the signals above — `planEngagement(signals)
→ EngagementPlan`. The model's role is confined to what it is *already* doing: the
`IntentExtractor` *populates the signals* (forks, confidence, kind) in the **same single gated
call** the intent engine already makes; APE adds **no second model call**. There is no
"model-proposes-the-plan" round-trip — that would violate the subscription cost discipline and
re-introduce the latency the mandate wants to avoid on trivial turns.

Justification for deterministic-over-model (the honest argument):

- **Cost.** A model-proposed engagement plan is a second cheap call on top of the intent call.
  Two calls before any work is exactly the "turn small tasks into ceremonies" failure
  (`partner-and-memory-design-5.5.md:54`). The deterministic policy is **free** and instant.
- **Testability & determinism.** `planEngagement` is a pure function → table tests assert
  "trivial → [EXECUTE_NOW], zero overhead"; "irreversible+ambiguous → [DISCUSS_OPTIONS] or one
  ASK"; etc. A model-proposed plan is not hermetically testable (the gate's determinism
  requirement, final-gate §6).
- **Fail-soft.** A pure function over a possibly-empty frame trivially degrades to EXECUTE_NOW
  (§6). A model-plan call adds another failure surface.
- **The model's judgment is already captured** — in the *frame it produced* (forks/confidence/
  kind are model-grade signals). APE just *acts on* that judgment deterministically. This is the
  same split that makes `router.ts` sound: the model *suggests* (tier/plan), the pure code
  *decides* (`decideRoute`).

So the **mechanism** is: the intent engine's existing gated call produces the frame → APE's pure
`planEngagement` maps frame+classification+bias+memory → an ordered `EngagementPlan` →
orchestrate executes that plan through the real levers. The model is in the loop exactly once,
exactly where it already was.

### 3.4 `planEngagement` — the pure decision (sketch)

```ts
// proposed: src/core/engagement.ts (PURE — no I/O, no time, no randomness)

export type EngagementAction =
  | 'EXECUTE_NOW' | 'REFLECT_VISION' | 'ASK_CLARIFYING' | 'PLAN_FIRST'
  | 'INVESTIGATE_CONTEXT' | 'WEB_RESEARCH' | 'DISCUSS_OPTIONS' | 'ESCALATE_DEPTH';

export interface EngagementPlan {
  readonly version: 1;
  /** Ordered actions to perform this turn (always non-empty; EXECUTE_NOW if nothing else). */
  readonly actions: readonly EngagementAction[];
  /** How many forks to voice as ask_user (0 → state all as assumptions). ≤ ASK_CAP. */
  readonly asks: number;
  /** Depth budget 0..2: 0=fast-path, 1=normal, 2=deep. Caps research/plan/investigate effort. */
  readonly depth: 0 | 1 | 2;
  /** Whether route.plan should be honored as PLAN_FIRST this turn. */
  readonly planFirst: boolean;
  /** Whether to lower the escalation bar / admit a panel this turn. */
  readonly escalate: boolean;
  /** Provenance for transparency + tests. */
  readonly source: 'policy' | 'fast-path' | 'fail-soft';
}

export interface EngagementSignals {
  readonly frame?: IntentFrame;            // from intent engine; may be absent (skipped/failed)
  readonly classification: Classification; // {tier, risk} — always present
  readonly routePlan: boolean;             // RouteDecision.plan
  readonly engagementBias: -1 | 0 | 1;     // from partnerStyle
  readonly memoryBias?: -1 | 0 | 1;        // derived from injected memory prefs (optional)
  readonly task: string;                   // for the reversibility/vision lexicons
}

export function planEngagement(s: EngagementSignals): EngagementPlan;
```

The body is a short, ordered cascade (pseudocode; every branch is a table-test row):

```
1. FAST-PATH (the §0 "efficient on trivial things" floor — runs BEFORE anything):
   if isTrivial(s):                         // worker tier, no fork, low risk, short, specific
     return { actions:[EXECUTE_NOW], asks:0, depth:0, planFirst:false,
              escalate:false, source:'fast-path' }   // ZERO overhead, instant

2. SAFETY FLOOR (stakes/reversibility dominate bias — a senior pro is careful, not reckless):
   irreversible = isIrreversible(s.task) || s.classification.risk in {high,critical}
   ambiguous    = (s.frame?.confidence !== 'high') || (s.frame?.forks?.length ?? 0) > 0
   if irreversible && ambiguous:
     // discuss/ask BEFORE acting, regardless of engagementBias=-1
     add DISCUSS_OPTIONS; asks = min(realForks, 1)   // at most one, even here (§3 guardrail)

3. THOROUGHNESS LADDER (each rung is opt-in, gated by its own signal + bias-shifted threshold):
   threshold(base) = base - s.engagementBias - (s.memoryBias ?? 0)   // bias LOWERS the bar
   if scopeScore(s)        >= threshold(PLAN_T):     planFirst = s.routePlan; add PLAN_FIRST
   if needsContext(s)      >= threshold(INVEST_T):   add INVESTIGATE_CONTEXT     // & not re-derivable
   if needsExternal(s)     >= threshold(RESEARCH_T): add WEB_RESEARCH            // & not knowable
   if hasVisionPhrase(s) || s.frame?.kind in {writing,design,product}: add REFLECT_VISION
   if realForks(s) > 0:
     asks = clamp(forkBudget(s.engagementBias), 0, ASK_CAP)   // unasked forks → assumptions
     if asks == 0: add nothing (state assumptions in prompt)  // prefer-assume default
     else:         add ASK_CLARIFYING
   if (s.classification.risk in {high,critical}) && ambiguous: escalate = true

4. DEPTH: depth = clamp(1 + (scope/stakes bumps) - (engagementBias==-1 ? 1 : 0), 0, 2)

5. ALWAYS end the plan with EXECUTE_NOW unless the plan is terminal (asks>0 ⇒ wait).
   if actions == [] : actions = [EXECUTE_NOW]; source = 'policy'
```

`isTrivial`, `isIrreversible`, `hasVisionPhrase`, `needsContext`, `needsExternal`,
`scopeScore`, `realForks`, `forkBudget` are all **pure heuristics** over the frame + task +
classification — no model, no I/O. They reuse existing spirit: `isTrivial` mirrors the intent
gate's skip condition (`intent-engine-5.5.md:333-338`); `needsExternal`/`needsContext` reuse the
re-derivability judgment family from `memory-architecture-5.5.md:316-323` (SMART knowledge
boundary, research #2); `hasVisionPhrase` reuses the vision lexicon
(`partner-and-memory-design-5.5.md:216`).

---

## 4. Order + depth — sequencing and how deep to go

### 4.1 The canonical order

A senior pro doesn't ask before looking, or reflect before understanding. APE enforces a fixed
**precedence** when multiple actions are selected — the order in which they appear in the
`actions[]` array and are rendered into the prompt:

```
INVESTIGATE_CONTEXT  →  WEB_RESEARCH  →  REFLECT_VISION  →  PLAN_FIRST/DECOMPOSE
                     →  DISCUSS_OPTIONS  →  ASK_CLARIFYING  →  EXECUTE_NOW
```

Rationale, each transition grounded in the mandate's "what order":

- **Investigate/research first** — you gather what's *knowable* before forming a view (don't ask
  the user what you can find out yourself; research #2/#3).
- **Then reflect** — you can only reflect an *informed* understanding.
- **Then plan** — decomposition follows understanding.
- **Then discuss/ask** — only *after* you've reduced uncertainty as far as you cheaply can do you
  spend the user's attention on the *residual* genuine forks (research #3: ask only the
  high-information-gain residual).
- **Then execute.**

This order is **encoded once** as the array order and rendered by `assembleContextBlocks` (§5) so
the vendor turn receives a single coherent instruction: *"First inspect X. Then reflect the goal
in one line. Then, if a genuine fork remains, ask it; otherwise state your assumption and
proceed."* It is not N separate turns — for everything except PLAN_FIRST (optionally a turn) and
ASK_CLARIFYING (terminal), it is **one turn with a shaped instruction.**

### 4.2 Depth — how deep, bounded

`depth ∈ {0,1,2}` is the single knob that caps *how much* of each selected action to do:

- **depth 0 (fast-path):** EXECUTE_NOW only, no instruction overhead. The instant path.
- **depth 1 (normal):** at most one investigate scope, a one-line reflection, ≤1 ask,
  options capped at 2–3. The senior default for substantial turns.
- **depth 2 (deep):** permitted only when stakes **and** scope **and** ambiguity all clear the
  bar (genuinely consequential, ambiguous, multi-system work). Allows broader investigation, a
  real roadmap, web research, and (if `escalate`) a panel. **depth 2 is rare by construction** —
  the policy makes it hard to reach, exactly so the tool is thorough *only* where it must be.

Depth is what prevents the **over-engagement failure** (research #1): a partner that *can* do it
all but mostly *chooses* depth 0–1, reserving depth 2 for the turns that earn it.

### 4.3 Bias modulates thresholds, not actions

`engagementBias` and `memoryBias` **lower the bar** for the thoroughness rungs (a
`collaborative` / "discuss-first" user reaches REFLECT/DISCUSS/ASK at a lower scopeScore) and
**raise** it for `direct`. They are bounded: a single-step shift on the threshold, never enough
to cross the **safety floor** (§3 step 2) or to force depth 2. This is the concrete realization
of "soft bias, not hard mode" (§2).

---

## 5. Efficiency guardrails (equal weight to capability)

The mandate is explicit: a senior pro is **decisive, not paralyzed**, and **efficient on trivial
things**. These guardrails are first-class design, not afterthoughts. Each is bounded and
table-testable.

1. **EXECUTE_NOW is the default; thoroughness is opt-in.** The policy *starts* from
   `[EXECUTE_NOW]` and only *adds* actions when a signal clears a threshold (research #1). There
   is no path where a trivial turn accretes engagement.

2. **The trivial fast-path adds ZERO latency.** `isTrivial(s)` short-circuits *before any
   engagement reasoning* and before the intent pass is even consulted — it returns
   `[EXECUTE_NOW], depth:0` for worker-tier, no-fork, low-risk, short, specific turns. "What time
   is it?", "fix this typo", "what's 2+2" never touch APE's ladder. (This is the same population
   the intent gate already skips, `intent-engine-5.5.md:333-338` — APE reuses that boundary, so
   the two stay consistent.)

3. **"Ask at most once before acting."** `ASK_CAP = 1` *question-turn* per turn (the ask_user set
   may carry up to the schema's 1–4 questions `questions.ts:35-39`, but APE will not chain a
   *second* clarifying round before doing work). After one ask + answer, the next turn must make
   progress. This kills the interrogation failure (research #3) and the multi-round
   analysis-paralysis loop.

4. **Prefer stated assumptions over questions.** Default `forkBudget` for `balanced`/`direct` is
   **0 asks** unless a fork is *both* high-information-gain *and* not safely assumable; unasked
   forks are emitted as `assumeIfUnasked` assumptions the model states and proceeds on
   (research #3/#4, `intent-engine-5.5.md:202`). Asking is the exception, not the reflex.

5. **Don't investigate/research what's re-derivable or known (the SMART knowledge boundary,
   research #2).** INVESTIGATE_CONTEXT and WEB_RESEARCH are gated by `needsContext`/`needsExternal`
   which **reject** anything the turn would surface anyway or the model plainly knows — reusing
   `isCheaplyReDerivable` (`memory-architecture-5.5.md:316-323`). Target: the −24%-tool-overuse
   discipline, not the >30% reflexive-tool-use failure.

6. **Reversibility-aware decisiveness.** **Just do reversible things** (a reversible edit on a
   `direct`/`balanced` turn → EXECUTE_NOW even under mild ambiguity — it's cheap to redo).
   **Discuss/confirm irreversible ones** (deploy/delete/send/pay/publish). The reversibility
   signal is the one place where *acting* is the careful choice for reversible work and *pausing*
   is the careful choice for irreversible work — the senior-pro instinct.

7. **Quota/latency budget, not dollar budget.** On a flat-rate plan the dollar cost of depth is
   ~$0; the real budget is **quota + latency + user attention** (research #6 trilemma). APE's
   only *extra-cost* actions are PLAN_FIRST (≤1 turn) and ESCALATE_DEPTH (panel/escalation, both
   already bounded by `policy` caps `maxPanelProviders` etc.). APE **adds no model call of its
   own** — it rides the intent engine's single gated call. So the cumulative per-turn overhead is:
   `0` on trivial turns, `1 intent call (shared)` on substantial turns, `+panel/escalate only
   when the safety+scope signals demand it`. This is the **one cost-budget statement** the
   final-gate §6.3 asked for, on APE's slice.

8. **Anti-loop / fail-soft determinism.** A bad or absent frame → fail-soft EXECUTE_NOW or *one*
   clarifying question, never a hang and never a re-plan loop (§6). `planEngagement` is pure and
   total: it always returns a non-empty `actions[]`. There is no recursion, no "plan the plan."

9. **No engagement on goal turns' inner mechanics.** Autonomous `/goal` turns already have their
   own GOAL_CONTINUE roadmap loop (`work-contract.ts:204-223`); APE seeds the *initial* goal
   contract (§6 integration) but does not inject per-step engagement reasoning into the
   autonomous loop — that would double-plan.

---

## 6. Integration — where APE sits and how it drives the real levers

### 6.1 Placement in the orchestrate lifecycle

APE is a **pure decision computed once per turn**, slotted immediately *after* the intent stage
the intent doc inserts (between route and run) and *before* panel/hedge/loop. The intent doc's
inserted stage (`intent-engine-5.5.md:340-360`) produces the `frame`; APE consumes it:

```
decideRoute()                         // orchestrate.ts:255  (unchanged)
 → classification {tier,risk}; routePlan = decision.plan
 → [intent stage] frame = intentExtractor(...) ?? rulesIntentFrame(...)   // intent doc
 → [NEW: APE] plan = planEngagement({ frame, classification, routePlan,
                                      engagementBias, memoryBias, task })  // PURE, instant
 → [NEW] yield { type:'engagement', plan }            // new CoreEvent, render-optional
 → workTrace = seedFromIntentAndPlan(frame, plan, ...) // §6.3
 → panel/hedge/main loop, prompt carries the engagement instruction via assembleContextBlocks
```

`planEngagement` runs whether or not the frame exists (fail-soft, §6.4). It is computed **once**
and threaded read-only into the sequential loop **and** the panel/hedge executors — exactly like
`historyContext` is shared at `orchestrate.ts:324-329` — so there is no divergence and no
recompute.

A new `CoreEvent` variant `{ type:'engagement'; plan: EngagementPlan }` (added to the union at
`types.ts:404+`, coordinated with the intent/memory/presentation additions per final-gate §2.2)
lets the render layer optionally surface a one-line "Looking into X, then…" notice. It is **not
required** for APE to function — renderers may ignore it (the same optionality as the intent
event). Visibility is open-Q (§8).

### 6.2 Driving the levers (the heart of "investigate/research is an instruction, not a client")

| Action | Exact wiring |
|---|---|
| REFLECT_VISION / DISCUSS_OPTIONS / INVESTIGATE_CONTEXT / WEB_RESEARCH | Rendered as an **ENGAGEMENT block** by the shared `assembleContextBlocks` seam (final-gate §2.3, Phase 2) — so it reaches sequential, hedge, **and panel** prompts identically. The block is a short, ordered instruction ("First inspect `src/foo`. Then reflect the goal in one line. …"). The vendor model performs the file/web tool-use *in its own turn*. |
| INVESTIGATE_CONTEXT (permission) | When selected, APE ensures the run's **sandbox is not more restrictive than read** for that turn (it never *loosens* a write sandbox the user set; it only avoids forcing read-only when investigation is needed). The existing `deps.sandbox` flows into the `ProviderRequest` (`orchestrate.ts:543`). |
| PLAN_FIRST / DECOMPOSE | Sets `planFirst`, which (a) **finally consumes `route.plan`** — the latent hook (`router.ts:36-41`, `orchestrate.ts:264`) — by feeding `shouldMaterializeContract`'s `routePlan` path (`work-contract.ts:225-238`) and (b) adds a "plan-then-act" prompt instruction. The roadmap is seeded from the frame (§6.3). |
| ASK_CLARIFYING | Seeds the persona's `ask_user` guidance with the **specific forks** from `IntentFrame.forks` (id reusable as a `QuestionSet` id, `intent-engine-5.5.md:371`). The existing short-circuit (`orchestrate.ts:637-664`) is unchanged; APE only decides *whether/how many* via `asks`. |
| ESCALATE_DEPTH | Biases the **existing** machinery: lowers the review/escalation bar for this turn and/or makes `planPanel` admittable (`orchestrate.ts:330-342`) when stakes+ambiguity warrant — within the policy's existing caps. No new escalation path. |
| EXECUTE_NOW | The normal run; the prompt simply carries no extra engagement block (or just the one-line reflection). |

**The vendor-turn instruction is the load-bearing mechanism.** "The partner investigates / does
web research / discusses options" is realized as *how myshell instructs and drives the vendor
turn* (which already has tool use), exactly as the mandate states — **not** a new HTTP client or
code-search engine. APE's value is choosing *which* instructions, in *what order*, at *what
depth*, and **bounding** them so the vendor doesn't over-investigate (the SMART discipline, §5.5).

### 6.3 Work-contract seeding

APE refines the intent doc's `seedFromIntent` into `seedFromIntentAndPlan(frame, plan)`:
`objective ← frame.goal`, `vision ← frame.doneWhen`/scope, and **`roadmap` is seeded only when
`plan.planFirst`** (so a non-plan turn doesn't fabricate a roadmap). This replaces the verbatim
`capContract({ objective: task })` seed (`orchestrate.ts:277`) with a real, plan-aware objective
— and it consumes `route.plan` *through APE*, closing the latent hook cleanly. Caps/render/
checkpoints/verification stay 100% the work-contract's (`work-contract.ts`).

### 6.4 Fail-soft + the shared seam (respecting final-gate §2.3)

The ENGAGEMENT block goes through `assembleContextBlocks` — the **single composition path** the
final gate mandates so panel/synth prompts (`ensemble.ts:147,176`) are not bypassed. This is the
final-gate must-fix #1; APE **depends on Phase 2 having landed it** and adds the ENGAGEMENT block
as one more block alongside MEMORY and INTENT, in the canonical order
`system → MEMORY → INTENT → ENGAGEMENT → CONVERSATION SO FAR → Task` (extends the gate's §2.1
ordering). A test asserts a **panel candidate prompt carries the ENGAGEMENT block** (the gate's
required regression).

### 6.5 Smart memory: capture/scope/retrieval as a judgment, not a toggle

The mandate asks for memory that is "way smarter than a toggle" — APE makes the memory
*decisions* intelligently **while preserving every memory-doc safety rail (RC-1..RC-6)**. APE does
**not** re-implement the store, the gate, or retrieval; it improves the *decisions feeding* them:

- **Capture salience (write).** When the model proposes a `remember_user` fact, APE contributes a
  **salience judgment** to the approval decision: a fact that aligns with the turn's
  `IntentFrame.kind`/`constraints` (e.g. user states a durable constraint while doing constraint-
  relevant work) is *more* salient; chit-chat affect is *less*. This **only re-orders/justifies
  the existing Save/Skip/Edit approval** (`memory-architecture-5.5.md:695-700`) — it never
  auto-saves, never bypasses `worthGate` (RC-6 instruction-shape reject still runs first), and
  never stores secrets (RC-4 multi-field scrub still runs). APE can *raise* the bar
  (suggest Skip on low salience) but the user still confirms. No silent saves, ever.
- **Scope inference (global vs project vs narrower).** Instead of a fixed default scope
  (`memoryDefaultScope` `memory-architecture-5.5.md:741`), APE **infers** scope from context: a
  fact about *this codebase's feel* ("heyvera.org should feel like 2010 YouTube") → `project`
  (current `projectKey`); a durable communication preference ("prefers concise") → `global`; a
  fact tied to a transient task → **not stored at all** (the durability gate already rejects it).
  The inference is a **pure heuristic** over the frame's `kind`/`nonGoals` + the fact text — it
  *proposes* a scope, which is still shown in the approval selector and editable. The closed
  `subject` enum (RC-1) and `(scope,kind,subject)` consolidation key (RC-2) are untouched: APE
  only fills the `scope` field more intelligently; it cannot widen the subject vocabulary or skip
  consolidation.
- **Retrieval keying.** APE (via the frame) lets retrieval key on `frame.goal`/`frame.kind`
  instead of raw task keywords (already specified `intent-engine-5.5.md:372`) — sharper relevance
  within the **same** deterministic, no-LLM, capped Jaccard retrieval (RC-3 budget intact). APE
  also contributes the `memoryBias` read (§3.2): a retrieved "prefers direct execution" fact
  nudges `engagementBias` down for this user — memory *informing judgment*, the mandate's
  "signal INTO judgment."

**Reconciling "smart" with "safe + bounded":** every APE memory touch is *advisory on a
user-gated, RC-protected pipeline*. APE can make capture more discerning and scope more
contextual, but it **cannot** introduce a silent save, a secret leak, an instruction-shaped
poison, a cross-project bleed, or a subject-vocabulary drift — those are all closed by RC-1..RC-6,
which run *before* and *independently of* APE's advice. Smart = better *proposals*; safe = the
*gate that the proposals still pass through* is unchanged.

---

## 7. Fail-soft + determinism

- **Total, pure function.** `planEngagement` never throws and always returns a non-empty
  `actions[]`. Absent frame, garbage frame, missing classification fields → it degrades to the
  fast-path or `[EXECUTE_NOW]` (`source:'fail-soft'`). Mirrors `router.ts`'s null-on-failure
  discipline.
- **No hang, no loop.** APE makes **one** decision per turn. It never re-plans within a turn,
  never recurses, never waits on a model (it has no model call). The only "wait" is the existing
  ask_user short-circuit, capped at one (§5.3).
- **Reuses the subscription injected-port.** APE adds **no** provider call. It consumes the
  intent engine's existing gated `route-classifier`-twin call. No API key, no embeddings, no
  metered path — the `test/arch/guards.test.ts` purity guard still holds (engagement.ts is pure
  core, no fs/child_process).
- **Pure, table-testable seams.** `planEngagement`, `isTrivial`, `isIrreversible`,
  `hasVisionPhrase`, `needsContext`, `needsExternal`, `scopeScore`, `realForks`, `forkBudget`,
  `seedFromIntentAndPlan`, `inferMemoryScope`, `salienceForApproval` are all pure and individually
  tested. The ENGAGEMENT-block renderer is a pure string builder.

---

## 8. Test strategy

Pure unit seams (the bulk — and the point), mirroring the router/intent test surfaces:

1. **`planEngagement` table tests** (the headline). Rows assert the mandate directly:
   - trivial ("what time is it?", worker/low-risk/short/specific) → `[EXECUTE_NOW] depth:0
     source:'fast-path'` — **zero overhead**.
   - fully-specified reversible edit, `direct` → `[EXECUTE_NOW]` (no reflect, no ask).
   - vision-phrase substantial ("rebuild frontend as I envisioned, 2010-YouTube feel") →
     `[REFLECT_VISION, EXECUTE_NOW]`, `asks:0` (assumption stated) at `balanced`.
   - irreversible + ambiguous ("deploy this to prod" with low frame confidence) → contains
     `DISCUSS_OPTIONS`, `asks ≤ 1`, **even at `direct`** (safety floor beats bias).
   - manager-tier multi-system + `route.plan` → `planFirst:true`, contains `PLAN_FIRST`.
   - `collaborative` lowers the bar (a mid-scope turn that's `[EXECUTE_NOW]` at balanced becomes
     `[REFLECT_VISION, …]`); `direct` raises it — **bias modulates, never overrides** (a
     `collaborative` trivial turn is *still* `[EXECUTE_NOW]`).
   - re-derivable context request → **no** `INVESTIGATE_CONTEXT` (SMART boundary); known-fact
     question → **no** `WEB_RESEARCH`.
2. **Guardrail tests:** `ASK_CAP=1` enforced; assumptions preferred over asks at default bias;
   depth never reaches 2 without stakes∧scope∧ambiguity; reversible→act, irreversible→discuss.
3. **Fail-soft:** absent/garbage frame → `[EXECUTE_NOW]`/one-ask, `source:'fail-soft'`, never
   throws.
4. **Order:** when multiple actions selected, `actions[]` is in canonical precedence (§4.1).
5. **Seeding:** `seedFromIntentAndPlan` seeds roadmap **only** when `planFirst`; objective/vision
   from frame, capped; low-confidence frame still yields a safe contract.
6. **Memory judgment:** `inferMemoryScope` maps project-feel→`project`, comm-pref→`global`,
   transient→(rejected by gate); `salienceForApproval` re-orders but never auto-saves and never
   bypasses `worthGate`/secret-scrub (RC regression: a secret-bearing high-salience fact is still
   rejected).
7. **Prompt/seam:** `assembleContextBlocks` includes the ENGAGEMENT block when a non-trivial plan
   is supplied and omits it on fast-path; a **panel candidate prompt carries the ENGAGEMENT
   block** (the final-gate §2.3 regression); canonical block order preserved.

Not worth live-provider testing in v1 (same stance as the sibling docs): whether a given vendor
model *honors* the investigate/reflect instruction perfectly — prompt-behavioral, covered by the
transcript fixtures the partner/intent docs already define (`partner-and-memory-design-5.5.md:610-618`).

---

## 9. Phased plan (slots into final-gate §7 master order)

APE is **a refinement layered on top of the intent engine** (final-gate Phase 6) and the prompt
seam (Phase 2). It does **not** introduce a new master phase; it extends Phase 6 and adds a small
slice that depends on Phase 2's `assembleContextBlocks`. It is print-free and touches no
raw-mode/stdin code, so it **coexists with the 3.12.x stdin work** (final-gate Phase 0).

**APE-A — pure engagement core (no behavior change).** New `src/core/engagement.ts`
(`EngagementAction`/`EngagementPlan`/`EngagementSignals`, `planEngagement`, all pure heuristics,
`seedFromIntentAndPlan`) + `test/unit/engagement.test.ts`. Nothing calls it yet → zero runtime
change. Ships independently, after the intent core (final-gate Phase 6, Phase I) exists so it can
import `IntentFrame`.
*Touches:* new files only.

**APE-B — wire into orchestrate + the shared seam.** Add `{type:'engagement'}` `CoreEvent`
(`types.ts:404+`, coordinated additive edit), compute `planEngagement` right after the intent
stage (`orchestrate.ts`), render the ENGAGEMENT block via `assembleContextBlocks` (depends on
final-gate **Phase 2** having landed the unified seam + panel fix), thread `engagementBias` from
`partnerStyle` and `memoryBias` from injected memory. **Absent intent frame / fast-path → the
block is empty → byte-for-byte identical to today** (same backward-compat property as the router).
*Touches:* `orchestrate.ts`, `prompt.ts`/`ensemble.ts` (via the shared seam), `types.ts`.

**APE-C — consume the levers.** `planFirst` → work-contract roadmap seed swap
(`seedFromIntentAndPlan`, consuming `route.plan`); `asks` → ask_user fork budget; `escalate` →
escalation-bar/panel bias. Each independently revertable.
*Touches:* `orchestrate.ts`, `work-contract.ts` (seed consumer), `questions.ts` (comment only).

**APE-D — smart memory judgment.** `inferMemoryScope` + `salienceForApproval` feed the memory
approval/scope decisions (depends on final-gate **Phase 5** memory commands/proposals). Advisory
only; RC-1..RC-6 unchanged.
*Touches:* `src/core/engagement.ts` (pure helpers) + the Phase-5 approval call site (deps-assembly
in `menu.ts`, not input internals).

**Dependency spine:** `final-gate Phase 2 (seam) → Phase 6 intent core → APE-A → APE-B → APE-C`;
`APE-D` after `final-gate Phase 5`. APE slots **into** the intent phase, deepening it from
"extract a frame" to "extract a frame *and act on it with judgment*."

**File list (new):** `src/core/engagement.ts`, `test/unit/engagement.test.ts`.
**File list (touched):** `src/core/orchestrate.ts` (APE stage + lever wiring), `src/core/types.ts`
(event), `src/core/prompt.ts`/`src/core/ensemble.ts` (ENGAGEMENT block via the shared seam),
`src/core/work-contract.ts` (plan-aware seed), `src/interface/menu.ts` (deps-assembly:
`engagementBias`, memory scope/salience call sites), `src/infra/config.ts` (none new — reuses
`partnerStyle`).

---

## 10. Risks + open questions

1. **Heuristic ceiling.** `planEngagement` is deterministic heuristics over the frame. Its quality
   is bounded by the frame's quality and the lexicons (reversibility/vision). A subtle
   irreversible action with no lexicon hit could be mis-classified as reversible → just-do-it.
   *Mitigation:* the lexicon is conservative-broad on the irreversible side (false-positive =
   one extra confirm, recoverable; false-negative = acted irreversibly, not). Confirm the lexicon
   coverage with the user.
2. **Visibility of engagement.** Should APE's chosen plan be *shown* ("Looking into X, then I'll
   draft…")? Always, only on depth ≥1, or never (drive silently)? Risk: visible engagement on
   every substantial turn re-introduces ceremony — the exact thing we avoid. *Recommendation:*
   silent by default; surface only the one-line REFLECT_VISION when present (which the user wants
   anyway), not the mechanics.
3. **Bias strength.** Is a single-step threshold shift the right magnitude for `engagementBias`?
   Too weak → `direct`/`collaborative` feel identical; too strong → bias overrides signals (the
   thing we're killing). Needs a behavioral-fixture pass to tune.
4. **depth-2 reachability.** Is the depth-2 bar (stakes∧scope∧ambiguity) too strict (the tool is
   never thorough enough) or too loose (latency creeps)? Tunable; default strict.
5. **Memory salience advice.** Is APE *raising the Skip bar* on low-salience proposals the right
   call, or should the model's proposal stand on its own (APE scope-only)? Conservative v1:
   scope-inference + salience-reorder only; never auto-Skip.
6. **Confidence honesty.** `frame.confidence` is a model self-report. APE may only *raise* care
   (add discuss/ask/escalate), never *lower* it (never suppress a fork the safety floor wants) —
   same Honesty-Contract caveat as the router risk floor (`router.ts:224`). Confirm we never let a
   confident-but-wrong frame skip a needed confirmation on an irreversible turn (the §3-step-2
   safety floor is designed to be the backstop here).

---

## 11. How much better than fixed modes — honest assessment

**Materially better, with two honest soft spots.**

*Why it's better.* A fixed `partnerStyle` applies one posture to every turn: a `direct` user gets
terse treatment on a frontend rebuild they wanted aligned on; a `collaborative` user gets a vision
reflection on "what time is it?". APE makes the *per-turn* call the way a senior pro does:
instant on the trivial, aligned on the ambiguous, careful on the irreversible, decomposed on the
sprawling — **driven by the turn's actual signals, with the user's preference as a bias, not a
straitjacket.** It finally *consumes* signals myshell computes but throws away (`route.plan`), and
it gives "investigate / research / discuss" concrete mechanisms (vendor-turn instructions) instead
of leaving them to a persona's hope. And it does this **at $0 marginal model cost** — riding the
intent engine's one gated call, free on every trivial turn.

*Where it could still feel wrong.*
- **Too eager to ASK?** Lowest risk, by design: default `forkBudget` is **0 asks** (prefer stated
  assumptions), `ASK_CAP=1`, and the safety floor only adds *discuss*, not *ask*, except on
  irreversible+ambiguous turns. If anything, the risk is the *opposite* — see below.
- **Too eager to ACT?** This is the realer risk. A `direct` user on a subtly-irreversible turn
  whose irreversibility the lexicon misses could get an immediate action where a senior pro would
  have paused. The §3-step-2 safety floor + conservative-broad irreversible lexicon are the
  guard; risk #1 tracks the residual.
- **Too eager to INVESTIGATE/RESEARCH?** Bounded by the SMART knowledge-boundary gate (don't
  investigate the re-derivable, don't research the known) and `depth`. The residual risk is a
  vendor model that *over-investigates inside its turn* despite a bounded instruction — which APE
  can shape but not fully control (it's the vendor's tool-use). depth + a "inspect only what you
  need" instruction is the mitigation.

Net: APE is a clear upgrade over a 3-way mode toggle *and* it is honest about its one structural
limit — a deterministic heuristic can mis-read a turn the way a fixed mode can't even try to read
one. The safety floor and the conservative lexicons are where we spend our caution budget so the
failure, when it happens, is "asked one extra time" far more often than "acted irreversibly."

---

## 12. Bottom line

- **Core engagement-decision model:** a **pure, deterministic `planEngagement(signals) →
  EngagementPlan`** over the `IntentFrame` + `{tier,risk}` + `route.plan` + a `partnerStyle`-
  derived bias + memory, choosing an **ordered subset** of a closed action set
  `{EXECUTE_NOW, REFLECT_VISION, ASK_CLARIFYING, PLAN_FIRST, INVESTIGATE_CONTEXT, WEB_RESEARCH,
  DISCUSS_OPTIONS, ESCALATE_DEPTH}` at a bounded `depth ∈ {0,1,2}`. Default is **EXECUTE_NOW**;
  every deeper action is opt-in behind a signal-threshold. The model is in the loop exactly once
  (the intent engine's existing gated call) — APE adds **no model call**. "Investigate / research /
  discuss" are **vendor-turn instructions through the shared `assembleContextBlocks` seam**, not
  new subsystems.
- **How it supersedes `partnerStyle`:** the enum stops being a hard mode and becomes a single soft
  `engagementBias ∈ {-1,0,+1}` that **shifts thresholds**, never overrides the signals and never
  crosses the safety floor. Judgment per turn, not posture per user.
- **Top efficiency guardrails:** (1) EXECUTE_NOW default + zero-overhead trivial fast-path; (2)
  ask at most once, prefer stated assumptions (0 asks by default); (3) SMART knowledge-boundary —
  don't investigate the re-derivable or research the known; (4) reversibility-aware — just do
  reversible things, discuss irreversible ones; (5) bounded depth (depth-2 is rare by
  construction); (6) zero added model call — rides the intent engine's one gated call.
- **Top open questions:** (1) is engagement shown to the user or driven silently? (2) bias
  magnitude — single-step shift right? (3) irreversibility-lexicon coverage (the "too eager to
  act" residual); (4) depth-2 reachability tuning; (5) should APE only infer memory scope, or also
  advise Skip on low-salience proposals?
