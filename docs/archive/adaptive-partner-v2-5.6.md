# Adaptive Partner Engine v2 - design 5.6

Status: **DESIGN ONLY.** This document proposes the next generation Adaptive Partner Engine
for `myshell-tools`, a subscription-auth CLI that wraps Claude Code / Codex / OpenCode through
the user's OAuth sessions. It makes no source-code changes.

The core diagnosis is already verified in live use and is accepted as a constraint here:

1. The current engine is wired. `src/interface/menu.ts` `buildDeps` creates the intent
   extractor with an 8s cap, passes `environmentContext`, `memoryContext`, and
   `partnerStyle` into `orchestrate`, and `src/core/orchestrate.ts` computes
   `IntentFrame` plus `EngagementPlan` before the provider turn. `src/core/prompt-context.ts`
   `assembleContextBlocks` then renders `ENVIRONMENT -> MEMORY -> INTENT -> ENGAGEMENT ->
   partner posture` into sequential, hedge, and panel prompts.
2. The failure is not wiring. The failure is authority. `src/core/engagement.ts`
   `planEngagement(signals) -> EngagementPlan` is currently consumed mostly as prompt text via
   `renderEngagementBlock`. The model may ignore that text, and stale resumed history can
   few-shot it back into the old generic menu behavior.
3. Fresh one-shot runs show the prompt is capable: an IC-tier model can orient to the actual
   `cwd`, notice the requested project is absent, and recommend concrete next steps. The gap is
   reliability under stateful chat and poisoned history.

The v2 thesis: **the EngagementPlan must become an orchestrator-owned control plan, not just a
prompt hint.** The model can still write prose, but the orchestrator owns the turn contract:
what preliminary work is required, whether a structured question is terminal, whether stale
history is quarantined, and whether a generic open menu answer is rejected or repaired.

---

## 1. Gap Analysis

### 1.1 What exists and is valuable

`src/core/intent.ts` defines the right semantic primitive:

```ts
export interface IntentFrame {
  readonly goal: string;
  readonly kind?: string;
  readonly nonGoals?: readonly string[];
  readonly constraints?: readonly string[];
  readonly forks?: readonly IntentFork[];
  readonly doneWhen?: string;
  readonly confidence: IntentConfidence;
  readonly source: 'model' | 'rules-fallback' | 'skipped';
}
```

This is the right shared understanding layer. It already captures outcome, constraints,
forks, and "done." `src/core/intent-extractor.ts` `makeIntentExtractor` correctly mirrors the
router pattern: cheapest worker tier, read-only sandbox, caller timeout, parse-or-null, and
fallback to `rulesIntentFrame`.

`src/core/engagement.ts` already contains useful senior-judgment predicates:

- `isInvestigable(s)` distinguishes codebase-discoverable ambiguity from true user forks.
- `hasGenuineFork(s)` filters out investigable forks and generic menus.
- `isGenericOpenMenuFork(...)` identifies exactly the "fix/add/polish/integrate" failure
  mode when it appears in `IntentFrame.forks`.
- `needsExternal(s)` gates web research to current/latest/look-up cases.
- `deriveAskFromForks(frame, plan)` can create a structured `QuestionSet`.
- `seedFromIntentAndPlan(frame, plan, task)` already feeds `WorkContract` with real
  objective/vision instead of raw task text.

`src/core/prompt-context.ts` `assembleContextBlocks` is the correct single composition seam.
Any v2 context must continue to flow through that one function rather than adding ad hoc prompt
paths.

`src/core/repo-map.ts` `buildEnvironmentContext` provides cheap deterministic orientation:
project type, dirty/recent files, entry points, and ranked file map with no model call,
embeddings, vector DB, or metered service.

`src/core/work-contract.ts` already has the right durable trace shape:

```ts
export interface WorkContract {
  readonly version: 1;
  readonly objective: string;
  readonly vision?: string;
  readonly roadmap?: readonly RoadmapItem[];
  readonly checkpoints?: readonly Checkpoint[];
  readonly verification?: ContractVerification;
}
```

It is capped by `capContract`, prompt-rendered by `renderContractForPrompt`, and persisted on
accepted assistant entries as `SessionEntry.workTrace`.

### 1.2 Where v1 is still advisory

The live turn pipeline in `src/core/orchestrate.ts` does this:

