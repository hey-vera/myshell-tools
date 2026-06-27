/**
 * src/core/judgment-poll.ts — THE PLURAL JUDGMENT POLL (master-plan PHASE 7,
 * the GATED half of the judgment superpower; .tmp-master-judgment.md Part 1).
 *
 * THE ONE IDEA: every single-vendor tool ships ONE mind's judgment. myshell's user
 * owns 2–3 independent expert vendor minds, so on a genuine DECISION it can put the
 * call to all of them at once. When they AGREE, that agreement is earned multi-
 * perspective confidence a single model literally cannot produce. When they
 * DISAGREE, that disagreement is a genuine fork — surfaced honestly to the one judge
 * who owns the decision: the user.
 *
 * THE HARD BOUNDARY (the frontier result): this is NOT a debate / council / N agents
 * arguing across rounds — iterated debate flips correct answers as models talk each
 * other out of the truth. It is a bounded **ONE-SHOT poll → deterministic tally →
 * honest synthesis → collaborative surfacing**. Each vendor answers the decision
 * ONCE, independently, with NO cross-talk; a deterministic tally of the structured
 * `choice` fields yields CONSENSUS / LEAN / SPLIT; and — THE HONESTY INVERSION vs the
 * panel — the synthesizer is FORBIDDEN from resolving a genuine SPLIT. The split IS
 * the product, not a defect.
 *
 * REUSE, NOT REWRITE: `runJudgmentPoll` is a near-clone of `ensemble.ts::runPanel`,
 * sharing `runCandidate` / `mergeCandidates` / the cost+ledger accounting VERBATIM
 * (imported + parameterized, never duplicated). It differs from the panel in exactly
 * three ways: (a) it asks the DECISION (which option + why), not "do the task";
 * (b) candidates are CROSS-VENDOR by construction (one per distinct authed vendor);
 * (c) it is STRICTLY ONE ROUND with NO cross-talk and NO synthesizer model run — the
 * "synthesis" is a PURE deterministic tally, so no model can ever overwrite it.
 *
 * SINGLE-VENDOR (the non-negotiable): with <2 authed vendors the poll DOES NOT FORM
 * (`planJudgment` returns null) — the partner degrades honestly to its own single-
 * mind judgment (push_back / the existing flow). We never fake a second mind, never
 * poll the same vendor twice and call it plural.
 *
 * GOVERNED: the poll is an expensive lever (N candidate calls). It fires only when
 * the judgment flag is ON **and** it's a genuine multi-option fork **and** the
 * Governor's allocation permits it (the poll lever was granted within
 * `turnCallBudget`). It draws from the one budget; ONE poll per turn.
 *
 * PURITY: the PLANNER (`planJudgment`), the PROMPT builder
 * (`buildJudgmentCandidatePrompt`), the VERDICT parser (`parseJudgmentVerdict`), and
 * the SYNTHESIZER (`synthesizeJudgment`) are ALL pure (no fs/path/child_process, no
 * Date.now/Math.random/new Date, no provider imports beyond the type-only ProviderId)
 * — enforced by test/arch/guards.test.ts. Only `runJudgmentPoll` does I/O, and ONLY
 * through the injected `OrchestrateDeps` ports/providers, exactly like runPanel.
 */

import type { CoreEvent, OrchestrateDeps, Tier, Classification } from './types.js';
import type { ProviderId } from '../providers/port.js';
import { getModelPricing, calculateCost, calculateEffectiveCost } from '../infra/pricing.js';
import { parseFinalLineChoiceEnvelope, tallyChoiceEnvelopes } from './judgment-shared.js';
import {
  runCandidate,
  mergeCandidates,
  contextFromDeps,
  type CandidateOutcome,
  type PanelCapabilityInput,
} from './ensemble.js';
import { assembleContextBlocks } from './prompt-context.js';

// ---------------------------------------------------------------------------
// The decision the poll weighs — a genuine solution-space fork
// ---------------------------------------------------------------------------

/**
 * One named option on the decision the poll weighs. `id` is the stable key the
 * tally counts (a vendor's structured `choice` must match an `id`); `label` is the
 * human approach text the candidate prompt shows (`approach — tradeoff`).
 */
export interface JudgmentOption {
  readonly id: string;
  readonly label: string;
}

