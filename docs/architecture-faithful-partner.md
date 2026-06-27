# myshell-tools 10/10 Architecture: Faithful Async Work Partner

Read-only artifact. I did not edit source.

## 1. Product Thesis

myshell-tools wins by becoming the individual user’s faithful async work partner: the user chats carelessly, the system captures true intent, turns it into legible goals, works autonomously, verifies reality, and returns either `DONE` with evidence or `BLOCKED` for a reason any competent professional would accept.

The category-defining promise is trust under vagueness. Not “the model is smart.” Not “it learned your vibe.” The product promise is:

> “Say what you mean loosely. I will make the intended work explicit, preserve that intent through execution, verify the result against reality, and let you correct me at any point without losing valid work.”

The economic thesis from `docs/quota-plan-final.md:61-69` is correct: the differentiator is verified work per quota unit. Efficiency is not the product. Efficiency buys cheap intent confirmation, cheap re-planning, cheap context continuity, cheap verification, and cheap correction. Per-user RL is not the bet; `docs/quota-plan-final.md:19-44` correctly demotes it because an individual user will not generate enough clean, stationary outcome data.

Current code already contains pieces of this future: typed intent frames, auto-staged goals, work contracts, review, verification, receipts, work-state, native-session planning, governor allocation, and goal evidence rules. The missing core is durable intent provenance. Today the system has many intelligent seams but no single source of truth that says: “this exact work unit exists because of intent version N, verified by evidence E, and correction C invalidates only these descendants.”

## 2. Perfect Partner Definition

A perfect partner does seven things consistently.

1. Receives the request without forcing ceremony. For clear, reversible, low-risk tasks, it just works. For vague, high-stakes, expensive, or irreversible tasks, it mirrors intent first.
2. Converts language into a compact shared contract: objective, non-goals, assumptions, constraints, done criteria, risk, user-visible tradeoffs, and confirmation policy.
3. Creates goals only when there is real work. Goals are legible, scoped, dependency-aware, and born with done criteria. They are not hidden prompt state.
4. Works in public enough to be trusted: live worklog, current hypothesis, active tool, verification plan, and blockers. The worklog is not verbose thought dumping; it is an operational trace.
5. Verifies against the world: tests, typecheck, lint, diff, source links, repo state, command output, screenshots, or human approval. “Done” never means “the model sounded confident.”
6. Accepts correction as normal control flow. “Wait, you missed my intention” creates an intent fork, identifies the divergence point, reuses valid work, and discards invalid work without drama.
7. Blocks honestly. A block has one clear reason, one next user action or environmental requirement, and an explicit statement of what work is preserved.

Lifecycle behavior:

- Receiving: classify task shape and risk. Detect whether this is discussion, task, correction, approval, cancel, or meta-direction.
- Clarifying: ask one sharp question only when the answer changes execution materially. Otherwise state an assumption and proceed.
- Planning: create a short goal DAG with done criteria. For large work, park goals first or ask to start. For small work, execute inline.
- Working: run tools, update work units, record evidence, keep the user-facing trace legible.
- Interrupting: pause active work, capture user correction as a new intent version, invalidate only dependent work units.
- Reporting progress: report meaningful state changes, not spinner prose.
- Blocking: stop when verification cannot pass, authority is missing, risk requires approval, or intent confidence is below floor.
- Finishing: return a receipt: changed files, commands, test results, verifier verdict, open risks, cost/quota summary when enabled.
- Proactive noticing: surface real adjacent issues a professional would mention, but do not expand scope without permission.

## 3. Elite Interaction Contract

The partner collaborates, it does not argue.

Implementation contract:

- Clear and reversible: execute.
- Ambiguous but low-risk: state assumption inline and execute.
- Ambiguous and high-impact: ask one question.
- Expensive: mirror intent before spending substantial provider calls.
- Irreversible or security-sensitive: require approval.
- User override: recommend once, then comply.

Canonical override response:

> “Understood. I’ll do it your way. My recommendation is still X because Y; saying it once so it’s on record.”

