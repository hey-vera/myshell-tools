/**
 * src/core/review.ts — pure review prompt builder and verdict parser.
 *
 * Provides utilities for building manager-style review prompts and parsing
 * the structured review verdict returned by the reviewing model.
 *
 * Honesty Contract: parseReviewVerdict never throws and never fabricates a
 * verdict — on any parse failure it defaults to fail-open `approve` with
 * confidence null so a broken reviewer cannot block the user.
 *
 * Pure module: no I/O, no time, no randomness.
 */

import { lastJsonObjectWithKey } from './json-envelope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The structured verdict returned by a reviewing model.
 *
 * - `approve`   : IC output is acceptable; proceed to final.
 * - `revise`    : IC output needs changes; retry IC with the reviewer's notes.
 * - `escalate`  : The issue is beyond IC scope; escalate to manager tier.
 * - `parsed`    : True when a real verdict envelope was found and validated;
 *                 false when the fail-open default was used. Callers should
 *                 treat `parsed === false` on high/critical risk as
 *                 inconclusive rather than approved.
 */
export interface ReviewVerdict {
  readonly verdict: 'approve' | 'revise' | 'escalate';
  readonly notes: string;
  readonly confidence: number | null;
  readonly parsed: boolean;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a manager-style prompt asking the reviewer to critically assess the
 * IC's work for correctness, quality, security, and completeness.
 *
 * The prompt instructs the model to end its response with a JSON verdict
 * envelope on its own line:
 *   {"verdict": "approve|revise|escalate", "notes": "...", "confidence": 0.0-1.0}
 *
 * @param task     - The original user task description.
 * @param icOutput - The IC's full output text being reviewed.
 */
export function buildReviewPrompt(task: string, icOutput: string): string {
  return `\
You are a senior-manager / staff-engineer reviewer performing a critical quality gate.

You are reviewing the work of an individual-contributor (IC) engineer who was given the
following task. Your job is to identify any issues with correctness, quality, security,
or completeness in the IC's output before it reaches the user.

Original task:
${task}

IC output to review:
${icOutput}

Review checklist (assess each dimension):
1. CORRECTNESS — Does the output actually solve the task? Are there logic errors, off-by-ones,
   or wrong assumptions?
2. QUALITY — Is the code/output clean, idiomatic, and maintainable? Are there obvious smells?
3. SECURITY — Are there any injection risks, secret leaks, missing input validation, or
   privilege-escalation paths?
4. COMPLETENESS — Does the output address all parts of the task, or does it miss edge cases?

For any finding, anchor it to a specific file path and line range when applicable.

After your review, append EXACTLY the following JSON object on its own line at the very end
of your response (no trailing text after it):
{"verdict": "approve|revise|escalate", "notes": "<specific, file-anchored feedback>", "confidence": <0.0-1.0>}

verdict choices:
  approve   — the IC output is correct, complete, and safe; ship it.
  revise    — the IC output has fixable issues; provide actionable notes so the IC can retry.
  escalate  — the task requires architectural judgement or has critical defects beyond IC scope.

confidence: your honest estimate that your review is complete and correct (1.0 = certain).`;
}

// ---------------------------------------------------------------------------
// Verdict parser
// ---------------------------------------------------------------------------

/** Raw envelope shape before coercion. */
interface RawVerdict {
  verdict?: unknown;
  notes?: unknown;
  confidence?: unknown;
}

const VALID_VERDICTS = new Set<string>(['approve', 'revise', 'escalate']);

/** Fail-open default used whenever the envelope is absent or malformed. */
const FAIL_OPEN: ReviewVerdict = { verdict: 'approve', notes: '', confidence: null, parsed: false };

/**
 * Robustly parse the trailing JSON verdict envelope from a reviewer's output.
 *
 * Fail-open contract: if the envelope is absent or malformed, returns
 * `{ verdict: 'approve', notes: '', confidence: null }`. A broken reviewer
 * must never block the user. This function NEVER throws.
 *
 * @param output - The full text output from the reviewing model.
 */
export function parseReviewVerdict(output: string): ReviewVerdict {
  // Guard: never throw on any input
  if (typeof output !== 'string') return FAIL_OPEN;

  let envelope: RawVerdict | null;
  try {
    envelope = lastJsonObjectWithKey(output, 'verdict') as RawVerdict | null;
  } catch {
    return FAIL_OPEN;
  }

  if (envelope === null) return FAIL_OPEN;

  // Validate verdict — must be one of the three allowed values
  if (typeof envelope.verdict !== 'string' || !VALID_VERDICTS.has(envelope.verdict)) {
    return FAIL_OPEN;
  }

  const verdict = envelope.verdict as 'approve' | 'revise' | 'escalate';

  const notes =
    typeof envelope.notes === 'string' ? envelope.notes.trim() : '';

  // confidence is optional — null when absent or invalid
  let confidence: number | null = null;
  if (typeof envelope.confidence === 'number' && isFinite(envelope.confidence)) {
    confidence = Math.min(1, Math.max(0, envelope.confidence));
  }

  return { verdict, notes, confidence, parsed: true };
}
