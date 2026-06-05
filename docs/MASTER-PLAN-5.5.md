# MASTER PLAN 5.5 — The Single Binding Source of Truth

Status: **BINDING.** This is the one master plan for the `myshell-tools` "world-class chat"
5.5 design corpus — an external, **subscription-auth** end-user CLI wrapping Claude / Codex /
OpenCode for ANY work, ANY user. It closes the five must-fixes from
[`docs/final-gate-5.5.md`](./final-gate-5.5.md) (§8), integrates the Adaptive Partner Engine
([`docs/adaptive-partner-engine-5.5.md`](./adaptive-partner-engine-5.5.md)), and supersedes
every other doc's local phase list. Where any sibling doc's build order conflicts with this
one, **this plan wins.** It changes no `src/` or `test/` code; it is the implementation
contract the build follows.

**Hard product constraint (load-bearing everywhere):** subscription-auth (the user's own
OAuth), NOT API-key. **No embeddings, no vector DB, no metered service, no API key.** Every
model touch reuses the injected-port provider machinery the router already uses
(`ModelClassifier` `router.ts:59-62` → `route-classifier.ts:45-94`). The purity guard
(`test/arch/guards.test.ts`) stays green: no new `fetch`/SDK/API-key path.

---

## 0. The world-class chat — overview and how the 9 docs fit

The product goal: a partner that is **instant on the trivial, aligned on the ambiguous,
careful on the irreversible, decomposed on the sprawling** — that remembers durable facts
without drift, orients you when you return, and renders a polished, honest terminal feel. Nine
design docs compose into one product along a single per-turn spine.

**The per-turn spine (the shared control flow):**

```
input → route(tier,risk,plan) → intent frame → APE engagement plan
      → assembleContextBlocks(MEMORY, INTENT, ENGAGEMENT, partner bias)
      → run (sequential | hedge | panel)  ← all three render the SAME context blocks
      → settle → decidePostTurn(question-flow → memory-approval → drain-queue)
      → recap (conversation-scoped, on resume / /recap)   ← orientation, separate surface
```

| # | Doc | Role in the world-class chat |
|---|---|---|
| 1 | [`chat-ux-audit-5.5.md`](./chat-ux-audit-5.5.md) | Input/output **mechanics**: ESC turn-interrupt, typed-ahead queue, structured-question rendering, verbosity-as-chrome. Owns `runOneChatInput` and the post-turn slot (`decidePostTurn`, MF3). The Phase-0 unblocker. |
| 2 | [`chat-presentation-5.5.md`](./chat-presentation-5.5.md) | The **feel**: `●` turn marker, "Waiting on N models" panel status, completion lines, elapsed, optional inline markdown. Pure chrome on real events. |
| 3 | [`recap-feature-5.5.md`](./recap-feature-5.5.md) | The `※ recap` orientation line on resume + `/recap` + richer Recent list. Conversation-scoped, distinct from memory. |
| 4 | [`intent-engine-5.5.md`](./intent-engine-5.5.md) | The `IntentFrame` (goal/scope/constraints/forks/doneWhen/confidence): one cheap gated call turns "understand intent" from a prose hope into a typed artifact. **APE's primary input.** |
| 5 | [`adaptive-partner-engine-5.5.md`](./adaptive-partner-engine-5.5.md) (APE) | The **judgment** layer: pure `planEngagement(signals) → EngagementPlan` chooses an ordered subset of `{EXECUTE_NOW, REFLECT_VISION, ASK_CLARIFYING, PLAN_FIRST, INVESTIGATE_CONTEXT, WEB_RESEARCH, DISCUSS_OPTIONS, ESCALATE_DEPTH}` at bounded `depth`. Supersedes fixed `partnerStyle`. Adds **no** model call. |
| 6 | [`memory-architecture-5.5.md`](./memory-architecture-5.5.md) (v1.2) | Durable user memory: write-gate, consolidation (ADD/UPDATE/SUPERSEDE/NOOP), deterministic retrieval, injection. RC-1..RC-6 folded into the body. The anti-drift authority. |
| 7 | [`memory-architecture-redteam-5.5.md`](./memory-architecture-redteam-5.5.md) | The adversarial review that produced RC-1..RC-6 (and missed the panel-prompt bypass, now MF1). Verification trace, not an implementation target. |
| 8 | [`partner-and-memory-design-5.5.md`](./partner-and-memory-design-5.5.md) | The **baseline**, now loudly retired (MF5): memory half → doc 6; `partnerStyle`-as-mode → doc 5. Persona rewrite + prompt-API shape survive. |
| 9 | [`whole-tool-finish-5.5.md`](./whole-tool-finish-5.5.md) (parallel) | The §6 whole-tool gaps: onboarding/first-run, unified error/teach UX, cumulative cost budget + quota-shed, REPL asymmetry decision, combined upgrade-migration. The final phase points here. |

