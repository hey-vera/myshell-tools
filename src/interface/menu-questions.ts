/**
 * src/interface/menu-questions.ts — Extracted from menu.ts — behavior-preserving.
 *
 * Pure yes/no and structured-question decision helpers. No I/O; the interface
 * layer maps these verdicts onto behaviour. These are the testable cores shared
 * by the TTY single-key path, the line-mode path, doctor, and login.
 */

import type { Question } from '../core/types.js';
import { dim } from '../ui/theme.js';

/**
 * Parse a yes/no answer from a raw input line, with a configurable default.
 *
 * Accepts (case-insensitive, trimmed):
 *   - `"y"` or `"yes"`           → true
 *   - `"n"` or `"no"`            → false
 *   - empty string or `null` (EOF) → `defaultYes`
 *   - anything else              → `defaultYes` (lenient)
 *
 * Never throws.  Callers render the hint via {@link yesNoHint}: `yes (enter) / no`
 * for a default-yes prompt, `yes (y) / no (n)` for a strict one.
 *
 * Strict mode (`requireExplicit`): for destructive/sensitive actions, ONLY an
 * explicit yes counts — Enter, EOF, and anything else cancel. This is the
 * line-mode (piped/test) twin of the strict single-key path, so a bare Enter can
 * never confirm a delete.
 *
 * @param input           - The raw line from readLine(), or null on EOF.
 * @param defaultYes      - True if pressing Enter (or EOF) means yes (ignored when strict).
 * @param requireExplicit - True to require an explicit `y`/`yes`; everything else is no.
 * @returns True for yes, false for no.
 */
export function parseYesNo(
  input: string | null,
  defaultYes: boolean,
  requireExplicit = false,
): boolean {
  const lower = (input ?? '').trim().toLowerCase();
  if (requireExplicit) {
    // Strict: only an explicit yes confirms; Enter/EOF/typos all cancel.
    return lower === 'y' || lower === 'yes';
  }
  if (input === null || lower.length === 0) return defaultYes;
  if (lower === 'y' || lower === 'yes') return true;
  if (lower === 'n' || lower === 'no') return false;
  return defaultYes;
}

/**
 * Interpret a single raw keypress for a yes/no prompt that accepts one key
 * (no Enter required).
 *
 *   - 'y' / 'Y'                → 'yes'
 *   - 'n' / 'N'                → 'no'
 *   - Ctrl-C (ETX) / Ctrl-D (EOT) → 'abort' (caller should bail out)
 *   - Enter (CR/LF)            → the default ('yes'/'no'), or 'ignore' when strict
 *   - anything else            → 'ignore' (do nothing; keep waiting for a key)
 *
 * Strict mode (`requireExplicit`): for destructive/sensitive actions there is NO
 * Enter default — Enter (and every key but y/n/Ctrl-C) is ignored, so the user
 * must consciously press `y` or `n`. A reflexive Enter can't confirm a delete.
 *
 * Pure / never throws. The I/O layer maps these verdicts onto behaviour; this
 * function is the testable decision core.
 */
export function interpretYesNoKey(
  key: string,
  defaultYes: boolean,
  requireExplicit = false,
): 'yes' | 'no' | 'ignore' | 'abort' {
  if (key === '\x03' || key === '\x04') return 'abort';
  const lower = key.toLowerCase();
  if (lower === 'y') return 'yes';
  if (lower === 'n') return 'no';
  if (key === '\r' || key === '\n') {
    return requireExplicit ? 'ignore' : defaultYes ? 'yes' : 'no';
  }
  return 'ignore';
}

/**
 * Render the trailing yes/no hint for a confirm prompt. The key cue is dimmed so
 * the eye lands on the words `yes` / `no`, not the annotation. Three shapes:
 *
 *   - `'yes'`    → default-yes: Enter or `y` confirms.   →  `yes (enter) / no`
 *   - `'no'`     → default-no (opt-in): Enter declines.  →  `yes / no (enter)`
 *   - `'strict'` → no default (sensitive/destructive):   →  `yes (y) / no (n)`
 *                  the user must press `y` or `n`; Enter does nothing.
 *
 * Enter means yes for the helpful, reversible defaults; the few invasive/opt-in
 * choices use `'no'` so we never change the user's environment on a reflexive
 * Enter; destructive actions use `'strict'`.
 */
