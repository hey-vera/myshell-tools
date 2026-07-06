# Final Quality Gate 5.5 — RE-RUN — Whole-Tool Sign-Off (Corrected Corpus)

Role: principal engineer / architect, second pass. The first gate
([`final-gate-5.5.md`](./final-gate-5.5.md)) scored **8.4/10 CONDITIONAL-GO** with 5 must-fixes
and a §6 whole-tool gap list. This re-run renders an honest verdict on the **now-corrected**
corpus, with the master plan ([`MASTER-PLAN-5.5.md`](./MASTER-PLAN-5.5.md)) as the binding
spine, the Adaptive Partner Engine ([`adaptive-partner-engine-5.5.md`](./adaptive-partner-engine-5.5.md))
superseding the fixed `partnerStyle`, and the §6 gaps designed in
[`whole-tool-finish-5.5.md`](./whole-tool-finish-5.5.md).

Design review only — **no `src/` or `test/` changes were made.** Every claim below was
verified against the docs AND the real code (not the consolidation agent's self-report).

**Bottom line up front: 9.5 / 10 — GO, STAMPABLE.** All five prior must-fixes are CLOSED in the
binding source (the master plan), the memory body now reads correctly top-to-bottom, APE is
sound/bounded/fail-soft/zero-added-call, the §6 gaps close, and the subscription discipline holds
across every new doc. The residual that keeps it off a clean 10/10 is **not a design defect** —
it is two documentation-coherence stragglers in *non-binding* sections (a memory-doc phase-table
line and the cumulative-budget table) that contradict their own corrected bodies. They are
must-fix-before-implementation *as doc edits* (5 minutes each) but they do not change the
implementation contract, because the binding master plan is correct. With those two one-line
edits, this is a clean 10.

---

## 1. Must-Fix Verification Table

| MF | Prior defect | Status | Evidence (verified against docs + code) |
|---|---|---|---|
| **MF1** — panel/synth prompt context bypass | `buildPrompt`-only edits silently skip panel turns | **CLOSED** | Master plan §"MF1" specifies a single `assembleContextBlocks(opts)` seam (`prompt-context.ts`, PURE) called by `buildPrompt` AND both panel builders, with the **correct real names** `buildPanelCandidatePrompt` (def `ensemble.ts:146`, call `:348`) and `buildPanelSynthesisPrompt` (def `:186`, calls `:658-659`) — I confirmed these names/lines in `src/core/ensemble.ts`. The prior gate's `buildSynthesizerPrompt` name was wrong; the master plan uses the verified name. The **required regression test** is specified (MP §"Required test"): *"A panel candidate prompt built via `buildPanelCandidatePrompt` with a `memoryContext` + an `IntentFrame` + a non-trivial `EngagementPlan` CONTAINS the MEMORY, INTENT, and ENGAGEMENT blocks — and the synthesizer prompt likewise."* This covers BOTH builders and all three blocks. Code-accuracy verified: `buildPrompt` has exactly 2 call sites (`orchestrate.ts:521`, `hedge.ts:262`); both panel builders have the same "before CONVERSATION SO FAR" insertion point (`ensemble.ts:167-169`) the seam targets; `prompt.ts:289-292` is the matching seam in `buildPrompt`. Memory §7 and intent §5.3 both now route readers to the seam ("Do NOT thread `memoryContext` into each `buildPrompt` call site independently"). **MF1 fully closed in the binding source.** (One straggler — see §1-note below.) |
| **MF2** — fold RC-1..RC-6 into the memory BODY | Body read as pre-red-team algorithm; appendix "won" | **CLOSED (body)** | I read the memory doc §1–§7/§10 top-to-bottom. The body now reads as the v1.2 algorithm WITHOUT needing the appendix: closed `subject` enum is §1 (the keystone, with `normalizeSubject`); contradiction keys on `(scope,kind,subject)` in §4 step 2 with the explicit "NEVER gated by Jaccard" note; the **only** occurrence of `0.45` in the entire doc is line 1110 *inside the changelog* describing what was removed — the body §4 has no surviving `similarity>=0.45` pre-gate (matches the pre-verified claim); score-then-fill 12/1200 with ≥4 reserved relevance slots is §7 (RC-3); whole-transaction `withLock` reading index inside the lock is §2/§4 (RC-4); multi-field `secretScanText`(text+value+reason) + post-merge re-scan is §3 (RC-4); `isInstructionShaped` is §3 worthGate (RC-6); decay-exempt + relevance-only `markUsed` reset is §6 (RC-5). The "Red-Team Corrections" section is explicitly relabelled a **changelog, NOT an overriding appendix** (line 1082-1093). The old schema terms (`user_confirmed`, `MemorySource`, `memory:'on'`) do NOT appear anywhere in the memory doc as live spec. **Body is internally consistent.** One orphaned table-cell straggler remains — see Residual R1. |
| **MF3** — promote post-turn ordering into one canonical sequence | Axis-9 order lived only in the least-read red-team doc | **CLOSED** | Master plan §"MF3" defines a pure exported `decidePostTurn(inputs) → readonly PostTurnAction[]` with the canonical sequence *settle → discard-typeahead → question-flow (XOR) memory-approval → drain-queue (only if not interrupted)*, four table-test rows including the load-bearing *"memory-approval runs after discard, before drain → a queued '1' can never become 'Save'"*. Chat-ux now carries the pointer (`chat-ux-audit-5.5.md:136`: "owned by the single exported `decidePostTurn`… This chat-ux layer OWNS its implementation"). The mutual-exclusivity invariant is **verified against the memory doc**: `remember_user` is "never alongside `ask_user`" (`memory-architecture-5.5.md:811-812`) and an `ask_user` turn short-circuits as success-needing-reply (`orchestrate.ts:637-664`, `memory §8:826` "does not short-circuit") so a memory proposal can never co-occur with a question. **Closed and code-grounded.** |
| **MF4** — name canonical owner + binding phase order | Multi-writer churn on `BuildPromptOptions`, `CoreEvent`, `menu.ts` | **CLOSED** | Master plan §4 sets the binding spine `0 → 2 → 3 → 4 → {5,6+APE} → 7 → 8 → 9` with explicit single-owner rules: `BuildPromptOptions` extended **ONCE** in Phase 2 (prompt-seam owner); `CoreEvent` union extended **ONCE** in a single coordinated Phase-6 `types.ts` edit landing `{intent}`+`{engagement}`+`{phase}`+`final.memoryProposal` together; `menu.ts` chat-ux refactor lands Phase 0 **before** any command additions. Verified the targets are real and single: `CoreEvent` union is one place (`types.ts:404-472`), `OrchestrateDeps` is one interface (`:272`, `routeClassifier?` at `:349`), `final` variant with `questions?` at `:450-472`. The coordinated-edit discipline is correct and the union/interface are genuinely single-site. **Closed.** |
| **MF5** — loudly retire the partner baseline | Stale `user_confirmed`/cwd-keys/broken-cap math still live | **CLOSED** | `partner-and-memory-design-5.5.md` opens with "⚠️ SUPERSEDED — READ THIS FIRST (binding)" (line 3), names both retired halves (memory → doc 6; `partnerStyle`-as-mode → doc 5), and carries section-level banners (98, 294) plus an inline "⚠️ SUPERSEDED schema — do NOT implement" on the dead `MemoryConfidence='user_confirmed'` block (468). Master plan §0 row 8 records that "Persona rewrite + prompt-API shape survive." The stale schema/project-key/cap-math now appear only inside loudly-banned regions. **Closed.** |

**§1-note (MF1/MF2 straggler).** The memory doc's own *Phased Implementation Plan* table still
contains one line that contradicts its corrected §7 body: Phase 4 row (`memory-architecture-5.5.md:1014`)
says *"thread into all `buildPrompt` calls"* — the exact MF1 mis-statement phrasing. The §7 BODY
(763-768) is correct ("thread it through the single seam… Do NOT thread into each `buildPrompt`
call site independently"), and the **binding master plan supersedes the memory doc's local phase
list** (MP §"Status"). So the implementation contract is correct; this is a stale doc-table cell,
not a live instruction. Tagged Residual R1 (must-fix-as-doc-edit, not a design defect).

---

## 2. New-Seam Audit — did the fixes introduce new incoherence?

The risk of a corrective pass is that the fixes themselves create fresh seams. I audited the
three new shared artifacts (`assembleContextBlocks`, `decidePostTurn`, the APE stage) for
cross-doc coherence.

**(a) Do ENGAGEMENT + INTENT + MEMORY fit one per-turn budget together?** **Mostly yes, with one
table gap.** All three blocks render through the SAME `assembleContextBlocks` seam, which the
master plan specifies "**Caps total injected tokens regardless of caller**" (MP §MF1 contract,
line 91) — a single *total* cap is the real backstop, and it is sound: even if all three blocks
are present, the seam truncates to one budget. **However**, the cumulative-budget table that
whole-tool-finish §3.1 advertises as "the one place the overhead is summed… no sibling doc sums
them — this is that sum" accounts for **memory (~600–1200) + INTENT block (~200)** on a
substantial turn but **omits the ENGAGEMENT block** from the token line, even though APE's
ENGAGEMENT block is present on exactly those substantial turns and rides the same composition. The
block is "a short, ordered instruction" (small, <~150 tokens), so the omission is not a runtime
risk (the total cap protects the prompt), but the *authoritative budget table is internally
incomplete* — it claims to be the sum and misses one of the three summands. Tagged **Residual R2**
(must-fix-as-doc-edit: add an ENGAGEMENT row/figure to §3.1 and state the seam's single total
cap explicitly). The **per-turn model-call budget is coherent and verified**: memory = 0 calls
(deterministic Jaccard), intent = ≤1 gated call, APE = **0** added calls (rides the intent call —
verified `APE §3.3`, `§5.7`, `§7`), recap = background/non-blocking → "at most ONE blocking added
call per turn" holds across all docs.

**(b) Does `decidePostTurn` accommodate an APE-driven ask AND a memory proposal in one turn?**
**Yes — they are structurally mutually exclusive, so there is no conflict to resolve.** APE's
ASK_CLARIFYING is realized through the **existing `ask_user` block** (`APE §3.1`: lever =
"`ask_user` … short-circuit at `orchestrate.ts:637-664`"), not a parallel ask channel. An
`ask_user` turn short-circuits as a success-needing-reply, and the model "never [emits] ask_user
alongside remember_user" (`memory §8:811`). So when APE asks, the turn ends before any memory
proposal renders → `decidePostTurn`'s question-flow XOR memory-approval invariant is preserved
even with APE in the loop. Verified against both docs and `orchestrate.ts`. **Coherent.**

**(c) Does the binding phase order eliminate the multi-writer conflicts?** **Yes.** The three
historically-contended files now have enforced single owners: `BuildPromptOptions` (Phase 2,
prompt-seam owner; memory/intent/APE *consume*); `CoreEvent` union (one coordinated Phase-6 edit);
`menu.ts` input internals (Phase 0 chat-ux refactor lands first, downstream phases touch only
deps-assembly / command-dispatch / selectors). Cross-checked the master plan's per-phase
"Files + owner" lines against the prior gate's §2.2 collision matrix: every collision the first
gate flagged (`prompt.ts` three-writer, `menu.ts` five-writer, `render.ts`/`theme.ts` glyph
helpers, `CoreEvent` three-variant) now has a named owner and a sequencing rule. `theme.ts`
glyph helpers are sequenced (presentation `turnMarker()` Phase 1 before recap `recapMarker()`
Phase 7). **The single-owner contract is real and enforced by the phase spine.**

No new incoherence was introduced by the fixes. The two stragglers (R1, R2) are *pre-existing*
non-binding text that the corrective pass updated the binding bodies of but left one stale cell
in each.

---

## 3. APE Soundness

**Verdict: sound — genuinely bounded, fail-soft, zero-added-call, with an airtight safety floor
and real efficiency guardrails.**

- **Bounded / pure / total / zero-call.** `planEngagement(signals) → EngagementPlan` is specified
  PURE (no I/O, time, randomness), always returns a non-empty `actions[]`, never throws
  (`APE §3.4, §7`). It adds **no model call** — it consumes the `IntentFrame` the intent engine's
  single gated call already produced (`APE §3.3` justification: cost/testability/fail-soft, "the
  model is in the loop exactly once, exactly where it already was"). Verified the purity guard
  (`test/arch/guards.test.ts:81`) forbids `child_process`/`fs`/`crypto` imports in core, so
  `engagement.ts` structurally cannot introduce a metered/network path. The `planEngagement`
  table tests are specified (`APE §8`): trivial→`[EXECUTE_NOW] depth:0 source:'fast-path'`,
  fail-soft→`[EXECUTE_NOW] source:'fail-soft'`, ASK_CAP=1, depth-2 unreachable without
  stakes∧scope∧ambiguity.

- **Safety floor airtight?** **Yes.** The cascade (`APE §3.4`) runs the SAFETY FLOOR (step 2)
  *after* the trivial fast-path (step 1) but *before* the bias-shifted thoroughness ladder
  (step 3). On `irreversible && ambiguous` it forces DISCUSS_OPTIONS regardless of
  `engagementBias=-1` (`APE §2`, `§3.4 step 2`, headline test "irreversible+ambiguous → contains
  DISCUSS_OPTIONS, asks ≤ 1, **even at `direct`**"). Bias is bounded to a **single-step threshold
  shift** that "can never cross the safety floor or force depth 2" (`APE §4.3`, master plan
  locked-default #6). Trivial stays instant "even at `collaborative`" (`§2`, `§5.2`). The floor
  beats bias; bias never crosses the floor. **Airtight as specified.**

- **Efficiency guardrails real?** **Yes — and weighted equally with capability, per the mandate.**
  Nine guardrails (`APE §5`), each bounded and table-testable: EXECUTE_NOW default + zero-overhead
  trivial fast-path (no over-engagement accretion); ASK_CAP=1 + default `forkBudget=0` (prefer
  stated assumptions → no interrogation / analysis-paralysis); SMART knowledge-boundary gate
  reusing `isCheaplyReDerivable` so INVESTIGATE/RESEARCH reject the re-derivable/known (no
  over-research); reversibility-aware decisiveness (just-do reversible, discuss irreversible);
  bounded depth (depth-2 rare by construction); anti-loop fail-soft (one decision/turn, no
  re-plan recursion). The research base (`§1`) is real and on-point (Overthinking 2502.08235,
  SMART 2502.11435, Ask-or-Assume).

- **Any way it feels wrong (too eager to ask/act)?** APE's own honest §11 names the realer
  residual correctly: **too-eager-to-ACT** (a subtly-irreversible turn the lexicon misses), NOT
  too-eager-to-ask (default 0 asks is structurally the opposite risk). The mitigation is right —
  conservative-broad irreversible lexicon + safety floor, so the failure biases to "asked one
  extra time," not "acted irreversibly." This is a genuine heuristic-ceiling residual (R3),
  **acceptable-v1** (a deterministic heuristic mis-reads the way a fixed mode can't even try),
  tracked honestly with the right caution-budget allocation.

- **APE memory authority bounded?** **Yes.** APE "infers memory scope + re-orders/justifies the
  Save/Skip/Edit approval via salience — and nothing more" (master plan locked-default #7). It
  "**never auto-Saves, never auto-Skips silently, never bypasses RC-1..RC-6**" — worthGate
  (incl. `isInstructionShaped` RC-6), multi-field secret scrub (RC-4), closed-subject enum (RC-1),
  `(scope,kind,subject)` consolidation (RC-2) all run *before and independently of* APE's advice
  (`APE §6.5`, with the regression test §8.6: "a secret-bearing high-salience fact is still
  rejected"). Smart = better proposals; safe = the unchanged gate they pass through. **Sound.**

---

## 4. Whole-Tool-Finish Adequacy

**Verdict: the §6 gaps close, and "core answer always survives" is guaranteed.**

- **Onboarding** (`whole-tool §1`): progressive, just-in-time, once-each via a pure
  `shouldShowFirstTouch`/`markSeen` gate over an additive `AppConfig.seen` map; ONE setup-time
  "memory is on / `/memory` to manage" line (the only always-on durable-state surface), four
  dim once-each first-touch lines for the visible ephemeral surfaces, unified `/help` covering
  all five + an honest REPL `/help` asymmetry pointer. Pure seam, table-tested, fail-soft
  (a failed `saveConfig` only re-shows a line). **Closes.**

- **Teach-on-failure** (`whole-tool §2`): one pure `teach({what,did,you?,severity})` formatter,
  transient→silent-unless-promised-capability-lost, terminal→recover-once+one warn, explicit
  per-feature matrix, never red, never throws to the turn — plus a guard test asserting "no new
  feature path can `process.exit` or throw to the chat loop." Mirrors the proven
  corrupt-index/null-port fail-soft discipline. **Closes.**

- **Cumulative budget + quota-shed** (`whole-tool §3`): one summed budget table + a pure
  `decideShed(pressure, turnClass) → SheddingPlan` with the ordered shed **recap → narrow
  memory to identity/constraints → skip intent → CORE ANSWER always runs (never shed)**.
  Identity + hard constraints are never shed (decay-exempt, RC-5). A test asserts the
  core-answer flag stays true at every pressure level. **"Core answer always survives" is
  guaranteed** by construction (the shed ladder bottoms out at an un-sheddable core). *Caveat:*
  the budget *table* omits the ENGAGEMENT token line (Residual R2) — a completeness gap in the
  doc, not in the guarantee.

- **REPL asymmetry** (`whole-tool §4`): named, justified, bounded by a capability matrix + a
  divergence-guard test. The load-bearing insight is verified-correct: memory *injection* and the
  intent *frame* are deps/prompt concerns threaded through `assembleContextBlocks`, so the REPL
  gets sharper memory-aware answers *for free* via the shared core; only interactive
  write/visible affordances (approval selector, reflection line, recap, queue/ESC) are absent —
  which would be wrong in a pipe anyway. **Closes.**

- **Migration** (`whole-tool §5`): each artifact forward-migrates (recap fields via
  `normaliseMeta` `conversations.ts:64-75` — verified present; memory dir absent = empty;
  config keys via the merge that preserves unknown keys `config.ts:147-149`); plus the combined
  upgrade walkthrough (upgraders skip `runWelcome`, meet "memory is on" at first approval) and
  ONE integration test driving a real 3.12.x state dir → 5.5 with zero data loss / zero scary
  prompts. **Closes.**

---

## 5. Subscription-Guardrail Re-Audit (across the NEW docs)

**Verdict: PASS across all three new docs — no API-key / embeddings / metered drift.**

| Doc | Verdict | Evidence |
|---|---|---|
| **adaptive-partner-engine** | **PASS (exemplary)** | "No embeddings, no vector DB, no metered service, no API key" stated as load-bearing (`§intro`, `§7`). APE adds **zero** model calls (rides the intent gated call); INVESTIGATE/RESEARCH are *vendor-turn instructions* through `assembleContextBlocks`, not new HTTP clients (`§6.2` — "not a new HTTP client or code-search engine"). `engagement.ts` is pure core; the purity guard (`guards.test.ts`) holds. |
| **whole-tool-finish** | **PASS** | "$0 dollars, ceilings enforced by a test"; recap/intent reuse "the router's injected provider port"; shed policy protects quota+latency (the only real budgets on flat-rate), explicitly notes "no token-budget readout on subscription CLIs" so pressure is derived from the existing `rateLimitedProviders`/429 signal — no new probe. The three new primitives (`first-touch.ts`, `teach.ts`, `capability-budget.ts`) are all pure, no I/O. |
| **MASTER-PLAN** | **PASS** | §0 hard constraint + locked-decision #8: "no embeddings/vector DB/metered service/API key; recap + intent model calls go through the router's injected provider port; purity guard stays green." Every model touch routes through the verified `ModelClassifier`/`route-classifier.ts` injected port. |

The first gate's only enforcement ask — recap+intent MUST go through the same injected port and
`guards.test.ts` must stay green — is now explicit in the binding master plan (Phase 7 names the
"same injected provider port + null-on-failure contract as intent"). The recap doc's own wording
is slightly looser ("reuse the worker path"), but the binding source closes it. **No drift.**

---

## 6. Residual Risks (ranked)

| # | Residual | Tag | Why |
|---|---|---|---|
| **R1** | Memory doc Phase-4 table cell (`memory-architecture-5.5.md:1014`) still says "thread into all `buildPrompt` calls" — contradicts its own corrected §7 body and the master-plan MF1 seam. | **must-fix-before-implementation (doc edit)** | An implementer who follows the memory doc's *local* phase table instead of the binding master plan could re-introduce the panel bypass. The binding source is correct, so this is a 1-line edit (point the cell at `assembleContextBlocks`), not a design change. Low effort, real footgun. |
| **R2** | Cumulative-budget table (`whole-tool §3.1`) omits the ENGAGEMENT block from the per-turn token sum it advertises as authoritative. | **must-fix-before-implementation (doc edit)** | The table *claims* to be the one place overhead is summed; it misses one of the three blocks it sums. No runtime risk (the seam's single total cap protects the prompt), but the authoritative budget should be complete. 1-line edit. |
| **R3** | APE irreversibility-lexicon ceiling: a subtly-irreversible turn with no lexicon hit could be acted on. | **acceptable-v1** | Honestly named (`APE §10.1, §11`); mitigated by conservative-broad lexicon + safety floor; failure biases to "asked once more," not "acted irreversibly." Tunable via behavioral fixtures. The right caution-budget allocation. |
| **R4** | RC-4's rationale slightly over-states the `conversations.ts` lock claim. RC-4 says conversations.ts "reads the index OUTSIDE the lock" as a blanket TOCTOU; in reality the conversations *write* paths already read inside the lock (`readIndexLocked` inside `withLock`, verified `conversations.ts:265-268, 301, 348, 386, 399, 426`) — only the read-only `list()` reads once outside (`:206-214`). | **acceptable-v1** | The *design instruction* RC-4 gives memory (read-decide-write all inside one lock) is correct and sound regardless; only the rationale's characterization of the sibling code is imprecise. Does not affect the memory design's correctness. Optional rationale tweak. |
| **R5** | Jaccard relevance = tie-break not recall; moved-repo project-key orphaning; `isSecret` heuristic gaps; vendor over-investigation inside its own turn. | **acceptable-v1** | All carried forward from the first gate's documented residuals, each with a v2 path (embeddings, stable repo identity) and a backstop (approval, re-scrub, depth-bounded instruction). None block v1. |

**No residual is a design defect.** R1 and R2 are stale non-binding text whose corrected binding
counterparts are present and correct. R3–R5 are honestly-tracked heuristic ceilings with the
right mitigations.

---

## 7. Honest GO / NO-GO

**Overall score: 9.5 / 10. Verdict: GO — STAMPABLE.**

A professional lead **would** put their name on this corpus as ready to implement in the
master-plan order (`0 → 2 → 3 → 4 → {5,6+APE} → 7 → 8 → 9`, Phase 1 parallel-safe). The single
defect that made the first gate a CONDITIONAL-GO — the silent panel-prompt context bypass — is
genuinely closed: one shared `assembleContextBlocks` seam under the **correct** builder names,
covering both panel builders and all three context blocks, with a binding regression test that
asserts a panel candidate prompt carries MEMORY + INTENT + ENGAGEMENT. The memory body reads
correctly top-to-bottom without its appendix. The post-turn order is one canonical
`decidePostTurn`. The file-edit ownership is single-writer and phase-sequenced. The baseline is
loudly retired. APE is a bounded, fail-soft, zero-added-call judgment layer with an airtight
safety floor. The §6 whole-tool gaps close with the core answer guaranteed to survive. The
subscription discipline is exemplary across every new doc.

It is **9.5 and not a flat 10** only because of two one-line documentation stragglers (R1, R2)
in non-binding sections that contradict their own corrected bodies. These are
must-fix-before-implementation **as doc edits** — not because the implementation contract is
wrong (the binding master plan is correct on both points), but because a 10/10, 100%-confidence
stamp should not ship with any doc cell that, read in isolation, could mislead an implementer
back into the exact bug the corpus just fixed. Fix those two cells and this is a clean,
honest 10.

This is a GENUINE stamp, not a polite one: the corpus is coherent (one product, one spine, one
seam, one post-turn order), code-grounded (every seam target verified in `src/`), honest about
its heuristic ceilings, and disciplined on the subscription constraint. **Approved to implement.**

---

### Final summary

- **New overall score: 9.5 / 10.**
- **STAMPABLE: YES** — ready to implement in the master-plan phase order. The two residuals are
  doc-edits, not design or implementation blockers.
- **Must-fix-before-implementation residuals (both 1-line doc edits, neither changes the binding
  contract):**
  1. **R1** — repoint `memory-architecture-5.5.md:1014` (Phase-4 table) from "thread into all
     `buildPrompt` calls" to the `assembleContextBlocks` seam, matching its own §7 body.
  2. **R2** — add the ENGAGEMENT block to the `whole-tool-finish §3.1` cumulative-budget token
     sum (and state the seam's single total cap), so the authoritative budget is complete.
- **Single biggest remaining risk:** the APE irreversibility-lexicon ceiling (R3, acceptable-v1)
  — a subtly-irreversible turn the lexicon misses could be acted on; the safety floor +
  conservative-broad lexicon make the failure bias to "asked once more" rather than "acted
  irreversibly," which is the correct place to spend the caution budget, but it is the one place
  a deterministic heuristic can mis-read a turn the way no fixed mode could.
