# Final Quality Gate 5.5 — Whole-Tool Sign-Off Review

Role: principal engineer / architect rendering an honest, holistic verdict on the complete
5.5 design corpus for `myshell-tools` (an external, **subscription-auth** end-user CLI
wrapping Claude / Codex / OpenCode for ANY work). Design review only — no `src/` or `test/`
changes were made.

The bar: would a professional lead stamp a genuine **10/10, 100% confidence** on the entire
tool? This document says where it does and does not, with evidence cited to real code.

**Bottom line up front: NOT a 10/10 yet — call it 8.4/10, CONDITIONAL GO.** The corpus is
unusually strong (honest, code-grounded, research-backed, fail-soft). But three things block
a 10: (1) the docs say "thread context into every `buildPrompt` call" while the **panel and
synthesizer prompts are built by separate functions** (`ensemble.ts buildPanelCandidatePrompt`
/ `buildSynthesizerPrompt`) that `buildPrompt`-targeted edits will silently miss — a real
context-coherence hole; (2) there is **no unified, conflict-resolved master phase plan** —
four docs independently mutate `menu.ts`, `render.ts`, `orchestrate.ts`, `prompt.ts`,
`types.ts` and the merge order is left to the implementer; and (3) the corpus has **no
onboarding / first-run / error-recovery / reliability design** for the new surfaces, which a
whole-tool 10 requires. Everything else is fixable polish.

---

## 1. Per-Doc Verdict Table