1. `decideRoute(task, ...)` creates `classification` and `routePlan`.
2. The intent stage runs or skips `depsArg.intentExtractor`, falling back to
   `rulesIntentFrame`.
3. `planEngagement(...)` computes an `EngagementPlan`.
4. `renderIntentBlock(intentFrame)` and `renderEngagementBlock(engagementPlan)` create strings.
5. The strings are copied into `deps.intentFrame` and `deps.engagementPlan`.
6. Later, `buildPrompt(...)` renders them through `assembleContextBlocks`.

That means the plan is not an execution contract. It is a text block inside a larger prompt.
The only hard-ish enforcement today is after the model finishes:

```ts
const modelQuestions = parseQuestions(finalText ?? '');
const derivedQuestions =
  modelQuestions === null &&
  attempts === 1 &&
  engagementPlan.actions.includes('ASK_CLARIFYING')
    ? deriveAskFromForks(intentFrame, engagementPlan)
    : null;
```

This preserves the structured question flow when the model fails to emit `ask_user`, but it is
too late. The user may still see generic prose first, and stale chat history can teach the
model to emit the exact order-taker menu the prompt forbids.

### 1.3 Why prompt strengthening is insufficient

`src/core/prompt.ts` now strongly says "INVESTIGATE BEFORE YOU INTERROGATE" and forbids broad
menus. `src/core/engagement.ts` also filters generic menu forks. The gate can go green and
still not move live behavior because:

- History replay sits after context blocks in `buildPrompt`, and stale assistant outputs can
  few-shot the next provider turn.
- Native provider sessions can carry server-side stale behavior when `nativeSessions` is on.
- A model's free prose is not parsed as an execution decision unless it emits `ask_user` or a
  confidence envelope.
- The orchestrator currently accepts any successful prose unless confidence/review/escalation
  logic rejects it.

The v2 design therefore treats model prose as an output to validate, not as the source of
truth for engagement.

---

## 2. Proposed Architecture

### 2.1 New control-plane artifact: `TurnDirective`

Keep `EngagementPlan` pure and table-testable, but add an orchestrator-owned compiled form:

```ts
interface TurnDirective {
  readonly version: 1;
  readonly intent: IntentFrame;
  readonly engagement: EngagementPlan;
  readonly requiredBeforeAnswer: readonly RequiredPreAnswerAction[];
  readonly terminalQuestion?: QuestionSet;
  readonly outputValidators: readonly OutputValidator[];
  readonly workState?: WorkStateSnapshot;
  readonly escalationBudget: EscalationBudget;
  readonly historyPolicy: HistoryPolicy;
}

type RequiredPreAnswerAction =
  | { readonly kind: 'orient_repo'; readonly reason: string }
  | { readonly kind: 'investigate_context'; readonly queryHints: readonly string[]; readonly maxMs: number }
  | { readonly kind: 'web_research'; readonly reason: string; readonly maxMs: number }
  | { readonly kind: 'plan_first'; readonly reason: string }
  | { readonly kind: 'vision_triage'; readonly items: readonly VisionTriageItem[] };

type OutputValidator =
  | { readonly kind: 'reject_generic_open_menu' }
  | { readonly kind: 'require_grounded_recommendation' }
  | { readonly kind: 'require_structured_question'; readonly questions: QuestionSet }
  | { readonly kind: 'require_wrong_repo_orientation' }
  | { readonly kind: 'require_done_next_status' };
```

`TurnDirective` is not rendered as a substitute for `ENGAGEMENT`; it is consumed by
`orchestrate` before and after the provider run. The prompt block remains useful, but it
explains the contract to the model instead of being the only enforcement.

Implementation ownership:

- `src/core/engagement.ts`: keep `EngagementPlan`; add pure compiler
  `compileTurnDirective(...)`.
- `src/core/orchestrate.ts`: consume the directive before panel/hedge/sequential routing and
  after `finalText` is collected.
- `src/core/prompt-context.ts`: add only pre-rendered context strings if needed; do not bypass
  `assembleContextBlocks`.
- `src/core/types.ts`: add any directive/result event only if render needs it. Most directive
  work can remain internal.

### 2.2 A. Behavioral enforcement, not advice

The first enforced behavior should be pre-answer gating for `ASK_CLARIFYING` and generic-menu
repair.

#### A1. Orchestrator-owned structured asks