Then the system follows the order. No re-litigation.

Discretion policy:

- Discuss first when: high/critical risk, destructive file operations, credentials/secrets/security, user-visible architecture, legal/financial/medical claims, external facts that may be stale, large refactors, unclear success criteria, or multiple plausible product directions.
- Execute first when: small code edits, tests, inspections, formatting, local searches, reversible scaffolds, clear bug fixes, or user already chose the approach.
- Push back when: the requested path creates clear correctness/security/data-loss risk, contradicts stated goals, breaks verification, or spends quota badly for no gain.
- Never push back merely because the system prefers a style, wants more context, or can imagine a different product.

## 4. Use-Case Modes

Mode A: vision discussion. The user explores what the system should be. The partner should synthesize principles, identify tensions, propose options, recommend one, capture decisions as intent versions, and stage goals only when the user shifts from shaping to building. The output is a living product spec plus parked goals, not premature execution.

Mode B: direct task. “Do a security audit,” “look into this bug,” “build X,” “refactor Y.” The partner should scope, mirror if needed, create goals/work units, run appropriate tools, verify, and return evidence. For audit tasks, done means findings with reproduction/evidence and severity. For bug tasks, done means cause, fix, regression check. For builds, done means implementation plus tests or an honest verification gap. For refactors, done means behavior-preserving proof.

Other modes the architecture must handle:

- Correction: “wait, you missed my intention.”
- Narrowing: “only do the backend.”
- Expanding: “also handle mobile.”
- Override: “I know, do it anyway.”
- Stop/pause: preserve state and produce resumable receipt.
- Approval: continue exactly from pending decision.
- Block recovery: user supplies missing secret, account, test command, or direction.
- Follow-up: use the prior intent and evidence, not stale prose.
- Background work: user can leave and return to done/blocked.

## 5. Core Loop

The 10/10 loop is:

`USER INPUT -> INTENT MIRROR -> INTENT VERSION -> GOAL DAG -> WORK UNITS -> EVIDENCE -> VERIFY -> RECEIPT -> CORRECT/FORK`

Data model:

```ts
type IntentVersion = {
  id: string;
  parentId?: string;
  conversationId: string;
  userTurnIds: string[];
  objective: string;
  nonGoals: string[];
  assumptions: string[];
  constraints: string[];
  doneWhen: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  confidence: 'high' | 'medium' | 'low';
  confirmationPolicy: 'execute' | 'mirror' | 'ask' | 'approve';
  mirrorText: string;
  acceptedAt?: string;
  supersedes?: string;
};

type GoalNode = {
  id: string;
  intentVersionId: string;
  title: string;
  state: 'parked' | 'queued' | 'running' | 'blocked' | 'done' | 'failed';
  doneWhen: string;
  deps: string[];
};

type WorkUnit = {
  id: string;
  goalId: string;
  intentVersionId: string;
  status: 'pending' | 'running' | 'verified' | 'blocked' | 'invalidated';
  planStep: string;
  repoSnapshot: string;
  evidenceIds: string[];
  invalidatedByIntentId?: string;
};

type Correction = {
  id: string;
  fromIntentId: string;
  toIntentId: string;
  userTurnId: string;
  divergencePoint: 'intent' | 'goal' | 'workUnit' | 'artifact';
  preservedWorkUnitIds: string[];
  invalidatedWorkUnitIds: string[];
  reason: string;
};
```

Control flow:

1. Build or reuse an `IntentFrame`.
2. If confirmation policy says mirror, show the Intent Mirror and wait for tap/enter/correction.
3. Commit `IntentVersion`.
4. Derive goal DAG and work units from that version.
5. Execute each work unit against a verification plan.
6. Record evidence before claiming progress.
7. Verify the work unit. If verification fails, repair within budget; if still failing, block or escalate.
8. Finish only when done criteria are satisfied by evidence.
9. On correction, fork intent, compute affected descendants, preserve valid evidence, re-plan invalidated units.

## 6. Mechanisms Mapped To Current Code

