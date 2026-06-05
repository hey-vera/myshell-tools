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
 * when the signal is missing or unclear we STOP and tell the user instead of
 * burning the remaining autonomous turns on a guess.
 *
 * Pure module: no I/O, no time, no randomness, never throws.
 */

import type { WorkContract } from './work-contract.js';
import { renderContractForPrompt } from './work-contract.js';
import { lastJsonObjectBoundsWithKey } from './json-envelope.js';

/** What the model's last reply signalled about the goal. */
export type GoalSignal = 'complete' | 'continue' | 'missing';

/** Hard bounds on an autonomous goal run. */
export interface GoalCeilings {
  /** Max turns to run before stopping regardless of progress. */
  readonly maxIterations: number;
  /** Optional cumulative-cost ceiling in USD; undefined = no cost cap. */
  readonly maxCostUsd?: number;
}

/** The decision after one turn of a goal run. */
type GoalAction = 'complete' | 'continue' | 'stop-iterations' | 'stop-budget' | 'stop-error' | 'stop-signal';

export interface GoalStep {
  readonly action: GoalAction;
  readonly reason: string;
}

/** Default ceiling on autonomous turns — generous but finite. */
export const DEFAULT_MAX_GOAL_ITERATIONS = 8;

export const GOAL_MARKER_TOKENS = ['GOAL_COMPLETE', 'GOAL_CONTINUE'] as const;

const COMPLETE_MARKER = GOAL_MARKER_TOKENS[0];
const CONTINUE_MARKER = GOAL_MARKER_TOKENS[1];

/**
 * Build the task sent for one turn of an autonomous goal run. The first turn
 * frames the goal; later turns ask to continue. Both instruct the model to do
 * one concrete step and then emit a completion marker so the loop can decide
 * whether to keep going.
 *
 * @param goal      - The user's goal text.
 * @param iteration - 0-based turn index (0 = first turn).
 * @param contract  - Optional anti-drift contract for autonomous multi-turn work.
 */
export function buildGoalTask(goal: string, iteration: number, contract?: WorkContract): string {
  const header =
    iteration === 0
      ? `Goal: ${goal}`
      : `Continue working autonomously toward this goal: ${goal}`;
  const task = [
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

  if (contract === undefined) return task;

  return [
    renderContractForPrompt(contract),
    'Before acting, confirm this turn still directly serves the OBJECTIVE; do not pursue unrelated improvements.',
    '',
    task,
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
 * Parse a goal marker from ONLY the last non-empty line of a model reply.
 * Mid-prose mentions are content, not control signals. Never throws.
 */
export function parseTrailingGoalMarker(output: string): Exclude<GoalSignal, 'missing'> | null {
  try {
    const line = lastNonEmptyLine(output);
    if (line === null) return null;
    const trimmed = line.replace(/^[ \t]+/, '');
    if (/^GOAL_COMPLETE\s*$/.test(trimmed)) return 'complete';
    if (/^GOAL_CONTINUE\b/.test(trimmed)) return 'continue';
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove a trailing goal-marker line from assistant text. Idempotent; never
 * touches mid-prose mentions, and never throws.
 */
export function stripTrailingGoalMarker(output: string): string {
  try {
    if (typeof output !== 'string' || output.length === 0) return output;
    const bounds = lastNonEmptyLineBounds(output);
    if (bounds === null) return output;
    if (parseTrailingGoalMarker(output) === null) return output;

    const before = output.slice(0, bounds.start).replace(/\s+$/, '');
    const after = output.slice(bounds.end).replace(/^\s+/, '');
    return after.length > 0 ? `${before}\n${after}` : before;
  } catch {
    return output;
  }
}

/**
 * Parse the completion signal from a model reply. Only a trailing marker is
 * trusted; missing or garbled markers are represented explicitly. Never throws.
 */
export function parseGoalSignal(output: string): GoalSignal {
  return parseTrailingGoalMarker(output) ?? 'missing';
}

/**
 * Remove a trailing confidence envelope from a goal-turn output before the
 * goal-loop control path looks for its marker. This does NOT change
 * parseGoalSignal/parseTrailingGoalMarker semantics: those still trust only the
 * last non-empty line they are given. It is a goal-loop compatibility shim for
 * stale/conflicting prompts or provider retries that append the normal envelope
 * after a GOAL_CONTINUE/GOAL_COMPLETE marker.
 */
export function stripTrailingGoalConfidenceEnvelope(output: string): string {
  try {
    const match = lastJsonObjectBoundsWithKey(output, 'confidence');
    if (match === null || output.slice(match.end).trim().length > 0) {
      return output;
    }
    const before = output.slice(0, match.start).replace(/\s+$/, '');
    const after = output.slice(match.end).replace(/^\s+/, '');
    return after.length > 0 ? `${before}\n${after}` : before;
  } catch {
    return output;
  }
}

/**
 * Extract the free-text next-step payload from a trailing GOAL_CONTINUE marker.
 * This is additive: parseGoalSignal/parseTrailingGoalMarker keep their existing
 * return shapes and marker semantics. Never throws.
 */
export function parseGoalContinueText(output: string): string {
  try {
    if (parseTrailingGoalMarker(output) !== 'continue') return '';
    const line = lastNonEmptyLine(output);
    if (line === null) return '';
    const trimmed = line.replace(/^[ \t]+/, '');
    const match = /^GOAL_CONTINUE\b(?::[ \t]*(.*))?$/.exec(trimmed);
    return match?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function lastNonEmptyLine(output: string): string | null {
  const bounds = lastNonEmptyLineBounds(output);
  return bounds === null ? null : output.slice(bounds.start, bounds.end);
}

function lastNonEmptyLineBounds(output: string): { readonly start: number; readonly end: number } | null {
  if (typeof output !== 'string' || output.length === 0) return null;

  let end = output.length;
  while (end > 0) {
    const ch = output.charCodeAt(end - 1);
    if (ch !== 10 && ch !== 13 && ch !== 32 && ch !== 9) break;
    end--;
  }
  if (end === 0) return null;

  const prevLf = output.lastIndexOf('\n', end - 1);
  const start = prevLf >= 0 ? prevLf + 1 : 0;
  return { start, end };
}

/**
 * Decide what to do after one turn of a goal run. Pure.
 *
 * Order: a failed turn stops immediately; an explicit completion stops with
 * success; a missing/garbled signal stops honestly; otherwise the ceilings
 * (cost, then iterations) gate another turn.
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
  if (opts.signal === 'missing') {
    return {
      action: 'stop-signal',
      reason: 'the last turn gave no goal signal — re-run /goal to continue',
    };
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