| Doc | Score | What would make it a 10 |
|---|---|---|
| `chat-ux-audit-5.5.md` (mechanics) | **9.0** | Tighten the ESC↔queue↔memory-approval ordering into one *named, shared* "post-turn slot" contract (it's described prose-locally but not pinned as the single sequence all three docs cite); add the off-TTY ESC degradation acceptance test it promises. |
| `partner-and-memory-design-5.5.md` (baseline) | **7.5** | Explicitly mark itself superseded by the memory doc (it still ships the OLD `confidence:'user_confirmed'` schema, `memory:'on'|'off'`, free-text subject — all overridden); fix the "thread into panel/hedge **if they call buildPrompt**" hedge — panel does NOT call buildPrompt, so the conditional silently no-ops. |
| `memory-architecture-5.5.md` (THE memory design, v1.1) | **8.5** | Fold RC-1..RC-6 inline into the body (right now §4/§7 still *read* as the pre-red-team algorithm with a corrections appendix that "wins" — implementers will code the body); specify the panel-prompt memory injection; rotate `audit.jsonl`. |
| `memory-architecture-redteam-5.5.md` (adversarial review) | **9.5** | Nearly ideal. Only gap: it validated the design's code citations but did not catch that the panel/synth prompts bypass `buildPrompt` (the same blind spot the memory doc has). |
| `chat-presentation-5.5.md` (glyph/feel) | **9.0** | Resolve Q4 (explicit `phase` CoreEvent vs notice-string sniffing) before build — the renderer's panel state machine is otherwise built on string-parsing a `notice`; commit to the typed event. |
| `recap-feature-5.5.md` (※ recap) | **9.0** | Pin the recap model call to the same subscription provider seam used elsewhere and state the quota/latency budget (it says "cheap worker-tier pass" but never names the injected provider port or a timeout, unlike the intent doc which does). |
| `intent-engine-5.5.md` (IntentFrame) | **8.5** | Same panel/synth-prompt gap (the INTENT block is specced into `buildPrompt` only); confirm the latency cap (open Q1) — an ungated cap is the difference between "sharper" and "felt pause." Strong otherwise; the gate/fail-soft discipline mirrors `router.ts` faithfully. |
| `research/memory-frameworks.md` | **9.5** | Evidence base is real and accurately drawn on (mem0 #4896 LGY/LGS, Letta #3116 "blue", profile-vs-collection, no-LLM-at-query-time all verified present). |
| `research/memory-products-academic.md` | **9.5** | Likewise verified (Copilot 28-day use-it-or-lose-it, Unit 42 poisoning, BBQ-zip context rot, self-reinforcing error, trust-tier table all present and correctly cited). |

Average ≈ **8.9** per-doc, but the *integrated* score is lower (§2) because the seams between
docs are where the real risk lives.

---

## 2. Integrated-Whole Verdict — Seven Designs, One Product?

**Verdict: ~80% one coherent product, ~20% seven good ideas with under-specified seams.** The
docs cross-reference each other deliberately and the shared spine is real and consistent in
*concept*. But three concrete integration hazards are not closed in any single doc.

### 2.1 The shared spine — is the data/control flow consistent?

The intended per-turn spine is:
`intent → partner posture → ask_user → memory query → work-contract → recap → presentation.`

Checked against the real lifecycle (`orchestrate.ts:255-281` route→classify→contract→run;
`:637-664` ask_user short-circuit; `buildPrompt` at `prompt.ts:281-301`):

- **Consistent:** all four model-touching docs agree the injection slot is "after system,
  before CONVERSATION SO FAR" (`prompt.ts:291`), all agree `OrchestrateDeps` gets new optional
  fields (`types.ts:272`, next to `routeClassifier?` at `:349`), all agree the menu wiring is
  *deps-assembly only* via `buildDeps` (verified real at `menu.ts:2581`), all agree
  `assess()` ignores unknown keys so `remember_user`-in-envelope is safe (verified: assess
  reads only `confidence/escalate/reason/needs_review`, `assess.ts:24-27`). The control-envelope
  key set is exactly `['confidence','ask_user','verdict']` (verified `render.ts:141`), so
  adding `remember_user` is additive and correct.
- **Ordering within the prompt is consistent across docs** once stacked: system → MEMORY →
  INTENT → CONVERSATION SO FAR → Task → REVIEWER FEEDBACK. The partner doc, memory doc §7, and
  intent doc §5.4 each place their block in a non-conflicting position. Good.

- **CONTRADICTION (minor, resolvable): what "a turn" is at the post-turn boundary.** The
  chat-ux doc, the memory doc (Axis-9 / RC implied), and the intent doc each describe what
  happens *after* a turn settles, but only the red-team's Axis-9 actually pins the order:
  *settle → discard queued typeahead → (if questions) question flow → (else if memoryProposal)
  approval selector → then drain queue.* That ordering rule lives **only in the red-team doc**,
  not in the chat-ux doc that owns the queue, nor in the memory doc body. Two writers, one
  truth, and the authoritative copy is in the least-likely-to-be-read file. **This must be
  promoted into the chat-ux mechanics doc as the canonical post-turn sequence.**

### 2.2 Phase-plan COLLISIONS — who touches what

Mapping every doc's "files touched" onto the shared hot files:

| File | chat-ux | presentation | recap | memory | intent | partner |
|---|---|---|---|---|---|---|
| `menu.ts` | **input internals (heavy)** | callers pass `interruptHint` | resume line + `/recap` + list | deps-assembly + `/memory` cmds | deps-assembly + Settings | Settings + `/style` + deps |
| `render.ts` | notices only | **heavy (dot/panel/hint)** | `※` helper | strip `remember_user` | optional intent event | — |
| `orchestrate.ts` | — | (Q4 only) | — | thread `memoryContext` | **gate + stage + seed** | thread `partnerStyle`/`memoryContext` |
| `prompt.ts` | — | — | new `buildRecapPrompt` (sibling) | `BuildPromptOptions.memoryContext` + capture instr | INTENT block | `BuildPromptOptions` + persona rewrite |
| `types.ts` | `LineReader` ext | (Q4 `phase` event) | `ConversationMeta` fields | `OrchestrateDeps`/`CoreEvent.final` | `OrchestrateDeps`/`CoreEvent` | `OrchestrateDeps` |
| `ensemble.ts` | — | panel state SOURCE (read) | — | **MISSED (see 2.3)** | **MISSED (see 2.3)** | **MISSED** |

Real ordering hazards:

1. **`prompt.ts` / `BuildPromptOptions` — three writers.** Partner adds `partnerStyle` +
   `memoryContext`; memory re-adds `memoryContext`; intent adds the INTENT block + relies on
   the partner extension. They agree on the shape but each doc writes "extend
   `BuildPromptOptions`" as if it owns it. **`BuildPromptOptions` must be extended ONCE
   (partner doc lands it), then memory/intent consume it.** If built in the wrong order you get
   merge churn and a real risk of dropping a field. The corpus never names the canonical owner.

2. **`menu.ts` is touched by FIVE docs.** The chat-ux doc owns input/raw-mode internals; the
   other four claim "deps-assembly / command-dispatch / Settings ONLY, never input internals."
   That discipline is correct and the `buildDeps` seam (`:2581`) genuinely isolates them — BUT
   `/memory`, `/recap`, `/style`, and the memory approval selector all add command dispatch and
   selector reuse into the same `runChatLoop` body that chat-ux is simultaneously refactoring
   into `runOneChatInput`. **If chat-ux's refactor (its Phase 4) doesn't land first, every other
   doc's command additions rebase onto a moving target.** This is the single biggest
   merge-ordering risk and no doc sequences it.

3. **`render.ts` — presentation (heavy) vs memory (`remember_user` strip) vs recap (`※`).**
   Low collision risk (additive), but the presentation doc's `turnMarker()`/theme helper and
   the recap doc's `recapMarker()`/`formatRecapLine` both add glyph helpers to `theme.ts`;
   they should share one helper style. Recap explicitly defers to presentation's `turnMarker`
   pattern — good, but presentation must land first.

4. **`CoreEvent` union — presentation (Q4 `phase`), intent (`intent`), memory
   (`final.memoryProposal`).** Three additive variants/fields to one union (`types.ts:404-472`).
   Additive, safe, but all three must be in one coordinated `types.ts` change to avoid three
   conflicting edits to the same union.

### 2.3 The real seam defect: panel/synth prompts bypass `buildPrompt`

**This is the most important finding in this review.** Memory §7 ("thread into all
`buildPrompt` calls including panel/hedge executors"), intent §5.3 (INTENT block into "the
prompt builders for the sequential loop AND the panel/hedge executors"), and partner ("thread
the same prompt context into those executors **if they call buildPrompt internally**") all
assume the panel path funnels through `buildPrompt`.

It does not. Verified:
- `buildPrompt` has exactly **two** core call sites: `orchestrate.ts:521` (sequential loop)
  and `hedge.ts:262` (hedge winner).
- The panel path uses **separate pure builders**: `buildPanelCandidatePrompt(tier, task,
  historyContext)` (`ensemble.ts:147`, called at `:348`) and `buildSynthesizerPrompt`
  (`ensemble.ts:176`, used at `:672`). Neither takes or threads `memoryContext`, an
  `IntentFrame`, or `partnerStyle`.

Consequence: a memory/intent implementation that edits only `buildPrompt` will inject memory
and intent on sequential and hedge turns but **silently NOT on panel turns** — the
highest-stakes, multi-model turns get *no memory, no intent frame, no partner posture*. That
is a coherence bug that ships quietly (no error, just worse panel answers, and a user who set
a preference sees it ignored exactly when the tool is working hardest). The partner doc's
"if they call buildPrompt internally" is technically true and therefore a no-op trap.

**Fix (must-do):** extend `buildPanelCandidatePrompt` and `buildSynthesizerPrompt` to take the
same optional `memoryContext` / intent / `partnerStyle` and render the same blocks; add a test
asserting a panel candidate prompt contains the memory block. Cheap, but invisible if not
named. The red-team missed this too (it verified `buildPrompt` citations but not the panel
divergence).

### 2.4 Duplication / two-writers-of-one-truth

- **partner doc vs memory doc schema.** Partner ships `MemoryConfidence='user_confirmed'`,
  `MemorySource`, `memory:'on'|'off'`, free-text subject; memory doc replaces all of these
  (trust tiers, `memory?:boolean`, closed-subject RC-1). The memory doc says it supersedes
  "the memory half" of partner — but partner is still in the corpus with the **old types and
  old retrieval prompt text**, and the intent/recap docs cite partner for the prompt-ordering.
  An implementer reading partner first will code dead schema. **Partner must carry a loud
  "memory sections SUPERSEDED — see memory-architecture-5.5.md" banner**, or the partner memory
  sections should be deleted.
- **Project-key derivation** is specified in *both* partner (§Storage) and memory §10 (with the
  red-team's git-toplevel correction). Memory §10 + RC-implied is the live version; partner's is
  stale (cwd-basename). One truth, two copies.
- **Retrieval algorithm** appears in partner (§Retrieval, the 5-prefs/8-project/12-cap shape)
  AND memory §7 AND red-team RC-3 (which *fixes* the cap math partner introduced). Three copies,
  only RC-3 is correct.

Net: the duplication is all *between the superseded baseline and its successors*, which is
benign IF the baseline is clearly retired. Right now it is not loud enough.

---

## 3. "Car Part → UFO Part" Upgrades (ranked by value)

Places a component is merely adequate where the whole deserves exceptional.

1. **Make panel/synth prompts first-class context citizens (architecture).** Highest value.
   Today `buildPanelCandidatePrompt`/`buildSynthesizerPrompt` are context-blind. Unify the
   prompt-assembly so memory/intent/partner context flows through ONE composition path
   (e.g. a shared `assembleContextBlocks(opts)` that both `buildPrompt` and the panel builders
   call). Turns three silent divergence points into one tested seam. (See §2.3.)

2. **One canonical "post-turn slot" state machine (architecture + determinism).** Promote the
   red-team Axis-9 ordering into a single pure, exported, table-tested function in the chat-ux
   layer: `decidePostTurn({ hasQuestions, hasMemoryProposal, queuedCount, interrupted }) →
   ordered actions`. Every doc references it instead of re-describing it. Removes the
   accidental-Save hazard and makes the spine deterministic and testable.

3. **Inject-time gate on memory (cost/quality), reusing the router classifier.** Red-team
   Axis-10 is right: 1200 chars of dated prefs on "what's 2+2" is pure dilution and quota burn
   on a subscription plan. Gate *preference* injection behind "real work request" using the
   already-present `routeClassifier`/`hasTierEvidence` (verified `router.ts:207`), always-ride
   constraints/identity. This is a UFO-grade efficiency win that costs almost nothing because
   the classifier already runs.

4. **Fold RC-1..RC-6 into the memory doc body (coding correctness/determinism).** The current
   "body says X, appendix overrides to Y" structure is a latent implementation bug: an engineer
   codes the body's `similarity>=0.45` contradiction gate (the exact thing RC-2 removes) unless
   they read to the very end. Inline the corrections so the executable spec reads correctly
   top-to-bottom.

5. **Audit-log rotation + clock-injection everywhere (reliability/testability).** `audit.jsonl`
   is unbounded (red-team Axis-11.2); decay uses wall-clock (Axis-11.5). Both are cheap: cap/
   rotate the log, thread the existing `Clock` port (the store already takes `clock`, verified
   `conversations.ts:227`) into every time read so decay/validTo are hermetic and deterministic.

6. **Recap/intent provider port parity (purity/fail-soft).** Intent nails the injected-port,
   fail-soft, cheapest-tier, timeout discipline (`route-classifier.ts` twin). Recap describes
   "a cheap worker-tier pass" but does not name the port or timeout. Make recap use the *same*
   injected provider seam with the same null-on-failure contract, so a failed recap is provably
   non-blocking (its own test 6 demands this).

7. **`MYSHELL_PLAIN` / `--no-anim` / NO_COLOR parity across ALL new glyphs (fail-soft UX).**
   Presentation handles this well for `●`; recap's `※` and any memory/intent notices must route
   through the *same* `out.color`/`out.isTty` gating (verified the seam exists, `theme.ts`
   gated helpers, `cli.ts:191`). One shared degradation path, not per-feature.

---

## 4. Subscription-Guardrail Audit (across all docs)

**Constraint:** subscription-auth (user OAuth), NOT API-key. No embeddings, no vector DB, no
separate metered service. Model calls must reuse the injected-port provider machinery, cost-
disciplined.

| Doc | Verdict | Evidence |
|---|---|---|
| memory-architecture | **PASS** | Explicitly "no embeddings/vector DB/metered service"; deterministic Jaccard retrieval, "NO LLM at query time"; consolidation is pure. The only model touch is the *model proposing* `remember_user` inside an existing turn — no extra call. Clean. |
| intent-engine | **PASS (exemplary)** | The whole doc is built on the subscription constraint; reuses `route-classifier.ts` injected-port verbatim, cheapest tier, gated so most turns make zero call, $0 marginal on flat-rate. The model of how to do it. |
| recap-feature | **PASS, with a gap** | Cheap cached worker-tier pass, regenerate only every ≥3 turns, background. BUT it must name the *injected subscription provider port* explicitly (it says "reuse the worker path" but doesn't pin the seam). No embeddings. No metered service. Acceptable; tighten wording. |
| chat-presentation | **PASS** | Pure chrome on existing events; zero model calls; explicitly drops Codex's `context-remaining` because "no reliable token-budget signal for subscription CLIs" — correctly honoring the constraint (Q5). |
| chat-ux | **PASS** | Pure input mechanics; no model calls. |
| partner | **PASS** | Prompt + config only; deterministic `deriveInitialVision`; no new infra. |

**No doc assumes an API key, embeddings, a vector DB, or a metered service.** The corpus is
disciplined here. The only thing to enforce at build time: the recap and intent model calls
MUST go through the same provider port the router uses (the docs say so; the test suite must
assert no `fetch`/SDK/API-key path is introduced — the existing `test/arch/guards.test.ts`
purity guard is the right place).

---

## 5. Memory v1.1 Soundness — Do RC-1..RC-6 Close the Red-Team Must-Fixes?

Cross-checking each binding correction against the red-team's MUST-FIX list and for internal
consistency:

| RC | Closes | Sound? | Residual |
|---|---|---|---|
| **RC-1** closed `subject` enum per `kind` | MUST-FIX 1 (A, Axis-1, 3b, 11.4) | **YES** | The enum must be *exhaustive enough* — an under-populated `SUBJECTS_BY_KIND` pushes everything to `other`, recreating free-text drift inside the `other` bucket. The doc says "unmappable → other" but never caps how much can land in `other`. Minor: add a test that two synonymous prefs map to the SAME subject, not both to `other`. |
| **RC-2** contradiction off `(scope,kind,subject)`, not Jaccard≥0.45 | MUST-FIX 2 (A, 3a) | **YES** | Correct and load-bearing. But the doc BODY (§4 step 3) still literally contains the `s>=0.45 && contradicts` code; RC-2 says remove it. Body and correction now contradict — implementer hazard (see §3.4). |
| **RC-3** score-then-fill within one 12/1200 budget, reserve ≥4 relevance slots | MUST-FIX 3 (B, Axis-2) | **YES** | Closes the 13>12 crowd-out. Internally consistent. One nit: "reserve ≥4 for relevance" + "always-includes ranked by score" needs a tie-break rule when relevance and always-include compete for the last slot; specify constraints/identity win. |
| **RC-4** whole-transaction `withLock`, read index INSIDE lock; scrub text+value+reason+post-merge | MUST-FIX 4 (Axis-5, 6) | **YES** | **Verified against code:** `conversations.ts:210` DOES read the index outside the lock (`readIndex` returns the `ok` result before `withLock`), so RC-4's TOCTOU claim and its "do NOT copy conversations.ts" instruction are CORRECT. `atomicAppendJSONL` is only ordered under a held lock (`atomic.ts:218-219`) — RC-4 correctly requires the audit append inside the lock. Sound and code-accurate. |
| **RC-5** decay-reset only on relevance-selected (not always-include) facts; `user_stated` constraints + `importance:3` decay-exempt | MUST-FIX 5 (E, Axis-7) | **YES** | Closes both the immortal-junk loop and the dying-hard-constraint case coherently. Consistent with RC-3 (relevance selection is now well-defined). |
| **RC-6** reject instruction-shaped text at the gate | MUST-FIX 6 (Axis-4 poisoning) | **YES** | Sound defense-in-depth behind the read-time footer. Residual: the predicate is heuristic; pair it with the §7 "treat as data" footer (kept) and approval — the doc does keep both. |

**Do they fully close the red-team?** The five (six) MUST-FIX items are each addressed and
internally consistent **as a set**. Verdict on v1.1: **sound.** Two residual issues, both
documentation-not-design:

1. **Body/appendix contradiction (real hazard).** §4 and §7 still print the *pre-correction*
   algorithm; RC-1/RC-2/RC-3/RC-5 override it in an appendix. The design is correct only if read
   to the end. **Fold the corrections into the body before implementation.** (Flagged in §3.4.)
2. **The red-team itself missed the panel-prompt injection bypass (§2.3).** So even "v1.1 +
   red-team" does not inject memory on panel turns. This is a NEW must-fix not in either doc.

Also still open (red-team's own "acceptable v1 risk", correctly deferred but worth a tracking
note): Jaccard relevance weakness, near-dup merge semantics, moved-repo project-key orphaning,
audit-log rotation, importance-downgrade-on-UPDATE, `/memory loaded` honesty on injection-gated
turns. None block v1; all are documented.

---

## 6. Big-Picture Gaps — What a 10/10 TOOL Needs That the Corpus Does NOT Cover

These are out-of-the-seven-docs' explicit scope but **gate a whole-tool 10/10**, because a 10
is the *tool*, not seven features.

1. **No onboarding / first-run design for the new surfaces.** The first time a user sees a
   memory approval prompt, an `INTENT` reflection, a `※ recap`, or "Waiting on 2 models" —
   there is no designed first-run explanation, no `/help` update plan that covers all four, no
   "memory is on; here's how to turn it off" moment. The auth-flow audit shows onboarding is a
   real, fragile surface (`runWelcome`, `menu.ts:1296-1405`); none of the seven docs touch it.
   **A 10/10 introduces these features to the user; this corpus assumes the user already knows.**

2. **No consolidated error / failure UX for the new features.** Each doc handles ITS failure
   (recap best-effort, intent fail-soft, memory store corrupt-recovery). But there is no
   cross-cutting answer to: memory store lock contention surfaced to the user? A `remember_user`
   approval mid-failure? Intent extractor timeout *visible* or silent? The GOLDEN-PLAN's own
   tenet is "error messages that teach" (`GOLDEN-PLAN.md:320`) — the new surfaces have no
   teach-on-failure design.

3. **No reliability/perf budget for the cumulative cost.** Intent adds ≤1 call on substantial
   turns; recap adds a cached call; memory adds retrieval I/O + injection tokens every turn.
   Individually disciplined; **no doc sums them.** On a quota-limited subscription, the combined
   per-substantial-turn overhead (intent call + memory injection + recap staleness check) needs
   one budget statement and one "if quota-pressured, shed in this order" policy.

4. **No story for the two chat surfaces diverging.** `repl.ts` is a real second chat surface
   (verified: pause/resume, AbortController, no ESC/queue — `repl.ts:50-101`). The chat-ux,
   presentation, and memory docs design for *menu chat*; the REPL gets a degraded subset.
   That's defensible, but no doc states "the REPL intentionally does not get queue/ESC/memory-
   approval" as a decision — it's just omitted. A 10 names the asymmetry.

5. **No migration/versioning story for stored artifacts together.** Memory `index.json`,
   conversation `recap` fields, config keys all forward-migrate individually (good, and the
   `normaliseMeta` pattern is verified at `conversations.ts:64-75`). But there's no combined
   "what happens to a user upgrading from 3.12.x with existing conversations" walkthrough.

6. **Core orchestration quality is assumed, not re-validated.** The corpus builds on
   `orchestrate.ts`/`router.ts`/`ensemble.ts` as sound. They largely are (the code is clean and
   well-commented). But the panel-prompt-divergence bug (§2.3) shows the docs didn't fully audit
   the orchestration surface they're extending. A 10 would include an "orchestration extension
   points" map so every new context consumer is wired at every executor.

None of these are reasons the *designs* are wrong. They are reasons the *tool* is not yet a 10:
a 10/10 product ships onboarding, failure UX, and a cost budget for what it adds.

---

## 7. Unified Master Implementation Plan (dependency-ordered, conflict-free)

One sequence merging all seven docs, coexisting with the 3.12.x stdin work. Each phase is
independently shippable and testable. Files in **bold** are the high-collision ones.

**Phase 0 — Land the chat-ux refactor FIRST (unblocks everyone).**
Why first: four docs add command dispatch / selectors into `runChatLoop`. Do chat-ux's Phases
1–4 now (pure helpers → `createLineReader.beginCapture` → ESC listener → **refactor
`runChatLoop` into `runOneChatInput` + the post-turn slot**). Promote the red-team Axis-9
ordering into a single exported `decidePostTurn` here.
Touches: **`menu.ts`** (input internals), `types.ts` (`LineReader`), tests.
Coexists with 3.12.x: this IS the 3.12.x-adjacent work; obey suspend/resume single-owner rules.

**Phase 1 — Presentation chrome (zero core risk, visible win).**
Presentation steps 1–3a–3c: `theme.ts turnMarker()`, `spinner.elapsed()`, assistant `●`,
completion dots. Defer panel "Waiting on N" + the Q4 `phase` event to Phase 6.
Touches: `theme.ts`, `spinner.ts`, **`render.ts`**.

**Phase 2 — `BuildPromptOptions` canonical extension + partner posture (the ONE prompt-API
change).** Partner doc lands `BuildPromptOptions { goalTurn?, partnerStyle?, memoryContext? }`
ONCE, plus the shared `assembleContextBlocks` seam that `buildPrompt` AND the ensemble panel/
synth builders call (closes §2.3 before any consumer exists). Persona rewrite, `ASKING THE
USER` "genuine fork" text, `partnerStyle` config + `/style` + Settings + resolver.
Touches: **`prompt.ts`**, **`ensemble.ts`** (the unification), `questions.ts` (comment), `config.ts`,
`types.ts` (`OrchestrateDeps.partnerStyle`), **`orchestrate.ts`** + `hedge.ts` (thread it),
**`menu.ts`** (deps-assembly + `/style`), `cli.ts`.
Critical: this phase is where the panel-prompt seam gets fixed for everyone downstream.

**Phase 3 — Memory pure core + store (no UI).** Memory Phases 1–3 with RC-1..RC-6 folded into
the body. New `src/core/user-memory.ts` (gate, closed-subject consolidation per RC-1/RC-2,
score-then-fill retrieval per RC-3, decay per RC-5, instruction-scrub per RC-6, multi-field
secret scrub per RC-4); new `src/infra/user-memory-store.ts` (whole-transaction `withLock`
reading index INSIDE the lock per RC-4, audit append inside lock, rotation, `Clock`-injected);
config keys.
Touches: new files only + `config.ts`. Zero collision.

**Phase 4 — Memory injection (consumes Phase 2's seam).** Thread `memoryContext` through
`assembleContextBlocks` (already exists from Phase 2 → covers sequential, hedge, AND panel).
Add the inject-time gate (§3.3) reusing `routeClassifier`. Select+inject per turn in
`buildDeps`.
Touches: `orchestrate.ts` (pass `deps.memoryContext`), **`menu.ts`** (deps-assembly), `cli.ts`.

**Phase 5 — Memory commands + model-proposed memory.** `/remember`, `/forget`, `/memory[ all/
edit/export/loaded]`, CLI subcommands; `remember_user` inside the confidence envelope; render
strip (`remember_user` → `CONTROL_ENVELOPE_KEYS`); approval selector wired into the **Phase 0
post-turn slot** (memory approval runs after queue-discard, before queue-drain — the Axis-9
rule). `CoreEvent.final.memoryProposal`.
Touches: **`menu.ts`**, `render.ts`, `prompt.ts` (capture instr), `assess.ts` (no-op, verify),
`orchestrate.ts`, `types.ts`, new `src/commands/memory.ts`.

**Phase 6 — Intent engine.** Intent Phases I–IV: pure `intent.ts`, `intent-extractor.ts` (twin
of `route-classifier.ts`), gate, stage in `orchestrate.ts:255-281`, INTENT block via
`assembleContextBlocks` (covers panel too), work-contract seed swap, ask_user derivation,
memory-query keying on `frame.goal`. Config + Settings.
Touches: new files + `orchestrate.ts`, `prompt.ts`, `types.ts`, `work-contract.ts`, infra/config.
Depends on: Phase 2 (prompt seam), Phase 4 (memory query to key on goal).

**Phase 7 — Recap.** Recap Phase 1–2: pure `recap.ts`, `ConversationMeta` recap fields +
`setRecap`, replace the tail-echo at `menu.ts:2347` (verified that's the weak line), `/recap`,
richer Recent list. Use the same injected provider port (parity with intent). Defer Phase 3
(recap→compaction) — gated.
Touches: `conversation-store.ts`, `conversations.ts`, new `recap.ts`, **`menu.ts`**, `render.ts`/`theme.ts`.

**Phase 8 — Presentation panel "Waiting on N" + Q4 `phase` event + markdown (Q1).** Now that
intent/memory are stable, add the panel state machine (prefer the explicit `phase` CoreEvent
over notice-sniffing), the composition header in normal mode, interrupt-hint wording, optional
inline markdown.
Touches: **`render.ts`**, `types.ts` (`phase` event), `ensemble.ts`/`orchestrate.ts` (emit phase).

**Phase 9 — Whole-tool finish (the §6 gaps).** Onboarding/first-run for all four features,
unified error/teach-on-failure UX, the cumulative cost-budget + quota-shed policy, REPL-
asymmetry decision documented, combined upgrade-migration test.

Dependency spine: **0 → 2 (prompt seam + panel fix) → 3 → 4 → {5,6} → 7 → 8 → 9.** Phase 1 is
parallel-safe anytime. Phase 2's `assembleContextBlocks` unification is the linchpin that makes
4/5/6 coherent across all three executors.

---

## 8. Honest GO / NO-GO

**Overall score: 8.4 / 10. Verdict: CONDITIONAL GO** — approved to *begin implementation in the
Phase 0→2 order*, NOT approved as a stamped 10/10 design-complete corpus. A professional lead
would not put their name on "10/10, 100% confidence" today, primarily because of the
panel-prompt context bypass (a real, silent coherence bug the corpus actively mis-states) and
the absence of a single conflict-resolved build order.

### Must-fix BEFORE implementation (the short list)

1. **Fix the panel/synth prompt context bypass.** `buildPanelCandidatePrompt` /
   `buildSynthesizerPrompt` (`ensemble.ts:147,176`) must receive and render the same memory /
   intent / partnerStyle context as `buildPrompt`, via one shared `assembleContextBlocks` seam.
   Without this, memory/intent/posture silently vanish on panel turns. (§2.3 — *not in any doc*.)
2. **Fold RC-1..RC-6 into the memory doc body.** The executable spec currently reads as the
   pre-red-team algorithm with an overriding appendix; an implementer will code the wrong
   contradiction gate. Make the body correct top-to-bottom. (§3.4, §5.)
3. **Promote the post-turn ordering (red-team Axis-9) into the chat-ux mechanics doc as the one
   canonical `decidePostTurn` sequence,** and route memory-approval + question-flow + queue-
   drain through it. Closes the accidental-Save / capture-exclusivity hazard. (§2.1.)
4. **Name the canonical owner + order of the shared file edits** — `BuildPromptOptions`
   extended once (partner), `CoreEvent` union extended once, `menu.ts` refactored (chat-ux
   Phase 0) before any command additions. Adopt the §7 phase sequence as binding. (§2.2.)
5. **Loudly retire the partner doc's memory half + stale schema/project-key/retrieval
   duplication,** so no one implements `user_confirmed` / cwd-basename keys / the broken cap
   math. (§2.4.)

(Nice-to-have, not gating: inject-time memory gate for cost, audit-log rotation, recap provider-
port wording, `MYSHELL_PLAIN` parity for new glyphs, the §6 onboarding/error/budget items —
real, scheduled for Phase 9, but they don't block starting.)

### Single biggest risk to stamping 10/10 on the whole tool

**The silent panel-prompt context bypass (§2.3).** It is the one defect that is (a) a real bug,
not a polish item; (b) *invisible* — it ships with no error, just degraded answers on the most
expensive multi-model turns and a user whose stated preference is ignored exactly when it
matters most; and (c) actively *mis-stated* by three of the seven docs ("thread into all
buildPrompt calls" / "if they call buildPrompt internally"), so an implementer following the
docs faithfully will reproduce it. Until the prompt-assembly is unified through one tested seam
and a test asserts a panel candidate prompt carries the memory/intent blocks, the whole tool
cannot honestly be called coherent — and a 10/10 demands coherence, not seven features that
each work alone.
