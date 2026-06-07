/**
 * src/interface/render.ts — Human-readable event stream renderer.
 *
 * Consumes the AsyncIterable<CoreEvent> produced by orchestrate() and writes
 * a clean, truthful transcript to an OutputSink. All displayed values come
 * directly from CoreEvent data — no fabricated metrics, no hardcoded strings.
 *
 * Honesty Contract: confidence is rendered as a computed percentage or the
 * literal word "unrated" when null. No digit-% literals appear in this file.
 *
 * Two cross-cutting concerns live here:
 *   1. The confidence ENVELOPE (the trailing `{"confidence":…}` JSON that
 *      prompt.ts forces onto every response) is internal control-plane data and
 *      must NEVER be shown to the user. Model prose arrives only via streamed
 *      `text` deltas, so we buffer the trailing fragment that could be the
 *      start of an envelope and strip it before flushing at the terminal event.
 *   2. VERBOSITY gating — `normal` (default) shows a clean conversation (prose +
 *      errors), `quiet` shows prose + errors only, `verbose` shows everything
 *      (tool lines, reasoning, per-tier telemetry).
 */

import type { CoreEvent } from '../core/types.js';
import type { ProviderId } from '../providers/port.js';
import type { CliError, ErrorCategory } from '../providers/errors.js';
import { classifyError, formatErrorMessage } from '../providers/errors.js';
import { lastJsonObjectBoundsWithKey, isTrailingNoise } from '../core/json-envelope.js';
import { GOAL_MARKER_TOKENS, stripTrailingGoalMarker } from '../core/goal.js';
import {
  bold,
  cyan,
  dim,
  green,
  red,
  yellow,
  turnMarker,
  panelLabel,
  styleInlineMarkdown,
  type PanelistState,
} from '../ui/theme.js';
import { createSpinner, type SpinnerOverlay } from '../ui/spinner.js';
import { formatTokens } from '../infra/insights.js';

// ---------------------------------------------------------------------------
// OutputSink
// ---------------------------------------------------------------------------

export interface OutputSink {
  write(s: string): void;
  readonly color: boolean;
  readonly isTty: boolean;
}

/** How much status/telemetry chrome to show alongside model prose. */
export type Verbosity = 'quiet' | 'normal' | 'verbose';

// ---------------------------------------------------------------------------
// Chat input surface — prompt box + live typed-ahead row
// ---------------------------------------------------------------------------

const INPUT_BOX_MIN_COLUMNS = 32;
const INPUT_BOX_MAX_COLUMNS = 84;
const INPUT_BOX_GLYPH = '✦';

export interface InputPromptOptions {
  readonly color?: boolean;
  readonly isTty?: boolean;
  readonly columns?: number;
  readonly value?: string;
}

export function canRenderInputBox(opts: InputPromptOptions): boolean {
  return opts.isTty === true &&
    opts.color === true &&
    (opts.columns ?? 80) >= INPUT_BOX_MIN_COLUMNS;
}

function inputBoxWidth(columns: number | undefined): number {
  const width = columns ?? 80;
  return Math.max(INPUT_BOX_MIN_COLUMNS, Math.min(INPUT_BOX_MAX_COLUMNS, width));
}

function fitCell(text: string, width: number): string {
  if (text.length <= width) return text + ' '.repeat(width - text.length);
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + '…';
}

/** Render the idle chat prompt. TTY+colour+wide terminals get a compact input
 * box; non-TTY, NO_COLOR, and narrow terminals keep the historical plain caret. */
export function renderInputPrompt(opts: InputPromptOptions = {}): string {
  const value = opts.value ?? '';
  if (!canRenderInputBox(opts)) return `❯ ${value}`;

  const outerWidth = inputBoxWidth(opts.columns);
  const innerWidth = outerWidth - 2;
  const topFill = Math.max(1, innerWidth - INPUT_BOX_GLYPH.length - 1);
  const top = `╭${'─'.repeat(topFill)} ${INPUT_BOX_GLYPH}╮`;
  const content = fitCell(` ❯ ${value}`, innerWidth);
  const bottom = `╰${'─'.repeat(innerWidth)}╯`;

  // Paint the whole box, then put the cursor back on the editable row after the
  // caret. readline owns editing; this only positions its echo in the box.
  return `${top}\n│${content}│\n${bottom}\x1b[1A\r│ ❯ `;
}

export function renderQueuedIndicator(queueLength: number, color = false): string {
  return dim(`⏎ queued (${queueLength})`, color);
}

export interface TurnInputSurface {
  readonly overlay: SpinnerOverlay;
  setValue(value: string): void;
  setQueued(queueLength: number): void;
  clear(): void;
}

