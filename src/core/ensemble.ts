/**
 * src/core/ensemble.ts — the Parallel Subscription Panel (EXPERIMENTAL, opt-in).
 *
 * The sequential engine (orchestrate.ts) runs one model per step and escalates.
 * The Panel takes a different shape: it runs a turn as a CONCURRENT panel of the
 * user's signed-in providers — each answers the task INDEPENDENTLY — then a
 * cross-vendor synthesizer reads all candidate answers and adjudicates them into
 * a single final answer for the user.
 *
 * Why this is uniquely a subscription-first move: on a flat-rate plan, extra
 * model runs cost $0 in dollars. The only budget is rate-limit/quota headroom +
 * latency. Spending several CONCURRENT runs on a hard turn buys genuinely
 * independent judgment (different vendors, different training, different failure
 * modes) that an API-key-billed tool would never afford. The synthesizer then
 * cross-checks claims across vendors, which catches single-model confident-but-
 * wrong answers the sequential path would ship.
 *
 * Scope / safety:
 *  - Default OFF (panelPolicy absent → 'off'); zero behaviour change unless the
 *    user opts in. A panel only forms with ≥2 authenticated providers; otherwise
 *    the normal single-model path runs.
 *  - planPanel / buildPanelCandidatePrompt / buildPanelSynthesisPrompt are PURE.
 *  - runPanel does I/O ONLY through the injected OrchestrateDeps ports/providers,
 *    exactly like orchestrate() — that is not a purity violation.
 *
 * Purity rules (enforced by test/arch/guards.test.ts), same as the sibling core
 * modules: no fs/path/child_process/os/crypto, no Date.now()/Math.random()/new
 * Date(), and no imports from src/providers/* except the type-only ProviderId.
 * All time/ids come from deps.clock.
 */

import type {
  CoreEvent,
  OrchestrateDeps,
  Tier,
  Classification,
  Policy,
} from './types.js';
import type { ProviderId } from '../providers/port.js';
import { route } from './route.js';
import { getModelPricing, calculateCost } from '../infra/pricing.js';
import { assess } from './assess.js';

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * A resolved plan for one panel turn: which providers answer independently
 * (`candidates`) and which provider adjudicates their answers (`synthesizer`).
 */
export interface PanelPlan {
  /** The tier every panel run executes at (candidates + synthesizer). */
  readonly tier: Tier;
  /** The providers that answer the task independently (≥2, distinct). */
  readonly candidates: readonly ProviderId[];
  /** The provider that reconciles the candidate answers into the final one. */
  readonly synthesizer: ProviderId;
}

/**
 * Decide whether (and how) a panel should form for this turn. PURE.
 *
 * Returns null (→ the normal sequential path runs) when:
 *  - panelPolicy is 'off' or undefined; or
 *  - panelPolicy is 'hard-turns' and the turn is NOT high/critical risk; or
 *  - fewer than 2 authenticated providers are available (a panel needs ≥2
 *    distinct providers to be a real panel — a single-provider "panel" is just
 *    the normal path, so we defer to it).
 *
 * When a panel forms, candidates are the first `cap` authenticated providers
 * (cap = max(2, maxPanelProviders)) and the synthesizer is candidates[0]
 * (deterministic — it adjudicates ALL candidate outputs, including its own).
 *
 * @param opts.panelPolicy            - Policy posture ('off' | 'hard-turns' | 'always').
 * @param opts.classification         - Task classification (risk gates 'hard-turns').
 * @param opts.tier                   - The resolved tier every panel run uses.
 * @param opts.authenticatedProviders - Signed-in provider ids (panel candidates pool).
 * @param opts.maxPanelProviders      - Max concurrent candidates (quota guard; floor 2).
 */
