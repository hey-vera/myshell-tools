/**
 * src/core/history.ts — compact prior conversation history for context injection.
 *
 * Produces a bounded, human-readable summary of prior SessionEntry turns to be
 * injected into the next provider prompt, giving stateless one-shot providers
 * (claude -p / codex exec) awareness of earlier conversation context.
 *
 * Purity rules (enforced by test/arch/guards.test.ts):
 *  - No imports of fs / path / child_process
 *  - No console.* calls
 *  - No Date.now() / Math.random() / new Date()
 *  - No process.exit()
 */

import type { SessionEntry } from './types.js';
import { lastJsonObjectBoundsWithKey } from './json-envelope.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_MAX_TURNS = 12;
const TRUNCATION_MARKER = ' …[truncated]';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip any trailing confidence-envelope JSON block from an assistant's content.
 *
 * The envelope is a trailing `{ ... }` object that contains `"confidence"`.
 * Uses {@link lastJsonObjectBoundsWithKey} to locate the last such block, then
 * removes it (and surrounding whitespace) from the content.
 *
 * Never throws — returns the original content on any parse failure.
 */
function stripEnvelope(content: string): string {
  try {
    const match = lastJsonObjectBoundsWithKey(content, 'confidence');
    if (match === null) {
      return content;
    }

    // Remove the envelope and any leading whitespace/newline before it
    const before = content.slice(0, match.start).replace(/\s+$/, '');
    const after = content.slice(match.end).replace(/^\s+/, '');

    return after.length > 0 ? `${before}\n${after}` : before;
  } catch {
    return content;
  }
}

/**
 * Map a SessionEntry role to the display label used in the history block.
 */
function roleLabel(role: SessionEntry['role']): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  return 'System';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompactHistoryOptions {
  /** Maximum total characters in the returned string. Default: 6000. */
  readonly maxChars?: number;
  /** Maximum number of conversation turns to include. Default: 12. */
  readonly maxTurns?: number;
}

/**
 * Compact prior conversation history into a bounded string for context injection.
 *
 * - Takes the MOST RECENT up-to-`maxTurns` entries (preserves chronological order).
 * - Strips confidence-envelope JSON from assistant turns before including them.
 * - Enforces `maxChars` by dropping the OLDEST included turns first until under budget.
 * - If a single turn's content alone exceeds `maxChars`, truncates it with a marker.
 * - Returns '' for empty / undefined input.
 *
 * Pure: no I/O, no Date, no Math.random. Never throws.
 *
 * @param entries - The prior conversation entries (oldest first).
 * @param opts    - Optional bounds overrides.
 */
export function compactHistory(
  entries: readonly SessionEntry[],
  opts?: CompactHistoryOptions,
): string {
  try {
    if (!Array.isArray(entries) || entries.length === 0) {
      return '';
    }

    const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
    const maxTurns = opts?.maxTurns ?? DEFAULT_MAX_TURNS;

    // Take the most recent up-to-maxTurns entries, then keep chronological order
    const window = entries.slice(-maxTurns);

    // Format each entry into a display line
    const formatted: string[] = window.map((entry) => {
      const label = roleLabel(entry.role);
      const rawContent = entry.role === 'assistant' ? stripEnvelope(entry.content) : entry.content;
      const content = rawContent.trim();
      return `${label}: ${content}`;
    });

    // Enforce maxChars by dropping oldest turns first
    // Each formatted turn is separated by '\n\n'
    let kept = formatted.slice(); // copy so we can mutate

    while (kept.length > 0) {
      const joined = kept.join('\n\n');
      if (joined.length <= maxChars) {
        return joined;
      }
      // Drop the oldest turn
      kept = kept.slice(1);
    }

    // If we get here, even a single turn is too long — truncate it
    if (formatted.length > 0) {
      const last = formatted[formatted.length - 1];
      if (last !== undefined && last.length > maxChars) {
        const truncated = last.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
        return truncated;
      }
      if (last !== undefined) {
        return last;
      }
    }

    return '';
  } catch {
    return '';
  }
}
