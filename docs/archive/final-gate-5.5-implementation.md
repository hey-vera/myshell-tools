# Final Gate — 5.5 "World-Class Chat" IMPLEMENTATION re-gate

**Scope:** the BUILT, RUNNING tool (commits `745bc29..HEAD` on `main`), not the design.
**Mandate:** find the cross-phase integration bugs, incoherence, or unfaithfulness the
per-phase unit gates missed — verify the 10 phases COMPOSE into one correct product.
**Constraint honored:** review/design only — no `src/` or `test/` edits.
**Already-verified inputs used (not redone):** full gate green; the orchestrator's
`memory add → memory list` round-trip. I independently re-ran the arch/purity guard +
the key integration unit suites + a full typecheck (see §6).

---

## 1. End-to-end turn trace (a substantial chat turn, all features ON) — file:line

The single per-turn spine, traced through the REAL code:

1. **Input + capture.** `runOneChatInput(line)` → `runTaskWithInputHooks`
   (`menu.ts:3121`) arms two scoped hooks for the turn:
   - typed-ahead queue via `lineReader.beginCapture` → `queuedTurns.push` (`menu.ts:3132`);
   - the bare-ESC listener via `attachChatTurnKeyListener` (`menu.ts:3140`), whose
     `onEscape` sets `interruptedByEsc = true` and calls `currentAc?.abort()`
     (`menu.ts:3143-3144`). Both detach in the `finally` (`menu.ts:3150-3151`).
2. **Per-turn memory resolve.** `const deps = buildDeps(priorHistory, await resolveTurnMemory(line))`
   (`menu.ts:3941`). `resolveTurnMemory` (`menu.ts:3650`) → `resolveMemoryContextDetailed`
   (`memory-injection.ts:133`): sweep-once-per-session, `listAll`, **inject-gate**
   (`applyInjectGate` — identity/constraint always ride, prefs gated on `hasTierEvidence`,
   `memory-injection.ts:72/161`), `selectRelevant` (score-then-fill, RC-3), `markUsed`
   relevance-selected ids (RC-5), `renderMemoryContext`. Fully fail-soft (`.catch → ''`).
   The rendered block is threaded onto `deps.memoryContext` (`menu.ts:3599`).
3. **Route.** `orchestrate` (`orchestrate.ts:287`) → `decideRoute` → `{tier,risk,plan}`
   (`orchestrate.ts:298-307`); `yield {type:'classified'}`.
4. **Intent stage (gated, fail-soft, the ONE added blocking call).** `shouldExtractIntent`
   gate (`orchestrate.ts:333`); on a substantial/ambiguous turn with an injected
   `intentExtractor`, `await depsArg.intentExtractor(task, signal)` (`orchestrate.ts:343`)
   — the extractor (`intent-extractor.ts:48`) routes worker-tier, read-only sandbox,
   caller-capped timeout, through the **injected provider port** (no fetch/SDK/API-key),
   `parseIntentFrame`, **null on ANY failure** → `rulesIntentFrame` fallback
   (`orchestrate.ts:347`). Trivial/no-extractor → deterministic `source:'skipped'` frame
   (`orchestrate.ts:351`).
5. **APE.** `planEngagement({frame, classification, routePlan, engagementBias:
   engagementBiasOf(partnerStyle), task})` (`orchestrate.ts:353`) — PURE, no model call,
   `engagement.ts:261`. Fast-path → `[EXECUTE_NOW] depth:0` (`engagement.ts:278`);
   safety floor (irreversible∧ambiguous → DISCUSS + ≤1 ask, beats bias, `engagement.ts:300`);
   bias-shifted thresholds (`engagement.ts:306-315`); ASK_CAP=1 (`engagement.ts:79`).
6. **Block pre-render + per-turn deps copy.** `renderIntentBlock`/`renderEngagementBlock`
   once (`orchestrate.ts:364-365`); render-optional `{type:'intent'}` / `{type:'engagement'}`
   yielded ONLY when the block is non-empty (visible action) (`orchestrate.ts:372-377`);
   a per-turn `deps` copy carries `intentFrame`/`engagementPlan` strings
   (`orchestrate.ts:379-386`). This copy is what the panel/hedge branches below receive.
