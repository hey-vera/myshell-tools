/**
 * src/core/assess.ts — parse real confidence signals from model output.
 *
 * The model is instructed (via prompt.ts) to end its response with a JSON
 * envelope on its own line:
 *   {"confidence": 0.0-1.0, "escalate": true|false, "reason": "...", "needs_review": true|false}
 *
 * Honesty Contract: if the envelope is absent, truncated, or malformed we
 * return confidence=null. We NEVER guess or fabricate a confidence number from
 * keywords or heuristics (that was the v1 sin). This function must never throw
 * on any input — it degrades gracefully on all malformed/garbage data.
 *
 * Pure module: no I/O, no time, no randomness.
 */

import type { Assessment } from './types.js';

// ---------------------------------------------------------------------------
// Internal envelope shape (before coercion)
// ---------------------------------------------------------------------------

interface RawEnvelope {
  confidence?: unknown;
  escalate?: unknown;
  reason?: unknown;
  needs_review?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract the last JSON object from `text` that looks like a
 * confidence envelope.  Returns the raw parsed object or null.
 *
 * Strategy: scan backwards for the last `{...}` block that contains at least
 * the `confidence` key, then try to parse it.  This is robust to:
 *  - trailing whitespace / newlines
 *  - the model emitting extra text after the envelope (we pick the LAST match)
 *  - duplicate envelopes (last one wins — the model may have regenerated it)
 *  - garbage / truncated JSON elsewhere in the output
 */
function extractEnvelope(text: string): RawEnvelope | null {
  // Find all candidates: substrings that start with '{' and end with '}'
  // We do this by iterating over all '{' positions and trying to match the
  // closing '}', handling depth.  We collect all valid JSON objects and
  // return the last one that has a 'confidence' key.
  const candidates: RawEnvelope[] = [];

  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;

    // Walk forward tracking brace depth to find the matching '}'
    let depth = 0;
    let j = start;
    let foundClose = false;
    while (j < text.length) {
      if (text[j] === '{') {
        depth++;
      } else if (text[j] === '}') {
        depth--;
        if (depth === 0) {
          foundClose = true;
          break;
        }
      }
      j++;
    }

    if (foundClose) {
      const candidate = text.slice(start, j + 1);
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'confidence' in (parsed as object)
        ) {
          candidates.push(parsed as RawEnvelope);
        }
      } catch {
        // Not valid JSON — skip
      }
    }

    i = start + 1;
  }

  if (candidates.length === 0) return null;
  // Return the last valid envelope (handles duplicate/regenerated envelopes)
  return candidates[candidates.length - 1] ?? null;
}

/**
 * Clamp a number to [0, 1].
 */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Coerce an unknown value to boolean — any truthy value maps to true.
 */
function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a trailing JSON confidence envelope from `output`.
 *
 * Returns real parsed values when the envelope is present and valid.
 * Returns `{ confidence: null, escalate: false, reason: 'no confidence envelope', needsReview: false }`
 * when the envelope is absent or unparseable.
 *
 * @param output - The full text output from the model.
 */
export function assess(output: string): Assessment {
  const NULL_RESULT: Assessment = {
    confidence: null,
    escalate: false,
    reason: 'no confidence envelope',
    needsReview: false,
  };

  // Guard: never throw on any input
  if (typeof output !== 'string' || output.length === 0) {
    return NULL_RESULT;
  }

  let envelope: RawEnvelope | null;
  try {
    envelope = extractEnvelope(output);
  } catch {
    return NULL_RESULT;
  }

  if (envelope === null) {
    return NULL_RESULT;
  }

  // Validate confidence: must be a finite number
  if (typeof envelope.confidence !== 'number' || !isFinite(envelope.confidence)) {
    return NULL_RESULT;
  }

  const confidence = clamp01(envelope.confidence);
  const escalate = coerceBool(envelope.escalate);
  const needsReview = coerceBool(envelope.needs_review);
  const reason =
    typeof envelope.reason === 'string' && envelope.reason.trim().length > 0
      ? envelope.reason.trim()
      : 'model provided no reason';

  return { confidence, escalate, reason, needsReview };
}
