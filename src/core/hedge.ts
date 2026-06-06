/**
 * src/core/hedge.ts — Latency-Hedged Escalation (EXPERIMENTAL, opt-in, default OFF).
 *
 * The sequential engine (orchestrate.ts) is correct but serial: it waits for a
 * cheap-tier attempt to FINISH and be judged low-confidence BEFORE it starts a
 * stronger escalation. So a slow weak attempt serially delays the strong one and
 * the user pays that latency twice. Hedging hides it: when the PRIMARY attempt is
 * slow, speculatively start a flagship attempt IN PARALLEL and take whichever
 * finishes first with adequate confidence, cancelling the loser.
 *
 * Why this is uniquely a subscription-first move: on a flat-rate plan, the wasted
 * (cancelled) branch costs $0 in dollars. The only budget is quota/rate-limit
 * headroom + the cancelled run, so hedging deliberately SPENDS quota to buy
 * wall-clock — a trade an API-key-billed tool would never make. We gate it hard
 * (high/critical risk only, flagship must be admittable) so we never spend that
 * quota on trivial turns.
 *
 * Scope / safety:
 *  - Default OFF (hedgePolicy absent → 'off'); zero behaviour change unless the
 *    user opts in AND a delay port (deps.sleep) is injected.
 *  - planHedge is PURE.
 *  - runHedged does I/O ONLY through the injected OrchestrateDeps ports/providers
 *    (and deps.sleep), exactly like runPanel — that is not a purity violation.
 *
 * HONESTY: a cancelled CLI run may already have consumed capacity, so we never
 * claim cancellation "saved quota" — we phrase it as "cancelled the slower
 * branch". Every run that actually executed is recorded in the ledger with its
 * REAL measured usage (0 when none arrived — never fabricated); only the
 * never-started speculative branch is genuinely free.
 *
 * Purity rules (enforced by test/arch/guards.test.ts), same as the sibling core
 * modules: no fs/path/child_process/os/crypto, no Date.now()/Math.random()/new
 * Date(), and no imports from src/providers/* except the type-only ProviderId.
 * All time/ids come from deps.clock; all delays from deps.sleep.
 */

import type {
  CoreEvent,
  OrchestrateDeps,
  Tier,
  Risk,
  Classification,
  Policy,
} from './types.js';
import type { ProviderId } from '../providers/port.js';
import { route, selectReasoningEffort } from './route.js';
import { getModelPricing, calculateCost } from '../infra/pricing.js';
import { assess } from './assess.js';
import { authorizeTier } from './flagship.js';
import { buildPrompt } from './prompt.js';
import { findCapability, type ReasoningEffort, type TaskKind } from './model-capabilities.js';
import { modeFromPolicy } from './policy.js';
import type { WorkContract } from './work-contract.js';
import { capContract, isCleanObjectiveTask, shouldMaterializeContract } from './work-contract.js';

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * A resolved plan for one hedged turn: the tier the primary attempt runs at, the
 * (always-flagship) tier the speculative attempt runs at if the primary is slow,
 * and how long the primary may run before the speculative is started.
 */
export interface HedgePlan {
  /** The tier the primary (as-classified) attempt runs at. */
  readonly primaryTier: Tier;
  /** The tier the speculative attempt runs at — always `'manager'` (the flagship). */
  readonly speculativeTier: Tier;
  /** How long the primary may run before the speculative flagship is started. */
  readonly delayMs: number;
  /**
   * The turn's risk — carried so the adequacy bar uses the CORRECT risk-indexed
   * confidence threshold (a critical turn demands a higher confidence to accept a
   * primary than a high-risk one). Without this the bar would have to assume a
   * floor and could under-escalate a critical turn.
   */
  readonly risk: Risk;
}

