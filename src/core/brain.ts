/**
 * src/core/brain.ts — the Adaptive Confidence Brain pure core
 * (vision-brain §1 + §3, Phase 1: codebase-scrape only).
 *
 * Today the engine does ONE pass: `planEngagement` picks an ordered action list,
 * renders it as advisory prompt text, and hands the whole turn to ONE provider
 * run — it never RE-measures confidence after investigating, and never decides
 * again. This module supplies the two PURE pieces the bounded loop in
 * `orchestrate.ts` needs to turn that one-shot policy into an iterative one:
 *
 *   - `assessConfidence(frame, signals)` → a 3-tuple `{understanding, groundedness,
 *     stakes}` composed ENTIRELY from signals already in scope — `IntentFrame`
 *     confidence/source, the engagement predicates (`isAmbiguous`, `isInvestigable`,
 *     `hasGenuineFork`), and `classification.risk`/`isIrreversible`. NO new model
 *     call, NO fabrication: a skipped/failed extraction yields the honest rules
 *     prior and is treated as "investigate", never "assume high" (vision-brain §1).
 *
 *   - `decideNextMove(conf, signals, plan, state)` → the per-iteration policy that
 *     picks `answer | investigate | reflect_confirm | ask`. The LOOP is the new
 *     part; the per-iteration POLICY reuses `planEngagement` (passed in as `plan`)
 *     and the engagement predicates verbatim (vision-brain §3).
 *
 * PURE: no I/O, no time, no randomness, no model call (`test/arch/guards.ts`).
 * Total + fail-soft: a malformed/absent frame degrades to the fast-path or to
 * "investigate if investigable, else answer"; it never throws.
 *
 * SCOPE (Phase 1): only the `'codebase'` investigation kind is enabled here. The
 * `'web'` and `'brainstorm'` kinds (vision-brain §2b/§2c, Phases 2/3) are NOT
 * emitted — `decideNextMove` never returns them.
 */

import type { QuestionSet } from './types.js';
import type { IntentFrame } from './intent.js';
import type { EngagementPlan, EngagementSignals } from './engagement.js';
import {
  isTrivial,
  isAmbiguous,
  isInvestigable,
  hasGenuineFork,
  isIrreversible,
  realForks,
  scopeScore,
  PLAN_T,
} from './engagement.js';

// ---------------------------------------------------------------------------
// Confidence model (vision-brain §1) — the PURE 3-tuple
// ---------------------------------------------------------------------------

/** Understanding confidence: did we understand the GOAL? (not correctness of work). */
export type Understanding = 'high' | 'medium' | 'low';

/** Have we actually read the relevant code/facts for THIS request yet? */
export type Groundedness = 'unread' | 'grounded';

/** When is low confidence DANGEROUS — high risk / irreversible. */
type Stakes = 'low' | 'high';

/**
 * The brain's per-turn confidence, composed PURE from signals already in scope.
 * `understanding` + `stakes` are read directly from the existing predicates;
 * `groundedness` is the ONE genuinely-new bit of state the loop tracks (it flips
 * to `grounded` after an investigation round runs — see `decideNextMove`).
 */
export interface Confidence {
  readonly understanding: Understanding;
  readonly groundedness: Groundedness;
  readonly stakes: Stakes;
}

/**
 * Compose the confidence 3-tuple. PURE; never throws.
 *
 * understanding:
 *   - The frame's own `confidence`, lowered to at most `medium` whenever the turn
 *     is ambiguous (a real fork, or a non-high confidence) — `isAmbiguous`.
 *   - HONESTY (vision-brain §1, the hard rule): a `skipped`/`rules-fallback` frame
 *     is a tier PRIOR, not a measurement. On a NON-trivial turn we never read it as
 *     `high` — the best it can be is `medium` (so the loop treats unmeasured
 *     understanding as a reason to investigate, never to "assume high"). On a
 *     trivial turn the prior stands (the fast-path short-circuits before any loop).
 *
 * stakes: `high` when risk is high/critical OR the task is irreversible.
 *
 * groundedness: caller supplies the loop's running state (`'unread'` on the first
 * assessment, `'grounded'` after a round). When omitted (a one-shot assess) it
 * defaults to `'unread'`.
 */
