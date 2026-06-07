/**
 * src/interface/menu-message-redo.ts — /retry + /edit message-level redo.
 *
 * Extracted from menu.ts — behavior-preserving, pure helpers.
 *
 * The truncate POINTS are computed by these PURE helpers so they're hermetically
 * testable; the menu applies them via the store's controlled `truncateAfter` and
 * re-runs the turn.
 */

import type { SessionEntry } from '../core/types.js';

/**
 * Plan a `/retry` from a loaded conversation log.
 *
 * Finds the LAST user message whose turn produced an answer (i.e. there is at
 * least one assistant entry after it), then returns the truncation point and the
 * user line to replay: keep everything BEFORE that user message (`keepCount`),
 * drop the user message AND the assistant answer(s) that followed, and re-run
 * `replayLine`. The user message is dropped from the kept prefix because the
 * re-run re-appends it via orchestrate — keeping it too would duplicate the user
 * turn. System control entries are ignored when deciding "was there an answer."
 *
 * Returns null when there is nothing to retry — an empty log, or a log whose tail
 * is a user message with no assistant answer yet (the turn is still the user's).
 * PURE; never throws.
 */
export function planRetryTruncation(
  entries: readonly SessionEntry[],
): { readonly keepCount: number; readonly replayLine: string } | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  // Walk back to the last assistant entry (the answer we'd regenerate).
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return null; // no answer to retry
  // The user message that PROMPTED that answer is the last user entry before it.
  let userIdx = -1;
  for (let i = lastAssistant - 1; i >= 0; i--) {
    if (entries[i]?.role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx === -1) return null; // answer with no preceding user turn
  const replayLine = entries[userIdx]?.content ?? '';
  if (replayLine.trim().length === 0) return null;
  // Keep everything BEFORE the user message; it (and the answer after it) are
  // dropped, because the re-run re-appends the user turn via orchestrate.
  return { keepCount: userIdx, replayLine };
}

/** A recent user message offered in the `/edit` picker — its log index + text. */
export interface EditableUserMessage {
  /** The entry's index in the full loaded log (the truncate boundary basis). */
  readonly index: number;
  /** The user message body. */
  readonly content: string;
}

/**
 * The recent USER messages eligible for `/edit`, most-recent first, bounded to
 * `max`. Empty-bodied and non-user entries are skipped. PURE; never throws.
 */
export function recentUserMessages(
  entries: readonly SessionEntry[],
  max = 8,
): EditableUserMessage[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const out: EditableUserMessage[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < Math.max(1, max); i--) {
    const e = entries[i];
    if (e?.role === 'user' && e.content.trim().length > 0) {
      out.push({ index: i, content: e.content });
    }
  }
  return out;
}