The seams between docs are where risk lives; the two contracts below (`assembleContextBlocks`,
`decidePostTurn`) and the binding phase spine (§4) are what make them one coherent product.

---

## MF1 — `assembleContextBlocks`: the one prompt-assembly seam (THE #1 blocker)

**The defect (final-gate §2.3):** `buildPrompt` has exactly two call sites (sequential
`orchestrate.ts:521`, hedge `hedge.ts:262`). The panel path uses **separate builders**:
`buildPanelCandidatePrompt(tier, task, historyContext?)` (`ensemble.ts:146`, called `:348`) and
`buildPanelSynthesisPrompt(task, candidates, contract?)` (`ensemble.ts:186`, called `:658-659`).
*(Note: the final-gate doc calls the synthesizer `buildSynthesizerPrompt`; the real name is
`buildPanelSynthesisPrompt` — this plan uses the verified name.)* None thread `memoryContext`,
an `IntentFrame`, an `EngagementPlan`, or `partnerStyle`. So memory/intent/partner edits that
touch only `buildPrompt` inject context on sequential and hedge turns but **silently NOT on
panel turns** — the highest-stakes multi-model turns get no memory, no intent, no posture, no
error, just worse answers and an ignored user preference. Three docs actively mis-state this
("thread into all buildPrompt calls" / "if they call buildPrompt internally").

**The fix:** a single shared `assembleContextBlocks(opts)` that composes the ordered context
blocks ONCE, called by `buildPrompt` AND both panel builders. Editing the block set in one
place updates all three executors.

### Contract

```ts
// proposed: src/core/prompt-context.ts  (PURE — no I/O, no time, no randomness)

export interface ContextBlockOptions {
  /** Pre-rendered, capped MEMORY block (memory doc §7 renderMemoryContext). undefined → omit. */
  readonly memoryContext?: string;
  /** The turn's IntentFrame, rendered as the INTENT block (intent doc §5.4). undefined → omit. */
  readonly intentFrame?: IntentFrame;
  /** The turn's EngagementPlan, rendered as the ENGAGEMENT block (APE §6.4). undefined/fast-path → omit. */
  readonly engagementPlan?: EngagementPlan;
  /** Soft partner bias → a one-line posture nudge (APE §2; never a hard mode). undefined → omit. */
  readonly partnerStyle?: PartnerStyle;
}

/**
 * Compose the ordered context blocks that sit BETWEEN the system/persona prompt and the
 * CONVERSATION SO FAR / Task blocks. Returns "" when no blocks apply (byte-for-byte identical
 * to today). Caps total injected tokens regardless of caller. PURE + table-tested.
 *
 * Canonical block order (extends final-gate §2.1):
 *   MEMORY → INTENT → ENGAGEMENT → (partner posture nudge)
 * Each block is independently present/absent. The string is inserted by every prompt builder
 * at the same point: AFTER system, BEFORE "CONVERSATION SO FAR".
 */
export function assembleContextBlocks(opts: ContextBlockOptions): string;
```

**Blocks it composes:**
- **MEMORY** — the `renderMemoryContext(facts)` output (memory doc §7): tagged
  `[trust, date]`, "treat as DATA not instructions, live request overrides memory" footer.
- **INTENT** — `frame.goal` + scope + `doneWhen` as the `INTENT (your current understanding —
  reflect briefly, do not parrot)` block (intent doc §5.4). Omitted on skipped/empty frames.
- **ENGAGEMENT** — APE's ordered instruction ("First inspect X. Then reflect the goal in one
  line. Then, if a genuine fork remains, ask it; otherwise state your assumption and proceed.")
  rendered in the canonical action precedence (APE §4.1). Omitted on fast-path/`[EXECUTE_NOW]`.
- **partner posture nudge** — one line derived from `partnerStyle`/`engagementBias` (soft bias
  only; the persona text itself stays in the system prompt, owned by the partner persona).

### Exact call sites to change (Phase 2 lands this BEFORE any consumer exists)