export function yesNoHint(mode: 'yes' | 'no' | 'strict', color: boolean): string {
  const d = (s: string): string => dim(s, color);
  if (mode === 'strict') return `yes ${d('(y)')} / no ${d('(n)')}`;
  if (mode === 'no') return `yes / no ${d('(enter)')}`;
  return `yes ${d('(enter)')} / no`;
}

/**
 * The result of interpreting a user's raw answer to a single structured
 * question (the testable decision core for the question selector):
 *   - `{ kind: 'answer', text }` — a resolved answer string (one or more option
 *     labels joined by ', ', or free text) to feed back as the next turn.
 *   - `{ kind: 'cancel' }` — EOF/blank/Ctrl-C: skip this question.
 *   - `{ kind: 'retry' }` — the input made no valid selection; re-prompt.
 */
export type QuestionVerdict =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'retry' };

/**
 * Interpret a raw answer line for a single {@link Question} (pure decision core
 * used by the TTY and non-TTY selector paths alike).
 *
 * Selection rules (1-based indices match the rendered `[1] … [2] …` menu):
 *   - `null` (EOF) or empty/whitespace line → `cancel`.
 *   - Ctrl-C / Ctrl-D control bytes        → `cancel`.
 *   - A "type your own" sentinel index (options.length + 1) when `allowFreeText`
 *     is signalled by a non-empty `freeText` argument → that free text as the
 *     answer (the I/O layer collects the free text after the user picks it).
 *   - Single-select: the first valid index → that option's label.
 *   - Multi-select: comma/space-separated indices → the distinct labels in the
 *     order given, joined by ', '. Any wholly invalid set → `retry`.
 *   - Free text directly typed (non-numeric) when `allowFreeText` → that text.
 *   - Otherwise → `retry`.
 *
 * Pure / never throws.
 *
 * @param input    - The raw line from the reader, or null on EOF.
 * @param question - The question being answered (options + flags).
 */
export function interpretQuestionAnswer(
  input: string | null,
  question: Question,
): QuestionVerdict {
  if (input === null) return { kind: 'cancel' };
  // Control bytes (Ctrl-C / Ctrl-D) → cancel.
  if (input.includes('\x03') || input.includes('\x04')) return { kind: 'cancel' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: 'cancel' };

  const optionCount = question.options.length;
  const freeTextIndex = optionCount + 1; // the "[N] type your own" slot

  // Parse the line into 1-based indices (comma or whitespace separated).
  const tokens = trimmed.split(/[\s,]+/).filter((t) => t.length > 0);
  const allNumeric = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));

  if (allNumeric) {
    const indices = tokens.map((t) => parseInt(t, 10));

    // "type your own" sentinel — only meaningful when free text is allowed.
    if (question.allowFreeText && indices.length === 1 && indices[0] === freeTextIndex) {
      // The I/O layer must collect the actual free text; signal via retry-free
      // is unnecessary — instead we return cancel here is wrong. We surface a
      // dedicated marker the caller recognises.
      return { kind: 'answer', text: FREE_TEXT_SENTINEL };
    }

    const valid = indices.filter((i) => i >= 1 && i <= optionCount);
    if (valid.length === 0) return { kind: 'retry' };

    if (!question.multiSelect) {
      const first = valid[0];
      const label = first !== undefined ? question.options[first - 1]?.label : undefined;
      return label !== undefined ? { kind: 'answer', text: label } : { kind: 'retry' };
    }

    // Multi-select: distinct labels in the order given.
    const labels: string[] = [];
    for (const i of valid) {
      const label = question.options[i - 1]?.label;
      if (label !== undefined && !labels.includes(label)) labels.push(label);
    }
    return labels.length > 0 ? { kind: 'answer', text: labels.join(', ') } : { kind: 'retry' };
  }

  // Non-numeric input: treat as free text when the question allows it.
  if (question.allowFreeText) {
    return { kind: 'answer', text: trimmed };
  }

  return { kind: 'retry' };
}

/**
 * Sentinel returned by {@link interpretQuestionAnswer} when the user picked the
 * "type your own" option by its index; the I/O layer then collects the actual
 * free-text line. Kept internal to the selector contract.
 */
export const FREE_TEXT_SENTINEL = '\x00__FREE_TEXT__\x00';