Intent Mirror.

Current: `IntentFrame` already models goal, non-goals, constraints, forks, doneWhen, confidence, and draft-goal byproduct in `src/core/intent.ts:45-107`. The extractor is a gated provider call in `src/core/intent-extractor.ts:57-126`. Orchestrate already has unified vs split preflight and intent fallback paths in `src/core/orchestrate.ts:221-425`. It can emit an `intent` event in `src/core/orchestrate.ts:1049-1070`.

Gap: there is no first-class, durable mirror artifact with user acceptance/correction state. `IntentFrame` is per-turn control data, not an accepted shared contract.

Design: add `IntentMirror` and `IntentVersion` stores. For substantial turns, show: objective, assumptions, non-goals, doneWhen, verification plan, and “correct me with ‘wait…’”. For trivial turns, skip.

Intent Version Control.

Current: goals exist with states and sources in `src/core/goal-todo.ts:37-52`; persisted goals carry roadmap, scope, conversationId, goalAcceptance, verdict, approach, and parentGoalId in `src/core/goal-todo.ts:102-166`. Goal store creates parked goals in `src/infra/goal-store.ts:236-305`, enforces evidence-only verdict write paths in `src/infra/goal-store.ts:326-359`, and preserves verified work in replan/cancel paths in `src/core/goal-replan.ts:12-27` and `src/core/goal-replan.ts:341-452`.

Gap: goals do not point to an immutable intent version. Corrections cannot compute a semantic divergence point. Work reuse is manual/human.

Design: every goal, roadmap item, work contract, evidence snapshot, and receipt gets `intentVersionId`. A correction creates a new intent version and runs an invalidation pass: if the objective/non-goal/doneWhen touched a work unit’s dependency tags, invalidate; otherwise preserve. The UI says: “Re-steered from v3 to v4. Preserving tests and parser cleanup; discarding UI copy work.”

Calibrated Honest Blocking.

Current: the brain confidence model explicitly avoids treating rules fallback as measured confidence in `src/core/brain.ts:94-145` and `src/core/brain.ts:197-216`. Verification has four states and refuses fake green in `src/core/verify.ts:16-23` and `src/core/verify.ts:38-49`. Verify receipts are explicit in `src/core/verify.ts:238-280`. Best-effort final is honest but still success-shaped in `src/core/work-call.ts:2153-2175`.

Gap: “blocked” is not yet the universal terminal alternative to “done.” Some paths return best-effort success when the loop exhausts, which is useful, but the product-level state must distinguish usable partial output from verified completion.

Design: introduce `BlockedReason` as a first-class terminal for goals/work units: `missing_authority`, `intent_unclear`, `verification_failed`, `environment_unavailable`, `quota_exhausted`, `risk_requires_approval`, `external_truth_unavailable`. A block contains preserved work, failed checks, next action, and resume command.

Live Worklog + Evidence Receipt.

Current: `CoreEvent` already has classified, intent, engagement, phase, tier-start, tier-done, notice, final, and goal events in `src/core/types.ts:972-1173`. `trust-receipt.ts` composes confidence, verify, provider posture, and self-audit from real signals in `src/core/trust-receipt.ts:1-15` and `src/core/trust-receipt.ts:342-416`. Evidence snapshots exist in `src/core/evidence.ts:4-37` and append infrastructure exists in `src/infra/evidence-store.ts:74`.

Gap: events are not yet a durable, queryable worklog tied to intent/work-unit IDs. Receipts are turn-level, not full async-goal receipts.

Design: persist typed `WorkEvent` spans: `intent_mirrored`, `goal_created`, `tool_started`, `tool_finished`, `diff_captured`, `tests_run`, `review_done`, `blocked`, `done`. The final receipt links to evidence IDs and summarizes only facts.

## 7. Hardest Problem: Intent Fidelity Under Vagueness

The hardest sub-problem is not planning, routing, or model choice. It is preserving the user’s true intent across time, ambiguity, background work, interruptions, and partial correction.

Strongest solution: intent as a versioned operational object, not prompt prose.

