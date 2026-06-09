/**
 * src/core/eval/harness.ts — the PURE run driver over the frozen suite.
 *
 * Given two injected PORTS — one that produces the partner's REAL answer for a
 * prompt (`AnswerPort`, the live wiring drives orchestrate() headless), and one
 * that produces a cross-vendor JUDGE verdict (`JudgePort`) — this runs the whole
 * suite and returns a {@link RunResult}: a timestamped, storable scorecard.
 *
 * The ports are INJECTED precisely so `npm test` can drive the entire harness
 * with FAKES and make ZERO live model calls; the real provider/judge calls happen
 * ONLY when the owner invokes the runner (src/commands/eval.ts). This is the
 * "test the logic with fakes, run for real only on demand" contract from the brief.
 *
 * HONESTY: an answer-port failure → the prompt is recorded with a note and left
 * unjudged (no answer to judge). A judge-port returning null → recorded unjudged.
 * Neither path ever fabricates a score. Sequential by design: bounded, predictable
 * quota (one answer call + at most one judge call per prompt), and cancellable.
 *
 * PURITY: core — no I/O, no clock, no random. The timestamp + the call to disk are
 * supplied by the caller (the command layer), keeping this deterministically
 * testable.
 */

import type { EvalPrompt } from './suite.js';
import { EVAL_SUITE } from './suite.js';
import type { JudgeVerdict } from './judge.js';
import type { PromptResult, Scorecard, ObjectiveChecks } from './score.js';
import { aggregate, promptMean } from './score.js';

/** What the partner's real answer path returns for one prompt. */
export interface AnswerOutcome {
  /** The partner's verbatim final answer; undefined when the run produced none. */
  readonly answer: string | undefined;
  /** True when the run completed successfully (a `final.success === true`). */
  readonly success: boolean;
  /**
   * Objective, model-free observation of HOW the turn ran (for the honesty
   * cross-checks): was it an instant turn (one attempt, no escalation)? Optional —
   * absent when the wiring cannot observe it.
   */
  readonly instant?: boolean;
  /** Honest note when the answer could not be produced (error category etc.). */
  readonly note?: string;
}

/**
 * Produce the partner's REAL answer for a prompt. The live wiring drives
 * orchestrate() headless and captures the `final` event; tests inject a fake.
 */
export type AnswerPort = (prompt: EvalPrompt, signal: AbortSignal) => Promise<AnswerOutcome>;

/**
 * Produce a cross-vendor JUDGE verdict for a prompt + its answer. Returns null on
 * any failure (→ the prompt is recorded unjudged, never a fabricated score). The
 * live wiring routes to a DIFFERENT provider than the one that answered.
 */
export type JudgePort = (
  prompt: EvalPrompt,
  answer: string,
  signal: AbortSignal,
) => Promise<JudgeVerdict | null>;

/** A complete, storable result of one eval run. */
export interface RunResult {
  /** ISO timestamp supplied by the caller (core stays clock-free). */
  readonly timestamp: string;
  /** The engine/tool version this run measured (caller-supplied for provenance). */
  readonly version: string;
  /** Which provider answered + which judged, for cross-vendor provenance. */
  readonly provenance: RunProvenance;
  /** The aggregated scorecard. */
  readonly scorecard: Scorecard;
}

/** Cross-vendor provenance — recorded so a stored run is self-describing + auditable. */
export interface RunProvenance {
  /** Provider id that produced the partner answers (e.g. 'claude'); '' if unknown. */
  readonly answerProvider: string;
  /** Provider id that judged (a DIFFERENT vendor for honesty); '' if unknown. */
  readonly judgeProvider: string;
}

/** Optional progress callback (the command prints per-prompt progress); pure. */
export type ProgressFn = (done: number, total: number, promptId: string) => void;

/** Build the objective checks for a prompt from its observed run. */
function objectiveFor(prompt: EvalPrompt, outcome: AnswerOutcome): ObjectiveChecks | undefined {
  if (prompt.expectInstant === true && outcome.instant !== undefined) {
    return { instantExpected: true, instantActual: outcome.instant };
  }
  return undefined;
}

/**
 * Run the whole frozen suite through the injected ports and aggregate the result.
 *
 * @param answer   - port producing the partner's real answer per prompt.
 * @param judge    - port producing the cross-vendor judge verdict per prompt.
 * @param signal   - abort signal; checked between prompts so a long run is cancellable.
 * @param meta     - caller-supplied timestamp/version/provenance (core stays pure).
 * @param onProgress - optional per-prompt progress callback.
 * @param suite    - the prompt set (defaults to the frozen EVAL_SUITE; override in tests).
 */
export async function runEval(
  answer: AnswerPort,
  judge: JudgePort,
  signal: AbortSignal,
  meta: { readonly timestamp: string; readonly version: string; readonly provenance: RunProvenance },
  onProgress?: ProgressFn,
  suite: readonly EvalPrompt[] = EVAL_SUITE,
): Promise<RunResult> {
  const results: PromptResult[] = [];

  for (let i = 0; i < suite.length; i++) {
    const prompt = suite[i] as EvalPrompt;
    if (signal.aborted) {
      // Record the remaining prompts honestly as unjudged-aborted rather than
      // silently shrinking the suite (which would inflate a partial aggregate).
      results.push({
        promptId: prompt.id,
        class: prompt.class,
        judged: false,
        mean: null,
        note: 'aborted before run',
      });
      onProgress?.(i + 1, suite.length, prompt.id);
      continue;
    }

    let outcome: AnswerOutcome;
    try {
      outcome = await answer(prompt, signal);
    } catch (err) {
      outcome = { answer: undefined, success: false, note: errNote(err) };
    }

    const objective = objectiveFor(prompt, outcome);
    const base = {
      promptId: prompt.id,
      class: prompt.class,
      ...(objective !== undefined ? { objective } : {}),
    } as const;

    if (outcome.answer === undefined || outcome.answer.trim().length === 0) {
      results.push({
        ...base,
        judged: false,
        mean: null,
        note: outcome.note ?? 'no answer produced',
      });
      onProgress?.(i + 1, suite.length, prompt.id);
      continue;
    }

    let verdict: JudgeVerdict | null = null;
    try {
      verdict = await judge(prompt, outcome.answer, signal);
    } catch {
      verdict = null; // fail-soft: judge threw → unjudged, never a fabricated score
    }

    if (verdict === null) {
      results.push({ ...base, judged: false, mean: null, note: 'judge unavailable' });
    } else {
      results.push({ ...base, judged: true, verdict, mean: promptMean(verdict) });
    }
    onProgress?.(i + 1, suite.length, prompt.id);
  }

  return {
    timestamp: meta.timestamp,
    version: meta.version,
    provenance: meta.provenance,
    scorecard: aggregate(results),
  };
}

/** Short, safe note from a thrown error (never includes secrets). */
function errNote(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `run error: ${msg.slice(0, 120)}`;
}
