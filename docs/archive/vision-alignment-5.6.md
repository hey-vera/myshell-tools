# Vision Alignment 5.6

North-star under audit:

> one chat to rule them all - it boils everything down into ONE chatting surface. The user chats and gets work done with amazing coherence, performance, intelligence, quality of work and beyond - behaving and responding like a real elite pro would.

Scope: hard alignment/gap audit for Item 17, Item 10, Item 11, Item 12, Item 13, and Item 8k. This is not a rewrite of the roadmap.

## 0. Source Reality Skim

The repo already has meaningful organs:

- Verification and trust: `src/core/verify.ts`, `src/core/accept-stage.ts`, `src/core/trust-receipt.ts`, `src/interface/ui/verify-flag.ts`, `src/interface/ui/truly-complete-flag.ts`.
- Turn state and continuity: `src/core/work-state.ts`, `src/core/work-contract.ts`, `src/core/history.ts`, `src/core/orchestrate-memory.ts`, `src/core/native-session.ts`, provider `sessionId/resume` ports.
- Provider surface: `src/providers/registry.ts`, `src/providers/detect.ts`, `src/core/model-capabilities.ts`, `src/core/model-capability-refresh.ts`, `src/core/surface-capabilities.ts`.
- Goals: `src/core/goal.ts`, `goal-manager.ts`, `goal-steward.ts`, `scheduler.ts`, `decompose.ts`, `goal-todo.ts`, plus UI seams in `src/interface/menu.ts`, `menu-goal-review.ts`, `auto-stage.ts`.
- UI/input: one huge `src/interface/menu.ts` still owns too much: dependency construction, provider refresh, chat loop, goal activation, menus, startup, and rendering bridges.

The shape is advanced but not yet one coherent authority. There are many partial receipts and flags; the missing thing is binding: every user intent, work unit, provider action, verification result, resume attempt, and goal transition must refer to the same durable truth.

## 1. Do The Current Items Compose Into The Vision?

Short answer: yes as a control spine, no as the full "elite pro" product behavior.

They compose into a credible backbone:

- Item 8/8k gives one semantic interpretation surface for nontrivial turns.
- Item 5 gives one authoritative execution plan.
- Item 9 gives one model-call ledger.
- Item 17 should give one completion truth.
- Item 10 should give one execution/resume state machine.
- Item 11 should give one durable provider-neutral context/event substrate.
- Item 12 should give one provider/capability snapshot authority.
- Item 13 should give one goal stewardship lifecycle over all of that.

That is the right skeleton for "one chat." It reduces fragmented routing, scattered evidence, stale provider facts, fake done states, and orphaned goals.

But it is not sufficient for "behaves like an elite pro." The queue is mostly infrastructure correctness. It does not yet guarantee:

- the assistant preserves the exact accepted intention across many turns and corrections;
- the assistant knows when to ask, act, park, verify, or proactively resume;
- the delivered answer/work product is polished, scoped, and self-reviewed, not just technically completed;
- the chat feels fast, calm, and continuous while startup probes, recap, capability refresh, and background work happen.

### Item 8k - Semantic Preflight Default-On

Present:

- Item 8 has a strong dark contract: one semantic call for nontrivial turns, trivial bypass, deterministic risk floor, evidence obligations, evaluation gate, explicit rollback.
- Code exists: `src/core/semantic-preflight.ts`, extractor, evidence investigation, flag helper, eval harness.

Missing:

- Default-on semantic preflight improves intent capture, but by itself it can only create obligations. It cannot settle completion, durable intent, or exact resume.
- It may make the product feel smarter while still leaving "done" and "next" as scattered claims unless Item 17/11 bind the result.

Verdict:

- Promote only through the existing 8k eval and human gate.
- Do not treat 8k as the vision leap. It is an input contract, not a professional-delivery contract.

### Item 17 - Verification To Completion

Present:

- `verify.ts` has honest four-state verification: `unverified`, `reviewed`, `passing`, `failing`.
- `accept-stage.ts` and `trust-receipt.ts` already surface evidence without fabricating passes.
- `work-state.ts` conservatively derives `verifiedDone` from persisted work traces.

Missing:

- No versioned `CompletionResult` is the single terminal truth across chat, goals, resume, and UI.
- Dirty worktree baseline, concurrent changes, pre-existing user edits, no-test states, repair/retest policy, and non-code factual claims are not a unified completion contract.
- Current UI can still show command completion or goal progress in ways that feel stronger than the evidence.