/**
 * The DECISION put to the poll — a real fork with ≥2 named options. Built from the
 * intent frame's solution-space fork (the SAME `IntentFork` that already drives the
 * ask-vs-proceed spine). The poll NEVER invents a fork; `planJudgment` forms only
 * when the frame already carried one with ≥2 options.
 */
export interface JudgmentDecision {
  /** The fork question, in plain language (the design/approach call). */
  readonly question: string;
  /** The competing approaches (≥2), each an option the tally can count by id. */
  readonly options: readonly JudgmentOption[];
}

// ---------------------------------------------------------------------------
// The plan — cross-vendor by construction
// ---------------------------------------------------------------------------

/** A resolved plan for one judgment poll: which DISTINCT vendors weigh the call. */
export interface JudgmentPollPlan {
  /** The tier every candidate runs at (cross-vendor diversity is the value). */
  readonly tier: Tier;
  /** The DISTINCT authenticated vendors that weigh the decision (≥2 by construction). */
  readonly candidates: readonly ProviderId[];
  /** The decision being weighed (≥2 named options). */
  readonly decision: JudgmentDecision;
  /** The task classification (risk/tier) for this turn — threaded for parity. */
  readonly classification: Classification;
}

/** A poll needs at least this many DISTINCT vendors to be PLURAL (never faked). */
const MIN_JUDGMENT_VENDORS = 2;
/** A genuine fork needs at least this many named options to be a real decision. */
const MIN_OPTIONS = 2;

/**
 * Decide whether (and how) a judgment poll forms for this turn. PURE; never throws.
 *
 * Returns null (→ NO poll; the partner uses its own single-mind judgment) when:
 *  - the decision has fewer than {@link MIN_OPTIONS} named options (not a real fork); or
 *  - fewer than {@link MIN_JUDGMENT_VENDORS} DISTINCT authenticated vendors exist —
 *    plural judgment REQUIRES plurality; we never poll one mind and call it plural,
 *    never poll the same vendor twice.
 *
 * When a poll forms, candidates are the DISTINCT authenticated vendors (deduped,
 * announce order preserved) — cross-vendor BY CONSTRUCTION. There is NO synthesizer
 * field: the "synthesis" is a pure deterministic tally (no model can overwrite it).
 *
 * The trigger PREDICATES (`!isTrivial && hasGenuineFork && a real ≥2-option fork`)
 * are evaluated by the CALLER (orchestrate, reusing the existing engagement
 * predicates verbatim — no new fork detector) and the Governor gate (the poll lever
 * granted within budget). `planJudgment` is the final structural gate: even a granted
 * lever forms no poll without ≥2 options AND ≥2 distinct vendors.
 */