Rules:

- Every substantial action must cite an intent version.
- Every intent version has explicit assumptions and done criteria.
- Every assumption is either confirmed, user-overridable, or verifier-checkable.
- Corrections fork intent, not conversation history.
- Work units declare which intent fields they depend on.
- Verification checks done criteria, not just output plausibility.
- The system never treats “no user correction” as strong confirmation on high-risk work; it is only permission to proceed under stated assumptions.

This is “git for intentions”: immutable commits, parent links, diffs, forks, preserved artifacts, invalidated descendants, and receipts.

## 8. Current-State Gap Analysis

Already real:

- Typed intent extraction and fallback: `src/core/intent.ts:45-140`, `src/core/intent-extractor.ts:89-126`.
- Unified preflight path exists but is gated: `src/core/orchestrate.ts:221-425`.
- Auto-stage is default-on: `src/interface/ui/auto-goal-flag.ts:11-18`, `src/interface/ui/auto-goal-flag.ts:26-49`.
- Auto-stage creates parked goals, dedups, and may background-run confident work: `src/interface/auto-stage.ts:492-647`.
- Draft goals are default-off and non-executing: `src/interface/ui/draft-goals-flag.ts:14-25`; materialization path is in `src/interface/menu.ts:6201-6234`.
- Work contracts model objective, roadmap, checkpoints, verification, and evidence-only item verdicts: `src/core/work-contract.ts:12-104`.
- Review prompt checks output against contract drift: `src/core/review.ts:60-98`.
- Four-state verification is real and honest: `src/core/verify.ts:1-23`, `src/core/verify.ts:238-280`.
- Diff-scoped critic reviews the actual diff, not prose: `src/core/verify.ts:287-367`.
- Accept gate runs verification where wired: `src/core/work-call.ts:1015-1027`, `src/core/work-call.ts:2139-2149`.
- Trust receipt is pure signal composition: `src/core/trust-receipt.ts:342-416`.
- Work-state reconstruction is evidence-conservative: `src/core/work-state.ts:12-23`, `src/core/work-state.ts:138-243`.
- Native sessions are planned and hardened for stale history: `src/core/native-session.ts:4-20`, `src/core/native-session.ts:92-115`.
- History compaction strips control envelopes and reports truncation: `src/core/history.ts:65-109`, `src/core/history.ts:145-204`, `src/core/history.ts:210-245`.
- Governor allocates budget and now active verification despite stale header comments: `src/core/governor.ts:474-514`, `src/core/governor.ts:815-830`.

Fake, dark, or incomplete:

- No durable intent version store. This is the central missing primitive.
- No correction DAG. “Wait, you missed my intention” cannot fork from the divergence point.
- Goal provenance is source-level, not intent-version-level.
- Work contracts are powerful but not the durable intent authority. The file header still says Stage 1 contracts are ephemeral in `src/core/work-contract.ts:4-5`, while later code persists `workTrace`; the architecture has outgrown the comment.
- Governor comments are stale: `src/core/governor.ts:27-34` says verification is inactive, while `src/core/governor.ts:815-830` makes it active. That doc drift is dangerous in a trust system.
- Verification is optional through `verifyPort`; when absent, receipts can be missing and final success can still be best-effort.
- Evidence exists, but not as the universal substrate for all done/block/correction claims.
- Aux call accounting and cache accounting are still incomplete per `docs/quota-plan-final.md:45-59`.
- Live worklog is event-shaped but not yet durable/queryable as a user-facing async audit log.

## 9. Roadmap

All steps default-off unless explicitly noted. Ship-green means `tsc --noEmit`, targeted tests, and zero new failures by name-diff vs `main`; do not compare raw count because the repo already has known flaky/Windows failures, as stated in `docs/quota-plan-final.md:47`.

1. `MYSHELL_INTENT_MIRROR_V1=1`
   Add pure `IntentMirror` builder from `IntentFrame`. Render only on substantial/ambiguous/high-risk turns. No persistence yet. Tests: intent mirror snapshots, trivial skip, high-risk require mirror.

