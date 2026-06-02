/**
 * src/core/questions.ts — parse a structured `ask_user` elicitation block.
 *
 * The model is instructed (via prompt.ts) that, ONLY when it genuinely cannot
 * proceed without a user decision, it may end its response with exactly one JSON
 * object on its own final line:
 *
 *   {"ask_user":{"questions":[
 *     {"id":"<stable-key>","prompt":"<text>",
 *      "options":[{"label":"<short>","description":"<optional>"}],
 *      "multiSelect":<bool>,"allowFreeText":<bool>}
 *   ]}}
 *
 * This mirrors the confidence-envelope machinery (assess.ts): we reuse the
 * brace-aware, string-safe scanner from json-envelope.ts to locate the LAST
 * balanced `{...}` containing the `ask_user` key, then validate the schema and
 * bounds.
 *
 * Honesty Contract: this function NEVER throws and NEVER fabricates data. On any
 * malformed / out-of-bounds / absent input it returns null (degrade to plain
 * text, treat as NOT a question).
 *
 * Bounds: 1–4 questions; each question 2–4 options.
 *
 * Pure module: no I/O, no time, no randomness.
 */

import type { Question, QuestionOption, QuestionSet } from './types.js';
import { lastJsonObjectBoundsWithKey } from './json-envelope.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

// ---------------------------------------------------------------------------
// Validation helpers (each returns the typed value or null; never throws)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A non-empty trimmed string, or null. */
function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function parseOption(raw: unknown): QuestionOption | null {
  if (!isPlainObject(raw)) return null;
  const label = nonEmptyString(raw['label']);
  if (label === null) return null;
  const description = nonEmptyString(raw['description']);
  return {
    label,
    ...(description !== null ? { description } : {}),
  };
}

function parseQuestion(raw: unknown): Question | null {
  if (!isPlainObject(raw)) return null;

  const id = nonEmptyString(raw['id']);
  if (id === null) return null;

  const prompt = nonEmptyString(raw['prompt']);
  if (prompt === null) return null;

  const optionsRaw = raw['options'];
  if (!Array.isArray(optionsRaw)) return null;

  const options: QuestionOption[] = [];
  for (const o of optionsRaw) {
    const opt = parseOption(o);
    if (opt === null) return null; // any malformed option invalidates the question
    options.push(opt);
  }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null;

  // Booleans default to false when absent; reject non-boolean explicit values to
  // stay strict (the model is told to emit booleans).
  const multiSelect = coerceFlag(raw['multiSelect']);
  if (multiSelect === null) return null;
  const allowFreeText = coerceFlag(raw['allowFreeText']);
  if (allowFreeText === null) return null;

  return { id, prompt, options, multiSelect, allowFreeText };
}

/** Accept boolean or absent (→ false); reject anything else. */
function coerceFlag(v: unknown): boolean | null {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a trailing `ask_user` elicitation block from model output.
 *
 * Returns a typed {@link QuestionSet} when a well-formed, in-bounds block is
 * present; returns null otherwise (absent, malformed, or out-of-bounds). Never
 * throws — non-`ask_user` text and the confidence envelope both yield null.
 *
 * @param text - The full text output from the model.
 */
export function parseQuestions(text: string): QuestionSet | null {
  try {
    if (typeof text !== 'string' || text.length === 0) return null;

    const match = lastJsonObjectBoundsWithKey(text, 'ask_user');
    if (match === null) return null;
    // Require the block to be TRAILING (the contract: its own line at the very
    // end). This keeps detection in lockstep with the render-layer stripper,
    // which only strips a trailing control block — so a mid-prose example (e.g.
    // when the user asks "how does ask_user work?" and the model shows a sample)
    // is NOT misread as a real question and never pops a bogus selector.
    if (text.slice(match.end).trim().length !== 0) return null;
    const block = match.value;

    const askUser = block['ask_user'];
    if (!isPlainObject(askUser)) return null;

    const questionsRaw = askUser['questions'];
    if (!Array.isArray(questionsRaw)) return null;

    const questions: Question[] = [];
    for (const q of questionsRaw) {
      const parsed = parseQuestion(q);
      if (parsed === null) return null; // any malformed question invalidates the set
      questions.push(parsed);
    }
    if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) return null;

    return { questions };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Answer formatting (deterministic next-turn text)
// ---------------------------------------------------------------------------

/**
 * Build the deterministic next-turn text fed back into the conversation after
 * the user answers a {@link QuestionSet}.
 *
 * `answers` maps each question `id` to the chosen answer string (already joined
 * for multi-select, e.g. "vitest, jest", or free text). Questions with no entry
 * in `answers` (cancelled/skipped) are omitted. When nothing was answered the
 * result is an empty string.
 *
 * Example: `Answers: framework = vitest; coverage = yes`
 *
 * Pure / never throws.
 *
 * @param qs      - The question set the user was answering.
 * @param answers - Map of question id → answer text.
 */
export function formatAnswers(qs: QuestionSet, answers: Record<string, string>): string {
  try {
    const parts: string[] = [];
    for (const q of qs.questions) {
      const a = answers[q.id];
      if (typeof a === 'string' && a.trim().length > 0) {
        parts.push(`${q.id} = ${a.trim()}`);
      }
    }
    if (parts.length === 0) return '';
    return `Answers: ${parts.join('; ')}`;
  } catch {
    return '';
  }
}