export function planPanel(opts: {
  readonly panelPolicy: Policy['panelPolicy'];
  readonly classification: Classification;
  readonly tier: Tier;
  readonly authenticatedProviders: readonly ProviderId[];
  readonly maxPanelProviders: number;
}): PanelPlan | null {
  const { panelPolicy, classification, tier, authenticatedProviders, maxPanelProviders } = opts;

  // 'off' / undefined → never form a panel (the sequential engine runs).
  if (panelPolicy === undefined || panelPolicy === 'off') return null;

  // 'always' qualifies every turn; 'hard-turns' only on high/critical risk.
  const qualifies =
    panelPolicy === 'always' ||
    (panelPolicy === 'hard-turns' &&
      (classification.risk === 'high' || classification.risk === 'critical'));
  if (!qualifies) return null;

  // Cap concurrent candidates — never below 2 (a panel needs ≥2 to be a panel).
  const cap = Math.max(2, maxPanelProviders);
  const candidates = authenticatedProviders.slice(0, cap);

  // <2 distinct providers → no real panel; defer to the single-model path.
  if (candidates.length < 2) return null;

  // Deterministic synthesizer: the first candidate adjudicates all outputs.
  const synthesizer = candidates[0] as ProviderId;

  return { tier, candidates, synthesizer };
}

// ---------------------------------------------------------------------------
// Prompt builders (PURE)
// ---------------------------------------------------------------------------

/**
 * Build the prompt for ONE independent panel candidate.
 *
 * Each candidate is told it is one member of a panel solving the task in
 * parallel — it must answer on its own (no coordination), then end with a short
 * JSON self-report envelope on its own final line so the synthesizer can weigh
 * the answers. We deliberately reuse the same history-injection shape as
 * buildPrompt (prompt.ts) so stateless one-shot providers still get multi-turn
 * context.
 *
 * The envelope keys are intentionally panel-specific (`confidence`,
 * `assumptions`, `what_would_make_this_wrong`) — NOT the orchestrate confidence
 * envelope — because here they feed the synthesizer's cross-check, not assess().
 *
 * @param tier           - The tier this candidate runs at (sets the voice/depth).
 * @param task           - The raw user task.
 * @param historyContext - Optional compacted prior-conversation summary.
 */
export function buildPanelCandidatePrompt(
  tier: Tier,
  task: string,
  historyContext?: string,
): string {
  let prompt = `\
You are ONE independent member of an expert panel answering the following task in
parallel with other engineers. You are at the ${tier} tier. Do NOT coordinate with
or defer to anyone — produce YOUR best independent answer to the task on its own
merits. Another senior engineer will later read every panelist's answer and
synthesize them, so your job is to be a strong, honest, independent data point.

Solve the task fully and concretely. Then, on the FINAL line of your response,
emit EXACTLY this JSON object on its own line and nothing after it (raw JSON, no
code fences):
{"confidence": <0.0-1.0>, "assumptions": "<key assumptions you made>", "what_would_make_this_wrong": "<the most likely way your answer is wrong>"}

Be honest in the envelope: confidence is your real self-assessed probability of
correctness, and "what_would_make_this_wrong" should name a genuine failure mode,
not a throwaway.`;

  if (historyContext !== undefined && historyContext.trim().length > 0) {
    prompt += `\n\nCONVERSATION SO FAR (for context; do not repeat it back):\n${historyContext.trim()}`;
  }

  prompt += `\n\n---\n\nTask:\n${task}`;
  return prompt;
}

/**
 * Build the prompt for the cross-vendor synthesizer. PURE.
 *
 * The synthesizer reads the N independent candidate answers, reconciles and
 * cross-checks them, prefers the best-supported claims, flags any material
 * disagreement, and produces ONE final answer for the user. There is NO JSON
 * verdict to parse — the synthesizer's prose IS the answer the user sees.
 *
 * @param task       - The raw user task.
 * @param candidates - The successful candidate outputs, labelled by provider.
 */