7. **Compose + run — ALL THREE executors via the one seam (MF1).**
   - Sequential: `buildPrompt(..., {goalTurn?, partnerStyle?, memoryContext?, intentFrame?,
     engagementPlan?})` (`orchestrate.ts:648-660`) → `assembleContextBlocks(opts)` inserted
     AFTER system, BEFORE "CONVERSATION SO FAR" (`prompt.ts:347-352`).
   - Panel: `runPanel` (reached at `orchestrate.ts:467`) → `runCandidate` →
     `buildPanelCandidatePrompt(..., contextFromDeps(deps))` (`ensemble.ts:385-389`) →
     `assembleContextBlocks` (`ensemble.ts:189`); synthesizer
     `buildPanelSynthesisPrompt(..., synthContext)` (`ensemble.ts:721-724`) →
     `assembleContextBlocks` (`ensemble.ts:235`). `contextFromDeps` (`ensemble.ts:154`)
     derives the SAME `ContextBlockOptions` from the per-turn deps copy.
   - Hedge: `runAttempt` → `buildPrompt(..., {…memoryContext, intentFrame, engagementPlan})`
     (`hedge.ts:262-273`).
   Block order MEMORY → INTENT → ENGAGEMENT → partner-nudge is canonical and single-sourced
   (`prompt-context.ts:107`). **Verified: panel candidate AND synthesizer are no longer
   context-blind.**
8. **Render.** `● ` streaming marker before first prose (`render.ts:671`); panel "Waiting
   on N models" / "Synthesizing N" state machine driven by the typed `{type:'phase'}` event
   + real `tier-done`s, not string-sniffing (`render.ts:595-616`, `spinnerLabel`
   `render.ts:505`); `remember_user` stripped from prose via `CONTROL_ENVELOPE_KEYS`
   (`render.ts:158`); `{type:'intent'}`/`{type:'engagement'}` have NO render case →
   silently ignored (render-optional, as the locked default mandates).
9. **Settle → post-turn.** `runPostTurnSlot(result.final, …)` (`menu.ts:4086`) computes
   `hasQuestions`/`hasMemoryProposal` (`menu.ts:3169-3181`) and calls `decidePostTurn`
   (`menu.ts:941`): `discard-typeahead` (always, before any selector) → `question-flow`
   XOR `memory-approval` → `drain-queue` (only when NOT interrupted AND NOT a question).
   `memory-approval` runs `runMemoryApproval` through the injected `readLine`
   (`menu.ts:4110`), never the raw menu input internals.

**Verdict on the trace:** the data genuinely flows MEMORY+INTENT+ENGAGEMENT+partner →
all three executors → render → settle → post-turn. The per-turn budget/order/fail-soft
contracts hold with every feature on at once (§3). The composition is correct.

---

## 2. Integration-bug findings (each: real? severity? fix)

### F1 — Model-proposed memory (`memoryProposal`) is sequential-path-only; panel & hedge never propose. — REAL, LOW
`memoryProposalFor` (`orchestrate.ts:104`) is attached to the sequential finals
(`orchestrate.ts:1167, 1207, 1305`) but **neither `runPanel` nor `runHedged` emits a
`memoryProposal`** (greped both files — zero occurrences; panel final `ensemble.ts:843`,
hedge final `hedge.ts:772`). So on a panel/hedge turn the model could end with a
`remember_user` block and it is silently dropped (and, because `render.ts` strips the
block, the user never even sees it).
- **Severity LOW:** memory *injection* (the load-bearing half) DOES cover all three
  executors via MF1; only the *capture* asymmetry exists. Panel/hedge are EXPERIMENTAL,
  opt-in, default-OFF. The design docs explicitly require injection-on-panel (closed) but
  are silent on proposal-from-panel, so this is not a spec violation — it's an
  acceptable-v1 asymmetry. No data loss of *saved* memory; only an un-offered proposal.
- **Fix (v1.1):** route panel/hedge success finals through `memoryProposalFor(output)` the
  same way orchestrate does (one line each at `ensemble.ts:843` and `hedge.ts:772`). Cheap,
  isolated, and would close the asymmetry. Not a stamp blocker.

### F2 — `discard-typeahead` notice reason mislabels a memory-proposal turn as "interrupt". — REAL, COSMETIC
In `runPostTurnSlot` the discard reason is `hasQuestions ? 'question' : 'interrupt'`
(`menu.ts:3193`), and the discard fires when `hasMemoryProposal` is true
(`menu.ts:3198`). So on a clean memory-proposal turn that had typed-ahead lines, the
dropped-queue notice says "interrupt" though nothing was interrupted.
- **Severity COSMETIC:** wrong word in a rare notice; no behavioral effect. The discard
  itself is correct (a queued "1" must not auto-answer the Save/Skip selector).
- **Fix:** add a `'memory'` reason branch (`hasQuestions ? 'question' : hasMemoryProposal
  ? 'memory' : 'interrupt'`). Not a blocker.

### F3 — Budget doc says recap is a "background (non-blocking)" added call; in the build it is `await`ed. — REAL but NOT a budget violation, DOC-NUANCE
`resolveRecap` (`menu.ts:2975`) generates via a worker-tier model call (`menu.ts:3005`)
and is `await`ed on resume (`menu.ts:3044`) and on `/recap` (`menu.ts:3396`). The
`CAPABILITY_BUDGET` labels recap `addedBackgroundCalls` (`capability-budget.ts:43-80`).
- **Why it is NOT a per-turn budget breach:** recap runs ONLY on resume (before the turn
  loop) and as a standalone `/recap` command — **never on an answer turn's path**. So the
  "≤1 added blocking call per turn" invariant (the intent pass) is intact: I confirmed no
  answer-turn code path triggers recap. The "background" wording is about *resume
  orientation cost*, not the answer turn; it's loose phrasing, not a defect in the cap.
