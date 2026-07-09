# Intent Engine — design 5.5

Status: **DESIGN ONLY.** This document specifies an "intent understanding" layer for
`myshell-tools` — an external, subscription-auth end-user CLI that wraps Claude / Codex /
OpenCode for ANY kind of work (coding, writing, research, ops, planning, mixed). It does
**not** modify `src/` or `test/`. It coexists with and cross-references — without
duplicating — the sibling 5.5 designs:

- partner posture + `partnerStyle` — [docs/partner-and-memory-design-5.5.md](./partner-and-memory-design-5.5.md)
- durable user memory — [docs/memory-architecture-5.5.md](./memory-architecture-5.5.md)
- conversation recap — [docs/recap-feature-5.5.md](./recap-feature-5.5.md)

**Hard product constraint (load-bearing for every decision below):** myshell is
**subscription-auth** (the user's own Claude / ChatGPT / OpenCode OAuth logins), NOT
API-key / pay-per-token. So this design has **no embeddings, no vector DB, no separate
metered service, no API key**. Anything that calls a model MUST reuse the exact
subscription-based provider machinery myshell already uses — the injected-port pattern of
`ModelClassifier` (`src/core/router.ts:59-62`), realized as a real cheap provider run in
`src/core/route-classifier.ts:45-94`. We spend a model call only when it earns its keep,
exactly as `router.ts` does.

---

## 1. What "understanding" exists today (the real code)

I traced the full classify → route → run → review → ask_user lifecycle. The finding is
blunt: **today the system "understands" a turn only as a routing tier + a security risk
level. There is no representation of the user's goal, scope, constraints, or what "done"
means.** The vision-first partner burden falls entirely on a persona *prompt string*.

### 1.1 The deterministic classifier — keywords → {tier, risk}

`src/core/classify.ts` is a pure keyword matcher. It scores three tier tables
(`MANAGER_STRONG_SIGNALS` / `MANAGER_SOFT_SIGNALS` `src/core/classify.ts:49-89`, `WORKER_SIGNALS`
`:95-117`, `IC_SIGNALS` `:123-145`) and four risk tables (`CRITICAL`/`HIGH`/`MEDIUM`
`:155-214`), then emits a `Classification { tier, risk, rationale }`
(`src/core/classify.ts:298-384`; type at `src/core/types.ts:59-64`). That is the *entire*
structured output. There is no goal, no scope, no ambiguity flag, no success criterion.
`hasTierEvidence()` (`src/core/classify.ts:278-286`) reports only whether a tier keyword
fired — it is the gate the router reuses, not a confidence in *understanding*.

### 1.2 The model-brained router — the reuse pattern we mirror

`src/core/router.ts::decideRoute` (`:198-229`) is the template for everything in this doc.
Its discipline:

- **Fast path is free.** When `opts.classifier === undefined` OR `hasTierEvidence(task)` is
  true, it trusts the rules — **no model call, no latency, no cost** (`router.ts:207-209`).
- **Model path only on the ambiguous case.** Only when the rules had *no* tier evidence does
  it consult the injected `ModelClassifier` (`router.ts:211-217`).
- **Degrade gracefully.** Any failure — no classifier, parse error, timeout, invalid tier —
  falls straight back to the rules (`router.ts:218-220`).
- **Tiny, cheap, read-only.** The router prompt only buckets a turn; it never does the work
  (`buildRouterPrompt` `:73-97`), and the live classifier runs it at the cheapest `worker`
  tier in a `read-only` sandbox with a short timeout (`route-classifier.ts:37-39, 75-92`).
- **Pure + testable.** The model call is an injected port so `router.ts` stays a pure
  decision (`router.ts:18-19, 59-62`). The output is parsed by a tolerant-but-strict
  `parseModelRoute` that returns `null` on any shape violation (`router.ts:111-134`).

It emits `RouteDecision { tier, risk, plan, rationale, source }` (`router.ts:33-45`). Note
`plan: boolean` — "would a short plan-first pass help?" — **computed but, per the comment,
not yet consumed** (`router.ts:36-41`). It is wired into orchestrate at
`src/core/orchestrate.ts:255-264` (as `routePlan`).

### 1.3 The prompt — where "understand intent" lives today (only as prose)

`src/core/prompt.ts` builds tier personas (`WORKER_SYSTEM` `:34-89`, `IC_SYSTEM` `:91-160`,
`MANAGER_SYSTEM` `:162-228`). They *ask* the model to "acknowledge what the person is
actually trying to do" and to ask a clarifying question "when something is genuinely
ambiguous" (`prompt.ts:50-51, 113-114, 188-189`). But:

- This is an unstructured instruction. There is **no machine representation** of the intent
  the model inferred — nothing the orchestrator, memory, ask_user gate, or work-contract can
  read.
- The `ask_user` instruction is framed defensively — "**Only when you genuinely cannot
  proceed**" (`prompt.ts:74-75, 144-145, 213-214`) — which the partner doc flags as too timid
  (`partner-and-memory-design-5.5.md:11`).
- `buildPrompt` (`prompt.ts:281-301`) assembles `system → CONVERSATION SO FAR → Task →
  REVIEWER FEEDBACK`. There is **no slot** for an intent frame, memory, or partner style
  today (the partner doc proposes adding `partnerStyle`/`memoryContext` to
  `BuildPromptOptions` — we build on that, §4).

### 1.4 ask_user — a downstream effect with no upstream decision

`src/core/questions.ts` parses a trailing `ask_user` JSON block into a bounded `QuestionSet`
(`questions.ts:120-154`; types at `src/core/types.ts:46-57`). `orchestrate` short-circuits a
turn that ends in `ask_user` as a *complete success that needs a reply* — no escalate, no
review (`src/core/orchestrate.ts:637-664`). **The decision to ask is made entirely inside the
worker model's head, from prose instructions.** Nothing in core reasons about whether *this
turn* contains a genuine fork worth asking about.

### 1.5 Work-contract — the existing "objective / anti-drift" concept

`src/core/work-contract.ts` already has `WorkContract { objective, vision?, roadmap?,
checkpoints?, verification? }` (`:33-40`), capped defensively (`capContract` `:84-170`) and
prompt-renderable (`renderContractForPrompt` `:172-196`). Today it is seeded mechanically:
`orchestrate` materializes `capContract({ version: 1, objective: task })` — **the raw task
string verbatim as the objective, with no vision** — only for plan-like / manager / goal
turns (`orchestrate.ts:265-280`, gated by `shouldMaterializeContract` `work-contract.ts:225-238`).
`/goal` does the same: `capContract({ version: 1, objective: goalText })` with no vision
(`partner-and-memory-design-5.5.md:30`). The partner doc proposes a pure-heuristic
`deriveInitialVision(goalText)` (`partner-and-memory-design-5.5.md:184-192`). **The intent
engine is the natural, model-grade source of that seed** (§4.4) — it replaces a string copy
with an actual understanding, *without* duplicating the contract's storage or rendering.

### 1.6 Verdict on the current state

> The system routes turns competently and has good anti-drift *plumbing* (work-contract,
> ask_user, review). What it lacks is a **shared, structured representation of what the user
> is actually trying to achieve.** Every consumer that needs intent — the persona reflection,
> the ask_user decision, memory retrieval, the work-contract seed — reconstructs it ad hoc, or
> offloads it to a prose instruction the worker model may or may not honor. That is the gap.

---

## 2. Research: how serious agentic systems do intent / clarification

Grounded, transferable techniques (cited). I kept only what helps a general-purpose
subscription CLI partner.

1. **Intent classification vs. slot/frame extraction.** Task-oriented dialogue splits NLU
   into *intent detection* (map the whole utterance to a goal class) and *slot filling* (fill
   the typed parameters of that intent), together forming a **semantic frame**
   [[ACL/COLING survey](https://aclanthology.org/2020.coling-main.42/);
   [BERT joint IC+SF](https://arxiv.org/pdf/1902.10909)]. **Transfer:** an "intent frame" is
   the right shape — a goal plus a few typed slots — but a general CLI can't use a *fixed
   closed* intent taxonomy (work is open-ended). So we keep the *frame idea* and make the goal
   a free-text outcome, not a class label.

2. **Selective / staged clarification — classify-then-ask.** The CLAM-style pattern: first
   *classify whether ambiguity exists*, only then conditionally ask
   [[shanechang summary](https://shanechang.com/p/training-llms-smarter-clarifying-ambiguity-assumptions/)].
   **Transfer:** the intent frame should carry an explicit `ambiguities` list and a
   `confidence`; the ask_user decision keys off those, not off the model's mood.

3. **Confidence / information-gain as the ask trigger.** APA measures the "information gain"
   from internally disambiguating — if the model must *invent* substantial detail to answer,
   the query warrants a question; sample-variance (Cole et al.) is an alternative confidence
   signal [[ibid.]]. Active Task Disambiguation frames question selection as maximizing
   information gain (Bayesian experimental design)
   [[Structured Uncertainty, arXiv 2511.08798](https://arxiv.org/html/2511.08798v1)].
   **Transfer:** ask only at **forks whose resolution materially changes the result** — i.e.
   high expected information gain — never at every minor uncertainty.

4. **Surface assumptions instead of asking.** Prompting a model to explicitly enumerate its
   questionable assumptions improved performance ~20pp ((QA)²)
   [[shanechang](https://shanechang.com/p/training-llms-smarter-clarifying-ambiguity-assumptions/)].
   **Transfer:** the frame's `assumptions` field lets the partner *state a default and
   proceed* ("assuming X — say so if not") rather than blocking on a question. This is the
   cheaper, less annoying half of clarification.

5. **Don't over-ask — UX cost is real.** Every source stresses the same tension: always
   asking destroys UX, always guessing causes errors; the open problem is the *judgment* of
   significance, which research too often treats as binary
   [[Amazon Lex intent disambiguation](https://docs.aws.amazon.com/lexv2/latest/dg/generative-intent-disambiguation.html);
   [shanechang](https://shanechang.com/p/training-llms-smarter-clarifying-ambiguity-assumptions/)].
   **Transfer:** the frame's `confidence` + `partnerStyle` (§4.1) together gate *how hard* to
   clarify, on a continuum — not a binary.

6. **Spec-driven elicitation — a good spec's six elements.** 2025–26 spec-driven development
   (Spec Kit, Kiro, OpenSpec, Claude Code) makes an explicit spec the source of truth; a good
   spec defines **outcomes, scope boundaries, constraints, prior decisions, task breakdown,
   verification criteria**, and the headline failure it fixes is "plausible code that drifts
   from intent"
   [[Thoughtworks](https://www.thoughtworks.com/en-us/insights/blog/agile-engineering-practices/spec-driven-development-unpacking-2025-new-engineering-practices);
   [BCMS guide](https://thebcms.com/blog/spec-driven-development)].
   **Transfer:** this is almost exactly the field list for our intent frame — and it maps
   cleanly onto the existing `WorkContract` (objective/vision/roadmap/verification). We adopt
   the *minimal* subset (§3); we do **not** build a heavyweight spec artifact.

7. **Plan-first / decomposition gating.** SDD only writes code after "derive a plan, break
   into atomic tasks." myshell already has the latent signal for this — `RouteDecision.plan`
   (`router.ts:36-41`), currently unconsumed. **Transfer:** the intent frame is the natural
   producer of a trustworthy `plan` decision, and the natural seed for the work-contract
   roadmap.

**Net:** the literature converges on a small **frame** (goal + typed slots + ambiguities +
confidence), a **staged gate** (detect ambiguity, *then* selectively ask the
highest-information-gain forks), and a strong preference for **surfacing assumptions over
interrupting**. That is implementable with one cheap gated subscription call.

---

## 3. The intent frame — minimal useful shape

Define a small, typed `IntentFrame`. Designed to be the *minimal* set that actually drives a
downstream decision — every field has a named consumer (§4); nothing is collected "just to
have it" (the discipline the memory doc insists on, and the partner doc's "don't add
structured text without a consumer" rule, `partner-and-memory-design-5.5.md:194`).

```ts
// proposed: src/core/intent.ts (PURE — no I/O, no time, no randomness)

/** How sure the extractor is that it understood the user's actual goal. */
export type IntentConfidence = 'high' | 'medium' | 'low';

/** A single genuine decision fork: different answers materially change the result. */
export interface IntentFork {
  readonly id: string;          // stable key, reusable as an ask_user question id
  readonly question: string;    // the fork, in plain language
  readonly options?: readonly string[]; // 2–4 candidate answers when enumerable
  readonly assumeIfUnasked?: string;     // the default to STATE-and-proceed (research #4)
}

export interface IntentFrame {
  readonly version: 1;
  /** The user's intended OUTCOME in one line — free text, NOT a closed class (research #1). */
  readonly goal: string;
  /** Kind of work, for posture/routing nudges. Open vocab, lowercased, single token-ish. */
  readonly kind?: string;       // e.g. "coding" | "writing" | "research" | "ops" | "planning"
  /** What is explicitly OUT of scope / a non-goal, when the user signaled one. */
  readonly nonGoals?: readonly string[];
  /** Hard constraints the work must respect (max ~3). e.g. "Node 22", "no paid APIs". */
  readonly constraints?: readonly string[];
  /** Genuine forks worth a question OR a stated assumption (max ~3). Drives ask_user. */
  readonly forks?: readonly IntentFork[];
  /** What "done" looks like — the success criterion, when one is inferable. */
  readonly doneWhen?: string;
  /** Extractor's confidence it understood the GOAL (not correctness of the work). */
  readonly confidence: IntentConfidence;
  /** Provenance for transparency + tests: did this come from the model pass or a fallback? */
  readonly source: 'model' | 'rules-fallback' | 'skipped';
}
```

Caps mirror `work-contract.ts` (`GOAL` ≤ 240, each list item ≤ 160, ≤ 3 forks/constraints/
nonGoals, ≤ 4 options/fork) and a `capIntentFrame()` enforces them defensively, never throws
— same contract as `capContract` (`work-contract.ts:84-170`).

**Why these fields and no more.** They are the spec-driven "six elements" (research #6)
intersected with what a *general* CLI partner can reliably infer in one cheap pass: `goal`
(outcome), `nonGoals`+`constraints`+`doneWhen` (scope/constraints/verification), `forks`
(ambiguity, the ask_user driver), `kind` (domain), `confidence` (the gate). We deliberately
**omit** roadmap/task-breakdown — that already lives in `WorkContract.roadmap` and is seeded
from this frame (§4.4), not duplicated here.

---

## 4. Decision: do we need a dedicated intent engine?

**Yes — tier (b): a lightweight structured intent-extraction pass, one cheap subscription
call, gated exactly like `router.ts`.** Not (a) prompt-only; not (c) anything richer. The
honest argument:

**Why (a) prompt-only is not enough.** The partner doc's persona rewrite (vision-first loop,
"genuine fork" ask_user, `partnerStyle`) is necessary and we keep it — but it has a structural
ceiling: *the inferred intent never escapes the worker model's context.* Nothing in core can
read it. So the orchestrator cannot make the ask_user decision (it just detects a block the
model already chose to emit), memory retrieval cannot key on the goal (it keyword-matches the
raw task `memory-architecture-5.5.md` retrieval), the work-contract seed stays a verbatim task
copy (`orchestrate.ts:277`), and routing can't use intent. Prompt-only also means the
*expensive* work-tier model is the one doing intent reasoning every turn, with no shared,
testable artifact. You can polish the prose forever and still have no mechanism.

**Why (c) richer is over-build.** A multi-call elicitation loop, a learned intent taxonomy, a
persisted intent store, or embeddings-based retrieval all either (i) violate the subscription/
no-metered-service constraint, or (ii) add latency and ceremony to small turns — the exact
"turn small tasks into ceremonies" failure the partner doc warns against
(`partner-and-memory-design-5.5.md:54`). The research is clear that over-asking destroys UX
(research #5). One gated pass is enough to unlock every downstream consumer.

**Why (b) is right.** One cheap, gated, read-only call — reusing the *identical* machinery as
`route-classifier.ts` — produces a structured `IntentFrame` exactly when it earns its keep,
and falls back to rules on any failure. It is pure/testable (injected port), subscription-
native (no new infra), and cost-disciplined (skipped on clear/cheap turns, so they stay
instant). It is the smallest thing that turns "understand intent" from a *prompt hope* into a
*mechanism*.

### 4.0 "Extremely better" vs. today

> **Today:** a turn is understood as `{tier, risk}`. "Understanding the user's vision" is a
> sentence in a persona prompt, evaluated invisibly inside the work-tier model, producing no
> artifact anyone can act on. The ask_user decision is the model's private whim; the
> work-contract objective is the raw task string copied verbatim; memory matches keywords
> against that raw string.
>
> **With the intent engine:** on a substantial or ambiguous turn, one cheap call (the same
> cheap-tier, read-only, fail-soft call the router already makes) yields a typed
> `IntentFrame` — *goal, scope, constraints, the 1–3 genuine forks, what "done" looks like,
> and a confidence.* That single artifact then drives all four consumers coherently: the
> persona **reflects a goal it actually parsed and challenges it when constraints conflict**;
> `ask_user` fires **deterministically and only at real forks**, gated by `confidence` ×
> `partnerStyle`, with the rest **stated as assumptions** instead of interrupting; **memory
> retrieval keys on the goal**, not raw keywords; the **work-contract is seeded with a real
> objective + vision + roadmap**, not a string copy; and routing gets a trustworthy
> `plan`/tier nudge. Clear, cheap turns ("what time is it?", "fix this typo") **skip the pass
> entirely and stay instant** — the partner gets sharper exactly where it was dumb, and no
> slower where it was already fine.

---

## 5. Architecture — where it sits, the port, the data flow

### 5.1 The injected port (mirrors `ModelClassifier`)

```ts
// src/core/intent.ts
export type IntentExtractor = (
  task: string,
  signal: AbortSignal,
) => Promise<IntentFrame | null>;   // null on ANY failure → caller falls back
```

Identical discipline to `ModelClassifier` (`router.ts:59-62`): a pure port, returns `null` on
no-extractor / parse-error / timeout / garbled output, **never throws**. The live
implementation is a thin composer `makeIntentExtractor(deps)` in
**`src/core/intent-extractor.ts`**, a near-twin of `makeRouteClassifier`
(`route-classifier.ts:45-94`): pick the cheapest provider via `route('worker', ...)`, run a
small `buildIntentPrompt(task)` `read-only` with a short timeout, take the final text, and
`parseIntentFrame(finalText)`. No new fs/child_process — I/O stays in the injected provider,
keeping core pure (the purity guard at `test/arch/guards.test.ts`).

Wiring: add `intentExtractor?` to `OrchestrateDeps` (next to `routeClassifier?`
`src/core/types.ts:349-352`), built by the infra/conversation layer from the cheapest
available provider, absent for one-shot/disabled runs (then the engine is skipped → identical
to today).

### 5.2 The gate — when it runs vs. when it's skipped (cost discipline)

The gate is `shouldExtractIntent(task, classification, routePlan, partnerStyle)` — a **pure**
decision, the intent analogue of `hasTierEvidence`. It runs the pass ONLY when the turn is
*substantial or ambiguous*, so cheap/clear turns stay instant. Run when **any** of:

- `routePlan === true` (the router already judged a plan would help — `router.ts:36-41`); **or**
- `classification.tier === 'manager'` (genuinely high-level work); **or**
- the task is non-trivially long / multi-clause (a cheap length+structure heuristic, reusing
  the substantial-task spirit of `partner-and-memory-design-5.5.md:207-220` — NOT a new model
  call); **or**
- `partnerStyle === 'collaborative'` (the user opted into more alignment, §4.1 of the partner
  doc); **and in all cases**
- an `intentExtractor` is actually wired (else skip → `source: 'skipped'`).

**Skip** (no call, `source: 'skipped'`, frame is a trivial rules frame or omitted) when: the
turn is a clear small task (worker-tier factual Q&A, a one-line edit, explicit-format
request), or `partnerStyle === 'direct'` on a non-substantial turn, or no extractor wired.
This keeps the overwhelming-majority-of-turns-are-free property the router established
(`router.ts:207-209`). The gate runs *after* `decideRoute` so it can read `tier`/`risk`/`plan`
for free.

### 5.3 Placement in the orchestrate lifecycle

Insert one stage between **route** and **run**, right after the `classified` event
(`orchestrate.ts:255-281`) and before the panel/hedge/loop. Sketch:

```
decideRoute()                       // orchestrate.ts:255  (unchanged)
 → classification {tier,risk}        // :259-263
 → routePlan = decision.plan         // :264
 → [NEW] if shouldExtractIntent(...):                       // pure gate
        frame = await intentExtractor(task, signal) ?? rulesIntentFrame(task, classification)
     else:
        frame = rulesIntentFrame(task, classification)      // cheap, source:'skipped'/'rules-fallback'
 → [NEW] yield { type:'intent', frame }                     // new CoreEvent, render-optional
 → workTrace = seedFromIntent(frame, ...) ?? capContract({objective: task})  // :265-280, see §4.4
 → panel / hedge / main loop         // :330+  (prompt now carries the frame, §4.3)
```

The frame is computed **once per turn** and threaded read-only into the prompt builders for
the sequential loop AND the panel/hedge executors (same as `historyContext` is shared at
`orchestrate.ts:324-329`), so no double extraction. **The INTENT block is rendered through the
shared `assembleContextBlocks(opts)` seam** that `buildPrompt` (`prompt.ts`) AND the panel
builders `buildPanelCandidatePrompt` / `buildPanelSynthesisPrompt` (`ensemble.ts:146,186`) all
call — see **`docs/MASTER-PLAN-5.5.md` (MF1, Phase 2)**. This closes the panel-prompt bypass
(final-gate §2.3): do NOT inject the INTENT block by editing `buildPrompt` alone — the panel
builders do not call `buildPrompt`, so the frame would silently vanish on the highest-stakes
multi-model turns. Render it through the single seam so the INTENT block reaches sequential,
hedge, AND panel prompts identically.

A new `CoreEvent` variant `{ type: 'intent'; frame: IntentFrame }` (added to the union at
`src/core/types.ts:404-472`) lets the render layer optionally surface the reflection; it is
**not required** for the engine to function (renderers may ignore it, like other notices).

### 5.4 Data flow into the four consumers (no duplication)

| Consumer | What the frame feeds | Boundary (we do NOT duplicate) |
|---|---|---|
| **prompt / persona** (`prompt.ts:281-301`) | render `frame.goal` + scope + `doneWhen` into a new `INTENT (your current understanding — reflect briefly, do not parrot)` block, placed after memory and before `CONVERSATION SO FAR` | the persona text + `partnerStyle` posture stay owned by the partner doc; we only supply the *content* it reflects |
| **ask_user** (`questions.ts`, `orchestrate.ts:637-664`) | `frame.forks` + `frame.confidence` drive whether/which forks to ask; unasked forks become **stated assumptions** (research #4) via `assumeIfUnasked` | parsing/short-circuit machinery is unchanged; a fork's `id` can reuse a `QuestionSet` `id` so the existing selector renders it verbatim |
| **memory** (`memory-architecture-5.5.md` retrieval) | retrieval keys on `frame.goal`/`frame.kind` instead of raw task keywords → sharper relevance | the store, write-gate, and ranking stay 100% the memory doc's; intent only improves the *query*, it never writes memory |
| **work-contract** (`work-contract.ts`, `orchestrate.ts:265-280`) | seed `objective ← frame.goal`, `vision ← frame.doneWhen`/scope, `roadmap ←` decomposed plan when `routePlan` | replaces only the *seed* (`capContract({objective: task})` `:277`); caps/render/checkpoints/verification untouched. This realizes the partner doc's `deriveInitialVision` (`partner-and-memory-design-5.5.md:184-192`) with a real model-grade source |
| **routing** (`router.ts`) | optional: `frame.confidence === 'low'` can reinforce a plan-first pass; the deterministic **risk is never downgraded** | risk authority stays with `classify`/`router` (`router.ts:224`); intent may *raise* care, never lower it |

### 5.5 Cost & latency discipline (summary)

- Cheapest tier, read-only sandbox, short timeout — identical to `route-classifier.ts:37-39,
  75-81`.
- Gated: substantial/ambiguous turns only; clear/cheap turns skip entirely.
- One call per turn, shared across sequential/panel/hedge.
- Fail-soft: any failure → `rulesIntentFrame` (a pure frame built from `classify` output +
  the task), so the turn proceeds with *no* added latency on failure.
- Subscription-native: on a flat-rate plan the marginal dollar cost is $0; the real budget is
  quota + latency, which the gate protects.

---

## 6. Interaction with the other 5.5 designs (crisp boundaries)

- **partnerStyle** (`partner-and-memory-design-5.5.md:72-92`) is the *dial on the gate and the
  ask aggressiveness*, not a second engine. `direct` → run the pass only on clearly
  substantial turns, prefer stating assumptions over asking, ≤1 fork; `balanced` (default) →
  run on substantial/ambiguous turns, ask at meaningful forks, 1–2 questions; `collaborative`
  → run more readily, surface forks earlier. The intent engine *produces* forks; partnerStyle
  *decides how many to voice*. No overlap.
- **Memory** (`memory-architecture-5.5.md`) owns all storage/governance/retrieval. The intent
  engine is a **read-only consumer that improves the retrieval query** (goal-keyed, not
  keyword-keyed) and a **source of context** (durable user intent/preferences from memory are
  injected into the extractor prompt so the frame is preference-aware). The intent engine
  **never writes memory** and never persists frames in v1 (frames are turn-scoped, like the
  router decision).
- **Recap** (`recap-feature-5.5.md`) is conversation-scoped orientation ("where we were"); the
  intent frame is single-turn ("what you want now"). They don't collide: a recap may *read* the
  last accepted turn's seeded work-contract objective, but the intent engine emits no recap and
  the recap emits no frame.
- **Work-contract** owns objective/anti-drift/roadmap/verification *storage and rendering*. The
  intent engine is the **seeder** of those fields on the turns that materialize a contract — it
  reconciles by *feeding*, never by re-implementing. `WorkContract` stays the single durable
  trace (`types.ts:118-124`, `orchestrate.ts:110-127`).

---

## 7. Test strategy (pure seams) + phased plan

### 7.1 Pure, unit-testable seams (mirroring router's test surface)

1. **`parseIntentFrame`** — tolerant-but-strict, exactly like `parseModelRoute`
   (`router.ts:111-134`): valid frame parses; missing `goal` → `null`; bad `confidence` enum →
   `null`; oversized lists → capped not rejected; prose around the JSON tolerated; extra keys
   ignored; **never throws** on garbage.
2. **`capIntentFrame`** — caps goal/lists/forks/options, coerces bad types, never throws (twin
   of `capContract` tests, `work-contract.ts:84-170`).
3. **`shouldExtractIntent`** (the gate) — table test: clear small task → skip; manager-tier →
   run; `routePlan===true` → run; long multi-clause → run; `direct`+small → skip;
   `collaborative` → run; no extractor → skip. This is the cost-discipline contract.
4. **Fallback** — `extractIntent` with a classifier that returns `null` / throws / times out →
   yields a `rulesIntentFrame` with `source:'rules-fallback'`, turn proceeds (mirrors
   `router.ts:215-220`, `route-classifier.ts` null-on-failure).
5. **Seeding** — `seedFromIntent(frame)` → a `WorkContract` whose `objective`/`vision` come
   from the frame, capped; a low-confidence frame still produces a safe contract.
6. **Prompt assembly** — `buildPrompt` includes the INTENT block when a frame is supplied,
   omits it when absent, and keeps memory/history ordering and goal-turn suppression intact
   (extends the partner doc's prompt tests, `partner-and-memory-design-5.5.md:588`).
7. **ask_user derivation** — forks + confidence + partnerStyle → expected number of questions
   vs. stated assumptions (pure function, no model).

Not worth live-provider testing in v1 (same stance as the sibling docs): whether a given model
*always* extracts a perfect frame — that is prompt-behavioral, covered by transcript fixtures
(reuse the partner doc's eval fixtures `:610-618`: "what time is it?" → skip/no questions;
"build the frontend as I envisioned, old YouTube 2010 social area" → frame with a feel-goal and
one real fork).

### 7.2 Phased implementation (coexists with 3.12.x stdin work + the other 5.5 docs)

**Phase I — pure core (no behavior change).** New `src/core/intent.ts` (types,
`capIntentFrame`, `rulesIntentFrame`, `shouldExtractIntent`, `buildIntentPrompt`,
`parseIntentFrame`, `seedFromIntent`) + `test/unit/intent.test.ts`. Nothing calls it yet →
zero runtime change. Ship independently of stdin work.

**Phase II — the live extractor + wiring (gated, default-off-safe).** New
`src/core/intent-extractor.ts` (`makeIntentExtractor`, twin of `route-classifier.ts`) +
`test/unit/intent-extractor.test.ts`. Add `intentExtractor?` to `OrchestrateDeps`
(`types.ts:349-352`) and the `{type:'intent'}` `CoreEvent` (`types.ts:404-472`). In
`orchestrate.ts:255-281`, compute the frame behind the gate and thread it into the prompt
seam. **When `intentExtractor` is absent (one-shot / feature off) the gate skips → byte-for-byte
identical to today** (the same backward-compat property as `routeClassifier`).

**Phase III — consumers.** (a) prompt INTENT block in `buildPrompt` (depends on the partner
doc's `BuildPromptOptions` extension — land after/with it); (b) work-contract seeding swaps
`capContract({objective: task})` → `seedFromIntent(frame) ?? capContract({objective: task})`;
(c) ask_user derivation from forks; (d) memory retrieval keys on `frame.goal` (depends on the
memory doc landing). Each is independently revertable.

**Phase IV — infra build + config.** infra builds `intentExtractor` from the cheapest provider
(like the route-classifier wiring); add a config flag (`intentEngine?: 'on' | 'off'`, default
derived from `mode`/`partnerStyle`) and a Settings row. Coexists with the menu/stdin 3.12.x
work — print-free, touches no raw-mode/stdin code.

**File list (new):** `src/core/intent.ts`, `src/core/intent-extractor.ts`,
`test/unit/intent.test.ts`, `test/unit/intent-extractor.test.ts`.
**File list (touched):** `src/core/types.ts` (port + event), `src/core/orchestrate.ts` (gate +
stage + seed swap), `src/core/prompt.ts` (INTENT block — with partner doc),
`src/core/work-contract.ts` (consume `seedFromIntent` — or keep seed in intent.ts to avoid a
cycle), infra wiring + config + a Settings row.

---

## 8. Risks + open questions for the user

1. **Latency budget.** The pass adds one cheap-tier round-trip on substantial turns. The
   router's timeout is the precedent — what cap (e.g. 4–8s) before we abandon the frame and
   proceed on the rules fallback? Too tight = often-empty frames; too loose = a felt pause
   before substantial work.
2. **Default on/off.** Should the engine default **on** (derive from `mode`/`partnerStyle`,
   like smartRoute) or ship **off** behind an opt-in flag first? Recommendation: on for
   `balanced`/`collaborative`, off for `direct`/`cost-saver`, overridable.
3. **Ask aggressiveness by partnerStyle.** Confirm the mapping: `direct` ≤1 question (prefer
   stated assumptions), `balanced` 1–2, `collaborative` surface forks earliest. Is "state an
   assumption and proceed" (research #4) the right default over interrupting?
4. **Reflection visibility.** Should the model's reflected understanding always be *shown*
   (a one-line "Here's what I understand…"), shown only on low confidence, or kept internal
   and used only to drive forks/seed? Risk: visible reflection on every substantial turn could
   feel like ceremony — the exact thing we're trying to avoid.
5. **Frame persistence.** v1 keeps frames turn-scoped (not stored). Is that right, or should
   an accepted turn's frame be folded into the work-contract trace for cross-turn continuity?
   (Recommendation: turn-scoped in v1; the work-contract already carries the durable bits.)
6. **Confidence honesty.** `confidence` is the extractor's self-report — same Honesty-Contract
   caveat as the assess envelope (`prompt.ts:14-28`): never fabricated, `null`/`low` on doubt,
   and it can only *raise* care (request a plan/ask a fork), never *lower* risk
   (`router.ts:224`). Confirm we never let a confident-but-wrong frame suppress a fork the user
   needed.

---

## 9. Bottom line

- **Do we need an intent engine? YES.** Today "understanding" is only `{tier, risk}` and a
  prose hope in the persona; nothing structured represents the user's goal, so no consumer can
  act on intent.
- **Recommended tier: (b)** — a lightweight structured intent-extraction pass: one cheap,
  read-only, gated subscription-model call (the *same* injected-port machinery as
  `router.ts`/`route-classifier.ts`), emitting a small typed `IntentFrame`, with a pure
  rules-fallback on any failure. Not (a) prompt-only (no mechanism, never escapes the model),
  not (c) richer (violates the subscription/no-ceremony constraints).
- **"Extremely better" in one paragraph:** Instead of routing a turn as `{tier, risk}` and
  hoping a persona sentence makes the model "understand the vision," myshell spends one cheap,
  fail-soft call — only on substantial or ambiguous turns — to produce a shared, typed
  `IntentFrame` (goal, scope, constraints, the 1–3 genuine forks, what "done" means, a
  confidence). That single artifact drives a *real* vision reflection, a *deterministic*
  ask-only-at-real-forks decision (stating the rest as assumptions rather than interrupting),
  goal-keyed memory retrieval, and a genuinely-seeded work-contract — while clear, cheap turns
  skip the pass and stay instant. The partner gets demonstrably sharper exactly where it was
  blind, and no slower where it was already fine.
- **Top open questions for the user:** (1) latency cap for the pass; (2) default on/off and
  the mode/partnerStyle mapping; (3) ask-aggressiveness per partnerStyle and whether to prefer
  stated assumptions over questions; (4) whether the reflected understanding is shown to the
  user or kept internal.
```
