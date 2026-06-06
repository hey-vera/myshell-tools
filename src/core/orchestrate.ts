/**
 * src/core/orchestrate.ts — the bounded escalation + review loop.
 *
 * Implements the Phase-2 multi-tier loop:
 *   classify → route → run IC → (optionally) cross-vendor review → assess →
 *   escalate/retry/accept → final
 *
 * Control-flow overview:
 *   1. Classify the task.
 *   2. If no providers → notice(error) + final(false); return.
 *   3. Append user session entry once.
 *   4. Loop (≤ maxAttempts):
 *      a. Route to provider+model for currentTier.
 *      b. Yield tier-start → stream provider events → yield tier-done.
 *      c. Provider failure → escalate to manager (or break if already there).
 *      d. If IC tier + shouldReview(classification, assessment):
 *         run cross-vendor reviewer at manager tier.
 *         approve → accept; revise → retry IC with notes; escalate → escalate tier.
 *      e. Low-confidence / escalate signal → nextTierUp → continue.
 *      f. All good → yield final(success:true); return.
 *   5. Loop exhausted or broke on failure → yield final(success:false).
 *
 * Purity rules (enforced by test/arch/guards.test.ts):
 *  - No imports of fs / path / child_process
 *  - No console.* calls
 *  - No Date.now() / Math.random() / new Date() — use deps.clock
 *  - No process.exit() — only src/cli.ts may terminate the process
 */

import type { CoreEvent, OrchestrateDeps, Tier, Risk, Classification, Assessment, Policy } from './types.js';
import type { CliError, Usage, ProviderRequest, Provider, ProviderId } from '../providers/port.js';
import { decideRoute } from './router.js';
import { route, clampTier, selectReasoningEffort, type CapabilityRouteContext, type CapabilityTaskSignals } from './route.js';
import { findCapability, type CapabilityRegistry, type ReasoningEffort, type TaskKind } from './model-capabilities.js';
import { modeFromPolicy, type Mode } from './policy.js';
import { authorizeTier } from './flagship.js';
import type { FlagshipTrigger, FlagshipDecision } from './flagship.js';
import { buildPrompt } from './prompt.js';
import { assess } from './assess.js';
import { parseQuestions } from './questions.js';
import {
  parseRememberUser,
  worthGate,
  type Candidate,
  type RememberProposal,
} from './user-memory.js';
import { compactHistory } from './history.js';
import { getModelPricing, calculateCost } from '../infra/pricing.js';
import { nextTierUp, pickReviewer } from './escalate.js';
import { buildReviewPrompt, parseReviewVerdict } from './review.js';
import { planPanel, runPanel } from './ensemble.js';
import { planHedge, runHedged } from './hedge.js';
import type { WorkContract } from './work-contract.js';
import { capContract, shouldMaterializeContract, isCleanObjectiveTask } from './work-contract.js';
import type { IntentFrame } from './intent.js';
import { shouldExtractIntent, rulesIntentFrame, renderIntentBlock } from './intent.js';
import { planEngagement, seedFromIntentAndPlan, renderEngagementBlock, deriveAskFromForks } from './engagement.js';
import type { EngagementSignals } from './engagement.js';
import {
  compileTurnDirective,
  validateTurnOutput,
  detectGenericOpenMenu,
  GENERIC_MENU_REPAIR_NOTE,
} from './turn-directive.js';
import { engagementBiasOf } from './prompt-context.js';
import { deriveWorkStateFromHistory, renderWorkStateBlock } from './work-state.js';

// ---------------------------------------------------------------------------
// Pure helper: should this output be cross-vendor reviewed?
// ---------------------------------------------------------------------------

/**
 * Decides whether a cross-vendor review should be triggered, given the task
 * classification, assessment signals, and the active review policy.
 *
 * @param classification - Task classification (tier + risk).
 * @param assessment     - Model self-assessment (confidence, escalate, needsReview).
 * @param reviewPolicy   - Policy field; `undefined` is treated as `'auto'` for
 *                         backward compatibility.
 */
function shouldReview(
  classification: Classification,
  assessment: Assessment,
  reviewPolicy: Policy['reviewPolicy'],
): boolean {
  // 'off' — never auto-review.
  if (reviewPolicy === 'off') return false;

  // 'critical-only' — review only when risk is critical.
  if (reviewPolicy === 'critical-only') {
    return classification.risk === 'critical';
  }

  // 'auto' (or undefined, treated as 'auto') — original behaviour.
  return (
    classification.risk === 'high' ||
    classification.risk === 'critical' ||
    assessment.needsReview === true
  );
}

// ---------------------------------------------------------------------------
// Pure helpers: capability task-signal derivation (capability registry §3).
// These are deterministic (no model call, no I/O) and feed the optional
// CapabilityRouteContext that activates capability-fit + reasoning-effort.
// ---------------------------------------------------------------------------

/** Keyword sets for deterministic taskKind classification. Lowercased matching. */
const ARCHITECTURE_KEYWORDS = [
  'architect', 'architecture', 'design', 'migration plan', 'rearchitect',
  'system design', 'tradeoff', 'trade-off', 'high-level plan', 'roadmap',
] as const;
const DEBUG_KEYWORDS = ['debug', 'bug', 'fix the', 'stack trace', 'why is', "doesn't work", 'failing test', 'broken'] as const;
const REVIEW_KEYWORDS = ['review', 'audit', 'critique', 'assess the', 'evaluate the'] as const;
const TRIVIAL_KEYWORDS = ['what is', 'list', 'show me', 'print', 'rename', 'typo'] as const;

/** True when any keyword is a substring of the lowercased text. PURE. */
function hasAnyKeyword(lowerText: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => lowerText.includes(k));
}

/**
 * The large-context engage threshold (tokens) at/above which a turn is classified
 * `large-context` from size alone. Mirrors route.ts's LARGE_CONTEXT_ENGAGE_TOKENS
 * intent (kept as a local constant so this module stays decoupled). PURE.
 */
const LARGE_CONTEXT_TASKKIND_TOKENS = 100_000;

/**
 * Derive a deterministic {@link TaskKind} from the existing classification signals
 * (tier + risk), the route plan flag, the task text keywords, the estimated input
 * size, and whether the review path will run. PURE, conservative: uncertain →
 * 'unknown' (never guessed). Mirrors §2 Layer 3 / §3 examples:
 *  - manager + architecture keywords → 'architecture'
 *  - review path / review keywords   → 'review'
 *  - big input estimate              → 'large-context'
 *  - debug keywords                  → 'debug'
 *  - else IC/manager substantial     → 'implementation'; trivial worker → 'trivial'
 */
function deriveTaskKind(input: {
  readonly task: string;
  readonly tier: Tier;
  readonly risk: Risk;
  readonly routePlan: boolean;
  readonly estimatedInputTokens: number;
}): TaskKind {
  const lower = input.task.toLowerCase();
  // Large-context wins first when the input is genuinely huge — a big repo-map /
  // prompt is a large-context turn regardless of phrasing.
  if (input.estimatedInputTokens >= LARGE_CONTEXT_TASKKIND_TOKENS) return 'large-context';
  // Architecture: a manager-tier (or plan-first) turn with design/architecture
  // language. Restricting to manager/plan keeps a casual "design a logo" worker
  // turn from claiming architecture.
  if (
    (input.tier === 'manager' || input.routePlan) &&
    hasAnyKeyword(lower, ARCHITECTURE_KEYWORDS)
  ) {
    return 'architecture';
  }
  if (hasAnyKeyword(lower, REVIEW_KEYWORDS)) return 'review';
  if (hasAnyKeyword(lower, DEBUG_KEYWORDS)) return 'debug';
  if (input.tier === 'worker' && input.risk === 'low' && hasAnyKeyword(lower, TRIVIAL_KEYWORDS)) {
    return 'trivial';
  }
  if (input.tier === 'ic' || input.tier === 'manager') return 'implementation';
  // Worker turns with no clearer signal: don't over-claim — 'unknown'.
  return 'unknown';
}

/** Cheap deterministic token estimate ≈ chars/4 over the prompt-shaped inputs. PURE. */
function estimateInputTokens(parts: ReadonlyArray<string | undefined>): number {
  let chars = 0;
  for (const p of parts) if (p !== undefined) chars += p.length;
  return Math.floor(chars / 4);
}

/**
 * Select the reasoning effort for a resolved RouteDecision against the merged
 * registry, returning `undefined` when the registry is absent, the chosen model
 * has no capability record, or the model declares no efforts. The chosen tier
 * (decision.tier) is the tier the policy ALREADY granted (after route()'s clamp /
 * admission), so passing it here can never open manager or exceed policy — the
 * selector only decides how deep to think within the granted tier. PURE.
 */
function effortForDecision(
  registry: CapabilityRegistry | undefined,
  provider: ProviderId,
  model: string,
  tier: Tier,
  mode: Mode,
  signals: CapabilityTaskSignals,
): ReasoningEffort | undefined {
  if (registry === undefined) return undefined;
  const cap = findCapability(registry, provider, model);
  if (cap === undefined) return undefined;
  return selectReasoningEffort({
    model: cap,
    mode,
    tier,
    risk: signals.risk,
    taskKind: signals.taskKind,
    routePlan: signals.routePlan,
  });
}