export function buildPanelSynthesisPrompt(
  task: string,
  candidates: ReadonlyArray<{ provider: ProviderId; output: string }>,
): string {
  const blocks = candidates
    .map(
      (c, i) =>
        `--- PANELIST ${i + 1} (${c.provider}) ---\n${c.output.trim()}`,
    )
    .join('\n\n');

  return `\
You are a senior synthesizer adjudicating an expert panel. ${candidates.length}
engineers each answered the SAME task independently (their answers are below).
Your job is to produce the single best final answer for the user.

How to synthesize:
- Read every panelist's answer carefully and cross-check their claims against one
  another. Where they agree on something substantive, that agreement is evidence
  it is right.
- Where they DISAGREE on something material, do not paper over it: decide which
  position is better supported (and briefly say why), or surface the disagreement
  honestly if it genuinely cannot be resolved from what's here.
- Prefer the best-supported, most concrete claims; discard anything a panelist
  asserted without support that another panelist contradicts.
- Do NOT just stitch the answers together or pick one wholesale — integrate them
  into one coherent, correct answer in your own voice.
- Write the final answer directly to the user. Do not mention "panelists" or this
  instruction unless a real disagreement is worth flagging.

Original task:
${task}

Independent panel answers:
${blocks}

Now write the single final answer for the user.`;
}

// ---------------------------------------------------------------------------
// Executor — internal streaming + candidate helpers
// ---------------------------------------------------------------------------

/**
 * Stream a single provider run, yielding a `provider-event` for each event while
 * accumulating the terminal text/usage/cost. Mirrors orchestrate's streamProvider
 * so the synthesizer renders as one clean live stream. Returns the outcome.
 */
async function* streamProvider(
  deps: OrchestrateDeps,
  providerId: ProviderId,
  req: import('../providers/port.js').ProviderRequest,
  tier: Tier,
  signal: AbortSignal,
): AsyncGenerator<
  CoreEvent,
  {
    finalText: string | undefined;
    errored: import('../providers/port.js').CliError | undefined;
    usage: import('../providers/port.js').Usage | undefined;
    providerCostUsd: number | undefined;
    canceled: boolean;
  }
> {
  const provider = deps.providers[providerId];
  let finalText: string | undefined;
  let errored: import('../providers/port.js').CliError | undefined;
  let usage: import('../providers/port.js').Usage | undefined;
  let providerCostUsd: number | undefined;

  if (provider === undefined || signal.aborted) {
    return { finalText, errored, usage, providerCostUsd, canceled: signal.aborted };
  }

  for await (const ev of provider.run(req, signal)) {
    yield { type: 'provider-event', tier, event: ev };
    if (ev.type === 'done') {
      finalText = ev.text;
      if (ev.usage !== undefined && usage === undefined) usage = ev.usage;
      if (ev.costUsd !== undefined) providerCostUsd = ev.costUsd;
    } else if (ev.type === 'error') {
      errored = ev.error;
    } else if (ev.type === 'usage' && usage === undefined) {
      usage = ev.usage;
    }
    if (signal.aborted) {
      return { finalText, errored, usage, providerCostUsd, canceled: true };
    }
  }
  return { finalText, errored, usage, providerCostUsd, canceled: false };
}

/** The measured outcome of one panel candidate run. */
interface CandidateOutcome {
  readonly provider: ProviderId;
  readonly model: string;
  readonly finalText: string | undefined;
  readonly usage: import('../providers/port.js').Usage | undefined;
  readonly providerCostUsd: number | undefined;
  readonly errored: import('../providers/port.js').CliError | undefined;
  readonly durationMs: number;
}

/**
 * Run ONE candidate to completion WITHOUT yielding (we cannot yield from inside
 * Promise.all). Consumes the provider's events purely for their terminal data —
 * candidate prose deltas are intentionally NOT streamed to the user (attention
 * budget); the caller emits only the start/done summary events around the await.
 */