export function assessConfidence(
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
  groundedness: Groundedness = 'unread',
): Confidence {
  const stakes: Stakes =
    signals.classification.risk === 'high' ||
    signals.classification.risk === 'critical' ||
    isIrreversible(signals.task)
      ? 'high'
      : 'low';

  // Raw extractor confidence (or the rules prior). Default to 'medium' when a
  // frame is absent — never assume 'high' without a real measurement.
  const raw: Understanding = frame?.confidence ?? 'medium';
  const measured = frame !== undefined && frame.source === 'model';
  const trivial = isTrivial(signals);

  let understanding: Understanding = raw;
  // Ambiguity caps a 'high' raw confidence down to 'medium' — a real fork or a
  // non-high frame means we are not fully sure of the goal.
  if (understanding === 'high' && isAmbiguous(signals)) {
    understanding = 'medium';
  }
  // Honesty floor: an UNMEASURED (skipped/rules-fallback) frame on a non-trivial
  // turn can never read as 'high' — its 'confidence' is a tier prior, not a
  // measurement. The trivial fast-path short-circuits before the loop, so its
  // prior is left intact (it never reaches an investigation decision).
  if (!measured && !trivial && understanding === 'high') {
    understanding = 'medium';
  }

  return { understanding, groundedness, stakes };
}

/**
 * GENUINE ambiguity — the parity-preserving discriminator (vision-brain §1
 * honesty rule). `isAmbiguous` (engagement.ts) treats ANY non-high confidence as
 * ambiguous, INCLUDING the rules tier PRIOR (a skipped/failed extraction is
 * `medium`/`low` by tier, not by measurement). The brain must NOT loop on a bare
 * prior — that would gate every substantial/risky turn. So "genuinely ambiguous"
 * requires a REAL signal: an actual fork in the frame, OR a MODEL-MEASURED non-high
 * confidence. An unmeasured (skipped/rules-fallback) frame with no fork is NOT
 * genuinely ambiguous — the turn proceeds exactly as today. PURE.
 */
export function genuinelyAmbiguous(
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
): boolean {
  if (realForks(signals) > 0) return true;
  if (frame !== undefined && frame.source === 'model' && frame.confidence !== 'high') return true;
  return false;
}

/**
 * The pure "too low to act" predicate (vision-brain §1) — used ONLY for the
 * INVESTIGATE gate. CALIBRATION (the owner's #1 fast-path requirement): a
 * codebase-scrape round must fire ONLY when understanding is genuinely **LOW** —
 * NOT on a model-measured **medium**. A medium-confidence ordinary actionable
 * build turn proceeds exactly as today (prefer-assume + the prompt-level
 * INVESTIGATE_CONTEXT advice), incurring ZERO extra extractor call/latency.
 *
 * So "too low to act" = understanding is `low` AND that low is GENUINE (a real
 * fork or a measured non-high confidence — never a bare tier prior). A `medium`
 * or `high` understanding, or a merely-unmeasured `low` prior, is NOT too low.
 * PURE.
 */
export function confidenceTooLowToAct(
  conf: Confidence,
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
): boolean {
  return conf.understanding === 'low' && genuinelyAmbiguous(frame, signals);
}

/**
 * A SUBSTANTIAL / big-scope build where proposing a plan is genuinely valuable
 * (vision-brain §3 — the reflect_confirm trigger). Reuses the existing scope
 * signals verbatim: `plan.planFirst` (engagement.ts sets it when scope clears the
 * bias-shifted PLAN_T bar AND route.plan is honored) OR a raw `scopeScore` at/over
 * PLAN_T (a multi-clause / manager-tier / large turn). This is the ONLY thing —
 * besides genuine low-understanding ambiguity — that earns a plan proposal; a
 * small, clearly-understood task (even an irreversible one) is NOT substantial and
 * flows straight through. PURE.
 */
function substantialBuild(signals: EngagementSignals, plan: EngagementPlan): boolean {
  return plan.planFirst || scopeScore(signals) >= PLAN_T;
}

// ---------------------------------------------------------------------------
// The adaptive control loop (vision-brain §3) — the PURE per-iteration policy
// ---------------------------------------------------------------------------

/** Phase 1 enables ONLY the codebase scrape; web/brainstorm are Phases 2/3. */
type InvestigationKind = 'codebase';

/** The brain's running loop state (the impure loop in orchestrate owns it). */
export interface BrainLoopState {
  /** Investigation rounds run so far this turn. */
  readonly rounds: number;
  /** Current groundedness — flips to 'grounded' after the first round. */
  readonly groundedness: Groundedness;
  /** True for a `direct` posture: deep-dive rounds are opt-out (mirrors forkBudget). */
  readonly optedOutOfDeepDive: boolean;
  /** Max rounds for this turn (2 default; 3 collaborative — vision-brain §5). */
  readonly maxRounds: number;
}

