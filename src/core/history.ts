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
import { stripTrailingGoalMarker } from './goal.js';
import { ReconstructedContextV1, reconstructContextV1 } from './durable-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_MAX_TURNS = 12;
const CONTEXT_PRESSURE_CHAR_CAP = 6000;
const TRUNCATION_MARKER = ' …[truncated]';

export interface HistoryCompactionPlan {
  readonly maxChars: number;
  readonly maxTurns: number;
  readonly reduced: boolean;
}

/**
 * Reduce history by exactly the amount raw context exceeds its own 6,000-char cap.
 * Context at or below the cap retains the existing history defaults unchanged.
 */
export function planHistoryCompaction(
  rawContextLength: number,
): HistoryCompactionPlan {
  const normalizedRawLength = Number.isFinite(rawContextLength)
    ? Math.max(0, rawContextLength)
    : 0;
  if (normalizedRawLength <= CONTEXT_PRESSURE_CHAR_CAP) {
    return {
      maxChars: DEFAULT_MAX_CHARS,
      maxTurns: DEFAULT_MAX_TURNS,
      reduced: false,
    };
  }
  return {
    maxChars: Math.max(
      0,
      DEFAULT_MAX_CHARS - (normalizedRawLength - CONTEXT_PRESSURE_CHAR_CAP),
    ),
    maxTurns: DEFAULT_MAX_TURNS,
    reduced: true,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip any trailing control-envelope JSON block from an assistant's content
 * before it is replayed into a later prompt.
 *
 * Two control blocks live at the trailing edge of a response and are internal
 * control-plane data, never conversational content:
 *   - the confidence envelope (`{…"confidence"…}`), forced onto every response;
 *   - the structured-question block (`{"ask_user":…}`), emitted when the model
 *     needs a user decision.
 * Either must be removed from replayed history — otherwise the model sees its
 * own machine-control JSON as prior "conversation" and learns to treat it as
 * normal prose (and it wastes tokens). Mirrors the render-layer stripper.
 *
 * Never throws — returns the original content on any parse failure.
 */
function stripEnvelope(content: string): string {
  try {
    // Find whichever trailing control block starts earliest (only one should be
    // present per turn, but scanning both is harmless and future-proof).
    let match: { readonly start: number; readonly end: number } | null = null;
    for (const key of ['confidence', 'ask_user']) {
      const m = lastJsonObjectBoundsWithKey(content, key);
      if (m !== null && content.slice(m.end).trim().length === 0) {
        if (match === null || m.start < match.start) match = { start: m.start, end: m.end };
      }
    }
    if (match === null) {
      return content;
    }

    // Remove the block and any leading whitespace/newline before it
    const before = content.slice(0, match.start).replace(/\s+$/, '');
    const after = content.slice(match.end).replace(/^\s+/, '');

    return after.length > 0 ? `${before}\n${after}` : before;
  } catch {
    return content;
  }
}

function stripAssistantReplayControls(content: string): string {
  const withoutTrailingMarker = stripTrailingGoalMarker(content);
  const withoutEnvelope = stripEnvelope(withoutTrailingMarker);
  return stripTrailingGoalMarker(withoutEnvelope);
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

    if (maxChars <= 0) {
      return '';
    }

    // Take the most recent up-to-maxTurns entries, then keep chronological order
    const window = entries.slice(-maxTurns);

    // Format each entry into a display line
    const formatted: string[] = window.map((entry) => {
      const label = roleLabel(entry.role);
      const rawContent = entry.role === 'assistant' ? stripAssistantReplayControls(entry.content) : entry.content;
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
        const truncated =
          maxChars <= TRUNCATION_MARKER.length
            ? last.slice(0, maxChars)
            : last.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
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

// ---------------------------------------------------------------------------
// Truncation reporting (honesty seam)
// ---------------------------------------------------------------------------

export interface HistoryTruncationInfo {
  /** True when compactHistory would drop ≥1 whole turn from `entries`. */
  readonly truncated: boolean;
  /** How many whole turns compactHistory would omit (0 when not truncated). */
  readonly droppedTurns: number;
}

/**
 * Report whether {@link compactHistory} would drop whole turns from `entries`,
 * and how many — WITHOUT changing what compactHistory returns. The resume path
 * shows the full scrollback, but the model only receives compactHistory's recent
 * window; this seam lets the UI surface a quiet, honest note when those diverge.
 *
 * Uses the SAME bounds as compactHistory (maxTurns windowing, then maxChars
 * oldest-first dropping) so the count can never disagree with what was sent.
 * A single over-long final turn is character-truncated in place (not a dropped
 * turn), so it is NOT counted here — only whole omitted turns are.
 *
 * Pure: no I/O, no Date, no Math.random. Never throws.
 */
export function historyTruncationInfo(
  entries: readonly SessionEntry[],
  opts?: CompactHistoryOptions,
): HistoryTruncationInfo {
  try {
    if (!Array.isArray(entries) || entries.length === 0) {
      return { truncated: false, droppedTurns: 0 };
    }

    const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
    const maxTurns = opts?.maxTurns ?? DEFAULT_MAX_TURNS;

    if (maxChars <= 0) {
      return { truncated: true, droppedTurns: entries.length };
    }

    // (1) maxTurns windowing drops the oldest turns beyond the window.
    const droppedByTurns = Math.max(0, entries.length - maxTurns);
    const window = entries.slice(-maxTurns);

    // (2) maxChars then drops oldest turns first until under budget — mirror the
    //     exact loop in compactHistory so the count matches what was sent.
    const formatted: string[] = window.map((entry) => {
      const label = roleLabel(entry.role);
      const rawContent =
        entry.role === 'assistant' ? stripAssistantReplayControls(entry.content) : entry.content;
      return `${label}: ${rawContent.trim()}`;
    });

    // Mirror compactHistory's drop loop, but stop before emptying the array: a
    // single over-budget final turn is character-truncated IN PLACE (kept), not
    // dropped, so it must not be counted as a dropped turn.
    let kept = formatted.slice();
    let droppedByChars = 0;
    while (kept.length > 1 && kept.join('\n\n').length > maxChars) {
      kept = kept.slice(1);
      droppedByChars += 1;
    }

    const droppedTurns = droppedByTurns + droppedByChars;
    return { truncated: droppedTurns > 0, droppedTurns };
  } catch {
    return { truncated: false, droppedTurns: 0 };
  }
}

// ---------------------------------------------------------------------------
// Map snapshot reconstruction hook (phase2-r717-completion-map-binding)
// Small compat for durable 11 + CompletionResultV1 map orientation substrate.
// History consumers read from completion snapshot when the entrypoint-composed
// CompletionResultV1 dependency is on; explicit opt-out preserves old readers.
// ---------------------------------------------------------------------------

/** Reconstruction hook using Phase1 map (ranked+symbols) snapshot for ReconstructedContextV1. Delegates to durable recon. */
export function reconstructUsingCompletionMapSnapshot(
  snapshot: { ranked?: readonly unknown[]; env?: string } | null,
  _priorHistory?: readonly SessionEntry[],
): ReconstructedContextV1 {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!snapshot || !(snapshot as any).ranked) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { version: 1, logId: 'hist-compat', conversationId: 'current', baseSnapshotId: null, replayedEvents: [], promptBlocks: [], openLoops: [], tokenEstimate: 0 } as any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envSnap = { version: 1, snapshotId: 's', logId: 'l', kind: 'environment' as const, coversThrough: { logId: 'l', eventId: 'e', sequence: 0 }, createdAt: '', sourceEventIds: [], state: { rankedFiles: (snapshot as any).ranked }, stateHash: '', invalidatedBy: null, tokenEstimate: 10 } as any;
  const recon = reconstructContextV1({ logId: 'l', conversationId: 'current', snapshots: [envSnap], tailEvents: [] });
  return recon;
}

/**
 * Minimal wiring of durable store (P0) into history seam.
 * Uses dynamic import so core stays free of static infra dep (avoids graph issues).
 * When durable files exist for the log, loads real events/snapshots and reconstructs.
 * Falls back to empty recon (synthetic parity) when absent or error.
 * Higher layers (prompts/orchestrate) can call this for real durable path.
 */
export async function reconstructFromDurableStore(
  logId: string,
  conversationId: string,
): Promise<ReconstructedContextV1> {
  try {
    // dynamic to keep layering; the store itself dynamically pulls pure reconstruct
    const mod = await import('../infra/durable-context-store.js');
    if (typeof mod.loadAndReconstruct === 'function') {
      return await mod.loadAndReconstruct(logId, conversationId);
    }
  } catch {
    // fail soft to synthetic/empty
  }
  // synthetic empty (parity with prior no-store behavior)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { version: 1, logId, conversationId, baseSnapshotId: null, replayedEvents: [], promptBlocks: [], openLoops: [], tokenEstimate: 0 } as any;
}