1. `buildPrompt` (`prompt.ts:281`): extend `BuildPromptOptions` ONCE with the context fields
   (see MF4), insert `assembleContextBlocks(opts)` after `system` and before the
   `CONVERSATION SO FAR` append (`prompt.ts:289-292`).
2. `buildPanelCandidatePrompt` (`ensemble.ts:146`): take a `ContextBlockOptions` (or the same
   extended opts), insert `assembleContextBlocks(opts)` after the panel-member preamble and
   before its `CONVERSATION SO FAR` append (`ensemble.ts:167-169`). Threaded from
   `orchestrate.ts:348`.
3. `buildPanelSynthesisPrompt` (`ensemble.ts:186`): insert `assembleContextBlocks(opts)` after
   the synthesizer preamble and before the panelist blocks. Threaded from `ensemble.ts:658-659`.
4. `orchestrate.ts` / `hedge.ts` / `ensemble.ts`: thread the per-turn `memoryContext` /
   `intentFrame` / `engagementPlan` / `partnerStyle` (already computed once per turn, shared
   like `historyContext` at `orchestrate.ts:324-329`) into all three builders.

### Required test (the binding regression)

In `test/unit/prompt-context.test.ts` / `test/unit/ensemble.test.ts`:
- `assembleContextBlocks` table tests: each block present/absent; canonical order preserved;
  `""` when all empty; cap enforced.