Vision fit:

- Mandatory. This is the difference between a helpful tool and a pro that knows what is actually done.

### Item 10 - Exactly-Once Execution/Resume

Present:

- Native provider sessions exist for Claude/Codex/Grok at the adapter level.
- Scheduler and goal paths have partial retry/backoff/cooldown logic.
- Provider request metadata has `sessionId` and `resume`.

Missing:

- No durable work-unit state machine owns `parked -> claimed -> provider-started -> mutation-observed -> verifying -> settled`.
- No idempotency/CAS protocol distinguishes replay-safe from replay-forbidden after opaque subprocess mutation.
- Retry-After and provider cooldown are not reliable durable evidence across crash/resume.

Vision fit:

- Mandatory for trust. A pro does not double-run destructive work, lose partial work, or blindly retry after a crash.

### Item 11 - Durable Provider-Neutral Context

Present:

- Session history, work traces, recaps, memory, native-session planning, and provider session IDs exist.
- `work-state.ts` can reconstruct a truthful state snapshot from accepted turns.

Missing:

- No append-only canonical event log with versioned snapshots and invalidation rules.
- No provider-neutral reconstruction rule that proves a switch from Claude to Codex/Grok/OpenCode preserves the open loop.
- No bounded 500-turn cold-resume story that keeps context lean rather than dumping everything into each turn.

Vision fit:

- Mandatory for "one chat." Without it, the chat is a transcript plus heuristics, not a durable relationship.

### Item 12 - Async Startup And Provider Registry

Present:

- `providers/registry.ts` builds installed and authenticated provider maps.
- `model-capability-refresh.ts` merges declarative, detect, Codex cache, and OpenCode verbose facts.
- `menu.ts` memoizes some capability refresh state.

Missing:

- No single immutable provider/capability generation with subscription, invalidation, and route reaction semantics.
- Login/logout and slow probes can still leave stale or blocking behavior.
- Capability facts are not uniformly consumed by all executors.

Vision fit:

- Mandatory for feel and correctness. The product cannot feel like one elite surface if startup/probes block or if alternate execution paths route on stale capability facts.

### Item 13 - Goal Stewardship / Multi-Goal DAG

Present:

- Goals, goal store, scheduler, decompose, goal manager, and deterministic goal steward exist.
- UI seams can display active/parked/running/blocked goal state.

Missing:

- Goal lifecycle does not yet use one durable execution id from intent through verification and settlement.
- Stale parked/running goals are audited but not owned as a live stewardship loop.
- Multi-goal DAG completion evidence, cancellation ownership, and revalidation before launch are not one contract.

Vision fit:

- Necessary but should be downstream. If it lands before completion/resume/context, it risks making the product busier without making it more professional.

## 2. Missing "Elite Pro" Items

These are the 2-4 biggest gaps not covered by the current item set.

### Candidate Item 18 - Intent Continuity And Correction DAG

Scope: Version every accepted user intent, bind turns/goals/work units/completion to that intent version, and support correction/fork from the divergence point without losing valid work.

Why not covered: Item 11 stores provider-neutral context, but context is not the same as accepted intention. Item 13 manages goals, but goals born from wrong or superseded intent need lineage.

### Candidate Item 19 - Ask-Vs-Act Judgment Policy

Scope: Define the runtime decision contract for when the assistant answers, asks one clarifying question, executes, parks a goal, resumes stale work, escalates risk, or says no.

Why not covered: Item 8 classifies intent; Item 5 plans calls; Item 13 stewards goals. None defines the professional judgment boundary that makes the assistant feel like an elite collaborator rather than a clever automation engine.

### Candidate Item 20 - Delivery Quality Gate

Scope: Add a final response/work-product quality contract: self-review against user intent, evidence, style, completeness, and next-step usefulness before the answer is shown or the goal is settled.

Why not covered: Item 17 verifies reality. It does not ensure the final communication is scoped, crisp, complete, non-overclaiming, and useful. A passing test suite can still ship a weak answer.

### Candidate Item 21 - Latency And Feel Budget

Scope: Make responsiveness a first-class contract: instant prompt availability, nonblocking provider/capability probes, bounded pre-answer calls, progressive receipts, p95 targets, and cancellation semantics.

Why not covered: Item 12 helps startup, Item 8/5/9 meter calls, but no item owns the felt experience of one fast chat surface.

## 3. Corrected Contract/Build Order

### Recommended order

