/**
 * src/core/eval/scorecard.ts — PURE formatting of a Scorecard + run COMPARE.
 *
 * Renders a run's scorecard as plain text lines (aggregate + per-dimension +
 * per-prompt), and diffs the latest two runs so the owner can SEE whether a phase
 * moved the number. Lives in core (pure) — which is why it may contain the literal
 * scoring figures; the command layer just prints these lines (the honesty-lint
 * guard forbids hardcoded numbers in src/commands, not the computed strings core
 * hands it).
 *
 * Every number here is COMPUTED from the run data — nothing is hardcoded. A null
 * (unjudged / no data) renders as a literal "n/a", visibly distinct from 0.0.
 *
 * PURITY: core — no I/O, no clock, no random.
 */

import type { EvalDimension } from './suite.js';
import { EVAL_DIMENSIONS } from './suite.js';
import type { RunResult } from './harness.js';

/** Format a 0–10 score to one decimal, or 'n/a' for null (no data — never 0-faked). */
function fmt(score: number | null): string {
  return score === null ? 'n/a' : score.toFixed(1);
}

/** Format a signed delta to one decimal with an explicit sign, or 'n/a'. */
function fmtDelta(delta: number | null): string {
  if (delta === null) return 'n/a';
  const s = delta.toFixed(1);
  return delta > 0 ? `+${s}` : s;
}

/** Pad a label to a fixed width for column alignment (pure string op). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Render a full scorecard as text lines (no color — the caller may colorize).
 * Scores are on a 0–10 scale.
 */
export function formatScorecard(run: RunResult): string[] {
  const sc = run.scorecard;
  const lines: string[] = [];
  lines.push('myshell eval — scorecard');
  lines.push(`run: ${run.timestamp}  ·  v${run.version}`);
  lines.push(
    `answered by: ${run.provenance.answerProvider || 'unknown'}  ·  judged by: ${run.provenance.judgeProvider || 'unknown'}`,
  );
  lines.push(`judged: ${sc.judgedCount}/${sc.totalCount} prompts`);
  lines.push('');
  lines.push(`AGGREGATE: ${fmt(sc.aggregate)} / 10`);
  lines.push('');
  lines.push('By dimension (0–10):');
  for (const dim of EVAL_DIMENSIONS) {
    lines.push(`  ${pad(dim, 14)} ${fmt(sc.byDimension[dim])}`);
  }
  lines.push('');
  lines.push('By prompt:');
  for (const p of sc.prompts) {
    const score = p.judged ? fmt(p.mean) : 'unjudged';
    let line = `  ${pad(p.promptId, 14)} ${pad(p.class, 12)} ${score}`;
    if (!p.judged && p.note !== undefined) line += `  (${p.note})`;
    if (p.objective?.instantExpected === true) {
      line += p.objective.instantActual === true ? '  [instant ✓]' : '  [not instant ✗]';
    }
    lines.push(line);
  }
  return lines;
}

/** A single dimension's before→after movement. */
export interface DimensionDelta {
  readonly dimension: EvalDimension;
  readonly before: number | null;
  readonly after: number | null;
  /** after - before, or null when either side has no data. */
  readonly delta: number | null;
}

/** The structured diff between two runs (older → newer). */
export interface RunComparison {
  readonly before: RunResult;
  readonly after: RunResult;
  readonly aggregateDelta: number | null;
  readonly byDimension: readonly DimensionDelta[];
}

/** Pure subtraction that propagates null (no data on either side → null delta). */
function diff(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  return after - before;
}

/** Compute the structured comparison of two runs (older `before`, newer `after`). */
export function compareRuns(before: RunResult, after: RunResult): RunComparison {
  const byDimension: DimensionDelta[] = EVAL_DIMENSIONS.map((dim) => {
    const b = before.scorecard.byDimension[dim];
    const a = after.scorecard.byDimension[dim];
    return { dimension: dim, before: b, after: a, delta: diff(b, a) };
  });
  return {
    before,
    after,
    aggregateDelta: diff(before.scorecard.aggregate, after.scorecard.aggregate),
    byDimension,
  };
}

/** Render a run comparison as text lines (the `--compare` view). */
export function formatComparison(cmp: RunComparison): string[] {
  const lines: string[] = [];
  lines.push('myshell eval — compare (latest two runs)');
  lines.push(`before: ${cmp.before.timestamp}  (v${cmp.before.version})`);
  lines.push(`after:  ${cmp.after.timestamp}  (v${cmp.after.version})`);
  lines.push('');
  lines.push(
    `AGGREGATE: ${fmt(cmp.before.scorecard.aggregate)} → ${fmt(cmp.after.scorecard.aggregate)}  (${fmtDelta(cmp.aggregateDelta)})`,
  );
  lines.push('');
  lines.push('By dimension (before → after, Δ):');
  for (const d of cmp.byDimension) {
    lines.push(
      `  ${pad(d.dimension, 14)} ${fmt(d.before)} → ${fmt(d.after)}  (${fmtDelta(d.delta)})`,
    );
  }
  return lines;
}