2. `MYSHELL_INTENT_STORE_V1=1`
   Add append-only local intent version store. Store accepted mirror, parent, objective, assumptions, doneWhen, confidence, risk. Thread `intentVersionId` into goal creation and work contracts.

3. `MYSHELL_WORKLOG_V1=1`
   Persist typed work events with `intentVersionId`, `goalId`, `workUnitId`, evidence IDs, and timestamps. Render compact live status from the same events.

4. `MYSHELL_EVIDENCE_RECEIPT_V2=1`
   Promote evidence receipt from turn notice to async goal receipt. Include changed files, commands, test results, verifier state, reviewer, cost/quota, preserved/invalidated work.

5. `MYSHELL_CORRECTION_FORK_V1=1`
   Implement correction command detection: “wait,” “actually,” “you missed,” “not that,” plus explicit `/correct`. Fork intent, compute invalidation, preserve unaffected evidence.

6. `MYSHELL_BLOCKED_STATE_V1=1`
   Add first-class blocked state for work units and goals. Replace vague best-effort terminal UX with `partial_result + blocked_reason + next_action`.

7. `MYSHELL_VERIFY_REQUIRED_FOR_DONE=1`
   A goal cannot become `done` unless goal-level verdict is `passing` or `reviewed`, matching the existing evidence-only rules in `src/core/goal-todo.ts:87-95`.

8. `MYSHELL_ACCOUNT_AUX_CACHE_V2=1`
   Execute the quota-plan PR1/PR2 foundation: aux ledger, cache read/write accounting, effective cost, route/intent/understanding/autostage stage entries.

9. `MYSHELL_NATIVE_SESSIONS_PROMOTE=1`
   Promote native session reuse after telemetry proves lower replay cost and no stale-state regressions.

10. `MYSHELL_GOVERNOR_RUNTIME_BUDGET=1`
   Make governor spend decisions enforce measured budget from the ledger, starting log-only, then active.

Smallest verified win: ship Intent Mirror V1 plus Intent Store V1 for substantial turns. It creates the shared contract and the anchor every later feature needs.

## 10. Research Grounding

Anthropic’s agent guidance matches this architecture: use simple composable patterns, add complexity only when it improves outcomes, show planning steps, use ground truth from tools/code execution, and rely on tests plus human review for coding agents.

OpenAI’s Agents SDK shows the 2026 platform direction: tracing captures LLM calls, tools, handoffs, guardrails, and custom events; guardrails run input/output checks to avoid wasting expensive model calls; HITL pauses sensitive tool calls and resumes durable run state; sessions preserve history and support corrections via popping prior items.

Benchmarks show the gap between demos and dependable partnership. JobBench 2026 reports the strongest evaluated agent at only 45.9% on expert-prioritized delegation workflows. τ²-Bench shows performance drops when users and agents both act in a shared environment, making communication and coordination first-class problems. Phoenix-bench shows one round of test feedback can lift resolved rate by 42-45%, which supports verification-driven loops over confidence-driven loops. GDPval shows scaffolding, reasoning effort, and task context improve real work quality. 2026 coding-agent rule research finds negative constraints are more reliable than broad positive guidance, supporting guardrails and invariants over prompt wishlists.

## 11. Final Architecture Verdict

myshell-tools is not empty. It is an advanced scaffold with many of the right organs already present. But it is not yet the definitive faithful async partner because intent is still transient. The system can infer, stage, verify, and receipt pieces of work, but it cannot yet prove that every action served the exact user intention that produced it, nor can it fork cleanly when that intention is corrected.

The 10/10 architecture is therefore not “add more agents.” It is durable intent, evidence-bound work, reversible correction, and honest terminal states. Once every goal and work unit is tied to an accepted intent version, the rest of the codebase’s existing strengths become coherent: auto-stage becomes goal birth, verify becomes the done gate, trust receipts become proof, governor becomes spend discipline, and correction becomes a normal, lossless branch instead of a conversation failure.