/**
 * The brain's per-iteration decision. The LOOP picks one of these each round; the
 * impure loop in orchestrate executes it.
 *   - `answer`         — confident enough; run today's single sequential pass.
 *   - `investigate`    — too low + investigable + budget → run a codebase-scrape
 *                        round, narrate it, then RE-ASSESS (vision-brain §3 step 3).
 *   - `reflect_confirm`— investigated but still a judgment call / high stakes:
 *                        reflect a grounded plan and confirm before acting.
 *   - `ask`            — a GENUINE non-investigable fork the code can't settle.
 */
export type BrainMove =
  | { readonly kind: 'answer' }
  | { readonly kind: 'investigate'; readonly tool: InvestigationKind; readonly narration: string }
  | { readonly kind: 'reflect_confirm' }
  | { readonly kind: 'ask'; readonly questions: QuestionSet };

/** Default round budgets (vision-brain §5). */
export const MAX_ROUNDS_DEFAULT = 2;
export const MAX_ROUNDS_COLLABORATIVE = 3;

/**
 * Honest, non-fabricated narration for a Phase-1 codebase round (vision-brain §3).
 * HONESTY (the prompt's hard rule): Phase 1 does NOT read new files — it re-checks
 * the goal against the already-in-context static repo-map and re-runs the intent
 * extractor. The narration must reflect EXACTLY that and never imply a file read
 * that didn't happen. (The deeper targeted Read/Grep pass is Phase 2.)
 */
export const CODEBASE_NARRATION = 'Factoring in the project layout…';

/**
 * The per-iteration policy (vision-brain §3 `decideNextMove`). PURE, total, never
 * throws. Reuses `planEngagement` (passed in as `plan`) and the engagement
 * predicates verbatim — the LOOP (in orchestrate) is the only new control flow.
 *
 * Precedence (mirrors the doc's decision diagram, top-down — RECALIBRATED so the
 * common turn stays fast and the confirm gate never nags):
 *   0) trivial fast-path → answer (never loops — the hard fast-path guard).
 *   1) genuine non-investigable fork → ask (a real judgment call always wins),
 *      but ONLY when the plan actually voiced an ask (asks>0 + a derivable
 *      QuestionSet) — otherwise the assumption is stated and we proceed.
 *   2) genuinely-LOW understanding + investigable + budget left + still unread →
 *      investigate (KEEP GOING — the owner's core ask). Phase 1: codebase only.
 *      NOTE: a model-measured **medium** does NOT reach here — a medium build turn
 *      proceeds straight to `answer`, ZERO extra extractor call/latency.
 *   3) a genuine JUDGMENT CALL worth a plan → reflect_confirm. Fires ONLY when
 *      (understanding === 'low' AND genuinely ambiguous) OR a SUBSTANTIAL/big-scope
 *      build (`substantialBuild`). It does NOT fire merely because a task is
 *      high-stakes/irreversible when it is otherwise clearly understood ("delete
 *      the unused import" → just do it). Small, clearly-understood tasks ALWAYS
 *      flow straight through.
 *   4) otherwise → answer (the common, fast path).
 *
 * The `deriveAsk` thunk lets the caller supply the SAME `deriveAskFromForks`
 * QuestionSet the terminal-ask seam already uses, without this pure module
 * importing the (impure-adjacent) derivation site — keeping the policy testable.
 */