When `planEngagement` selects `ASK_CLARIFYING` and `deriveAskFromForks` returns a non-null
`QuestionSet`, `orchestrate` should be allowed to emit the question before the provider run.
No model prose should be generated first.

Control flow:

```ts
const directive = compileTurnDirective(...);

if (directive.terminalQuestion !== undefined) {
  await deps.session.append({ role: 'user', content: task, ... });
  await deps.session.append({ role: 'assistant', content: '', workTrace });
  yield {
    type: 'final',
    success: true,
    output: '',
    tier: classification.tier,
    totalCostUsd: 0,
    sessionId: deps.session.id,
    attempts: 0,
    questions: directive.terminalQuestion,
  };
  return;
}
```

This changes the authority boundary. The model no longer gets a chance to ignore a planned
terminal ask. It also spends no provider quota.

Guardrails:

- Only use this when `EngagementPlan.asks > 0` and `hasGenuineFork(signals)` is true.
- Never ask for `isInvestigable(s)` generic codebase facts; route those to investigation.
- Preserve `ASK_CAP = 1`.
- Keep `deriveAskFromForks` as the question source so the existing `QuestionSet` UI remains.

#### A2. Output validator for generic open menus

Add a pure validator over final prose:

```ts
interface ValidationFailure {
  readonly kind: 'generic_open_menu' | 'ungrounded_recommendation' | 'missing_required_question';
  readonly severity: 'repair' | 'retry' | 'fail';
  readonly reason: string;
}

function validateTurnOutput(text: string, directive: TurnDirective): ValidationFailure | null;
```

For stage 1, only enforce `reject_generic_open_menu`:

- Detect broad menus similar to `isGenericOpenMenuFork`, but over final prose.
- Examples: "are you fixing, adding, polishing, or integrating", "what are you trying to do",
  "which task type".
- Fire only when `directive.engagement.actions` includes `INVESTIGATE_CONTEXT` or when the
  environment block indicates a repo is present. This avoids overblocking normal brainstorming.

Repair path:

- First failure on attempt 1: retry once at the same tier with `managerNotes`-style feedback:
  "The previous answer asked a generic task-category menu. Do not ask that. Use the ENVIRONMENT
  block and task to orient, state what you can verify, and recommend the concrete next step. If
  the referenced project is not in `cwd`, say that and ask for the repo path."
- If the repaired answer fails again: convert to a deterministic fallback final if the
  environment makes the issue clear, otherwise fail honestly with a short explanation.

This is not another metered call in the common path. It costs one retry only on the exact live
failure mode. It reuses the existing attempt loop and provider machinery.

#### A3. Pre-answer investigation as a provider turn mode, not a new file scanner

For `INVESTIGATE_CONTEXT`, v2 should not add a second model call by default. The provider turn
is already the work turn, and Claude/Codex/OpenCode can read files through their own tools.
The orchestrator should enforce investigation by:

- Adding a directive block through `assembleContextBlocks` that names the required first action.
- Validating the final answer for grounded claims: either file paths/symbols found, an explicit
  "I do not see that project here", or a concrete reason no file inspection was needed.
- Retrying once when the model responds with a generic menu or no orientation.

Later, a cheap deterministic `repoProbe` may run before the model for wrong-repo detection, but
it should use existing `buildEnvironmentContext`/repo-map data, not embeddings or a new search
service.

#### A4. Structured triage output option

Do not require the main provider to emit a separate hidden triage JSON before answering in
stage 1. That adds latency and still depends on compliance. Instead:

- The cheap intent extractor may be extended later to emit `visionTriage` because it is already
  a gated worker-tier pass with an 8s cap.
- The orchestrator compiles the directive from that structured result.
- The provider work turn receives the directive and is validated after completion.

This preserves subscription discipline: no new always-on model call, no API key, no external
metered service.

### 2.3 B. Persistent work-state awareness: "what's done / what's next"

Reuse `WorkContract`, but promote it from audit trail to live work-state input.

Current limitation: `SessionEntry.workTrace` is persisted, but `src/core/types.ts` comments say
it is "not consumed by runtime routing, review, or goal-loop decisions today." Stage 5
cross-session seeding was deferred. v2 should close that gap.

New shape:

```ts
interface WorkStateSnapshot {
  readonly objective: string;
  readonly vision?: string;
  readonly roadmap: readonly RoadmapItem[];
  readonly recentCheckpoints: readonly Checkpoint[];
  readonly verifiedDone: readonly string[];
  readonly claimedNext?: string;
  readonly source: 'current-goal' | 'session-workTrace' | 'none';
}
```

Rules for truthfulness:

- "Done" requires evidence. Valid evidence is a successful provider final with an explicit
  completed step, a passing command reported by the provider, a reviewer approval, or
  `GOAL_COMPLETE`.
- `Checkpoint.summary` remains model-stated next action, not verified completion. Keep that
  comment true.
- Roadmap item status transitions should be conservative:
  - `pending -> active`: model started or explicitly says it is working on that item.
  - `active -> done`: final text provides evidence or review approves.
  - `active/pending -> blocked`: model emits structured question, timeout, auth failure, or says
    repo/context is missing.
- Never infer completion from silence.

Runtime use:

- In `menu.ts buildDeps`, load prior history as today.
- Add a pure helper over `SessionEntry[]`:

```ts
function deriveWorkStateFromHistory(history: readonly SessionEntry[]): WorkStateSnapshot | undefined;
```

- Thread a rendered `WORK STATE` block through `assembleContextBlocks`.
- Feed `workState` into `compileTurnDirective`, so a resumed chat knows what was last done and
  what the next honest step is.

Prompt block example:

```text
WORK STATE (truthful, from accepted prior turns):
OBJECTIVE: ship the analytics dashboard
DONE: R1 wired route; tests passed via npm test
NEXT: investigate chart hydration failure
BLOCKED: none
```

This is not memory. Memory is durable user/project preference. Work state is task/session
continuity and should be seeded across resumes from `workTrace`, not from profile memory.

### 2.4 C. Vision triage

The user's vision should be decomposed into parts with different dispositions. Add a small
structured triage representation:

```ts
type VisionDisposition =
  | 'SOLID'
  | 'DISCUSS'
  | 'MIGRATE_REARCHITECT'
  | 'INVESTIGATE_THEN_PROPOSE';

interface VisionTriageItem {
  readonly id: string;
  readonly claim: string;
  readonly disposition: VisionDisposition;
  readonly rationale: string;
  readonly defaultAction: 'proceed' | 'ask_user' | 'flag_architecture' | 'investigate';
  readonly evidence?: readonly string[];
  readonly question?: IntentFork;
}
```

How to produce it:

- Stage 1: deterministic heuristics over `IntentFrame`, task text, and repo-map.
- Later: extend `buildIntentPrompt` to optionally emit `triage` on manager/planning/product
  requests. This rides the existing intent call and caps, not a new pass.

Routing:

- `SOLID`: state the interpretation briefly and proceed.
- `DISCUSS`: if it is a genuine fork, compile `terminalQuestion`; otherwise discuss options
  and recommend one.
- `MIGRATE_REARCHITECT`: route at least IC, often manager when risk/scope warrants; require an
  opinionated architecture note before implementation. Use existing `authorizeTier` to avoid
  free-plan/never-auto violations.
- `INVESTIGATE_THEN_PROPOSE`: require `INVESTIGATE_CONTEXT`, then require the answer to return
  findings plus a proposed plan, not a generic question.

Example:

```json
{
  "id": "T2",
  "claim": "The current TypeScript CLI may need a Rust core for long-running local indexing",
  "disposition": "MIGRATE_REARCHITECT",
  "rationale": "Performance and distribution constraints could dominate implementation speed",
  "defaultAction": "flag_architecture"
}
```

This is general. It is not tied to any product name. It works for code, writing, research,
ops, design, and product planning because the fields describe disposition and action, not
domain.

### 2.5 D. Discovery-driven escalation

The current system escalates after a provider output via `assess(finalText)` confidence,
`needs_review`, provider failure, review verdict, `planPanel`, and `planHedge`.

v2 adds discovery events from within the turn output and from deterministic pre/post checks:

```ts
type DiscoverySignal =
  | { readonly kind: 'larger_bug'; readonly evidence: readonly string[]; readonly confidence: 'medium' | 'high' }
  | { readonly kind: 'cross_cutting_change'; readonly filesOrAreas: readonly string[] }
  | { readonly kind: 'wrong_repo_or_missing_context'; readonly expected?: string }
  | { readonly kind: 'high_stakes_surface'; readonly area: 'auth' | 'secrets' | 'payments' | 'deployment' | 'data' | 'security' }
  | { readonly kind: 'provider_low_confidence'; readonly reason: string };
```