async function runCandidate(
  task: string,
  deps: OrchestrateDeps,
  plan: PanelPlan,
  candidate: ProviderId,
  signal: AbortSignal,
  historyContext: string | undefined,
): Promise<CandidateOutcome> {
  const decision = route(
    plan.tier,
    [candidate],
    deps.policy,
    deps.availableModels,
    deps.authenticatedProviders,
    // Single-provider pool: the learned order can only confirm this candidate
    // (it cannot reorder a one-element pool, and each candidate is fixed by the
    // panel plan). Passed for consistency so every route() call threads it.
    deps.learnedProviderOrder?.[plan.tier],
  );
  const provider = deps.providers[candidate];
  const start = deps.clock.now();

  let finalText: string | undefined;
  let errored: import('../providers/port.js').CliError | undefined;
  let usage: import('../providers/port.js').Usage | undefined;
  let providerCostUsd: number | undefined;

  if (provider === undefined) {
    errored = {
      category: 'unknown',
      recoverable: false,
      message: `Provider "${candidate}" selected for the panel but absent from deps.providers.`,
      suggestion: 'Ensure the provider is installed and authenticated.',
    };
    return {
      provider: candidate,
      model: decision.model,
      finalText,
      usage,
      providerCostUsd,
      errored,
      durationMs: deps.clock.now() - start,
    };
  }

  const req: import('../providers/port.js').ProviderRequest = {
    model: decision.model,
    prompt: buildPanelCandidatePrompt(decision.tier, task, historyContext),
    cwd: deps.cwd,
    sandbox: deps.sandbox,
    timeoutMs: deps.timeoutMs,
  };

  try {
    for await (const ev of provider.run(req, signal)) {
      if (ev.type === 'done') {
        finalText = ev.text;
        if (ev.usage !== undefined && usage === undefined) usage = ev.usage;
        if (ev.costUsd !== undefined) providerCostUsd = ev.costUsd;
      } else if (ev.type === 'error') {
        errored = ev.error;
      } else if (ev.type === 'usage' && usage === undefined) {
        usage = ev.usage;
      }
    }
  } catch (err) {
    errored = {
      category: 'unknown',
      recoverable: false,
      message: err instanceof Error ? err.message : String(err),
      suggestion: 'The panel candidate run threw unexpectedly.',
    };
  }

  return {
    provider: candidate,
    model: decision.model,
    finalText,
    usage,
    providerCostUsd,
    errored,
    durationMs: deps.clock.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Executor — runPanel
// ---------------------------------------------------------------------------

/**
 * Execute one panel turn: run every candidate CONCURRENTLY, then stream the
 * cross-vendor synthesizer's adjudication as the user-facing answer.
 *
 * Event contract (so the render layer sees honest, real measurements):
 *  - notice(info) naming the panel composition.
 *  - tier-start for EVERY candidate BEFORE the concurrent await (so the UI knows
 *    all panelists are running), then tier-done for each with its REAL measured
 *    metrics after Promise.all resolves. Candidate prose deltas are NOT streamed.
 *  - If zero candidates succeed → a failing final (with the last error's
 *    category/provider when available) and return.
 *  - Otherwise: stream the synthesizer live (provider-event per event) wrapped in
 *    its own tier-start/tier-done, then a successful final whose output is the
 *    synthesizer's text.
 *
 * Costs, ledger entries, and session append all mirror orchestrate(): every run
 * (candidates + synthesizer) is recorded; usage that never arrived is recorded as
 * 0 (never fabricated); totalCostUsd is the real sum across all runs.
 *
 * @param task           - The raw user task.
 * @param deps           - Injected ports/providers (same shape orchestrate uses).
 * @param plan           - The resolved PanelPlan from planPanel().
 * @param signal         - AbortSignal; on abort yields notice(warn) + failing final.
 * @param historyContext - Optional compacted prior-conversation summary.
 */
export async function* runPanel(
  task: string,
  deps: OrchestrateDeps,
  plan: PanelPlan,
  signal: AbortSignal,
  historyContext?: string,
): AsyncGenerator<CoreEvent> {
  // Append the user message once (matches orchestrate's single user append).
  await deps.session.append({
    timestamp: deps.clock.isoNow(),
    role: 'user',
    content: task,
  });

  let totalCostUsd = 0;
  let attempts = 0;

  // Early abort: nothing ran yet.
  if (signal.aborted) {
    yield { type: 'notice', level: 'warn', message: 'cancelled' };
    yield {
      type: 'final',
      success: false,
      output: 'Task was cancelled before it started.',
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
    };
    return;
  }

  yield {
    type: 'notice',
    level: 'info',
    message: `Panel: ${plan.candidates.join(', ')} → synthesized by ${plan.synthesizer}`,
  };

  // --- Candidates: announce all, then run concurrently. ---
  // Resolve each candidate's model first so the tier-start carries the real model.
  const candidateModels = new Map<ProviderId, string>();
  for (const candidate of plan.candidates) {
    const d = route(
      plan.tier,
      [candidate],
      deps.policy,
      deps.availableModels,
      deps.authenticatedProviders,
      deps.learnedProviderOrder?.[plan.tier],
    );
    candidateModels.set(candidate, d.model);
    attempts++;
    yield {
      type: 'tier-start',
      tier: plan.tier,
      provider: candidate,
      model: d.model,
      attempt: attempts,
    };
  }

  // True concurrency: all candidates run in parallel.
  const outcomes = await Promise.all(
    plan.candidates.map((candidate) =>
      runCandidate(task, deps, plan, candidate, signal, historyContext),
    ),
  );

  // Per-candidate: record cost, ledger, session, and emit tier-done.
  let lastErrored: import('../providers/port.js').CliError | undefined;
  let lastErroredProvider: ProviderId | undefined;
  for (const outcome of outcomes) {
    const success = outcome.errored == null;
    const pricing = getModelPricing(outcome.provider, outcome.model);
    const usd =
      outcome.providerCostUsd ??
      (outcome.usage !== undefined && pricing !== undefined
        ? calculateCost(outcome.usage.inputTokens, outcome.usage.outputTokens, pricing)
        : 0);
    totalCostUsd += usd;

    if (!success && outcome.errored !== undefined) {
      lastErrored = outcome.errored;
      lastErroredProvider = outcome.provider;
    }

    const assessment = assess(outcome.finalText ?? '');

    await deps.ledger.record({
      timestamp: deps.clock.isoNow(),
      sessionId: deps.session.id,
      taskId: deps.clock.uuid(),
      provider: outcome.provider,
      model: outcome.model,
      tier: plan.tier,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      cachedInputTokens: outcome.usage?.cachedInputTokens ?? 0,
      usd,
      durationMs: outcome.durationMs,
      success,
    });

    yield {
      type: 'tier-done',
      tier: plan.tier,
      success,
      confidence: assessment.confidence,
      costUsd: usd,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      durationMs: outcome.durationMs,
    };
  }

  // Cancellation during candidate runs → stop honestly.
  if (signal.aborted) {
    yield { type: 'notice', level: 'warn', message: 'cancelled' };
    yield {
      type: 'final',
      success: false,
      output: 'Task was cancelled.',
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
    };
    return;
  }

  // --- Gather successful candidate outputs for synthesis. ---
  const succeeded = outcomes.filter(
    (o): o is CandidateOutcome & { finalText: string } =>
      o.errored == null && o.finalText !== undefined,
  );

  if (succeeded.length === 0) {
    // Every panelist failed — nothing to synthesize. Surface the last error.
    yield {
      type: 'final',
      success: false,
      output:
        lastErrored?.message ??
        'All panel candidates failed before producing an answer.',
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(lastErrored !== undefined ? { errorCategory: lastErrored.category } : {}),
      ...(lastErroredProvider !== undefined ? { provider: lastErroredProvider } : {}),
    };
    return;
  }

  // --- Synthesizer: stream its adjudication live as the user-facing answer. ---
  const synthDecision = route(
    plan.tier,
    [plan.synthesizer],
    deps.policy,
    deps.availableModels,
    deps.authenticatedProviders,
    deps.learnedProviderOrder?.[plan.tier],
  );
  const synthPrompt = buildPanelSynthesisPrompt(
    task,
    succeeded.map((o) => ({ provider: o.provider, output: o.finalText })),
  );

  attempts++;
  yield {
    type: 'tier-start',
    tier: synthDecision.tier,
    provider: plan.synthesizer,
    model: synthDecision.model,
    attempt: attempts,
  };

  const synthReq: import('../providers/port.js').ProviderRequest = {
    model: synthDecision.model,
    prompt: synthPrompt,
    cwd: deps.cwd,
    sandbox: deps.sandbox,
    timeoutMs: deps.timeoutMs,
  };
  const synthStart = deps.clock.now();
  const synthOutcome = yield* streamProvider(
    deps,
    plan.synthesizer,
    synthReq,
    synthDecision.tier,
    signal,
  );
  const synthDurationMs = deps.clock.now() - synthStart;

  if (synthOutcome.canceled) {
    yield { type: 'notice', level: 'warn', message: 'cancelled' };
    yield {
      type: 'final',
      success: false,
      output: 'Task was cancelled.',
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
    };
    return;
  }

  const synthSuccess = synthOutcome.errored == null;
  const synthPricing = getModelPricing(plan.synthesizer, synthDecision.model);
  const synthUsd =
    synthOutcome.providerCostUsd ??
    (synthOutcome.usage !== undefined && synthPricing !== undefined
      ? calculateCost(
          synthOutcome.usage.inputTokens,
          synthOutcome.usage.outputTokens,
          synthPricing,
        )
      : 0);
  totalCostUsd += synthUsd;

  const synthText = synthOutcome.finalText ?? (synthOutcome.errored?.message ?? '');
  const synthAssessment = assess(synthText);

  await deps.ledger.record({
    timestamp: deps.clock.isoNow(),
    sessionId: deps.session.id,
    taskId: deps.clock.uuid(),
    provider: plan.synthesizer,
    model: synthDecision.model,
    tier: synthDecision.tier,
    inputTokens: synthOutcome.usage?.inputTokens ?? 0,
    outputTokens: synthOutcome.usage?.outputTokens ?? 0,
    cachedInputTokens: synthOutcome.usage?.cachedInputTokens ?? 0,
    usd: synthUsd,
    durationMs: synthDurationMs,
    success: synthSuccess,
  });

  yield {
    type: 'tier-done',
    tier: synthDecision.tier,
    success: synthSuccess,
    confidence: synthAssessment.confidence,
    costUsd: synthUsd,
    inputTokens: synthOutcome.usage?.inputTokens ?? 0,
    outputTokens: synthOutcome.usage?.outputTokens ?? 0,
    durationMs: synthDurationMs,
  };

  if (!synthSuccess) {
    // The synthesizer itself failed; surface honestly rather than ship its error.
    yield {
      type: 'final',
      success: false,
      output: synthText,
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(synthOutcome.errored !== undefined
        ? { errorCategory: synthOutcome.errored.category }
        : {}),
      provider: plan.synthesizer,
    };
    return;
  }

  // Persist the synthesizer's answer as the assistant turn (matches orchestrate).
  await deps.session.append({
    timestamp: deps.clock.isoNow(),
    role: 'assistant',
    content: synthText,
    tier: synthDecision.tier,
    provider: plan.synthesizer,
    model: synthDecision.model,
    confidence: synthAssessment.confidence,
    costUsd: synthUsd,
    durationMs: synthDurationMs,
  });

  yield {
    type: 'final',
    success: true,
    output: synthText,
    tier: plan.tier,
    totalCostUsd,
    sessionId: deps.session.id,
    attempts,
  };
}
