/**
 * src/core/eval/score.ts — PURE aggregation of judge verdicts into a scorecard.
 *
 * Turns the per-prompt {@link JudgeVerdict}s into the numbers that answer "did a
 * phase move the ruler?": an overall aggregate, a per-dimension average (across
 * every prompt that exercised that dimension), and the per-prompt detail.
 *
 * HONESTY RULES baked in here:
 *  - Only JUDGED prompts contribute to any average. A prompt the judge could not
 *    score (judge call failed / unparseable) is counted as `unjudged` and is
 *    EXCLUDED from the math — never imputed as 0 and never silently dropped from
 *    the denominator. The scorecard always reports how many were judged.
 *  - Averages over an empty set are reported as `null` (not 0), so "no data" is
 *    visibly distinct from "scored zero".
 *
 * PURITY: core — no I/O, no clock, no random.
 */

import type { EvalDimension } from './suite.js';
import { EVAL_DIMENSIONS } from './suite.js';
import type { JudgeVerdict } from './judge.js';

/** One prompt's contribution to the scorecard. */
export interface PromptResult {
  readonly promptId: string;
  readonly class: string;
  /** True only when a REAL judge verdict was parsed for this prompt. */
  readonly judged: boolean;
  /** The verdict, present iff `judged`. */
  readonly verdict?: JudgeVerdict;
  /** The prompt's mean across its own dimensions (null when unjudged). */
  readonly mean: number | null;
  /**
   * Objective, model-free checks recorded at run time (honesty cross-checks):
   * was a trivial turn actually instant? did a code task carry a change/test
   * signal? These do NOT feed the judged averages — they are separate evidence.
   */
  readonly objective?: ObjectiveChecks;
  /** Honest note when the answer itself could not be produced (run failure). */
  readonly note?: string;
}

/** Cheap, model-free expectations the harness can verify against the real run. */
export interface ObjectiveChecks {
  /** Set when the prompt expected an instant turn: did it actually stay instant? */
  readonly instantExpected?: boolean;
  readonly instantActual?: boolean;
}

/** The aggregated scorecard for one whole run. */
export interface Scorecard {
  /** Mean over every JUDGED prompt's mean (null when nothing was judged). */
  readonly aggregate: number | null;
  /** Per-dimension mean across every judged prompt that scored that dimension. */
  readonly byDimension: Readonly<Record<EvalDimension, number | null>>;
  /** Per-prompt detail, in suite order. */
  readonly prompts: readonly PromptResult[];
  /** How many prompts were actually judged (the honest denominator). */
  readonly judgedCount: number;
  /** Total prompts attempted in this run. */
  readonly totalCount: number;
}

/** Mean of a non-empty number array; null for an empty array (never 0-imputed). */
function meanOrNull(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Compute a single prompt's mean across the dimensions its verdict scored. */
export function promptMean(verdict: JudgeVerdict): number | null {
  return meanOrNull(verdict.scores.map((s) => s.score));
}

/**
 * Aggregate per-prompt results into a {@link Scorecard}. Pure + total: handles an
 * empty input, all-unjudged input, and partially-judged input without throwing.
 */
export function aggregate(prompts: readonly PromptResult[]): Scorecard {
  const judged = prompts.filter((p) => p.judged && p.mean !== null);

  // Aggregate = mean of each judged prompt's own mean (equal weight per prompt).
  const aggregate = meanOrNull(judged.map((p) => p.mean as number));

  // Per-dimension = mean of every individual dimension score across all judged
  // prompts that scored that dimension.
  const byDimension = {} as Record<EvalDimension, number | null>;
  for (const dim of EVAL_DIMENSIONS) {
    const scores: number[] = [];
    for (const p of judged) {
      const ds = p.verdict?.scores.find((s) => s.dimension === dim);
      if (ds !== undefined) scores.push(ds.score);
    }
    byDimension[dim] = meanOrNull(scores);
  }

  return {
    aggregate,
    byDimension,
    prompts,
    judgedCount: judged.length,
    totalCount: prompts.length,
  };
}