- **Severity DOC-NUANCE:** the enforced invariant (one blocking call = intent) holds; the
  label could read "resume-time, off the answer path". Not a blocker.

### F4 — No integration bug found in the MF1 / MF3 / single-owner seams. — VERIFIED CLEAN
- **MF1:** `assembleContextBlocks` is the *only* path; `buildPrompt`, both panel builders,
  and hedge all call it; partner posture is applied EXACTLY ONCE (`promptForMode` consumes
  only `goalTurn`, `prompt.ts:302-303` — no double-nudge with `partnerNudge`).
- **MF3:** mutual exclusivity is airtight end-to-end: orchestrate's question path returns
  *before* `memoryProposalFor` is ever computed (`orchestrate.ts:793-808`), so a final can
  never carry both; `runPostTurnSlot` additionally requires `questions === undefined` for
  `hasMemoryProposal` (`menu.ts:3179`); `decidePostTurn` emits at most one selector
  (`menu.ts:947-951`). A queued line can never answer a selector (`discard-typeahead`
  always precedes both).
- **MF4 single-owners:** `BuildPromptOptions extends ContextBlockOptions` once
  (`prompt.ts:287`); the `CoreEvent` union carries intent+engagement+phase+memoryProposal
  in ONE coordinated edit (`types.ts:451-579`); `OrchestrateDeps` carries
  partnerStyle/memoryContext/intentFrame/engagementPlan once (`types.ts:345-368`).

---

## 3. Per-turn budget / order / fail-soft when ALL features on

- **≤1 blocking added call:** the intent extractor is the single gated blocking call
  (`orchestrate.ts:343`). APE adds none (pure). Memory adds none (deterministic retrieval).
  Recap is off the answer path (F3). `MAX_ADDED_BLOCKING_CALLS = 1`
  (`capability-budget.ts:89`) is enforced as data + asserted by tests. **Holds.**
- **Quota-shed ladder** (`decideShed`, `capability-budget.ts:152`) is wired live: rung 1
  drops recap refresh (`menu.ts:2992`), rung 2 narrows memory to identity-only
  (`menu.ts:3657` → `resolveMemoryContextDetailed` `identityOnly`, `memory-injection.ts:161`),
  rung 3 skips the intent pass (`menu.ts:3558` gates `intentExtractor` on
  `shedPlan.intentPass`). Core answer never shed. Order matches the spec exactly.
- **Fail-soft holes:** none found. Intent extractor → null → rules; memory resolve →
  `''`; recap → cached/null, never blocks resume (`menu.ts:3046`); APE `planEngagement`
  is total and degrades a garbage signal to `source:'fail-soft' [EXECUTE_NOW]`
  (`engagement.ts:263`).

---

## 4. Faithfulness + subscription-guardrail audit

- **Vision-first ADAPTIVE partner — FAITHFUL.** Judgment is per-turn and bounded:
  fast-path beats bias both ways; safety floor (irreversible∧ambiguous → discuss/ask) beats
  bias and is unconditional (`engagement.ts:300`); depth-2 reachable only on
  stakes∧scope∧ambiguity (`engagement.ts:333`); ASK_CAP=1. `partnerStyle` is a true soft
  bias (`engagementBiasOf` → `±1` threshold shift), never a hard mode.
- **Memory smart-not-hoarder — FAITHFUL.** RC-1..RC-6 are enforced in the LIVE path:
  closed-subject `normalizeSubject` (RC-1), `(scope,kind,subject)` contradiction not Jaccard
  (RC-2), score-then-fill with reserved relevance slots (RC-3), multi-field `isSecret` scrub
  (RC-4, `user-memory.ts:384`), decay-exempt + relevance-only reset (RC-5),
  `isInstructionShaped` reject (RC-6, `user-memory.ts:385`). The model-proposed path runs
  every fact through `worthGate` BEFORE it can even surface as a proposal
  (`orchestrate.ts:107-120`) — APE advice is advisory only; the gate is independent.
- **The feel — FAITHFUL.** `●` is semantic (cyan streaming → outcome-coloured completion,
  `render.ts:671/893`); "Waiting on N" derives from the real `{type:'phase'}` panel event +
  real `tier-done`s (`render.ts:595-616`), never fabricated; `※ recap` replaces the old
  tail-echo (`menu.ts:3048`).
