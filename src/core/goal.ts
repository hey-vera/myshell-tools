/**
 * src/core/goal.ts — the pure decision core for `/goal` autonomous runs.
 *
 * `/goal <text>` runs turns autonomously until the model reports the goal is
 * achieved, bounded by hard ceilings (iterations + optional cost) and the user's
 * Esc. This module holds the PURE pieces: the per-turn instruction, the
 * completion-signal parser, and the continue/stop decision. The actual loop
 * (running turns, accumulating cost, honouring Esc) lives in the interface layer.
 *
 * Completion is signalled by a plain-text marker the model writes, NOT a change
 * to the confidence envelope or the orchestrate hot path — so `/goal` is fully
 * self-contained and the marker parser is trivially testable. Honest default:
 * when the signal is unclear we CONTINUE (and let the ceilings stop the loop),
 * never falsely claim completion.
 *
 * Pure module: no I/O, no time, no randomness, never throws.
 */

/** What the model's last reply signalled about the goal. */
export type GoalSignal = 'complete' | 'continue';

/** Hard bounds on an autonomous goal run. */
export interface GoalCeilings {
  /** Max turns to run before stopping regardless of progress. */
  readonly maxIterations: number;
  /** Optional cumulative-cost ceiling in USD; undefined = no cost cap. */
  readonly maxCostUsd?: number;
}

/** The decision after one turn of a goal run. */
type GoalAction = 'complete' | 'continue' | 'stop-iterations' | 'stop-budget' | 'stop-error';

export interface GoalStep {
  readonly action: GoalAction;
  readonly reason: string;
}

/** Default ceiling on autonomous turns — generous but finite. */
export const DEFAULT_MAX_GOAL_ITERATIONS = 8;

const COMPLETE_MARKER = 'GOAL_COMPLETE';
const CONTINUE_MARKER = 'GOAL_CONTINUE';

/**
 * Build the task sent for one turn of an autonomous goal run. The first turn
 * frames the goal; later turns ask to continue. Both instruct the model to do
 * one concrete step and then emit a completion marker so the loop can decide
 * whether to keep going.
 *
 * @param goal      - The user's goal text.
 * @param iteration - 0-based turn index (0 = first turn).
 */
export function buildGoalTask(goal: string, iteration: number): string {
  const header =
    iteration === 0
      ? `Goal: ${goal}`
      : `Continue working autonomously toward this goal: ${goal}`;
  return [
    header,
    '',
    'You are working across multiple autonomous turns. Take the next concrete step',
    'now (read, edit, run — whatever actually moves the goal forward). Then, on its',
    'own line, signal status:',
    `  • write exactly "${COMPLETE_MARKER}" when the goal is FULLY achieved and verified;`,
    `  • otherwise write "${CONTINUE_MARKER}: <the single next step>".`,
    'Only claim completion when it is genuinely done — do not stop early, and do not',
    'claim completion just to end the loop.',
  ].join('\n');
}

/**
 * Format the live progress panel shown each turn of an autonomous goal run.
 * Every figure is REAL and measured — turn index, wall-clock elapsed, and tokens
 * actually recorded in the ledger for THIS run (no estimates, no fabrication) —
 * so the user can watch overall progress move without it ever looking frozen.
 *
 * Example: `turn 3/8 · 6m 12s · 42.1k tokens this goal`. Pure / never throws.
 */
export function formatGoalProgress(opts: {
  readonly turn: number; // 1-based
  readonly maxTurns: number;
  readonly elapsedMs: number;
  readonly tokensThisRun: number;
}): string {
  const fmtDur = (ms: number): string => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) {
      const rem = s % 60;
      return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
    }
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
  };
  const fmtTok = (n: number): string => {
    if (n < 1000) return `${Math.max(0, Math.floor(n))}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  };
  return `turn ${opts.turn}/${opts.maxTurns} · ${fmtDur(opts.elapsedMs)} · ${fmtTok(opts.tokensThisRun)} tokens this goal`;
}

/**
 * Parse the completion signal from a model reply. Returns 'complete' only on a
 * clear completion marker; anything ambiguous or absent returns 'continue' (the
 * ceilings, not a guess, decide when to stop). Never throws.
 */
export function parseGoalSignal(output: string): GoalSignal {
  if (typeof output !== 'string' || output.length === 0) return 'continue';

  const completeRe = new RegExp(`\\b${COMPLETE_MARKER}\\b`);
  const continueRe = new RegExp(`\\b${CONTINUE_MARKER}\\b`);
  const hasComplete = completeRe.test(output);
  const hasContinue = continueRe.test(output);

  if (hasComplete && !hasContinue) return 'complete';
  if (hasComplete && hasContinue) {
    // Both present — trust whichever the model wrote LAST.
    return output.lastIndexOf(COMPLETE_MARKER) > output.lastIndexOf(CONTINUE_MARKER)
      ? 'complete'
      : 'continue';
  }
  return 'continue';
}

/**
 * Decide what to do after one turn of a goal run. Pure.
 *
 * Order: a failed turn stops immediately; an explicit completion stops with
 * success; otherwise the ceilings (cost, then iterations) gate another turn.
 *
 * @param opts.signal              - The parsed signal from the turn's output.
 * @param opts.lastSucceeded       - Whether the turn's task succeeded.
 * @param opts.completedIterations - Turns completed so far (≥1 after the first).
 * @param opts.ceilings            - Hard bounds.
 * @param opts.costSoFarUsd        - Cumulative estimated cost across the run.
 */
export function decideGoalNext(opts: {
  readonly signal: GoalSignal;
  readonly lastSucceeded: boolean;
  readonly completedIterations: number;
  readonly ceilings: GoalCeilings;
  readonly costSoFarUsd: number;
}): GoalStep {
  if (!opts.lastSucceeded) {
    return { action: 'stop-error', reason: 'the last step failed — stopping the goal run' };
  }
  if (opts.signal === 'complete') {
    return { action: 'complete', reason: 'the model reported the goal is complete' };
  }
  if (
    opts.ceilings.maxCostUsd !== undefined &&
    opts.costSoFarUsd >= opts.ceilings.maxCostUsd
  ) {
    return {
      action: 'stop-budget',
      reason: `cost ceiling reached (~$${opts.costSoFarUsd.toFixed(2)} ≥ $${opts.ceilings.maxCostUsd.toFixed(2)})`,
    };
  }
  if (opts.completedIterations >= opts.ceilings.maxIterations) {
    return {
      action: 'stop-iterations',
      reason: `turn ceiling reached (${opts.ceilings.maxIterations}) before the goal completed`,
    };
  }
  return { action: 'continue', reason: 'more work remains' };
}