/**
 * Decide whether (and how) to hedge this turn. PURE.
 *
 * Returns null (→ the normal sequential path runs) unless ALL of:
 *  - `hedgePolicy === 'on'`;
 *  - `hasSleep` is true (no injected delay port → we cannot time a hedge);
 *  - the turn is high or critical risk (the turns likely to escalate — we don't
 *    hedge trivial turns and waste quota on a flagship they'd never reach);
 *  - the flagship is admittable for this turn — we call authorizeTier with the
 *    `'initial'` trigger and `flagshipAttemptsThisTurn: 0`; only hedge if it is
 *    allowed (no point speculating on a flagship the policy won't open — e.g.
 *    Efficient/never-auto, or a free-plan veto);
 *  - `classification.tier !== 'manager'` (already at the top tier → there is no
 *    higher tier to hedge TO, so the normal path runs);
 *  - at least 1 authenticated provider exists (the speculative flagship needs a
 *    provider — it MAY be the same provider at a higher tier or a different one;
 *    that is route()'s job).
 *
 * @param opts.hedgePolicy            - Policy posture ('off' | 'on').
 * @param opts.classification         - Task classification (risk + tier gate the hedge).
 * @param opts.policy                 - Active policy (admission + hedgeDelayMs).
 * @param opts.authenticatedProviders - Signed-in provider ids (≥1 required).
 * @param opts.hasSleep               - Whether the delay port (deps.sleep) is injected.
 */
export function planHedge(opts: {
  readonly hedgePolicy: Policy['hedgePolicy'];
  readonly classification: Classification;
  readonly policy: Policy;
  readonly authenticatedProviders: readonly ProviderId[];
  readonly hasSleep: boolean;
}): HedgePlan | null {
  const { hedgePolicy, classification, policy, authenticatedProviders, hasSleep } = opts;

  // 'off' / undefined → never hedge (the sequential engine runs).
  if (hedgePolicy !== 'on') return null;

  // No injected delay port → we cannot time the hedge; defer to sequential.
  if (!hasSleep) return null;

  // Only hedge the turns that are actually likely to escalate — high/critical
  // risk. Trivial turns rarely need the flagship, so speculating one would just
  // burn quota.
  const highStakes =
    classification.risk === 'high' || classification.risk === 'critical';
  if (!highStakes) return null;

  // Already at the flagship → there is no higher tier to hedge TO; run normally.
  if (classification.tier === 'manager') return null;

  // The speculative flagship needs at least one provider to run on.
  if (authenticatedProviders.length === 0) return null;

  // No point speculating on a flagship the policy won't open. Gate it through the
  // SAME adaptive admission as orchestrate's initial route ('initial' is the one
  // trigger that must justify itself via risk — which a high/critical turn does)
  // with the flagship budget unspent. Deny (Efficient/never-auto, free-plan veto)
  // → don't hedge; the sequential path handles the turn correctly.
  const admission = authorizeTier({
    requestedTier: 'manager',
    currentTier: classification.tier,
    classification,
    policy,
    candidateProviders: authenticatedProviders,
    flagshipAttemptsThisTurn: 0,
    trigger: 'initial',
  });
  if (!admission.allowed) return null;

  return {
    primaryTier: classification.tier,
    speculativeTier: 'manager',
    delayMs: policy.hedgeDelayMs ?? 4000,
    risk: classification.risk,
  };
}

// ---------------------------------------------------------------------------
// Executor — internal run helper
// ---------------------------------------------------------------------------

/**
 * The measured outcome of one hedged run, plus the CoreEvents it would have
 * emitted (buffered, not yielded — see runHedged's "event handling" note).
 */
