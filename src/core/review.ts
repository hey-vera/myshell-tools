/**
 * src/core/review.ts — pure review prompt builder and verdict parser.
 *
 * Provides utilities for building manager-style review prompts and parsing
 * the structured review verdict returned by the reviewing model.
 *
 * Honesty Contract: parseReviewVerdict never throws and never fabricates a
 * verdict — on any parse failure it defaults to a fail-safe `revise` with
 * confidence null and `parsed: false`. This never silently approves the IC's
 * work on a broken reviewer: lower tiers re-run/escalate (and ultimately accept
 * only as best-effort), while the high/critical guard keys off `parsed: false`.
 *
 * Pure module: no I/O, no time, no randomness.
 */

import { lastJsonObjectWithKey } from './json-envelope.js';
import type { WorkContract } from './work-contract.js';
import { renderContractForPrompt } from './work-contract.js';

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
 *                 false when the fail-safe default was used. Callers should
 *                 treat `parsed === false` on high/critical risk as
 *                 inconclusive rather than approved. On lower tiers the
 *                 default verdict is `revise` (NOT `approve`) so a broken
 *                 reviewer can never be mistaken for a clean approval.
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
 * @param contract - Optional ephemeral work contract criteria for this review.
 */
export function buildReviewPrompt(task: string, icOutput: string, contract?: WorkContract): string {
  const contractSection =
    contract !== undefined
      ? `\n\nVERIFY AGAINST CONTRACT:\n${renderContractForPrompt(contract)}\n\nUse this contract as the review criteria: did the IC output serve the objective and vision, or drift? Which roadmap item advanced, if any? Does any checkpoint claim conflict with the actual IC output? If there is divergence, identify where it began.`
      : '';

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
${contractSection}
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

/**
 * Fail-safe default used whenever the envelope is absent or malformed.
 *
 * Deliberately `revise` (not `approve`): a broken/unparseable reviewer must
 * never be silently flattened into a clean approval. `parsed: false` keeps the
 * high/critical-risk guard (orchestrate.ts) firing as "inconclusive"; on lower
 * tiers the `revise` verdict drives a bounded re-run / escalation and any
 * eventual acceptance is flagged best-effort rather than fully verified.
 */
const FAIL_SAFE: ReviewVerdict = { verdict: 'revise', notes: '', confidence: null, parsed: false };

/**
 * Robustly parse the trailing JSON verdict envelope from a reviewer's output.
 *
 * Fail-safe contract: if the envelope is absent or malformed, returns
 * `{ verdict: 'revise', notes: '', confidence: null, parsed: false }`. A broken
 * reviewer is never silently treated as an approval — it drives a bounded
 * re-run/escalation (lower tiers) or "inconclusive" handling (high/critical,
 * via `parsed: false`). This function NEVER throws.
 *
 * @param output - The full text output from the reviewing model.
 */
export function parseReviewVerdict(output: string): ReviewVerdict {
  // Guard: never throw on any input
  if (typeof output !== 'string') return FAIL_SAFE;

  let envelope: RawVerdict | null;
  try {
    envelope = lastJsonObjectWithKey(output, 'verdict') as RawVerdict | null;
  } catch {
    return FAIL_SAFE;
  }

  if (envelope === null) return FAIL_SAFE;

  // Validate verdict — must be one of the three allowed values
  if (typeof envelope.verdict !== 'string' || !VALID_VERDICTS.has(envelope.verdict)) {
    return FAIL_SAFE;
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
