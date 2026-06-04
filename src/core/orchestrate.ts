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

import type { CoreEvent, OrchestrateDeps, Tier, Classification, Assessment, Policy } from './types.js';
import type { CliError, Usage, ProviderRequest, Provider, ProviderId } from '../providers/port.js';
import { decideRoute } from './router.js';
import { route, clampTier } from './route.js';
import { authorizeTier } from './flagship.js';
import type { FlagshipTrigger } from './flagship.js';
import { buildPrompt } from './prompt.js';
import { assess } from './assess.js';
import { parseQuestions } from './questions.js';
import { compactHistory } from './history.js';
import { getModelPricing, calculateCost } from '../infra/pricing.js';
import { nextTierUp, pickReviewer } from './escalate.js';
import { buildReviewPrompt, parseReviewVerdict } from './review.js';

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
      if (ev.usage !== undefined && usage === undefined) {
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
  deps: OrchestrateDeps,
  signal: AbortSignal,
): AsyncGenerator<CoreEvent> {
  // -------------------------------------------------------------------------
  // (a) Decide the route. Deterministic rules first; the model-brained router
  //     (core/router.ts) only arbitrates turns the keyword classifier couldn't
  //     route, and only when deps.routeClassifier is wired. decision.plan is
  //     reserved for plan-first mode (Phase C).
  // -------------------------------------------------------------------------
  const decision = await decideRoute(task, {
    ...(deps.routeClassifier !== undefined ? { classifier: deps.routeClassifier } : {}),
    signal,
  });
  const classification: Classification = {
    tier: decision.tier,
    risk: decision.risk,
    rationale: decision.rationale,
  };
  yield { type: 'classified', classification };

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
        '(claude or codex) and try again.',
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

  // Compute history context once per orchestrate() call (before the loop).
  // It is injected into the first-tier prompt to give stateless providers
  // multi-turn context; the history does NOT grow during the loop.
  const historyContext =
    deps.history !== undefined && deps.history.length > 0
      ? compactHistory(deps.history)
      : undefined;
  /**
   * Track which attempt indices have already been reviewed so that re-runs
   * (e.g. after a revise verdict) are not reviewed a second time and we
   * cannot enter an infinite review loop.
   */
  const reviewedAttempts = new Set<number>();

  /**
   * Adaptive flagship admission for a manager request at the current decision
   * point. Closes over the live `currentTier` and `flagshipAttemptsThisTurn`.
   * Returns whether manager is authorized for the given trigger + assessment.
   */
  const managerAdmitted = (trigger: FlagshipTrigger, assessmentArg?: Assessment): boolean =>
    authorizeTier({
      requestedTier: 'manager',
      currentTier,
      classification,
      ...(assessmentArg !== undefined ? { assessment: assessmentArg } : {}),
      policy: deps.policy,
      ...(deps.planInfos !== undefined ? { planInfos: deps.planInfos } : {}),
      flagshipAttemptsThisTurn,
      trigger,
    }).allowed;

  // Adaptive flagship admission on the INITIAL route: a manager-classified turn
  // only starts on the flagship when the turn justifies it (high/critical risk, or
  // Max mode). Otherwise drop to IC — never open manager-first off a soft
  // classification. (Earned escalations later in the loop are gated separately.)
  if (currentTier === 'manager' && !managerAdmitted('initial')) {
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
    const decision = route(currentTier, routePool, effPolicy, deps.availableModels, deps.authenticatedProviders);

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
    const prompt = buildPrompt(decision.tier, task, managerNotes, useNative ? undefined : historyContext);

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
    });

    // --- Append assistant session entry ---
    // Persist the provider-assigned native session id (e.g. Codex thread id) so
    // a later turn can resume it. Claude reports none (it reuses the conv id).
    await deps.session.append({
      timestamp: deps.clock.isoNow(),
      role: 'assistant',
      content: finalText ?? (errored?.message ?? ''),
      tier: decision.tier,
      provider: decision.provider,
      model: decision.model,
      confidence: assessment.confidence,
      costUsd: usd,
      durationMs,
      ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
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

    // -----------------------------------------------------------------------
    // 0) Structured question short-circuit (ask_user)
    // -----------------------------------------------------------------------
    // If the model ended its turn by asking the user a structured question
    // instead of completing work, that is a COMPLETE turn that needs a reply —
    // not low-confidence work. Yield a successful final carrying the questions
    // and return WITHOUT escalating or reviewing. The confidence envelope is
    // ignored for this turn (the two are mutually exclusive per prompt.ts).
    if (success) {
      const questions = parseQuestions(finalText ?? '');
      if (questions !== null) {
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
          // name the target provider in the failover event.
          const nextDecision = route(currentTier, remaining, deps.policy, deps.availableModels, deps.authenticatedProviders);
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
        const target: Tier = managerAdmitted('failure')
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
      const reviewerId = pickReviewer(available, decision.provider);
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

        // Route reviewer at manager tier
        const reviewDecision = route('manager', [reviewerId], deps.policy, deps.availableModels, deps.authenticatedProviders);
        const reviewPrompt = buildReviewPrompt(task, lastOutput);

        // Yield tier-start for review run
        yield {
          type: 'tier-start',
          tier: 'manager' as Tier,
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
        };
        const reviewStart = deps.clock.now();

        // --- Stream reviewer events ---
        const reviewOutcome = yield* streamProvider(reviewerProvider, reviewReq, 'manager', signal);

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
          tier: 'manager',
          inputTokens: reviewOutcome.usage?.inputTokens ?? 0,
          outputTokens: reviewOutcome.usage?.outputTokens ?? 0,
          cachedInputTokens: reviewOutcome.usage?.cachedInputTokens ?? 0,
          usd: reviewUsd,
          durationMs: reviewDurationMs,
          success: reviewSuccess,
        });

        // Yield tier-done for reviewer
        yield {
          type: 'tier-done',
          tier: 'manager' as Tier,
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
          if (currentTier !== 'manager' && managerAdmitted('review', assessment)) {
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
            yield {
              type: 'final',
              success: true,
              output: lastOutput,
              tier: currentTier,
              totalCostUsd,
              sessionId: deps.session.id,
              attempts,
            };
            return;
          }

          if (verdict.verdict === 'revise') {
            // Retry current tier with reviewer's notes
            managerNotes = verdict.notes;
            continue mainLoop;
          }

          // verdict === 'escalate'
          const escalateTo = nextTierUp(currentTier);
          // Adaptive admission negates a flagship escalation the reviewer asked for
          // when this mode/turn doesn't admit manager (Efficient, free-plan veto, or
          // attempt budget spent). Accept the current result rather than re-running
          // the same model. (Escalation to 'ic' is always allowed.)
          const reviewEscalateBlocked =
            escalateTo === 'manager' ? !managerAdmitted('review', assessment) : false;
          if (escalateTo !== null && reviewEscalateBlocked) {
            yield {
              type: 'notice',
              level: 'warn',
              message: 'reviewer requested escalation but the policy tier ceiling is reached — accepting best result',
            };
            yield {
              type: 'final',
              success: true,
              output: lastOutput,
              tier: currentTier,
              totalCostUsd,
              sessionId: deps.session.id,
              attempts,
            };
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
    const escalateTo: Tier | null =
      nextTier === 'manager'
        ? managerAdmitted('confidence', assessment)
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

    // 4) Accept — everything checks out
    yield {
      type: 'final',
      success: true,
      output: lastOutput,
      tier: currentTier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
    };
    return;
  }

  // Loop exhausted or broke out on failure
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