- **A panel candidate prompt built via `buildPanelCandidatePrompt` with a `memoryContext` + an
  `IntentFrame` + a non-trivial `EngagementPlan` CONTAINS the MEMORY, INTENT, and ENGAGEMENT
  blocks** — and the synthesizer prompt likewise. This is the assertion that proves the panel
  path is no longer context-blind. (Mirrors APE §8 test 7 and intent/memory's own regressions.)

Minimal pointers added to memory §7 and intent §5.3 now route readers here instead of saying
"every buildPrompt call." **MF1 CLOSED.**

---

## MF3 — `decidePostTurn`: the one canonical post-turn order

**The defect (final-gate §2.1):** the post-turn ordering rule (the red-team Axis-9 sequence)
lives ONLY in the red-team doc, not in the chat-ux doc that owns the queue nor the memory doc
body. Two writers, one truth, in the least-read file → an implementer can let a queued line
answer an unseen memory/question selector (accidental Save / capture-exclusivity throw).

**The fix:** one pure, exported, table-tested function, authoritative here; chat-ux owns the
implementation (a one-line pointer now sits in chat-ux §"Structured Question Rendering").

### Contract

```ts
// proposed: src/interface/menu.ts (or src/interface/post-turn.ts) — PURE decision.

export type PostTurnAction =
  | 'discard-typeahead'      // drop lines typed during the turn (they never saw the selector)
  | 'question-flow'          // run runStructuredQuestionFlow (ask_user selector)
  | 'memory-approval'        // run the remember_user Save/Skip/Edit selector
  | 'drain-queue';           // run queued chat lines as the next turns, FIFO

export interface PostTurnInputs {
  readonly hasQuestions: boolean;        // final.questions present
  readonly hasMemoryProposal: boolean;   // final.memoryProposal present AND passed worthGate
  readonly queuedCount: number;          // chat-turn queue length
  readonly interrupted: boolean;         // ESC or Ctrl-C cancelled this turn
}

/**
 * The single canonical post-turn sequence (red-team Axis-9). Returns the ordered actions to
 * perform after a turn settles. PURE + table-tested. chat-ux owns the implementation; memory
 * and question flow both route through it.
 *
 *   settle
 *     → discard queued typeahead            (always, before any selector)
 *     → IF hasQuestions: question-flow      (mutually exclusive with memory-approval per turn)
 *     → ELSE IF hasMemoryProposal: memory-approval
 *     → drain-queue                         (only if NOT interrupted; interrupt discards)
 *
 * Rules: a selector is never fed a queued line (discard-typeahead always precedes it). On
 * interrupt, the queue is discarded and not drained. question-flow and memory-approval never
 * both run in one turn (the model never emits ask_user alongside remember_user — memory doc §8).
 */
export function decidePostTurn(inputs: PostTurnInputs): readonly PostTurnAction[];
```

### Table-test rows (the contract)
- normal settle, no q/proposal, queue=2 → `[discard-typeahead, drain-queue]`.
- questions present, queue=1 → `[discard-typeahead, question-flow]` (no drain — the answer
  turn re-enters the loop; per chat-ux a queued line is discarded with a notice).
- memory proposal, no questions, queue=0 → `[discard-typeahead, memory-approval, drain-queue]`.
- interrupted, queue=3 → `[discard-typeahead]` (queue discarded, no drain).
- memory-approval runs **after** discard, **before** drain → a queued "1" can never become "Save".

**MF3 CLOSED** (authoritative here; chat-ux implements; pointer added).

---

## APE — integration and locked open-question defaults

APE slots into the lifecycle immediately after the intent stage, before panel/hedge/loop, as a
**pure decision computed once per turn** (APE §6.1). It rides the intent engine's single gated
call and adds **no model call of its own**.

```
decideRoute()  → classification {tier,risk}; routePlan = decision.plan      (orchestrate.ts:255)
 → [intent stage] frame = intentExtractor(...) ?? rulesIntentFrame(...)      (Phase 6)
 → [APE] plan = planEngagement({ frame, classification, routePlan,
                                 engagementBias, memoryBias, task })          (PURE, instant)
 → yield { type:'engagement', plan }                                          (render-optional)
 → workTrace = seedFromIntentAndPlan(frame, plan)                             (consumes route.plan)
 → run; prompt carries MEMORY+INTENT+ENGAGEMENT via assembleContextBlocks (MF1)
```

**`partnerStyle` becomes a soft bias** (`engagementBias ∈ {-1,0,+1}`): `direct=-1`, `balanced=0`,
`collaborative=+1`, *added into* the thresholds of `planEngagement`. It never forces an action
the signals contradict and never crosses the safety floor (irreversible+ambiguous still gets a
discuss/ask even at `direct`; "what time is it?" stays instant even at `collaborative`).

### Locked open-question defaults (APE §8/§10 — now decided, binding)

1. **Engagement visibility (APE Q2/§10.2):** show engagement to the user **only when it
   produces a visible action** — a one-line REFLECT_VISION reflection, a DISCUSS_OPTIONS
   presentation, an ASK_CLARIFYING question, or a PLAN_FIRST roadmap. **Silent otherwise** —
   the mechanics (investigate/research instructions, depth, escalation bias) are never
   surfaced. The `{type:'engagement'}` CoreEvent is render-optional; renderers ignore it unless
   surfacing the reflection.
2. **Bias magnitude (APE Q3/§4.3):** **single-step threshold shift** per bias unit, bounded so
   it can never cross the safety floor or force depth 2. (Tunable later via behavioral
   fixtures; default = single step.)
3. **APE memory authority (APE Q5/§6.5):** APE **infers memory scope** (global/project/narrower)
   and **re-orders/justifies** the existing Save/Skip/Edit approval via a salience judgment —
   and **nothing more**. It **never auto-Saves, never auto-Skips silently, never bypasses
   RC-1..RC-6** (worthGate incl. `isInstructionShaped` RC-6, multi-field secret scrub RC-4,
   closed-subject enum RC-1, `(scope,kind,subject)` consolidation RC-2 all run *before and
   independently of* APE's advice). APE may *propose* a Skip on low salience, but the user
   confirms. Smart = better proposals; safe = the unchanged gate the proposals pass through.

### APE depends on / coexists with

- Depends on **Phase 2** (`assembleContextBlocks` + panel fix) for the ENGAGEMENT block.
- Depends on **Phase 6** (intent core) for `IntentFrame` and the shared gated call.
- APE-D (smart memory judgment) depends on **Phase 5** (memory commands/proposals).
- Print-free, touches no raw-mode/stdin code → coexists with the 3.12.x stdin work (Phase 0).

---

## 4. MF4 — the binding, conflict-resolved phase spine

This adopts final-gate §7's sequence as **binding**, integrating APE and naming single-owners.
The dependency spine: **0 → 2 → 3 → 4 → {5, 6+APE} → 7 → 8 → 9.** Phase 1 is parallel-safe
anytime. Phase 2's `assembleContextBlocks` unification is the linchpin that makes 4/5/6/APE
coherent across sequential, hedge, AND panel executors.

**Single-owner rules (the merge-safety contract):**
- `BuildPromptOptions` is extended **ONCE**, in **Phase 2** (partner/prompt-seam owner). Memory
  (Phase 4), intent (Phase 6), and APE then *consume* it. No other phase re-declares it.
- The `CoreEvent` union is extended **ONCE**, in a single coordinated `types.ts` change that
  lands the `{type:'intent'}`, `{type:'engagement'}`, `{type:'phase'}` variants and
  `final.memoryProposal` together (final-gate §2.2). Owned by Phase 6's types step; presentation
  (Phase 8) and memory (Phase 5) coordinate their additions into that one edit.
- `menu.ts` chat-ux refactor (`runChatLoop` → `runOneChatInput` + post-turn slot) lands in
  **Phase 0**, BEFORE any command additions (`/style`, `/memory`, `/recap`, approval selector)
  rebase onto it.
- `theme.ts` glyph helpers: presentation's `turnMarker()` (Phase 1) lands before recap's
  `recapMarker()`/`formatRecapLine` (Phase 7) reuses the same helper style.

---

### Phase 0 — chat-ux refactor FIRST (unblocks everyone)
- **Goal:** land chat-ux's mechanics so four downstream docs add commands/selectors onto a
  stable surface. Pure helpers → `createLineReader.beginCapture/drainBuffered/clearBuffered` →
  scoped ESC listener → refactor `runChatLoop` into `runOneChatInput` + the post-turn slot.
  Promote the red-team Axis-9 ordering into the exported **`decidePostTurn`** (MF3).
- **Files + owner:** `src/interface/menu.ts` (input internals — **chat-ux owner**),
  `src/core/types.ts` (`LineReader` ext), tests.
- **Tests:** `interpretChatKey`, `attachChatTurnKeyListener`, `beginCapture`, `decidePostTurn`
  table tests, queue drain/discard, off-TTY ESC degradation.
- **Coexistence (3.12.x):** THIS is the 3.12.x-adjacent work — obey single suspend/resume
  owner, no `removeAllListeners`, no `/dev/tty` mid-turn listener, no `stdin.read()` drain.

### Phase 1 — presentation chrome (parallel-safe, zero core risk)
- **Goal:** `theme.ts turnMarker()`, `spinner.elapsed()`, assistant `●` before first prose
  delta, completion dots + elapsed. Defer panel "Waiting on N" + the `phase` event to Phase 8.
- **Files + owner:** `src/ui/theme.ts`, `src/ui/spinner.ts`, `src/interface/render.ts`
  (**presentation owner**).
- **Tests:** turn-marker present; NO_COLOR/non-TTY no-ANSI; elapsed sourced from
  `spinner.elapsed()` (honesty); `turnMarker` pure table test.
- **Coexistence:** strictly additive chrome on existing events; touches no stdin/event model.

### Phase 2 — `BuildPromptOptions` canonical extension + `assembleContextBlocks` + partner posture (THE prompt-API change; closes MF1)
- **Goal:** extend `BuildPromptOptions` ONCE (`{ goalTurn?, partnerStyle?, memoryContext?,
  intentFrame?, engagementPlan? }`); land the shared **`assembleContextBlocks` seam** that
  `buildPrompt` AND `buildPanelCandidatePrompt` AND `buildPanelSynthesisPrompt` call (MF1 —
  fixes the panel bypass BEFORE any consumer exists); persona rewrite (domain-agnostic base +
  tier addenda, from the partner doc, LIVE); `ASKING THE USER` "genuine fork" rewrite;
  `partnerStyle` config + `/style` + Settings + resolver (as the soft-bias seed, APE §2).
- **Files + owner:** `src/core/prompt.ts` + new `src/core/prompt-context.ts`, `src/core/ensemble.ts`
  (**the unification — prompt-seam owner**), `src/core/questions.ts` (comment), `src/infra/config.ts`,
  `src/core/types.ts` (`OrchestrateDeps.partnerStyle`), `src/core/orchestrate.ts` + `src/core/hedge.ts`
  (thread it), `src/interface/menu.ts` (deps-assembly + `/style`), `src/cli.ts`.
- **Tests:** **panel candidate + synthesizer prompts carry the context blocks** (MF1 regression);
  `assembleContextBlocks` order/caps; persona/ask_user phrase updates; `/style` resolver.
- **Coexistence:** deps-assembly + `/style` dispatch only in `menu.ts` (no input internals);
  rides Phase 0's `runOneChatInput`.

### Phase 3 — memory pure core + store (no UI; RC-1..RC-6 in the body)
- **Goal:** memory doc Phases 1–2 with the v1.2 body: gate (`worthGate` incl.
  `isInstructionShaped` RC-6, multi-field secret scrub RC-4, empty-subject reject, `injectGate`),
  closed-subject consolidation (`normalizeSubject` RC-1, `(scope,kind,subject)` arbitration RC-2,
  tags-only near-dup merge), score-then-fill retrieval (RC-3), decay (`isDecayExempt` RC-5,
  importance recompute not max), `renderMemoryContext`, `parseRememberUser`; store with
  **whole-transaction `withLock` reading the index INSIDE the lock** (RC-4), audit append inside
  lock + rotation, `Clock`-injected, `0o600`, path-traversal-validated ids, git-toplevel project key.
- **Files + owner:** new `src/core/user-memory.ts`, new `src/infra/user-memory-store.ts` (+ port),
  `src/infra/config.ts` (**memory owner**) — new files only, zero collision.
- **Tests:** RC-1 synonym→one fact; RC-2 lexically-dissimilar contradiction; RC-3
  high-relevance-fact-survives-cap; RC-4 multi-field secret + concurrency; RC-5 decay-exempt
  constraint + injection-doesn't-reset; RC-6 instruction-shaped reject; the literal `#4896` scenario.
- **Coexistence:** new files; reuses `atomic.ts`/`state-dir.ts`; no `menu.ts` input internals.

### Phase 4 — memory injection (consumes Phase 2's seam)
- **Goal:** thread `memoryContext` through `assembleContextBlocks` (covers sequential, hedge,
  panel automatically); apply the `injectGate` (constraints/identity always ride; prefs gated
  behind "real work request" via `routeClassifier`); select+inject per turn in deps-assembly.
- **Files + owner:** `src/core/orchestrate.ts` (pass `deps.memoryContext`), `src/interface/menu.ts`
  (deps-assembly — **memory owner**), `src/cli.ts`.
- **Tests:** memory block reaches a panel prompt (via the Phase-2 seam test); gate skips
  prefs on a trivial turn but always rides constraints; `/memory loaded` honesty on gated turns.
- **Coexistence:** consumes the seam; deps-assembly only.

### Phase 5 — memory commands + model-proposed memory
- **Goal:** `/remember`, `/forget`, `/memory[ all/edit/export/loaded]`, CLI subcommands;
  `remember_user` inside the confidence envelope; render strip (`remember_user` →
  `CONTROL_ENVELOPE_KEYS` `render.ts:141`); `CoreEvent.final.memoryProposal`; approval selector
  wired into the **Phase-0 post-turn slot** via `decidePostTurn` (memory-approval after
  discard, before drain — MF3).
- **Files + owner:** `src/interface/menu.ts` (command dispatch + selector reuse — **memory owner**),
  `src/interface/render.ts` (strip), `src/core/prompt.ts` (capture instr), `src/core/assess.ts`
  (verify no-op on extra key), `src/core/orchestrate.ts`, `src/core/types.ts` (coordinated union
  edit), new `src/commands/memory.ts`.
- **Tests:** approval routes through `decidePostTurn`; queued line never answers the Save/Skip
  selector (MF3 regression); render strips `remember_user`; `assess()` ignores it.
- **Coexistence:** command dispatch + existing selector machinery, not raw input.

### Phase 6 — intent engine + APE (intent core deepened into judgment)
- **Goal:** intent Phases I–IV (pure `intent.ts`, `intent-extractor.ts` twin of
  `route-classifier.ts`, gate `shouldExtractIntent`, stage in `orchestrate.ts:255-281`, INTENT
  block via `assembleContextBlocks`, work-contract seed swap, ask_user derivation, memory query
  keyed on `frame.goal`). **APE-A** (pure `engagement.ts`: `planEngagement` + heuristics +
  `seedFromIntentAndPlan`) → **APE-B** (wire after the intent stage, `{type:'engagement'}`
  event, ENGAGEMENT block via the seam, `engagementBias` from `partnerStyle`, `memoryBias` from
  injected memory) → **APE-C** (consume levers: `planFirst` → roadmap seed consuming
  `route.plan`; `asks` → ask_user budget; `escalate` → escalation/panel bias). Coordinated
  `CoreEvent` union edit (`intent`+`engagement`+`phase`+`final.memoryProposal`) lands here.
- **Files + owner:** new `src/core/intent.ts`, `src/core/intent-extractor.ts`, `src/core/engagement.ts`;
  `src/core/orchestrate.ts` (gate+stage+APE stage+seed), `src/core/prompt.ts`/`ensemble.ts` (blocks
  via seam), `src/core/types.ts` (**intent/APE owner** of the union edit), `src/core/work-contract.ts`,
  `src/core/questions.ts` (comment), infra/config + Settings.
- **Tests:** `parseIntentFrame`/`capIntentFrame`/`shouldExtractIntent`/fallback;
  `planEngagement` table (trivial→`[EXECUTE_NOW]` depth0; irreversible+ambiguous→DISCUSS even at
  `direct`; collaborative lowers bar but trivial still instant; SMART boundary; ASK_CAP=1);
  `seedFromIntentAndPlan` (roadmap only when planFirst); **ENGAGEMENT block on a panel prompt**.
- **Depends on:** Phase 2 (seam), Phase 4 (memory query keys on goal; `memoryBias`).
- **Coexistence:** print-free, no raw-mode/stdin; backward-compat (absent extractor → byte-identical).

### Phase 7 — recap
- **Goal:** recap Phases 1–2: pure `recap.ts` (`buildRecapPrompt`, `isRecapStale`,
  `formatRecapLine`), `ConversationMeta` recap fields + `setRecap`, replace the tail-echo at
  `menu.ts:2341-2349`, `/recap`, richer Recent list. Same injected provider port + null-on-
  failure contract as intent (best-effort; a failed recap never blocks resume).
- **Files + owner:** `src/infra/conversation-store.ts`, `src/infra/conversations.ts`, new
  `src/core/recap.ts`, `src/interface/menu.ts`, `src/interface/render.ts`/`src/ui/theme.ts`
  (**recap owner**; reuses Phase-1 `turnMarker` helper style for `※`).
- **Tests:** prompt/staleness/format pure tests; store round-trip + `normaliseMeta` migration;
  resume shows `※ recap`, old tail-echo gone; generation failure falls back to title.
- **Coexistence:** print-only; touches no stdin; shares `theme.ts` glyph helper.

### Phase 8 — presentation panel "Waiting on N" + `phase` event + markdown
- **Goal:** the panel state machine ("Waiting on N models" from up-front `tier-start`s, flip on
  `tier-done`, "Synthesizing N"), the composition header in normal mode, interrupt-hint
  wording, optional inline markdown. Prefer the explicit `{type:'phase'}` CoreEvent over
  notice-string sniffing (final-gate §2.2 / presentation Q4).
- **Files + owner:** `src/interface/render.ts`, `src/core/types.ts` (the `phase` variant, into
  the coordinated union edit), `src/core/ensemble.ts`/`src/core/orchestrate.ts` (emit phase)
  (**presentation owner**).
- **Tests:** panel label transitions `Waiting on 2 → 1 → Synthesizing`; `phase` event drives
  state, not string parsing.
- **Coexistence:** additive chrome + one typed event; no stdin.

### Phase 9 — whole-tool finish (the §6 gaps)
- **Goal:** the §6 gaps — onboarding/first-run for all surfaces (memory approval, INTENT/APE
  reflection, `※ recap`, "Waiting on N"), unified error/teach-on-failure UX, the cumulative
  cost-budget + quota-shed policy (shed order: recap → intent → preference injection; constraints
  always ride), REPL-asymmetry decision documented, combined 3.12.x upgrade-migration test.
- **Files + owner:** see **[`docs/whole-tool-finish-5.5.md`](./whole-tool-finish-5.5.md)** (being
  written in parallel) — that doc is the authoritative spec and owner for this phase.
- **Tests:** first-run snapshots; teach-on-failure messages; quota-shed order; upgrade migration.
- **Coexistence:** mostly presentation/onboarding; respects all prior single-owner rules.

---

## 5. Decisions LOCKED

1. **One prompt-assembly seam.** `assembleContextBlocks` is the only path memory/intent/
   engagement/partner context flows through; the three prompt builders all call it (MF1).
2. **One post-turn order.** `decidePostTurn` (red-team Axis-9): settle → discard typeahead →
   question-flow → memory-approval → drain-queue; chat-ux owns it (MF3).
3. **`BuildPromptOptions` extended ONCE (Phase 2); `CoreEvent` union extended ONCE (Phase 6
   coordinated edit); `menu.ts` chat-ux refactor lands Phase 0 first** (MF4).
4. **Memory v1.2 = the body** (RC-1..RC-6 folded in): closed-subject enum; contradiction off
   `(scope,kind,subject)` not Jaccard; score-then-fill 12/1200 budget reserving ≥4 relevance
   slots; whole-transaction lock reading index inside the lock + multi-field secret scrub +
   audit rotation; decay-exempt `user_stated` constraints / `importance:3` + decay-reset only on
   relevance-selected facts; instruction-shaped reject; git-toplevel project key; inject-time
   gate (constraints/identity always ride, prefs gated) (MF2).
5. **Partner persona/ask_user/prompt-API survive in the baseline; its memory half and its
   `partnerStyle`-as-mode are retired** (MF5).
6. **APE supersedes fixed `partnerStyle`:** soft `engagementBias ∈ {-1,0,+1}`, single-step
   threshold shift, never crosses the safety floor; EXECUTE_NOW default; adds no model call.
7. **APE defaults locked:** engagement shown only when it produces a visible action (else
   silent); APE infers memory scope + reorders proposals only — never auto-Save, never
   auto-Skip silently, never bypasses RC-1..RC-6.
8. **Subscription discipline:** no embeddings/vector DB/metered service/API key; recap + intent
   model calls go through the router's injected provider port; purity guard stays green.
9. **Phase 9 (whole-tool finish) is in scope and points to `whole-tool-finish-5.5.md`.**

---

## 6. What the re-gate MUST verify (honest checklist)

A re-gate should NOT stamp 10/10 until each is checked against the *implemented* code:

- [ ] **MF1 panel coverage.** A test asserts `buildPanelCandidatePrompt` AND
  `buildPanelSynthesisPrompt` carry the MEMORY + INTENT + ENGAGEMENT blocks — not just
  `buildPrompt`. No prompt builder injects context except via `assembleContextBlocks`.
- [ ] **MF2 body correctness.** The memory doc body (not the appendix) reads as the v1.2
  algorithm top-to-bottom: no `similarity>=0.45` contradiction pre-gate survives; subject is a
  closed enum; retrieval is score-then-fill with a reserved relevance floor; the store reads the
  index inside the lock; `isSecret` scans text+value+reason+post-merge; `isInstructionShaped`
  exists; decay-exemption + relevance-only reset exist.
- [ ] **MF3 ordering.** `decidePostTurn` is the single source of the post-turn sequence; memory
  approval and question flow both route through it; a queued line cannot answer a selector
  (regression test present); interrupt discards the queue.
- [ ] **MF4 single-owners.** `BuildPromptOptions` extended exactly once; the `CoreEvent` union
  extended in one coordinated edit; Phase 0 landed before any command additions.
- [ ] **MF5 retirement.** No code implements `user_confirmed` / `MemorySource` /
  `memory:'on'|'off'` / cwd-basename project keys / the broken cap math from the baseline.
- [ ] **APE bounds.** `planEngagement` is pure/total (table-tested); fast-path adds zero
  overhead; ASK_CAP=1; safety floor beats bias on irreversible+ambiguous; depth-2 unreachable
  without stakes∧scope∧ambiguity; APE never auto-Saves/Skips or bypasses any RC.
- [ ] **APE memory advice is advisory only.** `inferMemoryScope`/`salienceForApproval` re-order
  and scope-infer but a secret-bearing high-salience fact is still rejected (RC regression).
- [ ] **Subscription guard.** `test/arch/guards.test.ts` stays green; no new fetch/SDK/API-key;
  recap + intent reuse the injected provider port with null-on-failure.
- [ ] **Cumulative cost budget + quota-shed (Phase 9).** One budget statement; shed order
  recap → intent → preference-injection; constraints/identity always ride.
- [ ] **Onboarding + teach-on-failure + REPL asymmetry + upgrade migration (Phase 9).** Each
  named, designed, and tested in `whole-tool-finish-5.5.md`.
- [ ] **Backward-compat.** With every feature absent/off, prompts and behavior are byte-for-byte
  identical to 3.12.x (the router's backward-compat property, extended to memory/intent/APE).

### Honest residuals the re-gate should track (NOT blockers, documented)
- Jaccard relevance is a tie-break, not recall (embeddings = v2).
- Moved/renamed-repo project-key orphaning (stable repo identity = v2).
- `isSecret` heuristic gaps (spaced keys / seed phrases) — best-effort + model self-filter +
  approval backstop; never render value/reason without re-scrubbing.
- APE heuristic ceiling: a subtly-irreversible turn the lexicon misses (conservative-broad
  lexicon + safety floor are the guard; failure biases to "asked once more," not "acted").
- Phase 9 surfaces (onboarding/error/budget) gate a whole-tool 10 but not the start of the build.