interface RunResult {
  readonly provider: ProviderId;
  readonly model: string;
  /** The tier the run actually resolved to (after route()'s clamp). */
  readonly tier: Tier;
  readonly finalText: string | undefined;
  readonly usage: import('../providers/port.js').Usage | undefined;
  readonly providerCostUsd: number | undefined;
  readonly errored: import('../providers/port.js').CliError | undefined;
  readonly durationMs: number;
  /** True when the run's own signal aborted (cancelled loser, or caller abort). */
  readonly canceled: boolean;
  /** The provider-event CoreEvents this run produced, in order (NOT yet yielded). */
  readonly events: CoreEvent[];
  /** The reasoning effort threaded to this run, when one was selected. */
  readonly reasoningEffort: ReasoningEffort | undefined;
  /** The taskKind this run served (Stage 4 ledger signal). Hedge is always
   *  'implementation' (its job is fast independent work, not adjudication). */
  readonly taskKind: TaskKind;
}

/**
 * Run ONE attempt to completion, buffering its provider-event CoreEvents into an
 * array instead of yielding them (an async generator cannot interleave events
 * from a background promise — we collect, then `yield*` the WINNER's buffered
 * events at the right point in runHedged). Consumes the provider stream purely
 * for its terminal text/usage/cost, exactly like runPanel's runCandidate.
 *
 * @param task           - The raw user task.
 * @param deps           - Injected ports/providers.
 * @param requestedTier  - The tier to route this attempt at (route() may clamp).
 * @param effPolicy      - The effective policy for the route (manager ceiling
 *                         lifted for the speculative flagship; as-is otherwise).
 * @param signal         - This attempt's OWN AbortSignal (so the loser can be cancelled).
 * @param historyContext - Optional compacted prior-conversation summary.
 */
async function runAttempt(
  task: string,
  deps: OrchestrateDeps,
  requestedTier: Tier,
  effPolicy: Policy,
  signal: AbortSignal,
  historyContext: string | undefined,
  risk: Risk,
): Promise<RunResult> {
  const decision = route(
    requestedTier,
    deps.authenticatedProviders !== undefined && deps.authenticatedProviders.length > 0
      ? [...deps.authenticatedProviders]
      : (Object.keys(deps.providers) as ProviderId[]).filter(
          (id) => deps.providers[id] !== undefined,
        ),
    effPolicy,
    deps.availableModels,
    deps.authenticatedProviders,
    deps.learnedProviderOrder?.[requestedTier],
  );
  // Reasoning effort for this hedge run (capability registry §3/§5). decision.tier
  // is the tier route() resolved (admission already passed in planHedge), so this
  // never opens manager or exceeds policy. undefined → no registry / no efforts →
  // no flag (byte-for-byte unchanged). Hedge only fires on high/critical-risk
  // turns; taskKind 'implementation' is the conservative default (risk drives the
  // effort). The selector reconciles against the model's supported set.
  const reasoningEffort = hedgeEffort(deps, decision.provider, decision.model, decision.tier, risk);
  // Hedge runs are always 'implementation' (the same conservative default
  // hedgeEffort uses) — recorded on the ledger for Stage 4 outcome learning.
  const taskKind: TaskKind = 'implementation';
  const provider = deps.providers[decision.provider];
  const start = deps.clock.now();
  const events: CoreEvent[] = [];

  let finalText: string | undefined;
  let errored: import('../providers/port.js').CliError | undefined;
  let usage: import('../providers/port.js').Usage | undefined;
  let providerCostUsd: number | undefined;

  if (provider === undefined) {
    errored = {
      category: 'unknown',
      recoverable: false,
      message: `Provider "${decision.provider}" selected for the hedge but absent from deps.providers.`,
      suggestion: 'Ensure the provider is installed and authenticated.',
    };
    return {
      provider: decision.provider,
      model: decision.model,
      tier: decision.tier,
      finalText,
      usage,
      providerCostUsd,
      errored,
      durationMs: deps.clock.now() - start,
      canceled: signal.aborted,
      events,
      reasoningEffort,
      taskKind,
    };
  }

  // Already cancelled before we started — nothing ran.
  if (signal.aborted) {
    return {
      provider: decision.provider,
      model: decision.model,
      tier: decision.tier,
      finalText,
      usage,
      providerCostUsd,
      errored,
      durationMs: deps.clock.now() - start,
      canceled: true,
      events,
      reasoningEffort,
      taskKind,
    };
  }

  const req: import('../providers/port.js').ProviderRequest = {
    model: decision.model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    prompt: buildPrompt(
      decision.tier,
      task,
      undefined,
      historyContext,
      {
        ...(deps.goalTurn === true ? { goalTurn: true } : {}),
        ...(deps.partnerStyle !== undefined ? { partnerStyle: deps.partnerStyle } : {}),
        ...(deps.environmentContext !== undefined ? { environmentContext: deps.environmentContext } : {}),
        ...(deps.memoryContext !== undefined ? { memoryContext: deps.memoryContext } : {}),
        ...(deps.intentFrame !== undefined ? { intentFrame: deps.intentFrame } : {}),
        ...(deps.engagementPlan !== undefined ? { engagementPlan: deps.engagementPlan } : {}),
      },
    ),
    cwd: deps.cwd,
    sandbox: deps.sandbox,
    timeoutMs: deps.timeoutMs,
  };

  let canceled = false;
  try {
    for await (const ev of provider.run(req, signal)) {
      events.push({ type: 'provider-event', tier: decision.tier, event: ev });
      if (ev.type === 'done') {
        finalText = ev.text;
        // done.usage is the authoritative accumulated total.
        if (ev.usage !== undefined) usage = ev.usage;
        if (ev.costUsd !== undefined) providerCostUsd = ev.costUsd;
      } else if (ev.type === 'error') {
        errored = ev.error;
      } else if (ev.type === 'usage' && usage === undefined) {
        usage = ev.usage;
      }
      if (signal.aborted) {
        canceled = true;
        break;
      }
    }
  } catch (err) {
    errored = {
      category: 'unknown',
      recoverable: false,
      message: err instanceof Error ? err.message : String(err),
      suggestion: 'The hedged run threw unexpectedly.',
    };
  }

  return {
    provider: decision.provider,
    model: decision.model,
    tier: decision.tier,
    finalText,
    usage,
    providerCostUsd,
    errored,
    durationMs: deps.clock.now() - start,
    canceled: canceled || signal.aborted,
    events,
    reasoningEffort,
    taskKind,
  };
}