export function decideNextMove(
  conf: Confidence,
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
  plan: EngagementPlan,
  state: BrainLoopState,
  deriveAsk: () => QuestionSet | null,
): BrainMove {
  // 0) TRIVIAL FAST-PATH — unchanged from today; NEVER loops, NEVER investigates.
  //    This is the hard fast-path guard: a greeting / quick question / trivial
  //    turn short-circuits here with zero extra rounds, latency, or cost.
  if (isTrivial(signals)) return { kind: 'answer' };

  // 1) GENUINE NON-INVESTIGABLE FORK always wins — a real judgment call (vision/
  //    preference/external decision the code can't answer). Only reached when the
  //    plan actually budgeted an ask AND a concrete QuestionSet is derivable;
  //    otherwise the engine states the assumption and proceeds (prefer-assume).
  if (hasGenuineFork(signals) && plan.asks > 0) {
    const questions = deriveAsk();
    if (questions !== null) return { kind: 'ask', questions };
  }

  const tooLow = confidenceTooLowToAct(conf, frame, signals);

  // 2) GENUINELY-LOW understanding + INVESTIGABLE + budget left + still unread →
  //    KEEP GOING (the owner's core ask). Phase 1: only the codebase-scrape round.
  //    `confidenceTooLowToAct` is now `understanding === 'low'` (not medium), so an
  //    ordinary medium-confidence build turn NEVER triggers a scrape — it falls
  //    through to step 4 (answer) with zero extra cost. groundedness === 'unread'
  //    prevents a second identical read (after a round it flips to 'grounded').
  if (
    tooLow &&
    conf.groundedness === 'unread' &&
    state.rounds < state.maxRounds &&
    !state.optedOutOfDeepDive &&
    isInvestigable(signals)
  ) {
    return { kind: 'investigate', tool: 'codebase', narration: CODEBASE_NARRATION };
  }

  // 3) A genuine JUDGMENT CALL worth a plan → reflect a grounded plan and confirm.
  //    Fires ONLY on (genuinely-LOW understanding) OR a SUBSTANTIAL/big-scope build
  //    THAT WE ACTUALLY MEASURED. It does NOT fire merely because the task is
  //    high-stakes/irreversible when it is otherwise clearly understood — a small
  //    clear "delete the unused import" / "delete the dead /legacy route" just runs
  //    (the prefer-assume default).
  //
  //    HONESTY (vision-brain §1): the substantial arm requires a MODEL-MEASURED
  //    frame. We never propose a plan we never understood — an unmeasured
  //    (skipped/rules-fallback) substantial turn has no real goal to reflect, so it
  //    flows straight through to the provider exactly as today (no fabricated
  //    confirm). The low-understanding arm (`tooLow`) is already measured-gated by
  //    `genuinelyAmbiguous`. Reached when grounded, non-investigable, budget out, or
  //    a measured substantial build worth a plan.
  const frameMeasured = frame !== undefined && frame.source === 'model';
  if (tooLow || (frameMeasured && substantialBuild(signals, plan))) {
    return { kind: 'reflect_confirm' };
  }

  // 4) CONFIDENT ENOUGH / ordinary actionable turn → run today's path. A
  //    medium-confidence build, a clearly-understood irreversible task, and a
  //    high-confidence turn all land here — straight through, no confirm gate.
  return { kind: 'answer' };
}

/**
 * Resolve the per-turn round budget from the partner posture. `collaborative`
 * earns one extra round (3); everyone else gets the default (2). PURE.
 */
export function maxRoundsFor(style: 'direct' | 'balanced' | 'collaborative' | undefined): number {
  return style === 'collaborative' ? MAX_ROUNDS_COLLABORATIVE : MAX_ROUNDS_DEFAULT;
}

// ---------------------------------------------------------------------------
// reflect_confirm proposal (vision-brain §3 / partner-doc §3) — a DETERMINISTIC
// confirm built from the now-grounded frame. ZERO model call, ZERO fabrication:
// every line is the real `IntentFrame.goal`/`doneWhen` the extractor produced.
// ---------------------------------------------------------------------------

const REFLECT_CONFIRM_ID = 'plan_confirm';
const REFLECT_PROMPT_CAP = 400;

/**
 * Build a deterministic `reflect_confirm` QuestionSet from the (grounded) frame.
 * The prompt REFLECTS the real goal + doneWhen the extractor produced — "Here's
 * what I'll do: <goal>. Done when: <doneWhen>. Go ahead?" — with `[Go] · [Edit] ·
 * [No]` options and `allowFreeText` so an Edit carries the user's correction. It
 * NEVER fabricates a plan it didn't derive. Returns `null` when there is no usable
 * goal to reflect (the caller then falls through to `answer`). PURE; never throws.
 */
export function buildReflectConfirm(frame: IntentFrame | undefined): QuestionSet | null {
  const goal = frame?.goal?.trim();
  if (goal === undefined || goal.length === 0) return null;

  const lines: string[] = [`Here's what I understand you want: ${goal}.`];
  const doneWhen = frame?.doneWhen?.trim();
  if (doneWhen !== undefined && doneWhen.length > 0) {
    lines.push(`I'll treat it as done when: ${doneWhen}.`);
  }
  lines.push('Want me to go ahead?');
  const prompt = lines.join(' ').slice(0, REFLECT_PROMPT_CAP);

  return {
    questions: [
      {
        id: REFLECT_CONFIRM_ID,
        prompt,
        options: [{ label: 'Go' }, { label: 'Edit' }, { label: 'No' }],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  };
}

/**
 * Whether a codebase round actually EARNED its keep (vision-brain §5 stop
 * condition): a round must RAISE understanding or flip an investigable gap to
 * grounded, or the loop stops. We compare the pre-round and post-round
 * understanding; `grounded` itself is the floor (the loop never re-reads the same
 * code because groundedness flips). Returns true when understanding strictly
 * improved (low→medium/high or medium→high). PURE.
 */
export function understandingImproved(before: Understanding, after: Understanding): boolean {
  const rank: Record<Understanding, number> = { low: 0, medium: 1, high: 2 };
  return rank[after] > rank[before];
}
