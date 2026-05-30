/**
 * src/core/json-envelope.ts — shared brace-depth JSON-envelope scanner.
 *
 * Provides reusable helpers that scan text for the LAST balanced `{...}` JSON
 * object containing a given key.  Used by assess.ts (confidence envelope),
 * review.ts (verdict envelope), and history.ts (envelope stripping) to avoid
 * duplicated scanning logic.
 *
 * Honesty Contract: these functions NEVER throw on any input.  On parse failure
 * or absent key they return null.  They never fabricate data.
 *
 * Pure module: no I/O, no time, no randomness.
 */

// ---------------------------------------------------------------------------
// Internal scan result (shared by both public APIs)
// ---------------------------------------------------------------------------

interface ScanMatch {
  /** Start index (inclusive) of the `{` in the original text. */
  readonly start: number;
  /** End index (exclusive, i.e. one past the `}`) in the original text. */
  readonly end: number;
  /** The parsed JSON object. */
  readonly value: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core scanning loop (private)
// ---------------------------------------------------------------------------

/**
 * Walk `text` left-to-right, collecting every balanced `{...}` block that
 * parses as a plain JSON object and contains `key`.  Returns the last match
 * (or null if none found).  Never throws.
 */
function scanLast(text: string, key: string): ScanMatch | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  let last: ScanMatch | null = null;

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
          key in (parsed as object)
        ) {
          last = { start, end: j + 1, value: parsed as Record<string, unknown> };
        }
      } catch {
        // Not valid JSON — skip
      }
    }

    i = start + 1;
  }

  return last;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `text` and return the LAST balanced `{...}` block that:
 *  1. Parses as valid JSON,
 *  2. Is a plain object (not null, not an array), and
 *  3. Contains the given `key` as a direct property.
 *
 * Returns `null` when no matching block is found.  Never throws.
 *
 * Scanning semantics:
 *  - All `{` positions are tried left-to-right.
 *  - For each `{`, the matching `}` is located by tracking brace depth.
 *  - All candidates that parse and contain `key` are collected; the LAST one
 *    wins.  This handles duplicate/regenerated envelopes in model output.
 *
 * @param text - The text to scan (any string).
 * @param key  - The property key that must be present in the JSON object.
 */
export function lastJsonObjectWithKey(
  text: string,
  key: string,
): Record<string, unknown> | null {
  try {
    const match = scanLast(text, key);
    return match !== null ? match.value : null;
  } catch {
    return null;
  }
}

/**
 * Like {@link lastJsonObjectWithKey}, but also returns the character offsets of
 * the matched block within `text` so callers can excise it.
 *
 * Returns `null` when no matching block is found.  Never throws.
 *
 * The returned `start` and `end` follow the same convention as
 * `String.prototype.slice`: `text.slice(start, end)` reproduces the matched
 * `{...}` block exactly.
 *
 * @param text - The text to scan (any string).
 * @param key  - The property key that must be present in the JSON object.
 */
export function lastJsonObjectBoundsWithKey(
  text: string,
  key: string,
): { readonly start: number; readonly end: number; readonly value: Record<string, unknown> } | null {
  try {
    return scanLast(text, key);
  } catch {
    return null;
  }
}