1. Item 17 - Verification to Completion.
2. Item 11 - Durable Provider-Neutral Context.
3. Item 12 - Async Startup and Provider Registry.
4. Item 10 - Exactly-Once Execution/Resume.
5. Item 13 - Goal Stewardship / Multi-Goal DAG.
6. Item 8k - Default-on semantic preflight promotion, only after its eval artifacts and a mini integration checkpoint.
7. New Item 18/19/20/21 contracts, before implementation of Item 13 beyond parked/steward behavior.

### Dependency edges

- 17 -> 10: resume needs a terminal `CompletionResult` to decide whether replay is forbidden, repairable, or already settled.
- 17 -> 13: goals cannot mark done or advance dependent nodes without one completion truth.
- 11 -> 10: exactly-once state must persist in the canonical event/snapshot substrate, not in ad hoc chat memory.
- 11 -> 13: a goal DAG needs durable intent/context linkage and bounded resume reconstruction.
- 12 -> 10: provider generation, login/logout invalidation, and Retry-After/cooldown facts must be stable before a resume machine can claim safe retry behavior.
- 12 -> 13: goal scheduling needs current provider capability snapshots and generation-change behavior.
- 10 -> 13: multi-goal execution needs exactly-once work attempts before it can safely fan out.
- 8k -> 17/11: semantic preflight produces objective, evidence obligations, and done conditions; those must be named in completion and context contracts.
- 18 -> 13: goal DAGs should be born from accepted intent versions, not from transient prose.
- 19 -> 13: stewardship must know when to ask/resume/act, not merely that a goal is stale.
- 20 -> 17/13: completion evidence is necessary but not sufficient for delivery quality.
- 21 -> 8k/12/13: default-on intelligence and goal work must not make the one chat feel slow or jumpy.

Note on 8k placement: if the existing 8k eval passes, the default flip can be done before implementation of 10/11/12/13, but only as a guarded promotion that preserves pending completion obligations and explicit rollback. Do not flip it as a substitute for the missing downstream contracts.

## 4. Blunt Verdict

"Author these six contracts next" is directionally right, but the set should change before implementation.

Do:

- Author Item 17, 11, 12, 10, and 13 as delegation-ready contracts.
- Keep 8k as a gated promotion slice, not a broad architecture slice.
- Add at least Item 18 and Item 19 to the roadmap before building Item 13 deeply.
- Add Item 20 or fold it explicitly into Item 17 if the owner wants fewer item numbers.
- Add Item 21 or fold it explicitly into Item 12 if the owner wants fewer item numbers.

Do not:

- Treat 17/10/11/12/13 + 8k as sufficient for the north-star.
- Build multi-goal autonomy before completion, durable context, provider generations, and exactly-once are contracted.
- Let 8k default-on become a narrative win while completion and intent continuity remain unsettled.

The current queue is the right control-plane move, not the complete product move. It makes the tool less fake and more durable. To make it feel like an elite pro, add the behavior contracts that govern intention, judgment, delivery quality, and feel.

## 5. Adversarial Self-Challenge

Challenge: "Aren't Intent Continuity and Correction DAG already covered by Item 11?"

Answer: No. Item 11 can store events and snapshots, but it does not define what the user actually authorized, what was superseded, or where a correction forks valid work from invalid work. Storage without intent lineage still lets stale or wrong work look continuous.

Challenge: "Aren't Ask-Vs-Act and Proactivity already covered by semantic preflight plus goal stewardship?"

Answer: Only partially. Semantic preflight identifies task shape and uncertainty. Goal stewardship audits stale work. Neither owns the professional decision to ask one question, act now, defer, park, resume, or stop. That decision is the user's felt experience.

Challenge: "Is Delivery Quality just verification?"

Answer: No. Verification answers "is the work evidenced?" Delivery quality answers "is the user's need actually satisfied in the response they see?" A code change can pass tests while the assistant buries the answer, omits a risk, or fails to name the next action.

Challenge: "Is adding new items roadmap bloat?"

Answer: It would be bloat if implemented immediately as big subsystems. It is not bloat to add slim contracts that prevent the current core items from overclaiming. The worst path is building a perfect resume/goal engine around fuzzy intent and mediocre delivery.

Challenge: "Should 8k be blocked until every downstream item ships?"

Answer: Not necessarily. If the eval gate is genuinely green and rollback is explicit, 8k can improve coherence now. But its promotion receipt must say what it does not prove: completion, durable context, exactly-once, and goal stewardship remain pending.