Sources:

- Provider confidence envelope: already parsed by `assess`.
- Output text validator: catches "larger bug", "root cause is elsewhere", "requires migration",
  "security issue", and file-spread claims.
- Future optional structured self-report: add fields inside the existing confidence envelope,
  not a second control block, for `discoveries`.

Escalation policy:

- Escalate when evidence indicates high-risk or cross-cutting blast radius and
  `authorizeTier` admits manager.
- Form a panel when risk is high/critical, two authenticated providers are available, and
  `panelPolicy` permits it. Do not silently override user policy.
- Ask the user when the discovery creates a true product/business fork, not when it merely
  makes the implementation larger.
- Just do the larger fix when it is local, reversible, and within current tier/timeout.

Cost and latency bounds:

- No extra pass on normal turns.
- One repair retry for validator failures.
- Existing `policy.maxAttempts` remains the hard loop bound.
- Existing intent 8s and router 20s caps remain.
- Panel/hedge stay opt-in or risk-gated exactly as `src/core/ensemble.ts` and
  `src/core/hedge.ts` do today.

### 2.6 E. Always-on informed opinion

The prompt already asks the model to recommend a winner. v2 makes that observable:

```ts
type RecommendationGrounding =
  | { readonly kind: 'file_evidence'; readonly paths: readonly string[] }
  | { readonly kind: 'repo_orientation'; readonly facts: readonly string[] }
  | { readonly kind: 'stated_assumption'; readonly assumptions: readonly string[] }
  | { readonly kind: 'external_source'; readonly sources: readonly string[] }
  | { readonly kind: 'not_enough_context'; readonly missing: string };
```

Validator rule:

- On substantial turns, the answer should include a recommendation or next step.
- The recommendation must be grounded in at least one of: repo finding, environment fact,
  explicit assumption, external source, or a clear "I cannot see the requested repo."
- Do not force this on tiny factual tasks.

If missing:

- Retry once with a repair note.
- If still missing, append a deterministic wrapper only when it is truthful:
  "I cannot ground a recommendation from the current output; the next step is to point the tool
  at the correct repo or narrow the task."

### 2.7 F. Generality

No hardcoded domain assumptions. The engine operates on generic primitives:

- intent goal/kind/constraints/forks/doneWhen;
- repo environment facts;
- work-state objective/roadmap/checkpoints;
- vision dispositions;
- risk and reversibility;
- output validation for generic failure modes.

Specific project names like "heyvera" should appear only as user-provided strings or
environment-derived repo names. Wrong-repo behavior should be generic: if the requested project
is not visible in `cwd`, say so and ask for the repo/path.

---

## 3. History Robustness

Stale resumed history was a major live cause. v2 needs a direct mitigation.

Add a pure history policy:

```ts
interface HistoryPolicy {
  readonly replayMode: 'normal' | 'summarize_only' | 'quarantine_assistant_prose';
  readonly reasons: readonly string[];
}
```

Triggers for quarantine:

- Prior assistant turns contain generic open menus matching the validator.
- Prior assistant turns predate the engine version that introduced enforced asks.
- Current directive requires `ASK_CLARIFYING` or `INVESTIGATE_CONTEXT` and prior assistant prose
  conflicts with it.

Behavior:

- `normal`: use `compactHistory` as today.
- `summarize_only`: pass recap/work-state, not raw stale assistant prose.
- `quarantine_assistant_prose`: include user messages and trusted work-state, but omit or
  summarize old assistant free prose that demonstrates bad behavior.

Native session caveat:

- When `deps.nativeSession` would resume a provider session known to contain stale behavior,
  prefer replayed compact history for that turn or start a new native session. This must be a
  narrow policy, not a global native-session disable.

This keeps raw-mode/stdin untouched. It lives in history/deps selection, not the chat input loop.

---

## 4. Staged Build Plan

Each stage is independently shippable, gate-green, and real-run verifiable.

### Stage 1 - Highest Leverage: pre-provider `ask_user` + generic-menu validator

Goal: close the exact live failure mode by moving planned terminal asks before the model and
rejecting generic menu prose after the model.