/**
 * Select the reasoning effort for a hedge run against the chosen model's
 * registry facts (capability registry §3/§5). Returns undefined when the registry
 * is absent, the model has no capability record, or it declares no efforts (→ no
 * flag, byte-for-byte unchanged). The resolved tier is the tier route() granted
 * (admission already passed in planHedge), so this never opens manager. Hedge only
 * fires on high/critical risk; taskKind 'implementation' is the conservative
 * default (risk is the dominant signal). PURE.
 */
function hedgeEffort(
  deps: OrchestrateDeps,
  provider: ProviderId,
  model: string,
  tier: Tier,
  risk: Risk,
): ReasoningEffort | undefined {
  const registry = deps.capabilityRegistry;
  if (registry === undefined) return undefined;
  const cap = findCapability(registry, provider, model);
  if (cap === undefined) return undefined;
  const taskKind: TaskKind = 'implementation';
  return selectReasoningEffort({
    model: cap,
    mode: modeFromPolicy(deps.policy),
    tier,
    risk,
    taskKind,
    routePlan: false,
  });
}

// ---------------------------------------------------------------------------
// Executor — adequacy + ledger/cost helpers (PURE-ish; ledger is via deps)
// ---------------------------------------------------------------------------

/**
 * Is this run's output an adequate answer to ship? An answer is adequate when it
 * succeeded, did not self-request escalation, and either reported no confidence
 * (null — we can't second-guess silence) OR a confidence at/above the risk-indexed
 * threshold. Mirrors orchestrate's accept condition. PURE.
 */
function isAdequate(result: RunResult, policy: Policy, classification: Classification): boolean {
  if (result.errored != null || result.finalText === undefined) return false;
  const assessment = assess(result.finalText);
  if (assessment.escalate) return false;
  const threshold = policy.escalateBelowConfidence[classification.risk];
  return assessment.confidence === null || assessment.confidence >= threshold;
}