export function planJudgment(opts: {
  readonly decision: JudgmentDecision;
  readonly tier: Tier;
  readonly classification: Classification;
  readonly authenticatedProviders: readonly ProviderId[];
  /** Optional cap on candidates (quota guard); floored at MIN_JUDGMENT_VENDORS. */
  readonly maxCandidates?: number;
}): JudgmentPollPlan | null {
  try {
    const { decision, tier, classification, authenticatedProviders } = opts;
    if (decision === null || typeof decision !== 'object') return null;
    const options = (decision.options ?? []).filter(
      (o): o is JudgmentOption =>
        o !== null &&
        typeof o === 'object' &&
        typeof o.id === 'string' &&
        o.id.length > 0 &&
        typeof o.label === 'string' &&
        o.label.trim().length > 0,
    );
    // Not a real fork → no poll (the partner states its assumption / proceeds).
    if (options.length < MIN_OPTIONS) return null;

    // DISTINCT vendors only — dedupe, preserve announce order. Plural by construction.
    const seen = new Set<ProviderId>();
    const distinct: ProviderId[] = [];
    for (const id of authenticatedProviders ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        distinct.push(id);
      }
    }
    const cap = Math.max(
      MIN_JUDGMENT_VENDORS,
      Number.isFinite(opts.maxCandidates ?? NaN) ? Math.floor(opts.maxCandidates as number) : distinct.length,
    );
    const candidates = distinct.slice(0, cap);

    // <2 DISTINCT vendors → no plural poll (degrade honestly to single-mind judgment).
    if (candidates.length < MIN_JUDGMENT_VENDORS) return null;

    return { tier, candidates, decision: { question: decision.question, options }, classification };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The candidate prompt — the DECISION framed as a judgment question (PURE)
// ---------------------------------------------------------------------------

/** Cap on the raw decision question rendered into the prompt. */
const QUESTION_CAP = 600;
/** Cap on each option label rendered into the prompt. */
const OPTION_CAP = 300;

/**
 * Build the prompt for ONE independent judgment-poll candidate (sibling of
 * `buildPanelCandidatePrompt`). PURE.
 *
 * Each vendor is told it is one of several INDEPENDENT senior engineers weighing a
 * real DESIGN DECISION — NOT asked to do the task. It is given the candidate
 * approaches (each with its tradeoff) and asked which IT would choose, why, and the
 * one risk that would change its mind. It ends with the SAME structured self-report
 * envelope discipline the panel uses, but JUDGMENT-specific keys
 * (`{"choice","confidence","why","key_risk"}`) so the deterministic tally counts the
 * `choice` id, never prose. NO coordination, NO deference — a strong honest data
 * point. The SAME ordered context blocks every executor gets ride here too
 * (so the vendor reasons WITH the user's taste/intent in scope).
 *
 * @param tier     - The tier this candidate runs at (sets voice/depth).
 * @param decision - The fork question + the named options.
 * @param historyContext - Optional compacted prior-conversation summary.
 * @param context  - The rendered context blocks (assembleContextBlocks input).
 */
export function buildJudgmentCandidatePrompt(
  tier: Tier,
  decision: JudgmentDecision,
  historyContext?: string,
  context?: Parameters<typeof assembleContextBlocks>[0],
): string {
  const question = (decision.question ?? '').trim().slice(0, QUESTION_CAP);
  const optionLines = (decision.options ?? [])
    .map((o, i) => `${i + 1}. [${o.id}] ${o.label.trim().slice(0, OPTION_CAP)}`)
    .join('\n');
  const optionIds = (decision.options ?? []).map((o) => o.id).join('", "');

  let prompt = `\
You are ONE of several INDEPENDENT senior engineers weighing a real design decision
the user faces. You are at the ${tier} tier. Do NOT do the task and do NOT coordinate
with or defer to anyone — give YOUR own honest, independent call on the DECISION
below, on its merits. Several strong minds will each answer this same decision
independently and a deterministic tally will count the calls, so your job is to be a
strong, honest, independent data point — not to guess what the others will say.

THE DECISION:
${question}

THE CANDIDATE APPROACHES (choose exactly one by its bracketed id):
${optionLines}

Think it through briefly, then decide: which approach would YOU choose, and why —
and name the ONE risk that would change your mind. Then, on the FINAL line of your
response, emit EXACTLY this JSON object on its own line and nothing after it (raw
JSON, no code fences). "choice" MUST be one of the option ids ("${optionIds}"):
{"choice": "<one option id>", "confidence": <0.0-1.0>, "why": "<one sentence: why this approach>", "key_risk": "<the one risk that would change your mind>"}

Be honest in the envelope: "choice" is your genuine call, "confidence" your real
self-assessed probability it's the better approach, and "key_risk" a genuine reason
you might be wrong — never a throwaway.`;

  // The poll candidate reasons WITH the user's taste/intent/memory in scope — the
  // SAME ordered context blocks every other executor gets (so plural judgment
  // already leans the user's way). Absent → byte-for-byte the no-context prompt.
  if (context !== undefined) {
    const contextBlocks = assembleContextBlocks(context);
    if (contextBlocks.length > 0) {
      prompt += `\n\n${contextBlocks}`;
    }
  }

  if (historyContext !== undefined && historyContext.trim().length > 0) {
    prompt += `\n\nCONVERSATION SO FAR (for context; do not repeat it back):\n${historyContext.trim()}`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// The structured verdict — parsed from a candidate's final-line envelope (PURE)
// ---------------------------------------------------------------------------

/** ONE vendor's independent verdict on the decision (the tally's unit). */
export interface JudgmentVerdict {
  /** Which vendor produced this verdict. */
  readonly vendor: ProviderId;
  /** The option id the vendor chose (validated to be one of the decision's ids). */
  readonly choice: string;
  /** The vendor's self-assessed confidence (0–1), when parseable. */
  readonly confidence?: number;
  /** The vendor's one-sentence reasoning (its REAL `why`, surfaced on a split). */
  readonly why: string;
  /** The one risk the vendor named that would change its mind. */
  readonly keyRisk?: string;
}

/**
 * Parse ONE candidate's structured verdict from its final text. PURE; never throws.
 *
 * Reads the LAST JSON object on its own line (mirrors how the panel's self-report
 * envelope is emitted) and validates `choice` against the decision's option ids —
 * the HONESTY FLOOR: a verdict counts ONLY when the vendor named a REAL option id
 * (never a hallucinated one, never inferred from prose). Returns null when the run
 * errored, produced no text, or emitted no parseable in-vocabulary choice — that
 * vendor is then OMITTED from the tally, never invented (judgment §6.2.1).
 *
 * @param vendor   - The vendor whose run this is.
 * @param text     - The candidate's final text (may be undefined on error).
 * @param optionIds - The valid option ids (the `choice` vocabulary).
 */
export function parseJudgmentVerdict(
  vendor: ProviderId,
  text: string | undefined,
  optionIds: readonly string[],
): JudgmentVerdict | null {
  const parsed = parseFinalLineChoiceEnvelope(vendor, text, optionIds);
  if (parsed === null) return null;
  return {
    vendor: parsed.vendor,
    choice: parsed.choice,
    ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
    why: parsed.why ?? '',
    ...(parsed.keyRisk !== undefined ? { keyRisk: parsed.keyRisk } : {}),
  };
}

// ---------------------------------------------------------------------------
// THE SYNTHESIS — a DETERMINISTIC tally (PURE). The honesty inversion.
// ---------------------------------------------------------------------------

/** The three honest states a tally yields. */
type Agreement = 'consensus' | 'lean' | 'split';

/** One option's share of the tally (the count of vendors that chose it). */
interface TallyEntry {
  readonly optionId: string;
  readonly count: number;
  /** The vendors that chose this option (for surfacing each side honestly). */
  readonly vendors: readonly ProviderId[];
}

/**
 * The result of synthesizing a poll — a DETERMINISTIC read of the real verdicts.
 * It NEVER resolves a SPLIT: on a split it surfaces BOTH sides with their real
 * `why`, and `chosen` is null. The synthesizer is forbidden from picking for the
 * user on a split — the split is the product (judgment §1.3, §6.2.2/.3).
 */
export interface JudgmentSynthesis {
  /** CONSENSUS (all agree) / LEAN (a majority + a dissent) / SPLIT (no majority). */
  readonly agreement: Agreement;
  /** The per-option tally (most-supported first), built from REAL verdicts only. */
  readonly tally: readonly TallyEntry[];
  /**
   * The chosen option id — set ONLY on CONSENSUS or LEAN (a real majority). On a
   * SPLIT it is null: the synthesizer is FORBIDDEN from resolving a genuine split.
   */
  readonly chosen: string | null;
  /** The dissenting verdicts (a LEAN's minority) — surfaced honestly, never hidden. */
  readonly dissent: readonly JudgmentVerdict[];
  /** Every counted verdict (the real envelopes the tally is built from). */
  readonly verdicts: readonly JudgmentVerdict[];
}

/**
 * Synthesize a poll into the honest agreement state. PURE; never throws. THE HONESTY
 * INVERSION vs the panel synthesizer: it does NOT pick the best answer and it is
 * STRUCTURALLY incapable of resolving a genuine split — there is no model run here, a
 * SPLIT always yields `chosen: null`.
 *
 * The deterministic mapping over the counted verdicts (only verdicts that named a
 * REAL option id reach here — `parseJudgmentVerdict` already dropped the rest):
 *   - 0 verdicts            → SPLIT, chosen null (no signal; never a fabricated call).
 *   - 1 verdict             → CONSENSUS of one (a single real mind agreed with itself
 *                             is NOT plural — but with a formed poll there are ≥2
 *                             vendors; if only one returned a verdict the others are
 *                             omitted, so we report a LEAN toward the one real call
 *                             with no dissent, never a fake "consensus" of the absent).
 *   - all agree (≥2)        → CONSENSUS (earned multi-perspective confidence).
 *   - a strict MAJORITY     → LEAN (state the lean + name the dissent honestly).
 *   - a tie / no majority   → SPLIT (the call is genuinely the user's — surface both).
 *
 * "all agree" requires ≥2 verdicts that ALL chose the same option — one mind alone
 * can never be a consensus (the honesty floor: plural needs plurality).
 */
export function synthesizeJudgment(verdicts: readonly JudgmentVerdict[]): JudgmentSynthesis {
  const counted = (verdicts ?? []).filter(
    (v): v is JudgmentVerdict => v !== null && typeof v === 'object' && typeof v.choice === 'string',
  );
  const { tally, total, top, distinctOptions, tiedAtTop, strictMajority } =
    tallyChoiceEnvelopes(counted);

  // No real signal → SPLIT, chosen null (never fabricate a call from nothing).
  if (total === 0 || top === undefined) {
    return { agreement: 'split', tally, chosen: null, dissent: [], verdicts: counted };
  }

  // CONSENSUS — ≥2 real minds ALL chose the same option (plural needs plurality;
  // one mind alone is NEVER a consensus).
  if (distinctOptions === 1 && total >= MIN_JUDGMENT_VENDORS) {
    return { agreement: 'consensus', tally, chosen: top.optionId, dissent: [], verdicts: counted };
  }

  // A genuine divide with NO majority (a tie at the top, or a plurality that is not a
  // strict majority of the total) → SPLIT. The synthesizer is FORBIDDEN from picking.
  if (tiedAtTop || !strictMajority) {
    return { agreement: 'split', tally, chosen: null, dissent: [], verdicts: counted };
  }

  // LEAN — a strict majority for one option, with a real dissent named honestly.
  // (Also the single-real-verdict case: one vendor returned a parseable choice, the
  // others were omitted — a lean toward the one real call, no dissent, never a fake
  // consensus of the absent.)
  const dissent = counted.filter((v) => v.choice !== top.optionId);
  return { agreement: 'lean', tally, chosen: top.optionId, dissent, verdicts: counted };
}

// ---------------------------------------------------------------------------
// runJudgmentPoll — the executor (near-clone of runPanel; ONE round, NO synth run)
// ---------------------------------------------------------------------------

/** The terminal result of a poll: the synthesis + the real measured cost. */
export interface JudgmentPollResult {
  readonly synthesis: JudgmentSynthesis;
  readonly totalCostUsd: number;
  /** Whether the poll completed (false → aborted / no candidate succeeded). */
  readonly completed: boolean;
}

/**
 * Execute one judgment poll: run every DISTINCT-vendor candidate CONCURRENTLY (the
 * SAME `runCandidate` + `mergeCandidates` the panel uses, parameterized with the
 * judgment prompt + `taskKind: 'judgment'`), parse each structured verdict, and
 * return the DETERMINISTIC synthesis. STRICTLY ONE ROUND — there is NO synthesizer
 * model run and NO rebuttal pass (the bright line off the debate-flips-answers
 * result).
 *
 * FAIL-SOFT (the non-negotiable): a candidate error / unparseable envelope omits
 * that vendor from the tally (never invents one); if no candidate yields a verdict
 * the poll completes with a SPLIT-of-nothing (chosen null) and the CALLER degrades
 * to the existing flow — a poll error NEVER breaks the turn. It does NOT append to
 * the session and does NOT emit a user-facing `final` (it is a pre-flight signal, not
 * the answer) — the caller owns surfacing. Cost + ledger accounting mirror runPanel
 * (every run recorded; usage that never arrived recorded as 0, never fabricated).
 *
 * Liveness: yields a notice naming the poll composition + its quota cost (honest, up
 * front, like the panel), a `phase:panel` so the renderer shows "Weighing N expert
 * views…", and a tier-start/tier-done per candidate with REAL measured metrics.
 *
 * @returns the events stream; the generator RETURNS the {@link JudgmentPollResult}.
 */
export async function* runJudgmentPoll(
  deps: OrchestrateDeps,
  plan: JudgmentPollPlan,
  signal: AbortSignal,
  historyContext?: string,
  capability: PanelCapabilityInput = {},
): AsyncGenerator<CoreEvent, JudgmentPollResult> {
  let totalCostUsd = 0;
  let attempts = 0;

  const optionIds = plan.decision.options.map((o) => o.id);

  // Early abort: nothing ran — return an empty SPLIT so the caller degrades cleanly.
  if (signal.aborted) {
    return { synthesis: synthesizeJudgment([]), totalCostUsd, completed: false };
  }

  // Up-front honesty (like the panel notice): a poll spends one quota-consuming run
  // per distinct vendor. State that cost here — quota + latency on a flat-rate plan,
  // never dollars; the user sees it even though they never flipped a switch.
  yield {
    type: 'notice',
    level: 'info',
    message:
      `Weighing ${plan.candidates.length} expert views on a genuine call: ${plan.candidates.join(', ')}` +
      ` · ${plan.candidates.length} quota-consuming runs, may take longer`,
  };

  // A typed PANEL phase so the renderer drives its "Weighing N views" state machine
  // from a real event (reuses the panel render path; additive, ignored elsewhere).
  yield { type: 'phase', phase: 'panel', participants: plan.candidates };

  // The decision framed as a judgment question, built ONCE (identical across
  // vendors — independence is the point; only the vendor differs).
  const decisionPrompt = buildJudgmentCandidatePrompt(
    plan.tier,
    plan.decision,
    historyContext,
    contextFromDeps(deps),
  );

  // Announce every candidate up front so the UI knows all are running, then run
  // concurrently — exactly the panel's shape. The poll runs at plan.tier (no lifted
  // manager ceiling, no synthesizer): N independent IC/oracle reads, cross-vendor.
  // A PanelPlan-shaped object lets `runCandidate` route each candidate identically.
  const candidatePlan = {
    tier: plan.tier,
    candidates: plan.candidates,
    // runCandidate only reads `tier` + `classification` off the plan; synthesizer is
    // unused on the candidate path but typed on PanelPlan, so we set it to the first
    // candidate (never run as a synthesizer here — the poll has NO synthesizer run).
    synthesizer: plan.candidates[0] as ProviderId,
    classification: plan.classification,
  };

  for (const candidate of plan.candidates) {
    attempts++;
    yield {
      type: 'tier-start',
      tier: plan.tier,
      provider: candidate,
      model: '', // resolved inside runCandidate; the tier-done carries real metrics
      attempt: attempts,
    };
  }

  // Per-candidate completion: record cost + ledger + emit tier-done, the INSTANT each
  // returns (fastest first) — identical accounting to runPanel's recordCandidate.
  async function* recordCandidate(outcome: CandidateOutcome): AsyncGenerator<CoreEvent> {
    const success = outcome.errored == null;
    const pricing = getModelPricing(outcome.provider, outcome.model);
    const usd =
      outcome.providerCostUsd ??
      (outcome.usage !== undefined && pricing !== undefined
        ? (deps.cacheAccountingV2 === true
          ? calculateEffectiveCost(
              outcome.usage.inputTokens,
              outcome.usage.outputTokens,
              pricing,
              { cachedInputTokens: outcome.usage.cachedInputTokens, cacheWriteInputTokens: outcome.usage.cacheWriteInputTokens },
            )
          : calculateCost(outcome.usage.inputTokens, outcome.usage.outputTokens, pricing))
        : 0);
    totalCostUsd += usd;

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
      ...(deps.cacheAccountingV2 === true && outcome.usage?.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: outcome.usage.cacheWriteInputTokens }
        : {}),
      usd,
      durationMs: outcome.durationMs,
      success,
      ...(outcome.reasoningEffort !== undefined ? { reasoningEffort: outcome.reasoningEffort } : {}),
      taskKind: outcome.taskKind,
    });

    yield {
      type: 'tier-done',
      tier: plan.tier,
      success,
      confidence: null,
      costUsd: usd,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      durationMs: outcome.durationMs,
    };
  }

  const outcomes = yield* mergeCandidates(
    plan.candidates.map((candidate) =>
      runCandidate(
        '', // the task is irrelevant — the injected prompt IS the decision
        deps,
        candidatePlan,
        candidate,
        signal,
        historyContext,
        capability,
        { prompt: decisionPrompt, taskKind: 'judgment' },
      ),
    ),
    recordCandidate,
  );

  // Aborted mid-run → degrade: return whatever verdicts parsed (likely none).
  if (signal.aborted) {
    const verdicts = collectVerdicts(outcomes, optionIds);
    return { synthesis: synthesizeJudgment(verdicts), totalCostUsd, completed: false };
  }

  const verdicts = collectVerdicts(outcomes, optionIds);
  return { synthesis: synthesizeJudgment(verdicts), totalCostUsd, completed: true };
}

/** Parse + collect the in-vocabulary verdicts from the candidate outcomes. PURE. */
function collectVerdicts(
  outcomes: readonly CandidateOutcome[],
  optionIds: readonly string[],
): JudgmentVerdict[] {
  const out: JudgmentVerdict[] = [];
  for (const o of outcomes) {
    if (o.errored != null) continue; // an errored run is OMITTED, never invented
    const v = parseJudgmentVerdict(o.provider, o.finalText, optionIds);
    if (v !== null) out.push(v);
  }
  return out;
}