Mechanisms:

- Add `compileTurnDirective` with only `terminalQuestion`, `reject_generic_open_menu`, and
  `historyPolicy` fields.
- In `orchestrate`, before panel/hedge/sequential branches, if `terminalQuestion` exists,
  append the user entry and return a `final` with `questions` and zero provider attempts.
- Add `validateTurnOutput` and a one-retry repair path for generic menus.
- Add history quarantine for prior assistant generic menus on the next turn.

Why first:

- It changes authority, not wording.
- It costs nothing when a structured ask is required.
- It directly verifies the diagnosis: live behavior must change even with poisoned history.

Unit gate:

- Existing 3109 tests stay green.
- Add focused tests around `compileTurnDirective`, `validateTurnOutput`, zero-attempt question
  final, and one-retry repair.

Real-run verification:

1. Start a chat in a conversation whose prior assistant history includes the old generic menu.
2. Type a task like: `make the socials page feel like the real product, but don't overbuild`.
3. Correct behavior:
   - It must not print "are you fixing/adding/polishing/integrating?"
   - If the fork is genuine, the UI must render structured choices from `ask_user`.
   - If the ambiguity is investigable, it must inspect/orient or say the repo is missing and
     recommend the concrete next step.
4. Also run the known one-shot wrong-repo case from inside `myshell-tools` while referencing an
   absent project. Correct behavior: it says the requested repo is not visible in the current
   `cwd` and asks for the path/repo, not a generic menu.

### Stage 2 - Live work-state from `workTrace`

Goal: make "done vs next" a truthful runtime input across turns and resumes.

Mechanisms:

- Add `deriveWorkStateFromHistory(history)` over persisted `SessionEntry.workTrace`.
- Render a `WORK STATE` block through `assembleContextBlocks`.
- Update `seedFromIntentAndPlan`/workTrace consumption so accepted normal turns can advance a
  conservative next-step trace.
- Keep completion evidence conservative.

Unit gate:

- Work state derivation from multiple assistant entries.
- No fabrication: checkpoint summaries do not become `verifiedDone`.
- Resume with stale history uses latest trusted workTrace.

Real-run verification:

1. In chat, ask for a multi-step repo task and accept keep-going or run `/goal`.
2. Let turn 1 complete one concrete step and emit a next step.
3. Exit and resume the conversation.
4. Type: `continue`.
5. Correct behavior: the assistant names what is already done from the prior turn and starts the
   next step, without asking "what are we doing?" or repeating completed work.

### Stage 3 - Vision triage

Goal: decompose broad visions into `SOLID`, `DISCUSS`, `MIGRATE_REARCHITECT`, and
`INVESTIGATE_THEN_PROPOSE` items.

Mechanisms:

- Add `VisionTriageItem` and deterministic triage heuristics.
- Extend `TurnDirective.requiredBeforeAnswer` with `vision_triage`.
- Later, optionally extend `IntentFrame` parser to accept capped `triage` when the existing
  intent extractor runs.

Unit gate:

- Triage table tests for proceed/discuss/migration/investigate dispositions.
- Caps and fail-soft parsing if added to `IntentFrame`.

Real-run verification:

1. Type a broad vision: `I want this CLI to feel like a senior partner: part product judgment,
   part code investigator, and maybe some parts need a Rust rewrite. Make a plan.`
2. Correct behavior: it separates solid implementation work, genuine forks to discuss,
   migration/rearchitecture concerns with an opinion, and investigation-first items.
3. It must recommend a sequence, not list generic options.

### Stage 4 - Discovery-driven escalation

Goal: when investigation finds a larger bug or risk, the engine changes scope/agents
deliberately.

Mechanisms:

- Add `DiscoverySignal` extraction from output text and confidence envelope.
- Feed signals into existing escalation/review/panel/hedge gates.
- Emit clear notices only when a real additional run starts.

Unit gate:

- Pure signal extraction tests.
- Admission tests: free-plan veto, Efficient never-auto, Max eligible, panel requires two
  authenticated providers.
- Attempts remain bounded by `policy.maxAttempts`.

Real-run verification:

1. Use a repo fixture with a surface bug whose root cause is in shared state or auth/data code.
2. Type: `fix the broken page`.
3. Correct behavior: the first model investigates, identifies the wider root cause, and either
   escalates/reviews/forms a panel under policy or states why it is handling locally.