/** Compute the real USD cost for a run (provider-reported preferred; never fabricated). */
function costOf(result: RunResult): number {
  const pricing = getModelPricing(result.provider, result.model);
  return (
    result.providerCostUsd ??
    (result.usage !== undefined && pricing !== undefined
      ? calculateCost(result.usage.inputTokens, result.usage.outputTokens, pricing)
      : 0)
  );
}

// ---------------------------------------------------------------------------
// Executor — runHedged
// ---------------------------------------------------------------------------

/**
 * Execute one hedged turn. CONTROL FLOW (exactly one `final` event total):
 *
 *  1. Append the user session entry once (matches runPanel/orchestrate).
 *  2. Start the PRIMARY run (route at plan.primaryTier) under its own
 *     `primaryAc`, as a consumed background promise that buffers the events it
 *     would yield (a background promise cannot yield — see runAttempt).
 *  3. Race the primary's completion against `deps.sleep(plan.delayMs)`.
 *  4. If the PRIMARY finishes before the delay:
 *       - adequate → emit its buffered events + success final; the speculative
 *         was NEVER started (quota saved) — emit an honest "answered in time"
 *         notice. DONE.
 *       - inadequate → run the speculative flagship SEQUENTIALLY now (no latency
 *         saved, but correct) and emit its events + final.
 *  5. If the DELAY elapses first (primary still running):
 *       - emit a "primary slow — starting speculative flagship" notice;
 *       - start the SPECULATIVE run (route at 'manager', ceiling lifted —
 *         admission already passed in planHedge) under its own `speculativeAc`;
 *       - await BOTH; take the FIRST to finish with an ADEQUATE result, abort the
 *         OTHER. If the first finisher is inadequate, await the other and pick the
 *         adequate one; if neither is adequate, ship the speculative (flagship) as
 *         the best-effort answer. Emit the winner's events + final.
 *  6. Ledger.record EVERY run that actually executed (primary always; speculative
 *     when started) with real measured metrics — a cancelled run still gets an
 *     entry with whatever usage was captured (0 if none) and success:false. We
 *     never fabricate usage. totalCostUsd = sum of all runs.
 *  7. Abort handling: if the CALLER's `signal` aborts at any point, both branch
 *     controllers are aborted (they are linked to it), and we emit notice(warn,
 *     'cancelled') + a failing final and return.
 *
 * @param task           - The raw user task.
 * @param deps           - Injected ports/providers (must include deps.sleep).
 * @param plan           - The resolved HedgePlan from planHedge().
 * @param signal         - Caller AbortSignal; on abort → notice(warn) + failing final.
 * @param historyContext - Optional compacted prior-conversation summary.
 */
