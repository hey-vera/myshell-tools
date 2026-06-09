/**
 * src/core/eval/answer-runner.ts — drive the REAL answer path headless for eval.
 *
 * Builds an {@link AnswerPort} that runs a prompt through the partner's ACTUAL
 * answer machinery — orchestrate(), the exact generator the live chat uses — and
 * captures the `final` event's output. This is what makes the ruler honest: it
 * measures the real partner, not a re-implementation. No rendering, no UI; it just
 * consumes the CoreEvent stream and reads the terminal `final`.
 *
 * The OrchestrateDeps are supplied per-run by the caller (the command layer builds
 * them from real providers, exactly like the `run` subcommand). We thread a small
 * factory so each prompt gets a FRESH session writer (an eval prompt is a cold,
 * single-turn run — never carries history from the previous prompt).
 *
 * HONESTY: a turn that errors / produces no output → AnswerOutcome with no answer
 * and an honest note (→ recorded unjudged). We also report whether the turn was
 * INSTANT (one attempt, no escalation) so the harness can verify the "trivial
 * stays instant" expectation against the real run, model-free.
 *
 * PURITY: core — imports orchestrate() (also core) and the Provider port; no
 * fs/path/child_process. The real I/O is inside the injected providers.
 */

import type { CoreEvent, OrchestrateDeps } from '../types.js';
import type { ProviderId } from '../../providers/port.js';
import { orchestrate } from '../orchestrate.js';
import type { EvalPrompt } from './suite.js';
import type { AnswerPort, AnswerOutcome } from './harness.js';

/** Deps for the answer port: a fresh-deps factory + the answering provider id. */
export interface AnswerRunnerDeps {
  /**
   * Build a FRESH OrchestrateDeps for one prompt run (fresh session writer, no
   * carried history). Injected so the command layer owns the real provider/ledger
   * wiring and so tests can inject a fake-provider deps factory.
   */
  readonly makeDeps: (promptId: string) => OrchestrateDeps;
  /** The provider id that will answer (for run provenance + cross-vendor judge). */
  readonly answerProvider: ProviderId;
}

/**
 * Consume orchestrate()'s event stream for one prompt and reduce it to an
 * {@link AnswerOutcome}. Pure reducer over the CoreEvent stream — the same `final`
 * the renderer reads, but headless.
 */
export async function captureAnswer(
  events: AsyncIterable<CoreEvent>,
): Promise<AnswerOutcome> {
  let answer: string | undefined;
  let success = false;
  let note: string | undefined;
  let escalated = false;
  let attempts = 1;

  for await (const ev of events) {
    if (ev.type === 'escalate') {
      escalated = true;
    } else if (ev.type === 'final') {
      success = ev.success;
      attempts = ev.attempts;
      if (ev.output.trim().length > 0) answer = ev.output;
      if (!ev.success) {
        note =
          ev.errorCategory !== undefined
            ? `run failed (${ev.errorCategory})`
            : 'run failed';
      } else if (ev.questions !== undefined) {
        // The partner asked the user a question instead of answering — that IS a
        // valid partner move (and is what some ambiguous prompts SHOULD do), so we
        // judge the question text as the answer. Honest: it's the real output.
        note = undefined;
      }
    }
  }

  // "Instant" = exactly one attempt and no escalation — the cheap, model-free
  // honesty check that a trivial turn did not over-spend.
  const instant = attempts <= 1 && !escalated;

  return {
    answer,
    success,
    instant,
    ...(note !== undefined ? { note } : {}),
  };
}

/** Build an {@link AnswerPort} that runs each prompt through orchestrate() headless. */
export function makeAnswerPort(deps: AnswerRunnerDeps): AnswerPort {
  return async (prompt: EvalPrompt, signal: AbortSignal): Promise<AnswerOutcome> => {
    const od = deps.makeDeps(prompt.id);
    return captureAnswer(orchestrate(prompt.prompt, od, signal));
  };
}