4. It must not ask the user to choose "debug/refactor/integrate."

### Stage 5 - Grounded recommendation validator

Goal: make informed opinion reliable.

Mechanisms:

- Add `require_grounded_recommendation` for substantial turns.
- Detect recommendation plus grounding facts: files, repo-map, sources, assumptions, or missing
  context.
- Retry once when missing.

Unit gate:

- Validator accepts concrete file-grounded recommendations.
- Validator rejects option lists with no recommendation on substantial tasks.
- Validator skips tiny factual turns.

Real-run verification:

1. Type: `should we keep this in TypeScript or move the core to another language?`
2. Correct behavior: it inspects enough repo context, recommends a default, flags what would
   change the decision, and asks only a genuine fork if needed.

### Stage 6 - Native-session and stale-history hardening

Goal: prevent provider-side resumed state from reintroducing old behavior.

Mechanisms:

- Add `HistoryPolicy` into native session planning.
- On quarantined turns, avoid resuming a poisoned provider session or force replayed compact
  state.
- Record an engine behavior version in conversation metadata or assistant entries so old
  transcript periods can be identified.

Unit gate:

- `planNativeSession` respects quarantine.
- History compaction excludes old generic assistant menus while preserving user asks and
  trusted workTrace.

Real-run verification:

1. Resume an old conversation known to contain pre-fix generic menus.
2. Ask a context-dependent repo question.
3. Correct behavior: no generic menu imitation; the answer follows the enforced directive.

---

## 5. Subscription-Cost Discipline

The design keeps the current subscription-first rules:

- No API keys.
- No embeddings.
- No vector DB.
- No metered third-party service.
- No new always-on model pass.
- Reuse `makeIntentExtractor` and provider `run(req, signal)` machinery.
- Keep the 8s intent cap and 20s router cap.
- Keep `policy.maxAttempts`.
- Keep panel/hedge opt-in/risk/admission gates.
- Make every added mechanism sheddable:
  - Under quota pressure, skip optional intent triage expansion.
  - Keep deterministic validators.
  - Keep pre-provider structured asks because they save provider quota.
  - Disable repair retry before disabling the core answer.

---

## 6. Risks

- **Overblocking legitimate brainstorming.** Mitigation: generic-menu validator only fires on
  broad task-category menus and investigable/substantial turns.
- **False confidence in work-state.** Mitigation: separate claimed next actions from verified
  done; never mark done without evidence.
- **Extra retries can burn subscription quota.** Mitigation: one retry only, only on validator
  failure, bounded by `policy.maxAttempts`, and sheddable.
- **Native session quarantine may reduce continuity.** Mitigation: use it only when stale
  assistant behavior conflicts with the current directive; preserve work-state.
- **Panel escalation can overuse quota.** Mitigation: reuse `planPanel`, `authorizeTier`,
  authenticated-provider checks, `maxPanelProviders`, and existing policy gates.

---

## 7. Deliberately Not Building

- No embeddings or semantic vector memory.
- No separate agent runtime outside existing provider orchestration.
- No hardcoded project/product behavior.
- No new raw-mode/stdin changes in `src/interface/menu.ts`.
- No hidden second model call before every answer.
- No automatic file edits or source changes as part of this design round.
- No claim that work is done unless the system has evidence.
- No broad auto-panel on every ambiguous turn.

---

## 8. Ten-Line Executive Summary

1. The core fix is **advisory -> enforced**: `EngagementPlan` becomes an orchestrator-owned `TurnDirective`.
2. Prompt blocks remain, but they stop being the only behavior control.
3. Highest-leverage first stage: pre-provider `ask_user` plus post-output generic-menu validator.
4. Planned terminal questions should be emitted before any provider prose, with zero model attempts.
5. Generic "fix/add/polish/integrate?" prose should be rejected and repaired once.
6. Work-state should reuse `WorkContract` and persisted `SessionEntry.workTrace`.
7. "Done" must require evidence; checkpoints are next-action claims, not completion proof.
8. Vision triage routes parts to proceed, discuss, rearchitect, or investigate-then-propose.
9. Discovery-driven escalation should reuse panel/hedge/review/admission gates, not invent a new agent stack.
10. Real-run test for stage 1: resume a poisoned chat and verify it produces structured ask/orientation, never a generic menu.
