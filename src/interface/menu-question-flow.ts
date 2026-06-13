/**
 * src/interface/menu-question-flow.ts — Extracted from menu.ts — behavior-preserving.
 *
 * Renders a {@link QuestionSet} and collects the user's answers, returning the
 * deterministic next-turn text to resubmit into the same conversation.
 */

import type { QuestionSet } from '../core/types.js';
import { formatAnswers } from '../core/questions.js';
import type { OutputSink } from './render.js';
import { renderDecisionPrompt } from './decision-prompt.js';
import {
  interpretQuestionAnswer,
  FREE_TEXT_SENTINEL,
} from './menu-questions.js';

/**
 * Render a {@link QuestionSet} and collect the user's answers, returning the
 * deterministic next-turn text (via {@link formatAnswers}) to resubmit into the
 * same conversation, or `null` when the user cancelled every question (submit
 * nothing → return to the prompt).
 *
 * Behaviour (mirrors the existing numbered pickers in runImportNative/runManage):
 *   - For each question, print the prompt + numbered options
 *     (`[1] label — description`), plus an `[N] type your own` line when the
 *     question allows free text.
 *   - Read a full line via `readLine` and parse it through the pure decision
 *     core {@link interpretQuestionAnswer}. On the TTY this line comes from the
 *     same readline reader the chat prompt uses; in tests an injected readLine
 *     drives it deterministically (mirrors confirmViaKey's line fallback).
 *   - `retry` re-prompts the same question; `cancel` (EOF/blank/Ctrl-C) skips
 *     this question and submits nothing for it.
 *   - When the user picks "type your own", a follow-up line is read for the
 *     free text.
 *
 * The reader (and thus its EOF/Ctrl-C semantics) is injected, so this is
 * testable without a TTY.
 */
export async function runQuestionSelector(
  questions: QuestionSet,
  out: OutputSink,
  readLine: () => Promise<string | null>,
): Promise<string | null> {
  const answers: Record<string, string> = {};

  for (const q of questions.questions) {
    const freeTextIndex = q.options.length + 1;
    out.write('\n' + renderDecisionPrompt(
      {
        kind: 'question',
        title: q.prompt,
        options: [
          ...q.options.map((opt, i) => ({
            id: String(i + 1),
            label: opt.label,
            ...(opt.description !== undefined ? { description: opt.description } : {}),
          })),
          ...(q.allowFreeText
            ? [{ id: String(freeTextIndex), label: 'Type your own' }]
            : []),
        ],
        multiSelect: q.multiSelect,
        allowFreeText: q.allowFreeText,
      },
      out.color,
    ));

    // Re-prompt on `retry`; resolve on `answer`/`cancel`.
    for (;;) {
      const line = await readLine();
      const verdict = interpretQuestionAnswer(line, q);

      if (verdict.kind === 'cancel') break; // skip this question
      if (verdict.kind === 'retry') {
        out.write('  (please pick a listed number or type your own)\n');
        continue;
      }

      // answer
      if (verdict.text === FREE_TEXT_SENTINEL) {
        out.write('Type your answer: ');
        const free = await readLine();
        const freeTrimmed = (free ?? '').trim();
        if (freeTrimmed.length > 0) {
          answers[q.id] = freeTrimmed;
        }
        break;
      }
      answers[q.id] = verdict.text;
      break;
    }
  }

  const next = formatAnswers(questions, answers);
  return next.length > 0 ? next : null;
}