export function createTurnInputSurface(
  out: OutputSink,
  opts: { readonly columns?: number } = {},
): TurnInputSurface | null {
  if (!out.isTty || !out.color || (opts.columns ?? 80) < INPUT_BOX_MIN_COLUMNS) return null;

  let status = '';
  let value = '';
  let queued: number | null = null;
  let painted = false;

  const inputLine = (): string => {
    const outerWidth = inputBoxWidth(opts.columns);
    const innerWidth = outerWidth - 2;
    const body = queued !== null
      ? ` ${renderQueuedIndicator(queued, out.color)}`
      : ` ❯ ${value}`;
    return `│${fitCell(body, innerWidth)}│`;
  };

  const repaint = (): void => {
    if (status.length === 0) return;
    const prefix = painted ? '\x1b[1A' : '';
    out.write(`${prefix}\r${status}\x1b[K\n${inputLine()}\x1b[K`);
    painted = true;
  };

  return {
    overlay: {
      paint(nextStatus: string): void {
        status = nextStatus;
        repaint();
      },
      clear(): void {
        if (!painted) return;
        out.write('\x1b[1A\r\x1b[K\n\r\x1b[K\x1b[1A\r');
        painted = false;
        status = '';
        value = '';
        queued = null;
      },
    },
    setValue(next: string): void {
      value = next;
      queued = null;
      repaint();
    },
    setQueued(queueLength: number): void {
      value = '';
      queued = queueLength;
      repaint();
    },
    clear(): void {
      this.overlay.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Resume transcript — "here's where we left off" (pure, testable seam)
// ---------------------------------------------------------------------------

/** Minimal shape a resume-transcript message needs. Structurally a SessionEntry. */
export interface ResumeMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly timestamp?: string;
}

export interface ResumeTranscriptOptions {
  /** Emit ANSI colour (gated exactly like every theme helper). Default false. */
  readonly color?: boolean;
  /** How many of the most recent messages to show. Default 6. */
  readonly maxMessages?: number;
  /** Per-message body character budget before an ellipsis. Default 280. */
  readonly maxCharsPerMessage?: number;
  /**
   * "Now" in epoch ms, for the dim relative timestamp ("2h ago"). Injected so
   * the renderer stays pure/testable; absent → timestamps are omitted entirely
   * (we never fabricate a clock).
   */
  readonly nowMs?: number;
}

const RESUME_DEFAULT_MAX_MESSAGES = 6;
const RESUME_DEFAULT_MAX_CHARS = 280;

/**
 * Strip an ASSISTANT turn's stored content down to clean displayable prose:
 * remove the trailing control envelope (confidence / ask_user / verdict /
 * remember_user) and any trailing goal marker, exactly as the live renderer
 * does, so a copied/exported/replayed answer shows prose rather than leaked
 * control JSON or a `GOAL_COMPLETE` marker. PURE; never throws (the underlying
 * envelope/marker strippers are themselves fail-soft → original on any failure).
 */
export function cleanAssistantText(content: string): string {
  let body = content ?? '';
  const env = trailingControlEnvelope(body);
  if (env !== null) body = body.slice(0, env.start);
  body = stripTrailingGoalMarker(body);
  return body;
}

/**
 * Collapse the assistant's stored content down to displayable prose: strip the
 * trailing control envelope (confidence / ask_user / verdict / remember_user)
 * and any trailing goal marker, exactly as the live renderer does, so a resumed
 * transcript shows clean prose rather than leaked control JSON.
 */
function transcriptBody(msg: ResumeMessage): string {
  const body = msg.role === 'assistant' ? cleanAssistantText(msg.content ?? '') : (msg.content ?? '');
  // Flatten to a single visual block: trim, collapse runs of blank lines so a
  // long multi-paragraph turn doesn't dominate the recap strip.
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// /copy + /export — pure seams (real-chat gap #3). Local-only, no network.
// ---------------------------------------------------------------------------

/**
 * Pick the text the user wants `/copy` to put on the clipboard: the LAST
 * assistant answer in the conversation, stripped of its control envelope and
 * goal marker. Returns null when there is no assistant answer to copy (an empty
 * log, or a log whose only assistant turns are blank after stripping) so the
 * caller shows a "nothing to copy" notice. PURE; never throws.
 */
export function pickCopyText(entries: readonly ResumeMessage[]): string | null {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e === undefined || e.role !== 'assistant') continue;
    const body = cleanAssistantText(e.content ?? '').trim();
    if (body.length > 0) return body;
  }
  return null;
}

/**
 * Render the whole conversation as a faithful Markdown transcript for `/export`.
 * Mirrors the `/memory export` Markdown shape: a title header (the conversation
 * title), then one `## You` / `## Assistant` section per user/assistant turn with
 * the (stripped) body beneath. System control entries are dropped — they are
 * internal turns, not chat. PURE and deterministic (no clock/I/O); never throws.
 */
export function renderConversationMarkdown(
  meta: { readonly title?: string },
  entries: readonly ResumeMessage[],
): string {
  const title = typeof meta?.title === 'string' ? meta.title.trim() : '';
  const lines: string[] = [`# ${title.length > 0 ? title : 'Conversation'}`, ''];
  const turns = Array.isArray(entries) ? entries : [];
  let wrote = false;
  for (const e of turns) {
    if (e === undefined || (e.role !== 'user' && e.role !== 'assistant')) continue;
    const body =
      e.role === 'assistant'
        ? cleanAssistantText(e.content ?? '').trim()
        : (e.content ?? '').trim();
    if (body.length === 0) continue;
    lines.push(e.role === 'assistant' ? '## Assistant' : '## You', '', body, '');
    wrote = true;
  }
  if (!wrote) lines.push('_No messages yet._', '');
  return lines.join('\n');
}

/** A dim, human relative time ("just now" / "5m ago" / "3h ago" / "2d ago"). */
function relativeTime(timestamp: string | undefined, nowMs: number | undefined): string {
  if (timestamp === undefined || nowMs === undefined) return '';
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return '';
  const deltaMs = nowMs - then;
  if (deltaMs < 0) return 'just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Render a bounded, glyph-styled transcript of the recent conversation so that
 * RESUMING a conversation reads like reopening a real chat — "here's where we
 * were" — instead of dropping the user onto a blank prompt.
 *
 * PURE and side-effect-free (no I/O, no clock — `nowMs` is injected) so it is
 * hermetically unit-testable. The menu calls it once on resume and writes the
 * string above the recap line and the entry prompt.
 *
 * Shape (most-recent-last, chronological):
 *   - a dim "…N earlier messages" note when older turns were dropped;
 *   - one block per shown message: `› ` for the user, `● ` for the assistant
 *     (the existing Phase-1 glyphs), the body (bounded per-message), and a dim
 *     trailing relative timestamp when a clock + timestamp are available;
 *   - system entries are skipped (they're internal control turns, not chat).
 *
 * Returns '' when there is nothing worth showing (no entries, or every entry is
 * empty/system) so the caller can simply skip the block. Degrades cleanly under
 * NO_COLOR / non-TTY: with `color:false` it emits the bare glyphs and no ANSI.
 */
export function renderResumeTranscript(
  entries: readonly ResumeMessage[],
  opts: ResumeTranscriptOptions = {},
): string {
  const color = opts.color ?? false;
  const maxMessages = Math.max(1, opts.maxMessages ?? RESUME_DEFAULT_MAX_MESSAGES);
  const maxChars = Math.max(1, opts.maxCharsPerMessage ?? RESUME_DEFAULT_MAX_CHARS);

  if (!Array.isArray(entries) || entries.length === 0) return '';

  // Only user/assistant turns are conversation; drop empty bodies + system control.
  const shown = entries
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({ role: e.role, body: transcriptBody(e), ts: e.timestamp }))
    .filter((e) => e.body.length > 0);

  if (shown.length === 0) return '';

  const window = shown.slice(-maxMessages);
  const dropped = shown.length - window.length;

  const lines: string[] = [];
  if (dropped > 0) {
    const noun = dropped === 1 ? 'message' : 'messages';
    lines.push(dim(`  …${dropped} earlier ${noun}`, color));
  }

  for (const m of window) {
    const glyph =
      m.role === 'assistant'
        ? cyan('●', color) // assistant turn marker
        : dim('›', color); // user echo marker
    let body = m.body;
    if (body.length > maxChars) {
      body = `${body.slice(0, maxChars).replace(/\s+\S*$/, '')}…`;
    }
    // Indent continuation lines so a multi-line body stays visually grouped
    // under its glyph.
    body = body.replace(/\n/g, '\n    ');
    const rel = relativeTime(m.ts, opts.nowMs);
    const stamp = rel.length > 0 ? `  ${dim(rel, color)}` : '';
    lines.push(`  ${glyph} ${body}${stamp}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Render a confidence value as a computed percentage string or 'unrated'.
 * No digit-% literal is used here — the percentage is always interpolated
 * from the real numeric value.
 */
function renderConfidence(confidence: number | null, color: boolean): string {
  if (confidence === null) return dim('unrated', color);
  const pct = Math.round(confidence * 100);
  const str = `${pct}%`;
  if (pct >= 80) return green(str, color);
  if (pct >= 50) return yellow(str, color);
  return red(str, color);
}

/**
 * Reconstruct a {@link CliError} for a known {@link ErrorCategory} by feeding
 * `classifyError` a probe string that deterministically maps to that category.
 * This REUSES the existing classification + descriptor tables in errors.ts
 * rather than duplicating the per-category messages/suggestions here.
 *
 * Returns null for the 'unknown' category — there's no actionable suggestion
 * worth surfacing beyond the raw message the caller already shows.
 */
function cliErrorForCategory(category: ErrorCategory): CliError | null {
  const PROBES: Record<ErrorCategory, { stderr: string; exit: number }> = {
    auth: { stderr: 'authentication failed', exit: 1 },
    'rate-limit': { stderr: 'rate limit exceeded', exit: 1 },
    timeout: { stderr: 'request timed out', exit: 1 },
    network: { stderr: 'network error', exit: 1 },
    model: { stderr: 'model not found', exit: 1 },
    permission: { stderr: 'permission denied', exit: 126 },
    unknown: { stderr: '', exit: 1 },
  };
  const probe = PROBES[category];
  const err = classifyError(probe.stderr, probe.exit);
  // Guard: only return it when the probe actually produced the intended
  // category — otherwise the suggestion would be misleading.
  return err.category === category && category !== 'unknown' ? err : null;
}

/**
 * Find the index of the trailing OPEN `{` — i.e. the position of a `{` whose
 * matching `}` has not (yet) arrived, scanning from end-of-text back. Returns
 * -1 when every brace is balanced (nothing is "open" at the tail).
 *
 * String-aware so braces inside quoted JSON strings don't affect depth. This is
 * the earliest point a still-arriving trailing envelope could begin; a balanced
 * `{…}` followed by more text is inline content and is NOT held back.
 *
 * Never throws.
 */
function trailingOpenBraceIndex(text: string): number {
  let depth = 0;
  let openIndex = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++; // skip the escaped char
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) openIndex = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0) openIndex = -1;
    }
  }
  return depth > 0 ? openIndex : -1;
}

/**
 * The trailing control-envelope keys this filter strips from DISPLAY. Both are
 * trailing `{ … }` JSON objects that are control-plane data, never user-facing:
 *   - `confidence` : the self-assessment envelope prompt.ts forces onto every
 *                    normal response.
 *   - `ask_user`   : the structured-question block (questions.ts) the model
 *                    emits instead, when it needs a user decision. The selector
 *                    renders the questions from the parsed CoreEvent — the raw
 *                    JSON must never leak into the prose, same class of bug.
 *   - `verdict`    : the cross-vendor review verdict envelope. Review output is
 *                    internal, but the renderer strips it defensively too.
 *   - `remember_user` : the model-proposed durable-memory block (Phase 5). It is
 *                    carried INSIDE the confidence envelope, so the `confidence`
 *                    key already covers the common case; but the model may emit a
 *                    bare `{"remember_user":{…}}` and the approval selector
 *                    renders the proposal from the parsed CoreEvent — the raw
 *                    JSON must never leak into the prose (same class of bug).
 * These are mutually exclusive per turn, but scanning for all is harmless and
 * future-proof.
 */
const CONTROL_ENVELOPE_KEYS = ['confidence', 'ask_user', 'verdict', 'remember_user'] as const;

/**
 * The opening signatures a trailing control envelope can have: `{` then optional
 * whitespace then the quoted key. Used to decide whether a still-arriving trailing
 * `{…` fragment could BECOME a control envelope (and so must be held back) or is
 * just ordinary prose/code/JSON (and so should stream immediately).
 */
const CONTROL_ENVELOPE_OPENINGS = ['"confidence', '"ask_user', '"verdict', '"remember_user'] as const;

/**
 * Given a trailing fragment that begins at an OPEN `{` (its `}` hasn't arrived),
 * decide whether it could still grow into a control envelope. We compare what
 * follows the `{` (after optional whitespace) against the control-key openings:
 * it qualifies if the fragment is a prefix of an opening (still being typed) or
 * already starts with one. A `{` followed by anything else — `{\n  const`,
 * `{"name"`, `{1, 2` — is ordinary content and streams immediately, so prose
 * and code never stall mid-token waiting for a brace to close.
 *
 * Never throws.
 */
function couldBeControlEnvelope(fragment: string): boolean {
  if (fragment.length === 0 || fragment[0] !== '{') return false;
  const after = fragment.slice(1).replace(/^\s+/, '');
  if (after.length === 0) return true; // just opened — undecided, hold briefly
  for (const opening of CONTROL_ENVELOPE_OPENINGS) {
    if (opening.startsWith(after) || after.startsWith(opening)) return true;
  }
  return false;
}

/**
 * Find the bounds of the LAST trailing control envelope (keyed by any of
 * {@link CONTROL_ENVELOPE_KEYS}) in `text`, considering only a block whose match
 * is at the END (nothing but whitespace after it). Returns the match with the
 * EARLIEST start among the keyed candidates so the whole trailing block is cut.
 * Returns null when none is present. Never throws.
 */
function trailingControlEnvelope(
  text: string,
): { readonly start: number; readonly end: number } | null {
  let best: { readonly start: number; readonly end: number } | null = null;
  for (const key of CONTROL_ENVELOPE_KEYS) {
    const m = lastJsonObjectBoundsWithKey(text, key);
    // Tolerate a wrapping ```json … ``` fence after the object so a fenced
    // envelope is still recognised as trailing and stripped (not leaked raw).
    if (m !== null && isTrailingNoise(text.slice(m.end))) {
      if (best === null || m.start < best.start) {
        best = { start: m.start, end: m.end };
      }
    }
  }
  return best;
}

/**
 * Start index of a trailing goal-marker region (the final line, plus its leading
 * newline so no orphan blank line remains), or -1 when the last line isn't a goal
 * marker. Also matches a PARTIAL prefix still being streamed (e.g. `GOAL_CON`) so
 * push() can hold it back until it either completes (→ stripped) or diverges into
 * real prose (→ released). Only ever inspects the LAST line, so a mid-prose
 * mention is never touched. Pure / never throws.
 */
function trailingGoalMarkerStart(text: string): number {
  try {
    const nl = text.lastIndexOf('\n');
    const lineStart = nl + 1; // 0 when there is no newline
    const line = text.slice(lineStart).replace(/^[ \t]+/, '');
    if (line.length === 0) return -1;
    const tok = line.match(/^GOAL_[A-Z]*/)?.[0];
    if (tok === undefined) return -1;
    // The leading token must be one of the markers, a prefix of one (still being
    // typed), or a full marker with a trailing `:`/text (the CONTINUE case).
    const isMarkerOrPrefix = GOAL_MARKER_TOKENS.some(
      (mk) => mk === tok || mk.startsWith(tok) || tok.startsWith(mk),
    );
    if (!isMarkerOrPrefix) return -1;
    return nl >= 0 ? nl : 0;
  } catch {
    return -1;
  }
}

/**
 * A streaming writer that holds back any trailing fragment of model prose that
 * could be the start of a control envelope, then strips the envelope at the
 * terminal event.
 *
 * The envelope is a trailing `{ … }` JSON object containing one of the control
 * keys (`confidence` for the self-assessment envelope, or `ask_user` for the
 * structured-question block). It arrives at the very end of the `text` delta
 * stream and may be split across the last few deltas. To avoid leaking a
 * half-arrived envelope, we hold back only the trailing OPEN-brace fragment (a
 * `{…` whose `}` hasn't arrived yet); a balanced `{…}` with text after it is
 * inline content and streams normally. At the terminal event we run the
 * brace-aware `lastJsonObjectBoundsWithKey` scanner (the same one history.ts
 * uses) to excise a genuine trailing envelope before flushing the remainder.
 */
class EnvelopeFilter {
  private full = '';
  private flushed = 0;
  private readonly out: OutputSink;
  // Optional line-safe inline-markdown styler (Phase 8). When set, a flushed
  // chunk is styled ONLY up to its last newline — the trailing partial line is
  // held back (in `full`, not written) until a newline completes it. This makes
  // styling stream-safe: the styler only ever sees COMPLETE lines, so a paired
  // span split across deltas (`**bo` then `ld**`) is never half-styled and a
  // bullet/heading at a line start is correctly detected. Identity off-TTY.
  private readonly style: ((text: string, atLineStart: boolean) => string) | undefined;
  // Whether the next styled chunk begins at a fresh line (start of stream, or
  // right after a flushed newline) — so the line-leading heading/bullet rules
  // only apply at a real line start.
  private atLineStart = true;

  // NOTE: a plain field assignment, NOT a constructor parameter property
  // (`constructor(private out)`) — the test runner strips types in strip-only
  // mode, which rejects parameter properties even though tsc accepts them.
  constructor(out: OutputSink, style?: (text: string, atLineStart: boolean) => string) {
    this.out = out;
    this.style = style;
  }

  /** Write a slice of already-envelope-safe prose to the sink, applying the
   *  optional markdown styler line-safely. When a styler is present we only emit
   *  up to the last newline in `text` and HOLD BACK the trailing partial line
   *  (by NOT advancing `flushed` past it), so the styler always sees complete
   *  lines. Returns the number of chars actually emitted (≤ text.length). */
  private emit(text: string): number {
    if (this.style === undefined || text.length === 0) {
      if (text.length > 0) this.out.write(text);
      return text.length;
    }
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) {
      // No complete line yet — hold the whole fragment back for now.
      return 0;
    }
    const complete = text.slice(0, lastNl + 1);
    this.out.write(this.style(complete, this.atLineStart));
    // The emitted chunk ended on a newline, so the next chunk is a line start.
    this.atLineStart = true;
    return complete.length;
  }

  /** Accept the next streamed prose delta, flushing everything that cannot be
   *  part of a trailing envelope. */
  push(delta: string): void {
    this.full += delta;
    // The safe-to-flush boundary is whichever comes FIRST of:
    //   (a) a trailing OPEN-brace fragment (a `{…` whose `}` hasn't arrived) —
    //       it could grow into the envelope, so never flush past it; and
    //   (b) the start of an already-complete trailing control envelope
    //       (balanced `{…confidence…}` or `{…ask_user…}` with only whitespace
    //       after) — flushing it would leak the block before the terminal
    //       flush() can strip it.
    // A balanced `{…}` with real prose after it is inline content and streams.
    const safeUpto = this.safeFlushBoundary();
    if (safeUpto > this.flushed) {
      const emitted = this.emit(this.full.slice(this.flushed, safeUpto));
      this.flushed += emitted;
    }
  }

  /** The index up to which `full` may be flushed without risking an envelope
   *  leak. See {@link push} for the two cases it guards. */
  private safeFlushBoundary(): number {
    let boundary = this.full.length;
    // (a) Hold back a trailing OPEN-brace fragment ONLY if it could still grow
    //     into a control envelope. A plain code/JSON/prose brace (`{\n const`,
    //     `{"name"`, `the set {1,2`) streams immediately — so the response never
    //     stalls mid-token waiting for a brace to close.
    const open = trailingOpenBraceIndex(this.full);
    if (open !== -1 && open < boundary && couldBeControlEnvelope(this.full.slice(open))) {
      boundary = open;
    }
    // (b) A complete trailing control envelope must also be held (flush strips it).
    const match = trailingControlEnvelope(this.full);
    if (match !== null && match.start < boundary) {
      boundary = match.start;
    }
    // (c) A trailing goal-control marker line (or a prefix still streaming) is held
    //     so it never leaks; flush() strips a confirmed one and releases a non-marker.
    const goal = trailingGoalMarkerStart(this.full);
    if (goal !== -1 && goal < boundary) {
      boundary = goal;
    }
    return boundary;
  }

  /** Flush at the final stream end. Idempotent. */
  flush(): void {
    this.flushInternal(false);
  }

  /** Flush at a tier boundary and reset the attempt-local control tail. */
  finishAttempt(): void {
    this.flushInternal(true);
  }

  /** Flush any held-back tail, excising control data first.
   *
   *  At final stream end a trailing OPEN `{` that is NOT a complete control
   *  envelope is legitimate prose (e.g. "the set {1, 2") and must be shown. At
   *  tier boundaries, an unfinished trailing fragment that could still be a
   *  control envelope belongs to that completed attempt, so it is stripped
   *  instead of being raw-dumped or carried into the next attempt. */
  private flushInternal(stripOpenControlFragment: boolean): void {
    if (this.flushed >= this.full.length) return;
    const match = trailingControlEnvelope(this.full);
    let cutEnd = this.full.length;
    if (match !== null) {
      cutEnd = match.start;
    }
    if (stripOpenControlFragment) {
      const beforeCut = this.full.slice(0, cutEnd);
      const open = trailingOpenBraceIndex(beforeCut);
      if (open !== -1 && couldBeControlEnvelope(beforeCut.slice(open))) {
        cutEnd = open;
      }
    }
    // Also cut a confirmed trailing goal-control marker line using the same
    // shared definition as the parser/history compactor. A non-marker prefix
    // that was briefly held back is released here as normal prose.
    const strippedGoal = stripTrailingGoalMarker(this.full.slice(0, cutEnd));
    if (strippedGoal.length < cutEnd) {
      cutEnd = strippedGoal.length;
    }
    if (cutEnd > this.flushed) {
      // Trim trailing whitespace AND a dangling ```json/``` fence-opener that the
      // model put just before the (now-removed) envelope, so no orphan fence leaks.
      const tail = this.full
        .slice(this.flushed, cutEnd)
        .replace(/\s+$/, '')
        .replace(/(?:^|\n)[ \t]*```[a-zA-Z0-9]*[ \t]*$/, '')
        .replace(/\s+$/, '');
      if (tail.length > 0) {
        // Terminal flush: this is the rest of the prose (incl. the last partial
        // line the streaming path held back), so style it as a complete unit.
        this.out.write(this.style !== undefined ? this.style(tail, this.atLineStart) : tail);
        if (tail.endsWith('\n')) this.atLineStart = true;
        else this.atLineStart = false;
      }
    }
    this.flushed = this.full.length;
  }
}

// ---------------------------------------------------------------------------
// renderStream
// ---------------------------------------------------------------------------

/**
 * Iterate events from orchestrate() and write a human-readable, truthful
 * transcript to the OutputSink. Returns the success flag and the final event
 * once the stream is exhausted.
 *
 * @param events    - The CoreEvent stream from orchestrate().
 * @param out       - Where rendered output is written.
 * @param verbosity - How much status chrome to show. Defaults to 'normal' so
 *                    callers that don't thread it through still compile and get
 *                    the clean conversation view.
 * @param interruptHint - Optional one-line hint (e.g. "esc to interrupt · ctrl-c
 *                    twice for menu") shown dim under the live status line on a
 *                    TTY and cleared with it. The renderer does NOT own
 *                    interruption mechanics — the driving loop passes the wording
 *                    that matches its keybindings (menu chat vs. plain repl), so
 *                    the two layers stay in sync. Omitted / off-TTY → no hint.
 */
export async function renderStream(
  events: AsyncIterable<CoreEvent>,
  out: OutputSink,
  verbosity: Verbosity = 'normal',
  interruptHint?: string,
  turnInput?: TurnInputSurface | null,
): Promise<{
  success: boolean;
  final?: Extract<CoreEvent, { type: 'final' }>;
  rateLimitedProviders: readonly ProviderId[];
}> {
  const c = out.color;
  const isVerbose = verbosity === 'verbose';
  const isQuiet = verbosity === 'quiet';

  let finalEvent: Extract<CoreEvent, { type: 'final' }> | undefined;
  // Providers that hit a rate-limit (429 / quota) at ANY point this run — even when
  // a later failover rescued the turn into a success final. The conversation layer
  // uses this to cool those providers down for the next turn (a success final's
  // errorCategory alone would miss the failed-then-recovered provider).
  const rateLimitedProviders = new Set<ProviderId>();
  let currentProvider: ProviderId | undefined;
  // Accumulate REAL tokens across tiers so the final summary shows a measured
  // total instead of an estimated dollar figure (subscription tool, not API).
  let runningTokens = 0;

  // Inline markdown is the lightweight, stream-safe styling from theme.ts. It is
  // applied per prose flush and is the identity off-TTY / NO_COLOR (so pipes get
  // raw markdown) — enabling it cannot corrupt machine output. Forced off with
  // MYSHELL_NO_MARKDOWN for users who prefer raw prose on a colour TTY.
  const markdownEnabled = c && process.env['MYSHELL_NO_MARKDOWN'] === undefined;
  const proseStyler = markdownEnabled
    ? (text: string, atLineStart: boolean): string =>
        styleInlineMarkdown(text, c, atLineStart)
    : undefined;

  // Buffers model prose and strips the trailing confidence envelope before it
  // can ever reach the user.
  let prose = new EnvelopeFilter(out, proseStyler);

  // Spinner is only used in TTY mode. It starts as soon as renderStream owns the
  // turn and STAYS alive through setup plus tool/reasoning activity (showing a
  // live step count + elapsed time) so a long run never looks frozen. It stops
  // only when real answer prose begins streaming, or when the tier finishes/errors.
  const spinner = createSpinner(out, turnInput?.overlay);
  let spinnerActive = false;
  let workLabel = 'Thinking';
  let stepCount = 0;

  // Whether any answer prose has streamed yet, and whether a tool call has
  // interrupted it since the last text delta. When prose resumes after a tool
  // call we insert a line break so the model's two segments aren't glued
  // together ("…before answering.The directory is empty…").
  let proseStarted = false;
  let toolSinceProse = false;
  let attemptHadProse = false;
  let breakBeforeNextProse = false;
  // Bytes of answer prose streamed in the current tier, so the live indicator can
  // show a Claude-style "↓ ~N tokens" readout. It's a measured estimate (≈4 chars/
  // token) shown only while working — marked with ~; the tier-done / final summary
  // reports the REAL measured token count, so no fabricated figure ever persists.
  let streamedChars = 0;

  // --- Multi-agent panel state (Phase 8) ---
  // Driven entirely by the typed `phase` event + the panel's REAL up-front
  // candidate tier-starts and their tier-dones. `panelMode` is set by a
  // `phase:'panel'` event and stays on for the rest of the turn; `panelists` is
  // the ordered candidate strip (each flips running→done on its tier-done);
  // `synthesizing` holds the success count once the `phase:'synthesis'` event
  // arrives, which switches the line to "Synthesizing N answers…". The sequential
  // and hedge paths never emit `phase`, so they keep their single-model line —
  // no fabricated race.
  let panelMode = false;
  const panelists: Array<{ provider: ProviderId; state: PanelistState }> = [];
  let synthesizing: { count: number } | null = null;
  /** Compose the live indicator label: the work verb, step count, and the
   *  streamed token estimate when any prose has arrived. The braille frame +
   *  `· Ns` elapsed suffix are added by the spinner itself. */
  function spinnerLabel(): string {
    // Multi-agent panel: collapse the N concurrent candidate runs into ONE live
    // line — "Waiting on N models · claude ✓ · codex …" while they run, then
    // "Synthesizing N answers…" once the synthesizer starts. Derived purely from
    // the real panel state (panelists/synthesizing), never fabricated.
    if (panelMode) {
      return panelLabel(panelists, synthesizing, c);
    }
    const steps = `${stepCount} step${stepCount === 1 ? '' : 's'}`;
    if (streamedChars > 0) {
      const approxTok = formatTokens(Math.ceil(streamedChars / 4));
      return `${workLabel}… ${steps} · ↓ ~${approxTok} tokens`;
    }
    return `${workLabel}… ${steps}`;
  }

  // The interrupt hint is a single dim line shown once per turn on a TTY (never
  // off-TTY, never in plain pipes). It is printed ABOVE the live status line so
  // the spinner's in-place `\r` repaints always land on the spinner's own (last)
  // line and never clobber the hint — the static hint sits just above the
  // animated verb, exactly the Claude/Codex layout. The wording is passed in by
  // the driving loop (Phase 0 owns the interrupt mechanics) rather than hardcoded
  // here, so the two layers stay in sync.
  let hintShown = false;
  function showInterruptHint(): void {
    if (hintShown) return;
    if (!out.isTty) return;
    if (interruptHint === undefined || interruptHint === '') return;
    out.write(`${dim(interruptHint, c)}\n`);
    hintShown = true;
  }

  function stopSpinner(): void {
    if (spinnerActive) {
      spinner.stop();
      spinnerActive = false;
    }
    // The hint clears with the status line: once the spinner's line is erased the
    // hint above is stale, so re-arm it to be reprinted if work resumes. (It is a
    // single line of chrome; the spinner's own \r\x1b[K handles its row.)
    hintShown = false;
  }

  /** The final-state assistant dot for a completion line, with a trailing space.
   *  This is where the turn's outcome colour lands (the streamed dot was cyan and
   *  can't be retro-recoloured). Empty (no leading space) under MYSHELL_PLAIN. */
  function completionDot(state: 'success' | 'fail' | 'cancel' | 'ask'): string {
    const marker = turnMarker(state, c);
    return marker === '' ? '' : `${marker} `;
  }

  /** Ensure the live indicator is on and showing the current label. Restarts it
   *  if it was stopped when answer prose began — so a tool/reasoning phase that
   *  runs AFTER an answer doesn't leave a dead, frozen-looking line. */
  function ensureAlive(): void {
    if (!out.isTty) return;
    if (!spinnerActive) {
      // resume(), not start(): a tier that streamed an answer and then runs more
      // tools keeps ONE continuous elapsed count instead of restarting at 0s.
      showInterruptHint();
      spinner.resume(spinnerLabel());
      spinnerActive = true;
    } else {
      spinner.update(spinnerLabel());
    }
  }

  /** Reflect ongoing tool activity in the indicator (counts a step) without
   *  spamming lines — the "still working" feedback for normal mode. */
  function noteWorkStep(): void {
    stepCount++;
    ensureAlive();
  }

  if (out.isTty) {
    showInterruptHint();
    spinner.start(spinnerLabel());
    spinnerActive = true;
  }

  for await (const ev of events) {
    switch (ev.type) {
      case 'classified': {
        // Only emit the classifier metadata line in debug mode — it's useful for
        // development but clutters the chat experience for regular users.
        if (process.env['MYSHELL_DEBUG']) {
          const cl = ev.classification;
          out.write(
            cyan(`Classified: ${cl.tier} tier, ${cl.risk} risk`, c) +
            ` — ${cl.rationale}\n`,
          );
        }
        break;
      }

      case 'phase': {
        // Phase 8 — the typed multi-agent signal. `panel` opens panel mode and
        // pre-registers every candidate as `running` (the up-front candidate
        // tier-starts that follow are then collapsed into the one "Waiting on N"
        // line); `synthesis` switches the line to "Synthesizing N answers…".
        // Non-panel turns never emit this, so their rendering is unchanged.
        if (ev.phase === 'panel') {
          panelMode = true;
          synthesizing = null;
          panelists.length = 0;
          for (const p of ev.participants ?? []) {
            panelists.push({ provider: p, state: 'running' });
          }
          // Refresh the live line so it reflects the new panel composition the
          // moment the panel forms (before the candidate tier-starts arrive).
          if (spinnerActive) spinner.update(spinnerLabel());
        } else if (ev.phase === 'synthesis') {
          synthesizing = { count: ev.count ?? 0 };
          if (spinnerActive) spinner.update(spinnerLabel());
        }
        break;
      }

      case 'tier-start': {
        const spinnerWasActive = spinnerActive;
        if (isVerbose && spinnerActive) {
          spinner.stop();
          spinnerActive = false;
        }
        if (isVerbose) {
          out.write(
            dim(`▶ ${ev.tier} (${ev.provider}/${ev.model})`, c) +
            `\n`,
          );
        }
        // Reset per-tier work tracking and start the live indicator. In verbose
        // mode the model/provider is shown; otherwise a clean "Thinking…".
        stepCount = 0;
        streamedChars = 0;
        attemptHadProse = false;
        currentProvider = ev.provider;
        // In panel mode the candidates' up-front tier-starts are collapsed into
        // the single "Waiting on N models" line; a candidate not pre-registered
        // by the `phase:'panel'` event (defensive) is added as running. Once
        // synthesis has begun, the synthesizer's tier-start is a normal single
        // stream — the panel line gives way to "Synthesizing…" already shown.
        if (panelMode && synthesizing === null) {
          if (!panelists.some((p) => p.provider === ev.provider)) {
            panelists.push({ provider: ev.provider, state: 'running' });
          }
        }
        workLabel = isVerbose ? `${ev.tier} (${ev.provider}/${ev.model})` : 'Thinking';
        if (out.isTty) {
          // Hint first (sits above), then the animated status line below it.
          showInterruptHint();
          // In panel mode keep ONE continuous line across the candidate
          // tier-starts (they all share the "Waiting on N" status) instead of
          // restarting the spinner per candidate.
          if (panelMode && spinnerActive) {
            spinner.update(spinnerLabel());
          } else if (spinnerActive) {
            spinner.start(spinnerLabel());
          } else if (spinnerWasActive) {
            spinner.resume(spinnerLabel());
            spinnerActive = true;
          } else {
            spinner.start(spinnerLabel());
            spinnerActive = true;
          }
        }
        break;
      }

      case 'provider-event': {
        const pe = ev.event;
        if (pe.type === 'text') {
          // First real answer prose — clear the indicator and start streaming.
          stopSpinner();
          // Head the assistant's turn with the cyan streaming `●`, exactly once,
          // immediately before the first prose delta — the same marker the live
          // status line carried, so the eye tracks one object from "working" →
          // "answer". It is written straight to the sink (not through the envelope
          // filter) so it can't be mistaken for prose. A streamed dot cannot be
          // retro-recoloured, so the COMPLETION line (below) owns the final-state
          // colour. Under MYSHELL_PLAIN turnMarker() returns '' → no marker.
          if (!proseStarted) {
            const marker = turnMarker('streaming', c);
            if (marker !== '') out.write(`${marker} `);
          }
          // If a tool call interrupted the prose, break the line so the resumed
          // text isn't glued onto the previous sentence. Only between segments —
          // never before the very first delta.
          if (breakBeforeNextProse && proseStarted) prose.push('\n');
          breakBeforeNextProse = false;
          if (toolSinceProse && proseStarted) prose.push('\n');
          toolSinceProse = false;
          proseStarted = true;
          attemptHadProse = true;
          // Measure streamed prose so a later tool phase's indicator can show the
          // running "↓ ~N tokens" readout (real bytes; ~4 chars/token estimate).
          streamedChars += pe.delta.length;
          // Stream prose, holding back any trailing envelope fragment.
          prose.push(pe.delta);
        } else if (pe.type === 'tool') {
          if (isVerbose) {
            // Verbose: print each tool line (stop the spinner so it isn't clobbered).
            stopSpinner();
            out.write(dim(`[tool] ${pe.name} ${pe.phase}`, c) + `\n`);
          } else {
            // Normal/quiet: keep the indicator alive and count the step, so a
            // tool-heavy run shows life ("Thinking… 12 steps · 8s") instead of
            // freezing on a dead line. Mark that prose (if any) was interrupted so
            // the next text delta starts on a fresh line.
            noteWorkStep();
            toolSinceProse = true;
          }
        } else if (pe.type === 'reasoning') {
          if (isVerbose) {
            stopSpinner();
            out.write(dim(pe.delta, c));
          } else {
            // Normal/quiet: reasoning is internal — don't print it, but keep (or
            // revive) the live indicator so a long thinking phase shows life.
            ensureAlive();
          }
        } else if (pe.type === 'error' && pe.error.category === 'rate-limit' && currentProvider !== undefined) {
          // Remember a 429 against the running provider so the conversation layer
          // can cool it down next turn — even if failover later rescues this run.
          rateLimitedProviders.add(currentProvider);
        }
        // 'usage', 'done' are handled via tier-done / final
        break;
      }

      case 'tier-done': {
        // Panel candidate tier-done (we're in panel mode and synthesis hasn't
        // started): flip that panelist to ✓ and keep the SINGLE live line going,
        // ticking "Waiting on N" down — do NOT stop the spinner or reset prose
        // (candidate prose is never streamed). The synthesizer's tier-done falls
        // through to the normal path below.
        if (panelMode && synthesizing === null) {
          // Flip the first still-running panelist (candidate tier-dones arrive in
          // announce order). Match by the running flag so a provider that appears
          // twice is handled left-to-right.
          const pending = panelists.find((p) => p.state === 'running');
          if (pending !== undefined) pending.state = 'done';
          // Tokens are real and measured — accumulate them like any tier.
          runningTokens += ev.inputTokens + ev.outputTokens;
          if (isVerbose) {
            const confidenceStr = renderConfidence(ev.confidence, c);
            const tokenStr = formatTokens(ev.inputTokens + ev.outputTokens);
            const successMark = ev.success ? green('✓', c) : red('✗', c);
            // Stop the live line so the verbose telemetry isn't clobbered, then
            // let ensureAlive() bring the panel line back for the remaining
            // candidates.
            stopSpinner();
            out.write(
              `\n${successMark} ${bold('tier done', c)} — ` +
              `confidence: ${confidenceStr}, ` +
              `${tokenStr} tokens, ` +
              `duration: ${ev.durationMs}ms\n`,
            );
            ensureAlive();
          } else if (spinnerActive) {
            spinner.update(spinnerLabel());
          }
          break;
        }
        stopSpinner();
        prose.finishAttempt();
        prose = new EnvelopeFilter(out, proseStyler);
        if (attemptHadProse) {
          breakBeforeNextProse = true;
        }
        attemptHadProse = false;
        toolSinceProse = false;
        // Tokens are real and measured; dollars are an API-equivalent estimate
        // that doesn't map to subscription billing, so they live in `cost`, not here.
        runningTokens += ev.inputTokens + ev.outputTokens;
        // Per-tier telemetry is verbose-only chrome.
        if (isVerbose) {
          const confidenceStr = renderConfidence(ev.confidence, c);
          const tokenStr = formatTokens(ev.inputTokens + ev.outputTokens);
          const successMark = ev.success ? green('✓', c) : red('✗', c);
          out.write(
            `\n${successMark} ${bold('tier done', c)} — ` +
            `confidence: ${confidenceStr}, ` +
            `${tokenStr} tokens, ` +
            `duration: ${ev.durationMs}ms\n`,
          );
        }
        break;
      }

      case 'escalate': {
        // Escalation is internal routing — verbose-only.
        if (isVerbose) {
          out.write(
            yellow(`↑ Escalating ${ev.from} → ${ev.to}: ${ev.reason}`, c) + `\n`,
          );
        }
        break;
      }

      case 'failover': {
        // Failover is internal routing — verbose-only.
        if (isVerbose) {
          out.write(
            yellow(`⇄ Failing over ${ev.from} → ${ev.to} (${ev.tier}): ${ev.reason}`, c) + `\n`,
          );
        }
        break;
      }

      case 'notice': {
        // The panel COMPOSITION header ("Panel: claude, codex → synthesized by …")
        // and the hedge speculative notices are surfaced dim in NORMAL mode too
        // (not just verbose) so the user sees who is on the panel / why the wait,
        // per docs/chat-presentation-5.5.md §4.2/§4.3. Other info notices stay
        // verbose-gated chrome. We key off the message shape (the only info notice
        // runPanel emits is the "Panel: …" line; hedge emits "primary slow …").
        const isPanelHeader =
          ev.level === 'info' &&
          (ev.message.startsWith('Panel: ') || ev.message.startsWith('Panel (hard turn): '));
        const isHedgeNotice =
          ev.level === 'info' && ev.message.startsWith('hedge: primary slow');
        // The unknown-spend warning (orchestrate.ts, emitted on a timeout when the
        // child was killed before reporting usage) MUST reach normal-mode users:
        // hiding it would let the timeout final line below read as a clean "0
        // tokens" failure that silently implies no spend, when spend is in fact
        // unknown. We key off the message prefix the orchestrator emits.
        const isSpendUnknownWarn =
          ev.level === 'warn' && ev.message.startsWith('Spend unknown —');
        // Clear the live indicator before printing a notice so it isn't clobbered.
        if (
          ev.level === 'error' ||
          isVerbose ||
          isPanelHeader ||
          isHedgeNotice ||
          isSpendUnknownWarn
        ) {
          stopSpinner();
        }
        // Errors are ALWAYS shown (every verbosity). Info/warn are chrome and
        // only surface in verbose mode — except the normal-mode notices above
        // (panel header, hedge, and the honest unknown-spend warning).
        if (ev.level === 'error') {
          out.write(`${red('[error]', c)} ${ev.message}\n`);
        } else if (isVerbose) {
          const prefix = ev.level === 'warn' ? yellow('[warn]', c) : dim('[info]', c);
          out.write(`${prefix} ${ev.message}\n`);
        } else if (isSpendUnknownWarn) {
          // A yellow `[warn]` line in normal mode too — spend honesty is not
          // verbose-gated chrome.
          out.write(`${yellow('[warn]', c)} ${ev.message}\n`);
        } else if (isPanelHeader || isHedgeNotice) {
          // A dim `⋮ <message>` header line, matching the spec mockups.
          out.write(`${dim(`⋮ ${ev.message}`, c)}\n`);
        }
        break;
      }

      case 'final': {
        finalEvent = ev;
        stopSpinner();
        // Flush any held-back prose (envelope already stripped) before the
        // completion/error line so the conversation reads in order.
        prose.flush();

        if (ev.canceled === true) {
          if (!isQuiet) {
            // Dim turn dot + the existing `■ Cancelled` glyph line.
            out.write(`\n${completionDot('cancel')}${dim('■ Cancelled', c)}\n`);
          }
          break;
        }

        if (!ev.success) {
          if (ev.errorCategory === 'timeout') {
            if (!isQuiet) {
              out.write(
                `\n${yellow("That ran past the single-turn time limit — it's a big task, not a crash.", c)}\n`,
              );
              out.write(
                `${dim(
                  `Timed out after one turn · tier: ${ev.tier} · ${formatTokens(runningTokens)} tokens · attempts: ${ev.attempts} · session: ${ev.sessionId}`,
                  c,
                )}\n`,
              );
            }
            break;
          }
          // Surface an ACTIONABLE error in every verbosity mode: the bare
          // category message plus the suggestion from formatErrorMessage().
          if (ev.errorCategory !== undefined) {
            const cliErr = cliErrorForCategory(ev.errorCategory);
            if (cliErr !== null) {
              out.write(`\n${red(formatErrorMessage(cliErr, ev.provider), c)}\n`);
            }
          }
          if (!isQuiet) {
            // Red turn dot owns the failed final-state colour.
            out.write(
              `\n${completionDot('fail')}${bold(red('Failed', c), c)} — ` +
              `tier: ${ev.tier}, ` +
              `${formatTokens(runningTokens)} tokens, ` +
              `attempts: ${ev.attempts}, ` +
              `session: ${ev.sessionId}\n`,
            );
          }
          break;
        }

        // A turn that ends in a structured question is a complete success that
        // needs a REPLY, not finished work. Suppress the normal completion line
        // entirely; the caller inspects `final.questions` and drives a selector
        // (renderStream returns `{ success, final }`). The prose (the model's
        // lead-in before the ask_user block, already stripped above) has been
        // flushed; printing "✓ done" here would read as if the task were over.
        if (ev.questions !== undefined) {
          break;
        }

        // Best-effort success: the loop exhausted its escalation/review budget
        // without a clean accept but DID produce a substantive answer. Surface it
        // honestly — the answer above is real and usable, but it stayed under the
        // confidence bar / wasn't fully verified. Shown in every non-quiet mode so
        // the user isn't misled into treating it as a clean success.
        if (ev.bestEffort === true && !isQuiet) {
          out.write(
            `\n${yellow('Best-effort answer — reached the attempt limit without a fully-confident result; treat the above as unverified.', c)}\n`,
          );
        }

        // Success: a single minimal completion line in normal/verbose; nothing
        // in quiet.
        if (isVerbose) {
          // Green turn dot owns the success final-state colour.
          out.write(
            `\n${completionDot('success')}${bold(green('Success', c), c)} — ` +
            `tier: ${ev.tier}, ` +
            `${formatTokens(runningTokens)} tokens, ` +
            `attempts: ${ev.attempts}, ` +
            `session: ${ev.sessionId}\n`,
          );
        } else if (!isQuiet) {
          // `● ✓ done · N tokens · Ns` — green dot, dim metrics. Elapsed is the
          // real seconds the spinner was visible (spinner.elapsed(), tick-derived,
          // never fabricated); on a non-TTY run no ticks fire so it is 0 and the
          // suffix is omitted, keeping piped output stable.
          const secs = spinner.elapsed();
          const elapsedStr = secs > 0 ? ` · ${secs}s` : '';
          out.write(
            `\n${completionDot('success')}` +
            `${dim(`✓ done · ${formatTokens(runningTokens)} tokens${elapsedStr}`, c)}\n`,
          );
        }
        break;
      }
    }
  }

  // Safety: ensure the spinner is stopped and any buffered prose is flushed if
  // the stream ended without a terminal event.
  stopSpinner();
  prose.flush();

  const rl = [...rateLimitedProviders];
  if (finalEvent !== undefined) {
    return { success: finalEvent.success, final: finalEvent, rateLimitedProviders: rl };
  }
  return { success: false, rateLimitedProviders: rl };
}