export async function* runHedged(
  task: string,
  deps: OrchestrateDeps,
  plan: HedgePlan,
  signal: AbortSignal,
  historyContext?: string,
): AsyncGenerator<CoreEvent> {
  // Append the user message once (matches orchestrate/runPanel).
  await deps.session.append({
    timestamp: deps.clock.isoNow(),
    role: 'user',
    content: task,
  });

  let totalCostUsd = 0;
  let attempts = 0;
  const classification = adequacyClassification(plan);
  const incomingWorkContract =
    deps.workContract !== undefined ? capContract(deps.workContract) : undefined;
  const generatedWorkTrace =
    incomingWorkContract === undefined &&
    shouldMaterializeContract({
      classification,
      routePlan: false,
      context: 'normal',
      reviewWillRun: false,
    }).roadmap &&
    isCleanObjectiveTask(task)
      ? capContract({ version: 1, objective: task })
      : undefined;
  const workTrace =
    incomingWorkContract !== undefined ? incomingWorkContract : generatedWorkTrace;

  // Early abort: nothing ran yet.
  if (signal.aborted) {
    yield { type: 'notice', level: 'warn', message: 'cancelled' };
    yield {
      type: 'final',
      success: false,
      output: 'Task was cancelled before it started.',
      tier: plan.primaryTier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(signal.aborted ? { canceled: true } : {}),
    };
    return;
  }

  // The delay port is guaranteed present (planHedge required hasSleep), but be
  // defensive: a missing sleep degrades to "no wait", i.e. the speculative path.
  const sleep = deps.sleep ?? ((): Promise<void> => Promise.resolve());

  // Each branch runs under its own AbortController linked to the caller's signal,
  // so (a) we can cancel the LOSER independently and (b) a caller abort cancels
  // BOTH. We link by forwarding the caller's abort to each branch controller.
  const primaryAc = new AbortController();
  const speculativeAc = new AbortController();
  const onCallerAbort = (): void => {
    primaryAc.abort();
    speculativeAc.abort();
  };
  if (signal.aborted) onCallerAbort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  // Helper: record a run in the ledger + accumulate its cost. Called for every
  // run that actually executed (incl. cancelled losers, with their real captured
  // usage — 0 when none arrived; never fabricated).
  const recordRun = async (result: RunResult): Promise<number> => {
    const usd = costOf(result);
    totalCostUsd += usd;
    await deps.ledger.record({
      timestamp: deps.clock.isoNow(),
      sessionId: deps.session.id,
      taskId: deps.clock.uuid(),
      provider: result.provider,
      model: result.model,
      tier: result.tier,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
      usd,
      // A cancelled run is not a successful run, even if it produced partial text.
      success: result.errored == null && !result.canceled,
      durationMs: result.durationMs,
      ...(result.reasoningEffort !== undefined ? { reasoningEffort: result.reasoningEffort } : {}),
      taskKind: result.taskKind,
    });
    return usd;
  };

  try {
    // --- Start the PRIMARY run as a background promise. ---
    attempts++;
    const primaryPromise = runAttempt(
      task,
      deps,
      plan.primaryTier,
      deps.policy,
      primaryAc.signal,
      historyContext,
      plan.risk,
    );

    // --- Race the primary against the delay. ---
    // A tagged wrapper distinguishes "delay won" from "primary won" — the delay
    // branch carries no RunResult, so we tag the primary branch and treat any
    // other outcome as "delay elapsed first".
    const raceWinner = await Promise.race<{ readonly primary: RunResult } | { readonly delay: true }>([
      primaryPromise.then((run) => ({ primary: run })),
      sleep(plan.delayMs).then(() => ({ delay: true as const })),
    ]);

    // ===================================================================
    // CASE A: the primary finished before the delay elapsed.
    // ===================================================================
    if ('primary' in raceWinner) {
      const primary = raceWinner.primary;
      await recordRun(primary);

      // Caller aborted while the primary ran → honest cancel.
      if (signal.aborted) {
        yield { type: 'notice', level: 'warn', message: 'cancelled' };
        yield {
          type: 'final',
          success: false,
          output: 'Task was cancelled.',
          tier: primary.tier,
          totalCostUsd,
          sessionId: deps.session.id,
          attempts,
          ...(signal.aborted ? { canceled: true } : {}),
        };
        return;
      }

      if (isAdequate(primary, deps.policy, adequacyClassification(plan))) {
        // Adequate AND in time — the speculative flagship was never started, so
        // its quota is genuinely saved. Honest notice (no cancellation claim).
        yield { type: 'notice', level: 'info', message: 'hedge: primary answered in time' };
        yield* primary.events;
        yield* finalAndAppend(primary, totalCostUsd, deps, attempts, workTrace);
        return;
      }

      // Primary finished fast but inadequate → run the speculative flagship
      // SEQUENTIALLY now. No latency was saved (the primary already returned),
      // but the answer is correct. Lift the manager ceiling (admission already
      // passed in planHedge).
      yield* primary.events;
      yield {
        type: 'notice',
        level: 'info',
        message: 'hedge: primary low-confidence — escalating to the flagship',
      };
      attempts++;
      const specPolicy: Policy = { ...deps.policy, maxTier: 'manager' };
      const speculative = await runAttempt(
        task,
        deps,
        plan.speculativeTier,
        specPolicy,
        speculativeAc.signal,
        historyContext,
        plan.risk,
      );
      await recordRun(speculative);

      if (signal.aborted) {
        yield { type: 'notice', level: 'warn', message: 'cancelled' };
        yield {
          type: 'final',
          success: false,
          output: 'Task was cancelled.',
          tier: speculative.tier,
          totalCostUsd,
          sessionId: deps.session.id,
          attempts,
          ...(signal.aborted ? { canceled: true } : {}),
        };
        return;
      }

      yield* speculative.events;
      // Ship the flagship result (it's the strongest attempt) — successful when it
      // produced output without error, even if its confidence is unparsed.
      yield* finalAndAppend(speculative, totalCostUsd, deps, attempts, workTrace);
      return;
    }

    // ===================================================================
    // CASE B: the delay elapsed first — the primary is still running.
    // ===================================================================
    yield {
      type: 'notice',
      level: 'info',
      message: 'hedge: primary slow — starting speculative flagship',
    };

    // Start the speculative flagship in parallel. Lift the manager ceiling
    // (admission already passed in planHedge).
    attempts++;
    const specPolicy: Policy = { ...deps.policy, maxTier: 'manager' };
    const speculativePromise = runAttempt(
      task,
      deps,
      plan.speculativeTier,
      specPolicy,
      speculativeAc.signal,
      historyContext,
      plan.risk,
    );

    // Take the FIRST to finish with an adequate result; cancel the other.
    const winner = await pickWinner(
      primaryPromise,
      speculativePromise,
      primaryAc,
      speculativeAc,
      deps.policy,
      classification,
    );

    // Record BOTH runs that executed (winner + the cancelled/finished loser).
    await recordRun(winner.first);
    if (winner.second !== undefined) await recordRun(winner.second);

    if (signal.aborted) {
      yield { type: 'notice', level: 'warn', message: 'cancelled' };
      yield {
        type: 'final',
        success: false,
        output: 'Task was cancelled.',
        tier: winner.chosen.tier,
        totalCostUsd,
        sessionId: deps.session.id,
        attempts,
        ...(signal.aborted ? { canceled: true } : {}),
      };
      return;
    }

    // Honest notice naming which branch won and that we cancelled the slower one.
    yield {
      type: 'notice',
      level: 'info',
      message:
        winner.chosen === winner.primaryRef
          ? 'hedge: primary won the race — cancelled the slower flagship branch'
          : 'hedge: speculative flagship won the race — cancelled the slower primary branch',
    };

    yield* winner.chosen.events;
    yield* finalAndAppend(winner.chosen, totalCostUsd, deps, attempts, workTrace);
    return;
  } finally {
    // Never leave a branch running or a listener attached.
    primaryAc.abort();
    speculativeAc.abort();
    signal.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * The classification used for the adequacy bar. Uses the turn's REAL risk (carried
 * on the plan) to index `escalateBelowConfidence`, so a critical turn applies the
 * stricter critical threshold to accept a primary — never under-escalating it. Pure.
 */
function adequacyClassification(plan: HedgePlan): Classification {
  return { tier: plan.primaryTier, risk: plan.risk, rationale: 'hedge adequacy bar' };
}

// ---------------------------------------------------------------------------
// Winner selection (module-level so it isn't recreated per call)
// ---------------------------------------------------------------------------

/** The outcome of racing the primary and speculative runs. */
interface WinnerOutcome {
  /** The run whose answer is shipped. */
  readonly chosen: RunResult;
  /** Identity ref to the primary's RunResult (for the honest "who won" notice). */
  readonly primaryRef: RunResult;
  /** The first run to finish (for ledger ordering). */
  readonly first: RunResult;
  /** The second run that finished (or was cancelled), or undefined if same as first. */
  readonly second: RunResult | undefined;
}

/**
 * Await the primary and speculative runs and pick the answer to ship:
 *  - take the FIRST to finish with an ADEQUATE result, abort the other;
 *  - if the first finisher is inadequate, await the other and pick the adequate
 *    one;
 *  - if NEITHER is adequate, ship the speculative (flagship) as the best-effort
 *    answer (it is the strongest attempt).
 *
 * Aborting the loser is best-effort (the CLI may already have consumed capacity)
 * — we never claim it saved quota.
 */
async function pickWinner(
  primaryPromise: Promise<RunResult>,
  speculativePromise: Promise<RunResult>,
  primaryAc: AbortController,
  speculativeAc: AbortController,
  policy: Policy,
  classification: Classification,
): Promise<WinnerOutcome> {
  // Tag each promise with its identity so we know which finished first.
  const tagged = await Promise.race([
    primaryPromise.then((r) => ({ which: 'primary' as const, run: r })),
    speculativePromise.then((r) => ({ which: 'speculative' as const, run: r })),
  ]);

  const firstAdequate = isAdequate(tagged.run, policy, classification);
  if (firstAdequate) {
    // First finisher is good — cancel the slower branch and ship it.
    if (tagged.which === 'primary') speculativeAc.abort();
    else primaryAc.abort();
    const other = tagged.which === 'primary' ? await speculativePromise : await primaryPromise;
    const primaryRef = tagged.which === 'primary' ? tagged.run : other;
    return { chosen: tagged.run, primaryRef, first: tagged.run, second: other };
  }

  // First finisher inadequate — let the other finish and choose between them.
  const other = tagged.which === 'primary' ? await speculativePromise : await primaryPromise;
  const otherAdequate = isAdequate(other, policy, classification);

  const primaryRun = tagged.which === 'primary' ? tagged.run : other;
  const speculativeRun = tagged.which === 'speculative' ? tagged.run : other;

  // Prefer an adequate `other`; else ship the speculative flagship (strongest).
  const chosen = otherAdequate ? other : speculativeRun;
  return { chosen, primaryRef: primaryRun, first: tagged.run, second: other };
}

// ---------------------------------------------------------------------------
// Final emission + session append (module-level)
// ---------------------------------------------------------------------------

/**
 * Emit the final event for the chosen run AND persist its assistant turn to the
 * session (on success), mirroring orchestrate/runPanel. A failing run emits a
 * failing final and is NOT appended (we never persist an error message as the
 * assistant's answer).
 */
async function* finalAndAppend(
  run: RunResult,
  totalCostUsd: number,
  deps: OrchestrateDeps,
  attempts: number,
  workTrace: WorkContract | undefined,
): AsyncGenerator<CoreEvent> {
  const success = run.errored == null && run.finalText !== undefined && !run.canceled;
  const output = run.finalText ?? (run.errored?.message ?? '');

  if (!success) {
    yield {
      type: 'final',
      success: false,
      output,
      tier: run.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(run.canceled ? { canceled: true } : {}),
      ...(run.errored !== undefined ? { errorCategory: run.errored.category } : {}),
      provider: run.provider,
    };
    return;
  }

  const assessment = assess(output);
  const usd = costOf(run);
  await deps.session.append({
    timestamp: deps.clock.isoNow(),
    role: 'assistant',
    content: output,
    tier: run.tier,
    provider: run.provider,
    model: run.model,
    confidence: assessment.confidence,
    costUsd: usd,
    durationMs: run.durationMs,
    ...(workTrace !== undefined ? { workTrace } : {}),
  });

  yield {
    type: 'final',
    success: true,
    output,
    tier: run.tier,
    totalCostUsd,
    sessionId: deps.session.id,
    attempts,
  };
}