/**
 * Parse a model-proposed `remember_user` block from a NORMAL successful turn's
 * final text and keep ONLY the facts that pass `worthGate` as
 * `agent_inferred / model_proposed` candidates (so a secret / noise / instruction
 * never even surfaces as a proposal — memory doc §8(b)). Returns a
 * `RememberProposal` of the surviving facts, or `undefined` when there is no
 * block or none survive the gate. Pure; never throws.
 *
 * Attached to the final ONLY on the normal (non-question) success path so it can
 * never ride alongside `questions` (the two are mutually exclusive). The
 * interface renders the Save/Skip/Edit selector for it via the post-turn slot.
 */
function memoryProposalFor(finalText: string | undefined): RememberProposal | undefined {
  const proposal = parseRememberUser(finalText ?? '');
  if (proposal === null) return undefined;
  const kept = proposal.facts.filter((f) => {
    const candidate: Candidate = {
      scope: f.scope,
      projectKey: null,
      shape: f.kind === 'correction' ? 'collection' : 'profile',
      kind: f.kind,
      subjectHint: f.text,
      text: f.text,
      reason: f.reason,
      trust: 'agent_inferred',
      source: 'model_proposed',
    };
    return worthGate(candidate).ok;
  });
  if (kept.length === 0) return undefined;
  return { facts: kept };
}

/**
 * Wrap a delegated panel/hedge event stream and attach a model-proposed memory
 * block to its successful final — parity with the sequential path (closes the
 * Phase-9 implementation re-gate's F1 gap, where panel/hedge injected memory but
 * never proposed it). Attaches ONLY to a normal success final that carries
 * neither questions nor an existing proposal, preserving the questions ⊻ memory
 * mutual-exclusivity invariant. Pure pass-through for every other event.
 */
export async function* withMemoryProposalAttached(
  source: AsyncGenerator<CoreEvent>,
): AsyncGenerator<CoreEvent> {
  for await (const ev of source) {
    if (
      ev.type === 'final' &&
      ev.success === true &&
      ev.questions === undefined &&
      ev.memoryProposal === undefined
    ) {
      const memoryProposal = memoryProposalFor(ev.output);
      yield memoryProposal !== undefined ? { ...ev, memoryProposal } : ev;
    } else {
      yield ev;
    }
  }
}

// ---------------------------------------------------------------------------
// Private streaming helper
// ---------------------------------------------------------------------------

interface StreamOutcome {
  finalText: string | undefined;
  errored: CliError | undefined;
  usage: Usage | undefined;
  providerCostUsd: number | undefined;
  /** Provider-assigned session/thread id captured from the `done` event, if any. */
  sessionId: string | undefined;
  canceled: boolean;
  /** True only when the signal was already aborted before streaming started. */
  canceledBeforeStream: boolean;
}

interface AcceptedRunSessionData {
  readonly content: string;
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string;
  readonly confidence: number | null;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly sessionId?: string;
  readonly workTrace?: WorkContract;
}

async function appendAcceptedAssistant(
  deps: OrchestrateDeps,
  run: AcceptedRunSessionData,
): Promise<void> {
  await deps.session.append({
    timestamp: deps.clock.isoNow(),
    role: 'assistant',
    content: run.content,
    tier: run.tier,
    provider: run.provider,
    model: run.model,
    confidence: run.confidence,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    ...(run.workTrace !== undefined ? { workTrace: run.workTrace } : {}),
  });
}

/**
 * Stream a single provider run, yielding `{type:'provider-event', tier, event}`
 * for every event, while accumulating `finalText`, `usage`, `providerCostUsd`,
 * and `errored`.  Cancellation via `signal` is detected both before and after
 * each event; on cancellation the generator returns immediately with
 * `canceled: true` (no notice/final events — the caller emits those).
 */
async function* streamProvider(
  provider: Provider,
  req: ProviderRequest,
  tier: Tier,
  signal: AbortSignal,
): AsyncGenerator<CoreEvent, StreamOutcome> {
  let finalText: string | undefined;
  let errored: CliError | undefined;
  let usage: Usage | undefined;
  let providerCostUsd: number | undefined;
  let sessionId: string | undefined;

  // Pre-stream abort check
  if (signal.aborted) {
    return { finalText, errored, usage, providerCostUsd, sessionId, canceled: true, canceledBeforeStream: true };
  }

  for await (const ev of provider.run(req, signal)) {
    yield { type: 'provider-event', tier, event: ev };

    if (ev.type === 'done') {
      finalText = ev.text;
      // done.usage is the authoritative accumulated total.
      if (ev.usage !== undefined) {
        usage = ev.usage;
      }
      if (ev.costUsd !== undefined) {
        providerCostUsd = ev.costUsd;
      }
      if (ev.sessionId !== undefined && ev.sessionId.length > 0) {
        sessionId = ev.sessionId;
      }
    } else if (ev.type === 'error') {
      errored = ev.error;
    } else if (ev.type === 'usage' && usage === undefined) {
      usage = ev.usage;
    }

    if (signal.aborted) {
      return { finalText, errored, usage, providerCostUsd, sessionId, canceled: true, canceledBeforeStream: false };
    }
  }

  return { finalText, errored, usage, providerCostUsd, sessionId, canceled: false, canceledBeforeStream: false };
}

/**
 * Consume a provider run for terminal data only. Internal control-plane runs
 * such as cross-vendor review must not stream their prose to the renderer.
 */
