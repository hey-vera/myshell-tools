/**
 * src/core/recap.ts — the conversation RECAP core (docs/recap-feature-5.5.md).
 *
 * A recap is a short, model-written, CONVERSATION-SCOPED orientation note that
 * answers "where were we?" on resume / `/recap`. It is the ※ line that replaces
 * the weak raw-tail-echo at the top of `runChatLoop`. It is DISTINCT from durable
 * user memory (memory-architecture-5.5 §6): a recap is a read-only projection of
 * this conversation's history, regenerated as the thread grows and discarded with
 * it — it never writes a durable fact.
 *
 * This module is PURE (no fs/path/child_process/Date/Math.random): the load-bearing
 * logic is unit-testable at the seam, exactly like `intent.ts`/`history.ts`. The
 * one model touch — generating the recap text — lives behind the injected
 * {@link RecapGenerator} port, realised by the thin composer `makeRecapGenerator`
 * in `src/core/recap-generator.ts` (a near-twin of `intent-extractor.ts`).
 *
 * Fail-soft contract (mirrors the IntentExtractor): the generator returns `null`
 * on ANY failure — no provider, route throws, the run errors or times out,
 * unusable output — so resume NEVER blocks and falls back to the prior behaviour.
 */

import type { SessionEntry } from './types.js';
import { compactHistory } from './history.js';

// ---------------------------------------------------------------------------
// The injected port (mirrors IntentExtractor, intent.ts:68-71)
// ---------------------------------------------------------------------------

/**
 * The injected recap-generation port. Given a (already compacted) history block,
 * returns a one-to-three-line recap string, or `null` on ANY failure (no
 * generator, parse/empty output, timeout, garbled). Never throws — the caller
 * falls back to the title / prior behaviour. Twin of {@link IntentExtractor}.
 */
export type RecapGenerator = (
  historyBlock: string,
  signal: AbortSignal,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Tunables (mirror the design §5.1)
// ---------------------------------------------------------------------------

/** Minimum turns before a recap is worth distilling (Claude Code's ≥3 floor). */
export const RECAP_MIN_TURNS = 3;
/** Regenerate only when messageCount has advanced by ≥ this since recapMessageCount. */
export const RECAP_STALE_AFTER_TURNS = 3;
/** Hard cap on the rendered recap body (the design's ≤240 chars). */
export const RECAP_MAX_CHARS = 240;

// ---------------------------------------------------------------------------
// Staleness — the cache/cost lever (§5.1). PURE.
// ---------------------------------------------------------------------------

/** The recap-relevant subset of ConversationMeta — kept structural so the pure
 * core never imports the infra store type. */
export interface RecapMetaView {
  readonly messageCount: number;
  readonly recap?: string | null;
  readonly recapAt?: string | null;
  readonly recapMessageCount?: number;
}

/**
 * Is the conversation eligible for a recap at all? Below {@link RECAP_MIN_TURNS}
 * there is nothing to distill (fall back to the title), matching Claude Code's
 * ≥3-turn floor. PURE.
 */
export function recapEligible(messageCount: number): boolean {
  return messageCount >= RECAP_MIN_TURNS;
}

/**
 * Should a fresh recap be generated for this conversation? True when the
 * conversation is eligible AND either no recap is cached yet, or the cached recap
 * was generated ≥ {@link RECAP_STALE_AFTER_TURNS} turns ago (or its provenance
 * `recapMessageCount` is missing/ahead of the current count). A fresh-enough
 * cached recap returns false → it is shown with ZERO model cost. PURE; never
 * throws.
 */
export function isRecapStale(
  meta: RecapMetaView,
  staleAfterTurns: number = RECAP_STALE_AFTER_TURNS,
): boolean {
  if (!recapEligible(meta.messageCount)) return false;
  // No usable cached recap yet → generate.
  const cached = typeof meta.recap === 'string' ? meta.recap.trim() : '';
  if (cached.length === 0) return true;
  // Cached but provenance missing → treat as stale (can't trust freshness).
  if (typeof meta.recapMessageCount !== 'number') return true;
  const advanced = meta.messageCount - meta.recapMessageCount;
  return advanced >= staleAfterTurns;
}

// ---------------------------------------------------------------------------
// The recap prompt builder (mirror buildIntentPrompt, intent.ts:200). PURE.
// ---------------------------------------------------------------------------

/**
 * Build the (already-truncated) history block fed to the generator. Bounds input
 * size by reusing the deterministic `compactHistory` truncation, exactly as the
 * design (§5.1) prescribes. Returns '' for empty input. PURE.
 */
export function buildRecapHistoryBlock(history: readonly SessionEntry[]): string {
  return compactHistory(history);
}

/**
 * Build the one-shot recap-generation prompt. Small, read-only, and structured
 * after the Anthropic session-memory cookbook distillation (§1.4): goal · state ·
 * next, plus one concrete anchor (file/decision/blocker) when present. Asks for
 * the USER-facing form (1–3 short lines, ≤RECAP_MAX_CHARS, no markdown chrome),
 * NOT a model-facing compaction summary. Returns '' when there is nothing to
 * summarize. Sibling of `buildIntentPrompt`. PURE.
 */
export function buildRecapPrompt(history: readonly SessionEntry[]): string {
  const block = buildRecapHistoryBlock(history);
  if (block.trim().length === 0) return '';
  return [
    'You write a one-line ORIENTATION RECAP for the USER returning to a CLI work',
    'conversation. Read the transcript and say WHERE WE WERE — distil the arc of the',
    'work, never echo the last message verbatim.',
    '',
    'Cover, as a single compact note (≤3 short lines, no markdown, no bullets):',
    '  goal  — what the user is ultimately trying to achieve;',
    '  state — what has been done / decided so far;',
    '  next  — the immediate next step or open question;',
    'plus ONE concrete anchor (a file, a decision, or a blocker) if one is present.',
    '',
    `Keep it under ${RECAP_MAX_CHARS} characters. Write plain prose orienting the`,
    'user ("…; next: write the token-expiry tests"). Do NOT do the work, do NOT',
    'add a preamble, and reply with ONLY the recap text — nothing else.',
    '',
    'TRANSCRIPT:',
    block,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parse / normalise the generator reply (mirror parseIntentFrame). PURE.
// ---------------------------------------------------------------------------

/**
 * Normalise a raw generator reply into a usable recap string, or `null` if it
 * can't be trusted. Strips surrounding whitespace and a leading "recap:"/"※"
 * label if the model echoed one, collapses internal newlines to a single space,
 * and caps to {@link RECAP_MAX_CHARS} (adding an ellipsis when truncated). Returns
 * `null` for empty/whitespace-only input so a vacuous reply yields no line. Never
 * throws. Mirrors `parseIntentFrame`'s "trust the shape or return null" discipline.
 */
export function parseRecap(text: string | undefined | null): string | null {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (s.length === 0) return null;
  // Drop a leading marker/label the model may have parroted ("※ recap: …").
  s = s.replace(/^[※⏺*\-•]\s*/u, '');
  s = s.replace(/^recap\s*[:\-—]\s*/i, '');
  // Collapse internal whitespace (incl. newlines) to single spaces so a multi-line
  // reply renders as one clean note.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return null;
  if (s.length > RECAP_MAX_CHARS) {
    s = s.slice(0, RECAP_MAX_CHARS - 1).trimEnd() + '…';
  }
  return s;
}