- **Subscription guardrail — INTACT.** No API key / embeddings / vector DB / metered
  service. Intent + recap reuse the injected provider port (`intent-extractor.ts:85`,
  `recap-generator.ts`); `addedDollars: 0` is a typed invariant
  (`capability-budget.ts:47`). The arch/purity guard suite passes (§6).

---

## 5. Runtime risks (TTY / Replit)

- **Raw-mode single owner after 5 phases touched `menu.ts` — INTACT.**
  `attachChatTurnKeyListener` (`menu.ts:1364`) adds exactly one `keypress` listener and
  removes ONLY that listener (`menu.ts:1411`), never `removeAllListeners`, never opens
  `/dev/tty` mid-turn, never `suspend`/`resume`; it restores only the raw-mode state it
  changed (`menu.ts:1414`). Off-TTY it degrades to a no-op detach (`menu.ts:1371`). This
  honors the 3.12.x single suspend/resume-owner contract that the prior relaunch fix
  established.
- **ESC vs in-flight intent/recap — SAFE.** The intent extractor receives the turn's
  `signal` (`orchestrate.ts:343`); an ESC abort (`currentAc.abort()`, `menu.ts:3144`)
  cancels it → null → rules fallback → the main loop's pre-stream abort check
  (`orchestrate.ts:192`) ends the turn cleanly. Recap uses a *fresh* `AbortController`
  (`menu.ts:3005`) and runs off the answer path, so ESC during a turn cannot touch it and
  recap cannot wedge a turn.
- **No silent no-op feature found.** Intent default-ON-gated, memory default-ON,
  presentation always-on; panel/hedge default-OFF by design (`planPanel`/`planHedge` return
  null unless opted in). All confirmed wired through `buildDeps`.

---

## 6. Re-verification I ran (Node 22, the project's own runner)

- `test/arch/**` + `prompt-context` + `engagement` + `menu-flow`: **666 / 0 fail.**
- `intent-orchestrate` + `intent-extractor` + `intent` + `engagement` + `ensemble*`:
  **108 / 0 fail.**
- `tsc --noEmit`: **clean (exit 0).**
These corroborate the orchestrator's green gate on the integration-critical suites.

---

## 7. Residuals (deferred — confirmed clean, NOT half-wired)

- **§10 `isSensitive` content-classifier:** deferred; the heuristic `isSecret`
  (`user-memory.ts:242`) is the wired v1 backstop (scans text+value+reason, RC-4). The
  richer classifier is absent, not stubbed. Clean.
- **recap → compaction bridge:** not wired; recap is a standalone orientation surface with
  its own provider call + null-on-failure contract. No half-edges into `history.ts`. Clean.
- **smart-Tab T2–T4:** only T1 (`completeSlash`, `menu.ts:545`) is built — scoped to
  slash-commands, no shell-style word completion. T2–T4 absent, not half-wired. Clean.
- Documented heuristic ceilings (Jaccard tie-break not recall; APE lexicon false-negatives
  guarded by the safety floor; moved-repo project-key orphaning) — all acceptable v1.

---

## 8. Verdict

The 10 phases COMPOSE into one correct product. The MF1 prompt seam genuinely covers
sequential + hedge + panel; MF3 post-turn ordering and selector mutual-exclusivity are
airtight end-to-end; the single-owner rules (BuildPromptOptions, CoreEvent union,
OrchestrateDeps, the mid-turn key listener) held across all five phases that touched the
shared files. The per-turn ≤1-blocking-call budget, the quota-shed ladder, and the
fail-soft contracts all hold with every feature on at once. The subscription guardrail is
intact in the built code. The adaptive-partner vision and smart-memory discipline are
faithfully realized, not just designed.

The only findings are: one LOW asymmetry (F1 — panel/hedge don't *propose* memory, though
they *inject* it; experimental opt-in paths only), one cosmetic notice-wording nit (F2),
and one doc-label nuance that is not an actual budget breach (F3). None blocks a stamp; all
are clean v1.1 follow-ups.

**Overall score: 9.7 / 10.**
**STAMPABLE: YES** (acceptable-v1 residuals: F1 panel/hedge memory-proposal asymmetry,
F2 discard-notice wording, F3 recap budget-label nuance, plus the three deferred items in §7).
**Top must-fix items: none are blockers.** Highest-value v1.1 follow-up: F1 (one line each
in `ensemble.ts`/`hedge.ts` to thread `memoryProposalFor` so the experimental multi-model
paths can also propose memory).
**Single biggest remaining risk:** the experimental panel/hedge paths (default-OFF) are
the least-exercised at runtime — they correctly inject context but skip memory-proposal
(F1); if a user enables them, durable memory capture quietly narrows to the model's own
in-conversation `remember` requests on the sequential path only. Low blast radius today
(opt-in, default-OFF), but it is the one place the otherwise-uniform feature coverage is
asymmetric.