async function collectProviderRun(
  provider: Provider,
  req: ProviderRequest,
  signal: AbortSignal,
): Promise<StreamOutcome> {
  let finalText: string | undefined;
  let errored: CliError | undefined;
  let usage: Usage | undefined;
  let providerCostUsd: number | undefined;
  let sessionId: string | undefined;

  if (signal.aborted) {
    return { finalText, errored, usage, providerCostUsd, sessionId, canceled: true, canceledBeforeStream: true };
  }

  for await (const ev of provider.run(req, signal)) {
    if (ev.type === 'done') {
      finalText = ev.text;
      // done.usage is the authoritative accumulated total.
      if (ev.usage !== undefined) {
        usage = ev.usage;
      }
      if (ev.costUsd !== undefined) {
        providerCostUsd = ev.costUsd;
      }
      if (ev.sessionId !== undefined && ev.sessionId.length > 0) {
        sessionId = ev.sessionId;
      }
    } else if (ev.type === 'error') {
      errored = ev.error;
    } else if (ev.type === 'usage' && usage === undefined) {
      usage = ev.usage;
    }

    if (signal.aborted) {
      return { finalText, errored, usage, providerCostUsd, sessionId, canceled: true, canceledBeforeStream: false };
    }
  }

  return { finalText, errored, usage, providerCostUsd, sessionId, canceled: false, canceledBeforeStream: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Orchestrate a task through the bounded escalation + review loop.
 *
 * Yields a sequence of {@link CoreEvent} objects.
 * The interface/render layer drives the generator and surfaces events to
 * the user.
 *
 * @param task   - The raw user task description.
 * @param deps   - Injected dependencies (providers, clock, session, ledger, policy, …).
 * @param signal - AbortSignal; when aborted the generator stops and yields a
 *                 notice(warn, 'cancelled') followed by final(success:false).
 */
export async function* orchestrate(
  task: string,
  depsArg: OrchestrateDeps,
  signal: AbortSignal,
): AsyncGenerator<CoreEvent> {
  // -------------------------------------------------------------------------
  // (a) Decide the route. Deterministic rules first; the model-brained router
  //     (core/router.ts) only arbitrates turns the keyword classifier couldn't
  //     route, and only when deps.routeClassifier is wired. decision.plan is
  //     reserved for plan-first mode (Phase C).
  // -------------------------------------------------------------------------
  const decision = await decideRoute(task, {
    ...(depsArg.routeClassifier !== undefined ? { classifier: depsArg.routeClassifier } : {}),
    signal,
  });
  const classification: Classification = {
    tier: decision.tier,
    risk: decision.risk,
    rationale: decision.rationale,
  };
  const routePlan = decision.plan;
  yield { type: 'classified', classification };

  // -------------------------------------------------------------------------
  // (a2) INTENT ENGINE + ADAPTIVE PARTNER ENGINE (Phase 6 / APE).
  //
  // GATED, fail-soft, ZERO-overhead on trivial turns. shouldExtractIntent is the
  // pure gate (the intent analogue of hasTierEvidence): clear/cheap turns skip
  // the model pass entirely → EXECUTE_NOW, no extra call. Substantial/ambiguous
  // turns run the cheap, read-only, short-timeout extractor (the ONLY model touch
  // here) and fall back to the deterministic rulesIntentFrame on ANY failure
  // (null/timeout/bad-parse) — never a hang, never a blocked turn.
  //
  // planEngagement is then a PURE decision over {frame, classification, routePlan,
  // engagementBias, memoryBias} → an ordered EngagementPlan. It adds NO model
  // call (it rides the one gated intent call). The rendered INTENT + ENGAGEMENT
  // blocks flow through the Phase-2 prompt seam (assembleContextBlocks) to the
  // sequential, hedge, AND panel executors via the per-turn `deps` copy below.
  // -------------------------------------------------------------------------
  let intentFrame: IntentFrame | undefined;
  const runIntent =
    // Autonomous /goal turns own their roadmap loop (work-contract.ts) — running
    // the intent pass per goal sub-turn would double-plan (APE §5.9). The initial
    // goal contract is already seeded by the interface layer. So the gate never
    // fires inside a goal turn; the deterministic frame still feeds APE/seed.
    depsArg.goalTurn !== true &&
    shouldExtractIntent({
      task,
      classification,
      routePlan,
      ...(depsArg.partnerStyle !== undefined ? { partnerStyle: depsArg.partnerStyle } : {}),
      hasExtractor: depsArg.intentExtractor !== undefined,
    });
  if (runIntent && depsArg.intentExtractor !== undefined) {
    let extracted: IntentFrame | null = null;
    try {
      extracted = await depsArg.intentExtractor(task, signal);
    } catch {
      extracted = null; // fail-soft: extractor threw → rules fallback
    }
    intentFrame = extracted ?? rulesIntentFrame(task, classification, 'rules-fallback');
  } else {
    // Trivial turn (or no extractor): a cheap, deterministic, source:'skipped'
    // frame. No model call, no latency. It still lets APE/seed read a goal.
    intentFrame = rulesIntentFrame(task, classification, 'skipped');
  }
  const engagementSignals: EngagementSignals = {
    ...(intentFrame !== undefined ? { frame: intentFrame } : {}),
    classification,
    routePlan,
    engagementBias: depsArg.partnerStyle !== undefined ? engagementBiasOf(depsArg.partnerStyle) : 0,
    task,
  };
  const engagementPlan = planEngagement(engagementSignals);

  // -------------------------------------------------------------------------
  // (a3) ADAPTIVE PARTNER ENGINE v2 — compile the enforced TurnDirective (Stage 1).
  //
  // The EngagementPlan above is ADVISORY (rendered as prompt text). The directive
  // is the orchestrator-owned ENFORCED form (adaptive-partner-v2-5.6.md §2.1):
  //   - terminalQuestion: a planned ASK_CLARIFYING at a GENUINE non-investigable
  //     fork is emitted BEFORE the provider run (zero tokens) — §2.2 A1.
  //   - reject_generic_open_menu: the model's final prose is validated for the
  //     order-taker "fix/add/polish/integrate?" menu, with one repair retry — §2.2 A2.
  //   - historyPolicy: prior assistant generic-menu prose is quarantined from the
  //     replayed history so it can't few-shot the new turn — §3.
  // PURE compile, NO model call — it consumes the already-computed plan/frame.
  const priorAssistantTexts =
    depsArg.history !== undefined
      ? depsArg.history.filter((e) => e.role === 'assistant').map((e) => e.content)
      : undefined;

  // (a3b) WORK-STATE AWARENESS (adaptive-partner-v2-5.6.md §2.3 B). Reconstruct a
  // TRUTHFUL "what's done / what's next" snapshot from accepted prior turns'
  // persisted workTrace — PURE, no model call. Prefer a snapshot menu.ts already
  // derived from the same history (deps.workStateContext is pre-rendered there);
  // otherwise derive here from deps.history. The directive carries the snapshot and
  // the rendered block rides the prompt seam, so a resumed chat knows what was last
  // done + the next honest step. Truthful or absent: undefined → omitted.
  const workState =
    depsArg.history !== undefined ? deriveWorkStateFromHistory(depsArg.history) : undefined;

  const directive = compileTurnDirective({
    frame: intentFrame,
    plan: engagementPlan,
    signals: engagementSignals,
    repoPresent: depsArg.environmentContext !== undefined && depsArg.environmentContext.length > 0,
    ...(priorAssistantTexts !== undefined ? { priorAssistantTexts } : {}),
    ...(workState !== undefined ? { workState } : {}),
  });

  // Pre-render the INTENT + ENGAGEMENT blocks ONCE and thread them onto a per-turn
  // deps copy so they reach every executor through the shared seam with no further
  // plumbing. Empty blocks (trivial/silent) are omitted → byte-identical to today.
  const intentBlock = runIntent ? renderIntentBlock(intentFrame) : '';
  const engagementBlock = renderEngagementBlock(engagementPlan);
  // Render the truthful WORK STATE block once. menu.ts may have pre-rendered it
  // from the same history into deps.workStateContext (so it survives even the
  // pre-provider terminal-ask path's prompt); fall back to rendering here.
  const workStateBlock =
    depsArg.workStateContext !== undefined && depsArg.workStateContext.length > 0
      ? depsArg.workStateContext
      : renderWorkStateBlock(workState);

  // Render-optional events (locked APE default #1): surface intent ONLY when the
  // gated pass ran AND produced a non-empty reflection block; surface engagement
  // ONLY when the plan produces a VISIBLE action (a non-empty block). The silent
  // mechanics (bare EXECUTE_NOW, depth, escalation, fast-path) emit nothing, so a
  // plain substantial turn keeps the classified → tier-start stream unchanged.
  if (runIntent && intentFrame !== undefined && intentBlock.length > 0) {
    yield { type: 'intent', frame: intentFrame };
  }
  if (engagementBlock.length > 0) {
    yield { type: 'engagement', plan: engagementPlan };
  }

  const deps: OrchestrateDeps =
    intentBlock.length > 0 || engagementBlock.length > 0 || workStateBlock.length > 0
      ? {
          ...depsArg,
          ...(intentBlock.length > 0 ? { intentFrame: intentBlock } : {}),
          ...(engagementBlock.length > 0 ? { engagementPlan: engagementBlock } : {}),
          ...(workStateBlock.length > 0 ? { workStateContext: workStateBlock } : {}),
        }
      : depsArg;

  // Work-contract seed: prefer the frame's goal/vision (and a plan-aware roadmap
  // when planFirst) over the verbatim task copy. Consumes route.plan THROUGH APE
  // (plan.planFirst). Falls back to the prior capContract seed when there's no
  // usable goal. Caps/render/checkpoints/verification stay the work-contract's.
  const incomingWorkContract =
    deps.workContract !== undefined ? capContract(deps.workContract) : undefined;
  const normalRoadmapDecision = shouldMaterializeContract({
    classification,
    routePlan,
    context: 'normal',
    reviewWillRun: false,
  });
  const seededTrace =
    incomingWorkContract === undefined &&
    normalRoadmapDecision.roadmap &&
    isCleanObjectiveTask(task)
      ? (seedFromIntentAndPlan(intentFrame, engagementPlan, task) ??
        capContract({ version: 1, objective: task }))
      : undefined;
  const workTrace =
    incomingWorkContract !== undefined ? incomingWorkContract : seededTrace;

  // -------------------------------------------------------------------------
  // (a4) PRE-PROVIDER TERMINAL ASK (adaptive-partner-v2-5.6.md §2.2 A1).
  //
  // When the directive carries a terminalQuestion (planEngagement chose
  // ASK_CLARIFYING at a GENUINE non-investigable fork), the orchestrator OWNS the
  // ask: it emits the structured QuestionSet BEFORE any provider run and returns.
  // The model never runs — zero provider attempts, zero tokens, totalCostUsd 0 —
  // so a planned terminal ask can no longer be ignored by the model or poisoned by
  // stale history. This flows through the SAME final+questions path the interface
  // already renders for ask_user, so the selectable multiple-choice UI appears.
  //
  // We append the user entry + an EMPTY assistant entry (carrying workTrace) so the
  // turn is recorded symmetrically with the model-ask path, then yield the final.
  // Placed BEFORE the panel/hedge branches and the no-providers path: a free,
  // model-less ask takes precedence over every metered route.
  if (directive.terminalQuestion !== undefined) {
    await deps.session.append({
      timestamp: deps.clock.isoNow(),
      role: 'user',
      content: task,
    });
    await deps.session.append({
      timestamp: deps.clock.isoNow(),
      role: 'assistant',
      content: '',
      ...(workTrace !== undefined ? { workTrace } : {}),
    });
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

  // -------------------------------------------------------------------------
  // (b) Resolve available providers
  // -------------------------------------------------------------------------
  const available = (Object.keys(deps.providers) as Array<keyof typeof deps.providers>).filter(
    (id) => deps.providers[id] !== undefined,
  ) as ProviderId[];

  // -------------------------------------------------------------------------
  // (c) No providers path
  // -------------------------------------------------------------------------
  if (available.length === 0) {
    yield {
      type: 'notice',
      level: 'error',
      message:
        'No providers are available. Install and authenticate at least one provider ' +
        '(claude, codex, or opencode) and try again.',
    };
    yield {
      type: 'final',
      success: false,
      output: 'No providers available.',
      tier: classification.tier,
      totalCostUsd: 0,
      sessionId: deps.session.id,
      attempts: 0,
    };
    return;
  }

  // -------------------------------------------------------------------------
  // (c2) Parallel Subscription Panel (EXPERIMENTAL, opt-in, default OFF).
  //      planPanel() returns null unless deps.policy.panelPolicy opts in AND ≥2
  //      authenticated providers exist (and, for 'hard-turns', the turn is high/
  //      critical risk). When it returns a plan we delegate the ENTIRE turn to the
  //      panel and return — runPanel owns the user/assistant session appends,
  //      ledger records, and the streamed answer, so the sequential code below
  //      (including the single user append in (d)) never runs for this turn.
  //      Because panelPolicy defaults to 'off', planPanel returns null on every
  //      existing path → ZERO behaviour change. We branch here, BEFORE (d), so the
  //      user message is appended exactly once (by runPanel).
  // Compute the compacted history ONCE here (shared by the panel branch and the
  // sequential loop below) so a long history isn't compacted twice per turn.
  //
  // HISTORY QUARANTINE (adaptive-partner-v2-5.6.md §3): when the directive's
  // historyPolicy is 'quarantine_assistant_prose' (a prior ASSISTANT turn was
  // itself a generic open menu), drop ONLY those poisoned assistant entries before
  // compacting so they cannot few-shot the new turn back into the order-taker
  // behavior. User entries are NEVER dropped; the store is untouched (we filter a
  // local copy only). Fail-soft: any other policy uses the full history as before.
  const replayHistory =
    directive.historyPolicy.replayMode === 'quarantine_assistant_prose' &&
    deps.history !== undefined
      ? deps.history.filter(
          (e) => !(e.role === 'assistant' && detectGenericOpenMenu(e.content)),
        )
      : deps.history;
  const historyContext =
    replayHistory !== undefined && replayHistory.length > 0
      ? compactHistory(replayHistory)
      : undefined;

  // -------------------------------------------------------------------------
  // (c1) CAPABILITY TASK SIGNALS (capability registry §3) — computed ONCE per
  //      turn, deterministically, with NO model call. These activate the
  //      capability-fit re-rank + reasoning-effort selector when (and only when)
  //      deps.capabilityRegistry is present (the SAME merged snapshot the
  //      self-awareness summary is built from in cli.ts/menu.ts, REUSED here).
  //      ABSENT registry → capabilityContext stays undefined, no effort is ever
  //      selected, and every route() call below behaves byte-for-byte as before.
  // -------------------------------------------------------------------------
  const mode: Mode = modeFromPolicy(deps.policy);
  const estimatedInputTokens = estimateInputTokens([
    task,
    historyContext,
    deps.environmentContext,
    deps.toolStateContext,
    deps.memoryContext,
    deps.workStateContext,
    deps.intentFrame,
    deps.engagementPlan,
  ]);
  // needsVision is true ONLY when the turn genuinely carries image input. The
  // text-only orchestration pipeline has no image channel today, so this stays
  // false (the vision gate never fires falsely). Reserved for a future image path.
  const taskSignals: CapabilityTaskSignals = {
    risk: classification.risk,
    routePlan,
    estimatedInputTokens,
    needsVision: false,
    taskKind: deriveTaskKind({
      task,
      tier: classification.tier,
      risk: classification.risk,
      routePlan,
      estimatedInputTokens,
    }),
  };
  /**
   * The opt-in capability context handed to route(). Built ONLY when the registry
   * is present; absent → undefined → route() gets its existing argument list
   * unchanged. Reused for the work route, the failover preview, and the review
   * route so every site re-ranks with the SAME facts.
   */
  // Learned MODEL-level outcome order for THIS turn's taskKind (Stage 4, §2 Layer
  // 3). The impure ledger READ + aggregation happens in the conversation layer
  // (cli.ts / menu.ts) via learnModelOutcomeOrder; here we just SELECT the entry
  // for the current taskKind from the immutable snapshot the caller passed. Absent
  // (feature off / cold-start / below-threshold → no entry) → undefined → route()
  // gets no learned tie-break and behaviour is byte-for-byte unchanged.
  const workModelOutcomeOrder = deps.modelOutcomeOrderByTaskKind?.[taskSignals.taskKind];
  const capabilityContext: CapabilityRouteContext | undefined =
    deps.capabilityRegistry !== undefined
      ? {
          registry: deps.capabilityRegistry,
          taskSignals,
          mode,
          ...(workModelOutcomeOrder !== undefined
            ? { modelOutcomeOrder: workModelOutcomeOrder }
            : {}),
        }
      : undefined;

  const panelPlan = planPanel({
    panelPolicy: deps.policy.panelPolicy,
    classification,
    // Use the as-classified tier — the panel routes each candidate through
    // route(), which applies the policy's own tier ceiling per provider.
    tier: classification.tier,
    authenticatedProviders: deps.authenticatedProviders ?? [],
    maxPanelProviders: deps.policy.maxPanelProviders ?? 2,
  });
  if (panelPlan !== null) {
    yield* withMemoryProposalAttached(runPanel(task, deps, panelPlan, signal, historyContext));
    return;
  }

  // -------------------------------------------------------------------------
  // (c3) Latency-Hedged Escalation (EXPERIMENTAL, opt-in, default OFF).
  //      Only considered when NO panel formed (panel takes precedence). planHedge()
  //      returns null unless deps.policy.hedgePolicy === 'on' AND a delay port
  //      (deps.sleep) is injected AND the turn is high/critical risk AND the
  //      flagship is admittable AND the turn isn't already at manager AND ≥1
  //      provider is authenticated. When it returns a plan we delegate the ENTIRE
  //      turn to the hedge executor and return — runHedged owns the user/assistant
  //      session appends, ledger records, and the streamed answer, so the sequential
  //      code below (including the single user append in (d)) never runs for this
  //      turn. Because hedgePolicy defaults to 'off', planHedge returns null on
  //      every existing path → ZERO behaviour change. We branch BEFORE (d) so the
  //      user message is appended exactly once (by runHedged).
  const hedgePlan = planHedge({
    hedgePolicy: deps.policy.hedgePolicy,
    classification,
    policy: deps.policy,
    authenticatedProviders: deps.authenticatedProviders ?? [],
    hasSleep: deps.sleep !== undefined,
  });
  if (hedgePlan !== null) {
    yield* withMemoryProposalAttached(runHedged(task, deps, hedgePlan, signal, historyContext));
    return;
  }

  // -------------------------------------------------------------------------
  // (d) Append user message to session once (before any tier run)
  // -------------------------------------------------------------------------
  await deps.session.append({
    timestamp: deps.clock.isoNow(),
    role: 'user',
    content: task,
  });

  // -------------------------------------------------------------------------
  // (e) Loop state
  // -------------------------------------------------------------------------
  let currentTier: Tier = classification.tier;
  let managerNotes: string | undefined;
  let attempts = 0;
  let totalCostUsd = 0;
  let lastOutput = '';
  let acceptedRun: AcceptedRunSessionData | undefined;
  /** Track the last error category across all attempts (for the failing final). */
  let lastErroredCategory: import('../providers/port.js').CliError['category'] | undefined;
  /** Track the last attempted provider (for the failing final). */
  let lastAttemptedProvider: ProviderId | undefined;
  /**
   * Manager-tier attempts used this turn — the quota guard for adaptive flagship
   * admission (Balanced earns a bounded number of flagship passes per turn).
   */
  let flagshipAttemptsThisTurn = 0;

  /**
   * Generic-open-menu repair budget (adaptive-partner-v2-5.6.md §2.2 A2). The
   * `reject_generic_open_menu` validator may fire ONCE per turn: when a successful
   * answer is the order-taker menu, we re-run the SAME tier once with a manager-
   * style repair note. Bounded at 1 (distinct from MAX_REVISE_RETRIES, which is
   * the reviewer-revise budget) so it never adds a second metered call on a turn
   * that already passed. A repaired answer that still fails is KEPT (never
   * discarded) — the best-effort accept paths below preserve a usable answer.
   */
  let genericMenuRepairs = 0;
  const MAX_VALIDATOR_REPAIRS = 1;

  /**
   * Per-tier set of providers that have already been tried, used by the
   * cross-vendor failover logic so we never retry the same provider twice
   * within a tier on consecutive execution failures.
   */
  const triedByTier = new Map<Tier, Set<ProviderId>>();

  /**
   * When non-null, the next iteration must route among only these providers
   * (the remaining untried vendors at the current tier).  Cleared after use.
   */
  let failoverPool: ProviderId[] | null = null;

  // (historyContext is computed once above, before the panel branch, and reused
  // here — it is injected into the first-tier prompt so stateless providers get
  // multi-turn context; the history does NOT grow during the loop.)
  /**
   * Track which attempt indices have already been reviewed so that re-runs
   * (e.g. after a revise verdict) are not reviewed a second time and we
   * cannot enter an infinite review loop.
   */
  const reviewedAttempts = new Set<number>();

  /**
   * How many times a reviewer's `revise` verdict has triggered a same-tier
   * re-run this turn. A `revise` re-executes the ENTIRE (often expensive)
   * investigation against the same model with feedback notes; left unbounded it
   * can drive the loop to exhaust `maxAttempts` re-doing the same heavy work and
   * then discard the result. We allow ONE revise re-run (apply the notes once);
   * beyond that, blind re-execution is wasteful — escalate to a stronger tier if
   * admission allows, otherwise accept the best answer we already have.
   */
  let reviseRetries = 0;
  const MAX_REVISE_RETRIES = 1;

  /**
   * Adaptive flagship admission for a manager request at the current decision
   * point. Closes over the live `currentTier` and `flagshipAttemptsThisTurn`.
   * Returns the full decision (tier + allowed + reason) so callers can surface an
   * honest notice on denial. Scopes the free-plan veto to the eligible
   * (authenticated, cooldown-filtered) candidate providers.
   */
  const admitManager = (trigger: FlagshipTrigger, assessmentArg?: Assessment): FlagshipDecision =>
    authorizeTier({
      requestedTier: 'manager',
      currentTier,
      classification,
      ...(assessmentArg !== undefined ? { assessment: assessmentArg } : {}),
      policy: deps.policy,
      ...(deps.planInfos !== undefined ? { planInfos: deps.planInfos } : {}),
      ...(deps.authenticatedProviders !== undefined
        ? { candidateProviders: deps.authenticatedProviders }
        : {}),
      flagshipAttemptsThisTurn,
      trigger,
    });

  // Adaptive flagship admission on the INITIAL route: a manager-classified turn
  // only starts on the flagship when the turn justifies it (high/critical risk, or
  // Max mode). Otherwise drop to IC — never open manager-first off a soft
  // classification. (The actual manager run is counted at the route below; earned
  // escalations later in the loop are gated separately.)
  if (currentTier === 'manager' && !admitManager('initial').allowed) {
    currentTier = 'ic';
  }

  // -------------------------------------------------------------------------
  // (f) Main orchestration loop
  // -------------------------------------------------------------------------
  mainLoop: while (attempts < deps.policy.maxAttempts) {
    attempts++;

    // --- Route for current tier ---
    // When a failoverPool is set (previous failure, untried vendors remain),
    // route among only those vendors for this one iteration, then clear the pool.
    const routePool = failoverPool ?? available;
    failoverPool = null;
    // When currentTier is 'manager' we have ALREADY passed adaptive admission
    // (initial gate or an earned escalation gate), so route() must not re-clamp it
    // back down via the static maxTier safety net — lift the ceiling to 'manager'
    // for this resolve. For worker/ic, the static policy (and its maxTier) applies.
    const effPolicy: Policy =
      currentTier === 'manager' ? { ...deps.policy, maxTier: 'manager' } : deps.policy;
    // Learned, observed-only provider order for the tier we're routing (the
    // Local Outcome Learner). Absent → routing is unchanged. We key on
    // currentTier (the requested tier); route() applies it after its own clamp,
    // and an entry for a tier the run clamps away simply finds no eligible match
    // and falls through to the static order.
    const decision = route(
      currentTier,
      routePool,
      effPolicy,
      deps.availableModels,
      deps.authenticatedProviders,
      deps.learnedProviderOrder?.[currentTier],
      capabilityContext,
    );

    // Reasoning effort for THIS run, selected against the resolved model's
    // capability facts (capability registry §3/§5). decision.tier is the tier the
    // policy ALREADY granted (after route()'s clamp), so this can never open
    // manager or exceed policy. undefined when no registry / no efforts → no flag.
    const reasoningEffort = effortForDecision(
      deps.capabilityRegistry,
      decision.provider,
      decision.model,
      decision.tier,
      mode,
      taskSignals,
    );

    // Count a flagship attempt the moment the run resolves to the manager tier
    // (the quota guard read by subsequent admission decisions this turn).
    if (decision.tier === 'manager') {
      flagshipAttemptsThisTurn++;
    }

    // Record this provider as tried at this tier.
    let tierTried = triedByTier.get(currentTier);
    if (tierTried === undefined) {
      tierTried = new Set();
      triedByTier.set(currentTier, tierTried);
    }
    tierTried.add(decision.provider);
    lastAttemptedProvider = decision.provider;

    const provider = deps.providers[decision.provider];
    if (provider === undefined) {
      yield {
        type: 'notice',
        level: 'error',
        message: `Provider "${decision.provider}" was selected by route() but is not present in deps.providers.`,
      };
      break mainLoop;
    }

    // --- Native session decision (EXPERIMENTAL, opt-in) ---
    // Use native continuity only when this tier's provider has a plan. Otherwise
    // (no plan for this provider) fall back to replaying the compacted history —
    // so switching providers never loses context.
    const nativePlan = deps.nativeSession?.find((p) => p.provider === decision.provider);
    const useNative = nativePlan !== undefined;

    // --- Build prompt (with optional reviewer feedback on retry + history context) ---
    // Bug 4 fix: inject managerNotes whenever defined, not just when currentTier === 'ic'.
    // When using a native session, skip the replayed history — the provider holds it.
    // Use decision.tier (the tier route() actually resolved, AFTER any maxTier
    // clamp) — not the requested currentTier — so the persona prompt always
    // matches the model that runs (e.g. balanced clamps manager→ic: we must use
    // the IC persona on the sonnet model, never the manager persona).
    const prompt = buildPrompt(
      decision.tier,
      task,
      managerNotes,
      useNative ? undefined : historyContext,
      {
        ...(deps.goalTurn === true ? { goalTurn: true } : {}),
        ...(deps.partnerStyle !== undefined ? { partnerStyle: deps.partnerStyle } : {}),
        ...(deps.environmentContext !== undefined ? { environmentContext: deps.environmentContext } : {}),
        ...(deps.toolStateContext !== undefined ? { toolStateContext: deps.toolStateContext } : {}),
        ...(deps.memoryContext !== undefined ? { memoryContext: deps.memoryContext } : {}),
        ...(deps.workStateContext !== undefined ? { workStateContext: deps.workStateContext } : {}),
        ...(deps.intentFrame !== undefined ? { intentFrame: deps.intentFrame } : {}),
        ...(deps.engagementPlan !== undefined ? { engagementPlan: deps.engagementPlan } : {}),
      },
    );

    // --- Yield tier-start ---
    yield {
      type: 'tier-start',
      tier: decision.tier,
      provider: decision.provider,
      model: decision.model,
      attempt: attempts,
    };

    // --- Build request and record start time ---
    const req: ProviderRequest = {
      model: decision.model,
      prompt,
      cwd: deps.cwd,
      sandbox: deps.sandbox,
      timeoutMs: deps.timeoutMs,
      ...(nativePlan !== undefined
        ? { sessionId: nativePlan.sessionId, resume: nativePlan.resume }
        : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    const start = deps.clock.now();

    // --- Stream provider events ---
    const outcome = yield* streamProvider(provider, req, decision.tier, signal);

    if (outcome.canceled) {
      yield { type: 'notice', level: 'warn', message: 'cancelled' };
      yield {
        type: 'final',
        success: false,
        output: outcome.canceledBeforeStream
          ? 'Task was cancelled before it started.'
          : 'Task was cancelled.',
        tier: decision.tier,
        totalCostUsd,
        sessionId: deps.session.id,
        attempts,
        ...(outcome.canceled ? { canceled: true } : {}),
        ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
      };
      return;
    }

    const { finalText, errored, usage, providerCostUsd } = outcome;

    // Track last error for failing final event.
    if (errored !== undefined) {
      lastErroredCategory = errored.category;
    }

    // --- Compute duration + cost ---
    const durationMs = deps.clock.now() - start;
    const success = errored == null;

    const pricing = getModelPricing(decision.provider, decision.model);
    const usd =
      providerCostUsd ??
      (usage !== undefined && pricing !== undefined
        ? calculateCost(usage.inputTokens, usage.outputTokens, pricing)
        : 0);
    totalCostUsd += usd;

    // --- Assess output ---
    const assessment = assess(finalText ?? '');

    // --- Record in ledger ---
    await deps.ledger.record({
      timestamp: deps.clock.isoNow(),
      sessionId: deps.session.id,
      taskId: deps.clock.uuid(),
      provider: decision.provider,
      model: decision.model,
      tier: decision.tier,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      usd,
      durationMs,
      success,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      // Record the SAME taskKind orchestrate derived for routing (Stage 4, §2
      // Layer 3) so the model-level outcome learner weighs this run by task type.
      taskKind: taskSignals.taskKind,
    });

    // --- Yield tier-done ---
    yield {
      type: 'tier-done',
      tier: decision.tier,
      success,
      confidence: assessment.confidence,
      costUsd: usd,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      durationMs,
    };

    lastOutput = finalText ?? (errored?.message ?? '');
    if (success) {
      acceptedRun = {
        content: lastOutput,
        tier: decision.tier,
        provider: decision.provider,
        model: decision.model,
        confidence: assessment.confidence,
        costUsd: usd,
        durationMs,
        ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        ...(workTrace !== undefined ? { workTrace } : {}),
      };
    }

    // -----------------------------------------------------------------------
    // 0a) GENERIC-OPEN-MENU REPAIR (adaptive-partner-v2-5.6.md §2.2 A2).
    // -----------------------------------------------------------------------
    // A successful answer that is the order-taker "are you fixing / adding /
    // polishing / integrating?" menu is the exact live failure mode. When the
    // directive's validator fires (and the model did NOT emit a legitimate
    // structured ask_user block, which the short-circuit below owns), re-run the
    // SAME tier ONCE with a manager-style repair note appended. This costs one
    // retry ONLY on the live failure — never on a passing turn — and is bounded
    // (MAX_VALIDATOR_REPAIRS = 1). The current `acceptedRun`/`lastOutput` are left
    // in place: if the repaired answer is no better, the best-effort accept paths
    // below KEEP a usable answer rather than discarding it as Failed.
    if (
      success &&
      genericMenuRepairs < MAX_VALIDATOR_REPAIRS &&
      parseQuestions(finalText ?? '') === null &&
      validateTurnOutput(finalText ?? '', directive) !== null
    ) {
      genericMenuRepairs++;
      managerNotes =
        managerNotes !== undefined && managerNotes.length > 0
          ? `${managerNotes}\n\n${GENERIC_MENU_REPAIR_NOTE}`
          : GENERIC_MENU_REPAIR_NOTE;
      yield {
        type: 'notice',
        level: 'info',
        message: 'Reworking a generic task-category menu into a grounded recommendation.',
      };
      continue mainLoop;
    }

    // -----------------------------------------------------------------------
    // 0) Structured question short-circuit (ask_user)
    // -----------------------------------------------------------------------
    // If the model ended its turn by asking the user a structured question
    // instead of completing work, that is a COMPLETE turn that needs a reply —
    // not low-confidence work. Yield a successful final carrying the questions
    // and return WITHOUT escalating or reviewing. The confidence envelope is
    // ignored for this turn (the two are mutually exclusive per prompt.ts).
    if (success) {
      // Prefer the model's own ask_user block. When APE planned an ASK_CLARIFYING
      // at a genuine fork but the model did NOT ask, derive the structured
      // question from the frame's fork so the planned fork is never silently
      // dropped (intent §5.4 / APE §6.2). The derivation is bounded by ASK_CAP and
      // only fires on the FIRST attempt (a derived ask is terminal — it short-
      // circuits the turn exactly like a model ask, no escalate/review).
      const modelQuestions = parseQuestions(finalText ?? '');
      const derivedQuestions =
        modelQuestions === null &&
        attempts === 1 &&
        engagementPlan.actions.includes('ASK_CLARIFYING')
          ? deriveAskFromForks(intentFrame, engagementPlan)
          : null;
      const questions = modelQuestions ?? derivedQuestions;
      if (questions !== null) {
        if (acceptedRun === undefined) {
          throw new Error('orchestrate invariant violated: question final without accepted run');
        }
        await appendAcceptedAssistant(deps, acceptedRun);
        yield {
          type: 'final',
          success: true,
          output: lastOutput,
          tier: currentTier,
          totalCostUsd,
          sessionId: deps.session.id,
          attempts,
          questions,
        };
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Decision tree
    // -----------------------------------------------------------------------

    // 1) Provider failure → try cross-vendor failover first; escalate only when
    //    all vendors at this tier have been exhausted.
    if (!success) {
      // Bug 1 fix: auth errors are terminal — a missing credential cannot be
      // fixed by switching provider or escalating tier.  Short-circuit now.
      if (errored !== undefined && errored.category === 'auth') {
        yield {
          type: 'final',
          success: false,
          output: lastOutput,
          tier: currentTier,
          totalCostUsd,
          sessionId: deps.session.id,
          attempts,
          errorCategory: 'auth',
          provider: decision.provider,
        };
        return;
      }

      // Timeouts are terminal for THIS task: do NOT cross-vendor fail over and do
      // NOT escalate the tier. Re-running the same (too-broad) task on another
      // vendor at the same tier just doubles the wall-clock and the spend for the
      // same likely-to-time-out work — exactly the runaway we are fixing. Stop
      // here with an actionable notice. (Fast crashes and other recoverable
      // errors keep the existing failover/escalation behaviour below.)
      if (errored !== undefined && errored.category === 'timeout') {
        // Honest-spend judgment call (Goal 3): a timeout SIGKILLs the child before
        // the CLI emits its terminal usage/result, so claude-parse produces no
        // usage. The LedgerEntry schema (types.ts) holds only numeric token/usd
        // fields — it cannot represent "unknown". We do NOT fabricate a number:
        // the ledger entry was recorded above with success:false and the real
        // parsed usage (0 when none arrived before the kill). When nothing was
        // parsed, the recorded $0 is NOT a real cost — the run very likely burned
        // the user's subscription — so we surface that explicitly here rather than
        // letting the UI render "0 tokens / $0 / free". When partial usage DID
        // arrive before the kill, we trust it and make no unknown-spend claim.
        const parsedNoUsage =
          usage === undefined && providerCostUsd === undefined;
        if (parsedNoUsage) {
          yield {
            type: 'notice',
            level: 'warn',
            message:
              'Spend unknown — the process was killed before reporting usage; the recorded $0 is not a real cost (the run may still have consumed your subscription).',
          };
        }
        yield {
          type: 'notice',
          level: 'warn',
          message:
            'Timed out before the model finished. Not retrying on another vendor (the same work would likely time out again and double the cost). The task may be too broad — narrow it, or raise the timeout in Settings.',
        };
        yield {
          type: 'final',
          success: false,
          output: lastOutput,
          tier: currentTier,
          totalCostUsd,
          sessionId: deps.session.id,
          attempts,
          errorCategory: 'timeout',
          provider: decision.provider,
        };
        return;
      }

      // Compute which providers haven't been tried at this tier yet.
      const triedAtTier = triedByTier.get(currentTier) ?? new Set<ProviderId>();
      let remaining = available.filter((id) => !triedAtTier.has(id));
      // Don't fail over to a provider that isn't signed in — it would just fail
      // again with "not signed in" and burn an attempt. When we have real auth
      // info, restrict the failover pool to authenticated providers; if that
      // leaves nothing, we escalate/stop instead of attempting a doomed vendor.
      // (When auth info is absent/empty we keep the prior behaviour and try an
      // untried vendor anyway — auth may have changed since detection.)
      const authedProviders = deps.authenticatedProviders;
      if (authedProviders !== undefined && authedProviders.length > 0) {
        remaining = remaining.filter((id) => authedProviders.includes(id));
      }

      if (remaining.length > 0) {
        // Failover to an untried vendor at the same tier only when there is
        // still room for another attempt.
        // Bug 3 fix: only emit the failover event when another iteration can
        // actually execute — i.e., when attempts < maxAttempts.  At the ceiling
        // the next loop condition (attempts < maxAttempts) would be false, so the
        // promised failover run would never happen; don't mislead the caller.
        if (attempts < deps.policy.maxAttempts) {
          // Peek at what route() would pick from the remaining pool so we can
          // name the target provider in the failover event. Use the SAME effective
          // policy as the actual run (manager ceiling lifted when authorized), so
          // the previewed target matches what the next iteration really routes.
          const nextDecision = route(
            currentTier,
            remaining,
            effPolicy,
            deps.availableModels,
            deps.authenticatedProviders,
            deps.learnedProviderOrder?.[currentTier],
            capabilityContext,
          );
          yield {
            type: 'failover',
            from: decision.provider,
            to: nextDecision.provider,
            tier: currentTier,
            reason: errored?.message ?? 'execution failure',
          };
          // Signal the next iteration to route among only the remaining vendors.
          failoverPool = remaining;
          continue mainLoop;
        }
        // Reached maxAttempts with untried vendors — fall through to escalate/break.
      }

      // All vendors at this tier have been tried (or maxAttempts reached) — escalate or break.
      // Adaptive admission: a failure escalation to the flagship is an EARNED
      // trigger, but Efficient (never-auto) and a free-plan veto deny it; in that
      // case fall back to the static ceiling (clampTier) — preserving the prior
      // effective behaviour (e.g. Efficient worker→ic).
      if (currentTier !== 'manager') {
        const target: Tier = admitManager('failure').allowed
          ? 'manager'
          : clampTier('manager', deps.policy.maxTier);
        if (target === currentTier) {
          break mainLoop; // ceiling reached — cannot escalate further
        }
        yield { type: 'escalate', from: currentTier, to: target, reason: 'execution failure' };
        currentTier = target;
        continue mainLoop;
      } else {
        break mainLoop; // already at manager; emit failing final below
      }
    }

    // 2) Cross-vendor review for high/critical risk or needsReview — any tier
    //    Guard: each attempt is reviewed at most once (prevents infinite loops).
    //    Guard: skip review if the only available reviewer is the same vendor
    //           (cross-vendor review is required; same-vendor-only → skip).
    if (
      shouldReview(classification, assessment, deps.policy.reviewPolicy) &&
      !reviewedAttempts.has(attempts)
    ) {
      // Pick the reviewer from AUTHENTICATED (and, since the conversation layer
      // already cooldown-filters that list, un-throttled) providers when we know
      // them — never route a review to a signed-out or cooled-down vendor. Falls
      // back to all available providers only when auth state is unknown.
      const reviewerPool =
        deps.authenticatedProviders !== undefined && deps.authenticatedProviders.length > 0
          ? available.filter((id) => (deps.authenticatedProviders as readonly ProviderId[]).includes(id))
          : available;
      const reviewerId = pickReviewer(reviewerPool, decision.provider);
      // Only proceed with a DIFFERENT-vendor reviewer (cross-vendor requirement).
      const reviewerProvider =
        reviewerId !== null && reviewerId !== decision.provider
          ? deps.providers[reviewerId]
          : undefined;

      if (reviewerId !== null && reviewerProvider !== undefined) {
        reviewedAttempts.add(attempts);
        yield {
          type: 'notice',
          level: 'info',
          message: `Review by ${reviewerId} (cross-vendor)`,
        };

        // Route the reviewer at the flagship tier — through the SAME adaptive
        // admission gate as every other manager step, so it isn't a back door.
        // When admitted (e.g. high/critical risk, which is exactly when review
        // fires), lift the ceiling so the reviewer runs the strong model; when
        // denied, route() clamps it to the policy ceiling. Either way we use the
        // RESOLVED reviewDecision.tier everywhere below — never a hard-coded
        // 'manager' — so events/ledger never claim a tier the model didn't run.
        // Note: the review is gated through admission for honest labelling and the
        // never-auto / free-plan cases, but it does NOT consume the per-turn
        // flagship ESCALATION budget — review is a distinct, separately-bounded
        // mechanism (once per attempt, cross-vendor required). Counting it here
        // would let a high-risk review starve the task's own escalation pass.
        const reviewAdmission = admitManager('review', assessment);
        const reviewPolicy: Policy = reviewAdmission.allowed
          ? { ...deps.policy, maxTier: 'manager' }
          : deps.policy;
        // The reviewer pool is a single provider, so the learned order can only
        // confirm it (never reorder a one-element pool) — passed for consistency
        // so every route() call site threads the same learned snapshot.
        // Review is a 'review' taskKind regardless of the work turn's kind — the
        // reviewer's job is critique. Build a review-flavoured capability context
        // so capability-fit + effort selection treat it as such. Absent registry →
        // undefined → route() unchanged (byte-for-byte).
        const reviewModelOutcomeOrder = deps.modelOutcomeOrderByTaskKind?.['review'];
        const reviewCapabilityContext: CapabilityRouteContext | undefined =
          deps.capabilityRegistry !== undefined
            ? {
                registry: deps.capabilityRegistry,
                taskSignals: { ...taskSignals, taskKind: 'review' },
                mode,
                ...(reviewModelOutcomeOrder !== undefined
                  ? { modelOutcomeOrder: reviewModelOutcomeOrder }
                  : {}),
              }
            : undefined;
        const reviewDecision = route(
          'manager',
          [reviewerId],
          reviewPolicy,
          deps.availableModels,
          deps.authenticatedProviders,
          deps.learnedProviderOrder?.['manager'],
          reviewCapabilityContext,
        );
        const reviewTier = reviewDecision.tier;
        // Reasoning effort for the reviewer run, against the resolved reviewer
        // model. reviewTier is the tier admission already granted to the reviewer,
        // so this never opens manager or exceeds policy. undefined → no flag.
        const reviewEffort = effortForDecision(
          deps.capabilityRegistry,
          reviewerId,
          reviewDecision.model,
          reviewTier,
          mode,
          { ...taskSignals, taskKind: 'review' },
        );
        const reviewContractDecision = shouldMaterializeContract({
          classification,
          routePlan,
          context: 'normal',
          reviewWillRun: true,
        });
        const reviewContract =
          incomingWorkContract !== undefined
            ? incomingWorkContract
            : isCleanObjectiveTask(task)
              ? capContract({ version: 1, objective: task })
              : undefined;
        const reviewPrompt =
          reviewContractDecision.criteria && reviewContract !== undefined
            ? buildReviewPrompt(task, lastOutput, reviewContract)
            : buildReviewPrompt(task, lastOutput);

        // Yield tier-start for review run
        yield {
          type: 'tier-start',
          tier: reviewTier,
          provider: reviewerId,
          model: reviewDecision.model,
          attempt: attempts,
        };

        const reviewReq: ProviderRequest = {
          model: reviewDecision.model,
          prompt: reviewPrompt,
          cwd: deps.cwd,
          sandbox: deps.sandbox,
          timeoutMs: deps.timeoutMs,
          ...(reviewEffort !== undefined ? { reasoningEffort: reviewEffort } : {}),
        };
        const reviewStart = deps.clock.now();

        // --- Consume reviewer events without surfacing internal prose ---
        const reviewOutcome = await collectProviderRun(reviewerProvider, reviewReq, signal);

        if (reviewOutcome.canceled) {
          yield { type: 'notice', level: 'warn', message: 'cancelled' };
          yield {
            type: 'final',
            success: false,
            output: 'Task was cancelled.',
            tier: currentTier,
            totalCostUsd,
            sessionId: deps.session.id,
            attempts,
            ...(reviewOutcome.canceled ? { canceled: true } : {}),
            ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
          };
          return;
        }

        const reviewDurationMs = deps.clock.now() - reviewStart;
        const reviewSuccess = reviewOutcome.errored == null;

        const reviewPricing = getModelPricing(reviewerId, reviewDecision.model);
        const reviewUsd =
          reviewOutcome.providerCostUsd ??
          (reviewOutcome.usage !== undefined && reviewPricing !== undefined
            ? calculateCost(reviewOutcome.usage.inputTokens, reviewOutcome.usage.outputTokens, reviewPricing)
            : 0);
        totalCostUsd += reviewUsd;

        // Record reviewer run in ledger
        await deps.ledger.record({
          timestamp: deps.clock.isoNow(),
          sessionId: deps.session.id,
          taskId: deps.clock.uuid(),
          provider: reviewerId,
          model: reviewDecision.model,
          tier: reviewTier,
          inputTokens: reviewOutcome.usage?.inputTokens ?? 0,
          outputTokens: reviewOutcome.usage?.outputTokens ?? 0,
          cachedInputTokens: reviewOutcome.usage?.cachedInputTokens ?? 0,
          usd: reviewUsd,
          durationMs: reviewDurationMs,
          success: reviewSuccess,
          ...(reviewEffort !== undefined ? { reasoningEffort: reviewEffort } : {}),
          // The reviewer run is always a 'review' taskKind (Stage 4).
          taskKind: 'review',
        });

        // Yield tier-done for reviewer
        yield {
          type: 'tier-done',
          tier: reviewTier,
          success: reviewSuccess,
          confidence: null,
          costUsd: reviewUsd,
          inputTokens: reviewOutcome.usage?.inputTokens ?? 0,
          outputTokens: reviewOutcome.usage?.outputTokens ?? 0,
          durationMs: reviewDurationMs,
        };

        // Parse verdict and act on it
        const verdict = parseReviewVerdict(reviewOutcome.finalText ?? '');

        // Risk-indexed fail-open: when parsing failed (verdict.parsed === false)
        // AND the task is high/critical risk, do NOT silently auto-approve —
        // escalate (or warn if already at manager) rather than letting
        // unparseable output pass as approved.
        if (!verdict.parsed && (classification.risk === 'high' || classification.risk === 'critical')) {
          // Escalate to the flagship to adjudicate — but only if admission allows it
          // (high/critical risk justifies it under adaptive; a free-plan veto or spent
          // attempt budget can still deny). When denied, fall through to the honest
          // "inconclusive — not auto-approving" failing final rather than escalating.
          if (currentTier !== 'manager' && admitManager('review', assessment).allowed) {
            yield {
              type: 'notice',
              level: 'warn',
              message: 'review inconclusive — not auto-approving',
            };
            yield { type: 'escalate', from: currentTier, to: 'manager', reason: 'review inconclusive' };
            currentTier = 'manager';
            continue mainLoop;
          } else {
            // Already at manager (top tier): a high/critical-risk review came back
            // inconclusive and there is no higher tier to escalate to. Do NOT ship
            // it as a clean success — surface the inconclusive result honestly.
            yield {
              type: 'notice',
              level: 'warn',
              message: 'review inconclusive — not auto-approving',
            };
            yield {
              type: 'final',
              success: false,
              output: lastOutput,
              tier: currentTier,
              totalCostUsd,
              sessionId: deps.session.id,
              attempts,
              ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
            };
            return;
          }
        } else {
          yield {
            type: 'notice',
            level: 'info',
            message: `Review verdict: ${verdict.verdict}`,
          };

          if (verdict.verdict === 'approve') {
            if (acceptedRun === undefined) {
              throw new Error('orchestrate invariant violated: approved final without accepted run');
            }
            await appendAcceptedAssistant(deps, acceptedRun);
            {
              const memoryProposal = memoryProposalFor(lastOutput);
              yield {
                type: 'final',
                success: true,
                output: lastOutput,
                tier: currentTier,
                totalCostUsd,
                sessionId: deps.session.id,
                attempts,
                ...(memoryProposal !== undefined ? { memoryProposal } : {}),
              };
            }
            return;
          }

          if (verdict.verdict === 'revise') {
            // Bound blind re-execution. The first revise applies the reviewer's
            // notes and re-runs the same tier once. A SECOND revise would re-run
            // the same expensive investigation against the same model again — the
            // 160k-token runaway. Instead, treat a persistent revise like an
            // escalate: hand it to a stronger tier when admission allows; if we
            // can't escalate, accept the best answer we already have (the accept
            // path below), never blind-loop to exhaustion.
            if (reviseRetries < MAX_REVISE_RETRIES) {
              reviseRetries++;
              managerNotes = verdict.notes;
              continue mainLoop;
            }
            const escalateTo = nextTierUp(currentTier);
            const escalateBlocked =
              escalateTo === 'manager' ? !admitManager('review', assessment).allowed : false;
            if (escalateTo !== null && !escalateBlocked) {
              managerNotes = verdict.notes;
              yield {
                type: 'escalate',
                from: currentTier,
                to: escalateTo,
                reason: 'review revise (bounded re-execution)',
              };
              currentTier = escalateTo;
              continue mainLoop;
            }
            // Can't escalate (top tier, or admission denied) — accept the best
            // result rather than re-running the same model again.
            yield {
              type: 'notice',
              level: 'warn',
              message:
                'reviewer asked for further revision but the cheaper re-run budget is spent — accepting best result',
            };
            if (acceptedRun === undefined) {
              throw new Error('orchestrate invariant violated: revise-accept final without accepted run');
            }
            await appendAcceptedAssistant(deps, acceptedRun);
            {
              const memoryProposal = memoryProposalFor(lastOutput);
              yield {
                type: 'final',
                success: true,
                output: lastOutput,
                tier: currentTier,
                totalCostUsd,
                sessionId: deps.session.id,
                attempts,
                bestEffort: true,
                ...(memoryProposal !== undefined ? { memoryProposal } : {}),
              };
            }
            return;
          }

          // verdict === 'escalate'
          const escalateTo = nextTierUp(currentTier);
          // Adaptive admission negates a flagship escalation the reviewer asked for
          // when this mode/turn doesn't admit manager (Efficient, free-plan veto, or
          // attempt budget spent). Accept the current result rather than re-running
          // the same model. (Escalation to 'ic' is always allowed.)
          const reviewEscalateBlocked =
            escalateTo === 'manager' ? !admitManager('review', assessment).allowed : false;
          if (escalateTo !== null && reviewEscalateBlocked) {
            yield {
              type: 'notice',
              level: 'warn',
              message: 'reviewer requested escalation but the policy tier ceiling is reached — accepting best result',
            };
            if (acceptedRun === undefined) {
              throw new Error('orchestrate invariant violated: ceiling-accepted final without accepted run');
            }
            await appendAcceptedAssistant(deps, acceptedRun);
            {
              const memoryProposal = memoryProposalFor(lastOutput);
              yield {
                type: 'final',
                success: true,
                output: lastOutput,
                tier: currentTier,
                totalCostUsd,
                sessionId: deps.session.id,
                attempts,
                ...(memoryProposal !== undefined ? { memoryProposal } : {}),
              };
            }
            return;
          }
          if (escalateTo === null) {
            // Bug 2 fix: already at the top tier — reviewer requested escalation
            // but there is nowhere higher to go.  Yield an honest warn + failing
            // final instead of silently looping until maxAttempts.
            yield {
              type: 'notice',
              level: 'warn',
              message: 'reviewer requested escalation but already at the top tier — accepting best result',
            };
            yield {
              type: 'final',
              success: false,
              output: lastOutput,
              tier: currentTier,
              totalCostUsd,
              sessionId: deps.session.id,
              attempts,
              ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
            };
            return;
          }
          yield { type: 'escalate', from: currentTier, to: escalateTo, reason: 'reviewer escalation' };
          currentTier = escalateTo;
          continue mainLoop;
        }
      }
    }

    // 3) Confidence-based escalation
    const threshold = deps.policy.escalateBelowConfidence[classification.risk];
    const needEsc =
      assessment.escalate ||
      (assessment.confidence !== null && assessment.confidence < threshold);

    const nextTier = nextTierUp(currentTier);
    // The tier we'd actually escalate to, or null if escalation wouldn't change the
    // running model. For a flagship (manager) step, adaptive admission decides:
    // under Balanced this confidence trigger is justified, but a free-plan veto or a
    // spent attempt budget can still deny it. Escalation to 'ic' (from worker) is
    // always allowed; the static clamp guards that legacy case.
    const confAdmission: FlagshipDecision | null =
      nextTier === 'manager' ? admitManager('confidence', assessment) : null;
    const escalateTo: Tier | null =
      nextTier === 'manager'
        ? confAdmission?.allowed
          ? 'manager'
          : null
        : nextTier !== null && clampTier(nextTier, deps.policy.maxTier) !== currentTier
          ? nextTier
          : null;
    if (needEsc && escalateTo !== null) {
      const escalateReason =
        assessment.reason !== 'model provided no reason' &&
        assessment.reason !== 'no confidence envelope'
          ? assessment.reason
          : 'low confidence';
      yield {
        type: 'escalate',
        from: currentTier,
        to: escalateTo,
        reason: escalateReason,
      };
      currentTier = escalateTo;
      continue mainLoop;
    }

    // Honest notice: the turn WANTED to escalate to the flagship (low confidence /
    // escalate signal) but adaptive admission denied it (Efficient, free-plan veto,
    // or the per-turn flagship budget is spent). Surface why, so a low-confidence
    // result isn't silently accepted as if it were fully trusted.
    if (needEsc && confAdmission !== null && !confAdmission.allowed) {
      yield {
        type: 'notice',
        level: 'warn',
        message: `accepting best available result — ${confAdmission.reason}`,
      };
    }

    // 4) Accept — everything checks out (or the flagship was warranted but denied)
    if (acceptedRun === undefined) {
      throw new Error('orchestrate invariant violated: successful final without accepted run');
    }
    await appendAcceptedAssistant(deps, acceptedRun);
    {
      const memoryProposal = memoryProposalFor(lastOutput);
      yield {
        type: 'final',
        success: true,
        output: lastOutput,
        tier: currentTier,
        totalCostUsd,
        sessionId: deps.session.id,
        attempts,
        ...(memoryProposal !== undefined ? { memoryProposal } : {}),
      };
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Loop exhausted or broke out on failure.
  //
  // CARDINAL RULE — never discard a usable answer as "Failed". The bounded
  // escalation/review loop can run out of attempts (e.g. a reviewer kept asking
  // to `revise`, or low confidence kept retrying the same tier) WITHOUT ever
  // reaching a clean accept. If a provider run nonetheless produced a substantive
  // answer (`acceptedRun` is set only on an errorless run, and its content is
  // non-empty), that answer is the user's best result — returning success:false
  // here throws away good work AND hides it behind a "Failed" banner.
  //
  // So: when a substantive accepted answer exists, return it as a BEST-EFFORT
  // success — persist it to the session like any accepted turn, attach any
  // model-proposed memory, and flag `bestEffort` so the renderer notes honestly
  // that it exhausted the loop / stayed under the confidence bar (not a clean
  // success, but real work the user can use). success:false is reserved for
  // GENUINE failure: no usable output (provider/auth/timeout errors, empty text).
  // Those terminal paths already returned above with their own honest finals; the
  // only way to reach here with no acceptedRun is the `break mainLoop` on an
  // error with no untried vendor — that correctly still fails below.
  // -------------------------------------------------------------------------
  if (acceptedRun !== undefined && acceptedRun.content.trim().length > 0) {
    await appendAcceptedAssistant(deps, acceptedRun);
    const memoryProposal = memoryProposalFor(acceptedRun.content);
    yield {
      type: 'final',
      success: true,
      output: acceptedRun.content,
      tier: currentTier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      bestEffort: true,
      ...(memoryProposal !== undefined ? { memoryProposal } : {}),
    };
    return;
  }

  yield {
    type: 'final',
    success: false,
    output: lastOutput,
    tier: currentTier,
    totalCostUsd,
    sessionId: deps.session.id,
    attempts,
    ...(lastErroredCategory !== undefined ? { errorCategory: lastErroredCategory } : {}),
    ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
  };
}
