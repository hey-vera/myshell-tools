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
 * `RecapGenerator` port, realised by the thin composer `makeRecapGenerator`
 * in `src/core/recap-generator.ts` (a near-twin of `intent-extractor.ts`).
 *
 * Fail-soft contract (mirrors the IntentExtractor): the generator returns `null`
 * on ANY failure — no provider, route throws, the run errors or times out,
 * unusable output — so resume NEVER blocks and falls back to the prior behaviour.
 */

import type { SessionEntry } from './types.js';
import { compactHistory } from './history.js';
import { ELITE_VOICE_PREAMBLE } from './prompt.js';

// ---------------------------------------------------------------------------
// Tunables (mirror the design §5.1)
// ---------------------------------------------------------------------------

/** Minimum turns before a recap is worth distilling (Claude Code's ≥3 floor). */
export const RECAP_MIN_TURNS = 3;
/** Regenerate only when messageCount has advanced by ≥ this since recapMessageCount. */
const RECAP_STALE_AFTER_TURNS = 3;
/** Hard cap on the rendered recap body (the design's ≤240 chars). */
export const RECAP_MAX_CHARS = 240;
/** Hard cap on the model-written TITLE (a crisp objective, not a sentence). */
export const RECAP_TITLE_MAX_CHARS = 64;

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
 * Build the one-shot recap-generation prompt. This is read by a CAPABLE
 * (manager-tier) model — so it is given the product-vision / quality bar persona
 * first (the reused {@link ELITE_VOICE_PREAMBLE}), then asked to produce BOTH:
 *   - a professional TITLE: a crisp objective naming the actual project/goal, the
 *     way a senior engineer/PM would label the thread — NEVER an echo of the
 *     user's phrasing, NEVER a "we/this conversation" preamble; and
 *   - a STATE recap: where the work actually stands + the immediate next step, in
 *     1–2 sentences — NEVER an echo of the last assistant or user message.
 * The reply is a tagged two-part text (`TITLE:` / `STATE:`) so {@link parseRecapResult}
 * can split it fail-soft. Returns '' when there is nothing to summarize. PURE.
 */
export function buildRecapPrompt(history: readonly SessionEntry[]): string {
  const block = buildRecapHistoryBlock(history);
  if (block.trim().length === 0) return '';
  return [
    ELITE_VOICE_PREAMBLE,
    '',
    'Using that bar, you are labelling a CLI work conversation for the user so the',
    'thread reads like a senior engineer or PM titled and summarised it. Read the',
    'transcript and figure out what this work is REALLY about, then return EXACTLY',
    'two tagged lines and nothing else:',
    '',
    'TITLE: <a crisp, professional objective that names the actual project or goal>',
    'STATE: <where the work stands now + the immediate next step, 1–2 sentences>',
    '',
    'Hard rules:',
    `  - TITLE: ≤${RECAP_TITLE_MAX_CHARS} characters. Name the OBJECTIVE (e.g.`,
    '    "heyvera — YouTube-scale video platform"), not a topic-less restatement of',
    "    what the user typed. NEVER echo the user's opening phrasing. NO leading",
    '    "we"/"this conversation"/"the user" preamble. No trailing punctuation.',
    `  - STATE: ≤${RECAP_MAX_CHARS} characters, plain prose, no markdown, no bullets.`,
    '    Say what has been done/decided and the next step. NEVER echo or paraphrase',
    "    the last assistant or user message — distil the arc, don't parrot the reply.",
    '  - Do NOT do the work. Do NOT add any preamble, explanation, or extra lines.',
    '    Reply with ONLY the two tagged lines.',
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

// ---------------------------------------------------------------------------
// Structured {title, recap} parse — the manager pass produces BOTH in one call.
// ---------------------------------------------------------------------------

/**
 * The structured product of one manager-tier recap pass: a professional `title`
 * (the conversation objective) and a `recap` (the state/next orientation line).
 * `title` is null when the model didn't emit a usable one, so the caller keeps
 * its provisional/stub title rather than clobbering it.
 */
export interface RecapResult {
  readonly title: string | null;
  readonly recap: string;
}

/**
 * Normalise the model-written TITLE into a clean conversation title, or null when
 * unusable. Strips a leading "TITLE:" label / marker glyph, collapses whitespace,
 * drops a "we/you/this conversation/the user" preamble (so the title reads as an
 * objective, not a narration), removes wrapping quotes + trailing punctuation, and
 * bounds to {@link RECAP_TITLE_MAX_CHARS} on a word boundary. PURE; never throws.
 */
function parseRecapTitle(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[※⏺*\-•]\s*/u, '');
  s = s.replace(/^title\s*[:\-—]\s*/i, '').trim();
  // Strip surrounding quotes the model sometimes wraps a title in.
  s = s.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim();
  if (s.length === 0) return null;
  // Drop a leading conversational framing so the title is an objective, not a
  // narration — only when it leaves a usable remainder.
  const reframed = s.replace(
    /^(?:we(?:'ve| have| are| were)?|you(?:'ve| have| are| were)?|i(?:'ve| have| am| was)?|this conversation(?: is| was)?|the (?:user|thread))\b[\s:,-]*/i,
    '',
  );
  if (reframed.trim().length >= 3) s = reframed.trim();
  // Strip trailing sentence punctuation — a title is a label, not a sentence.
  s = s.replace(/[.;,]+$/, '').trim();
  if (s.length < 3) return null;
  if (s.length > RECAP_TITLE_MAX_CHARS) {
    s = s.slice(0, RECAP_TITLE_MAX_CHARS).replace(/\s+\S*$/, '').trim();
    if (s.length === 0) return null;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse the manager pass's tagged `TITLE:` / `STATE:` reply into a {@link
 * RecapResult}, or null when no usable recap could be extracted. Fail-soft and
 * tolerant of the model dropping the tags:
 *   - finds the `STATE:` line for the recap, falling back to the whole reply (run
 *     through {@link parseRecap}) when the tag is absent;
 *   - finds the `TITLE:` line for the title (null when absent/unusable);
 *   - returns null only when the recap itself can't be salvaged, so the caller
 *     falls straight back to today's behaviour and NEVER crashes.
 * PURE; never throws.
 */
export function parseRecapResult(text: string | undefined | null): RecapResult | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const titleMatch = trimmed.match(/(?:^|\n)\s*title\s*[:\-—]\s*(.+)/i);
  const stateMatch = trimmed.match(/(?:^|\n)\s*state\s*[:\-—]\s*([\s\S]+)/i);

  // Recap body: the STATE line if tagged, else the whole reply (less any TITLE
  // line) so an untagged reply still yields a usable recap.
  let recapSource: string;
  if (stateMatch?.[1] !== undefined) {
    recapSource = stateMatch[1];
  } else if (titleMatch !== null) {
    // Tagged title but no state → drop the title line, recap from the remainder.
    recapSource = trimmed.replace(/(?:^|\n)\s*title\s*[:\-—]\s*.*(\n|$)/i, '\n');
  } else {
    recapSource = trimmed;
  }

  const recap = parseRecap(recapSource);
  if (recap === null) return null;

  const title = parseRecapTitle(titleMatch?.[1]);
  return { title, recap };
}
