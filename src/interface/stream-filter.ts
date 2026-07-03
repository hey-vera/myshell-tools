/**
 * src/interface/stream-filter.ts — PURE stream/envelope-filtering logic.
 *
 * This module owns the correctness-critical, side-effect-free text processing
 * that protects the user from ever seeing control-plane data leak into model
 * prose: the trailing "confidence envelope" (and sibling control blocks) that
 * prompt.ts forces onto every response, and the trailing goal-control marker.
 *
 * It is deliberately PURE — no fs, no process.stdout, no Date.now/Math.random,
 * no execa. The only outward effect is via the injected {@link OutputSink} that
 * the stateful {@link EnvelopeFilter} writes already-safe prose to; the sink is
 * a caller-supplied seam, not ambient I/O. Keeping this logic pure and isolated
 * lets a future (Ink-based) renderer reuse the exact same filtering, and lets it
 * be characterised by hermetic unit tests independently of the renderer.
 */

import { lastJsonObjectBoundsWithKey, isTrailingNoise } from '../core/json-envelope.js';
import { GOAL_MARKER_TOKENS, stripTrailingGoalMarker } from '../core/goal.js';
import type { GoalBoardRow } from './ui/state.js';
import type { UiCapacityState } from './ui/state.js';

// ---------------------------------------------------------------------------
// OutputSink
// ---------------------------------------------------------------------------

export interface OutputSink {
  write(s: string): void;
  readonly color: boolean;
  readonly isTty: boolean;
  /**
   * OPTIONAL: commit any buffered, not-yet-newline-terminated text so it becomes
   * visible NOW. Needed by sinks that only render on a `\n` (e.g. the Ink sink,
   * which buffers a trailing partial line in `pending`): an unterminated prompt
   * written immediately before a blocking input read would otherwise never show.
   * Optional so legacy stdout sinks and test sinks (which write through directly)
   * need no implementation — callers invoke it as `out.flush?.()`.
   */
  flush?(): void;
  /**
   * OPTIONAL: open an EPHEMERAL FRAME. Between `beginFrame()` and `endFrame()`,
   * `write()` accumulates into a frame buffer that `endFrame()` flushes as a SINGLE
   * REPLACE of a bounded live region (NOT an append). Used for transient,
   * fully-redrawn-every-iteration chrome such as the interactive MENU: instead of
   * committing ~30 fresh permanent lines per keypress (unbounded `<Static>` growth
   * → progressive lag), the menu repaints in place. No-op on sinks without a live
   * region (legacy stdout / test sinks → unchanged byte-for-byte). Callers invoke
   * as `out.beginFrame?.()` / `out.endFrame?.()`.
   */
  beginFrame?(): void;
  endFrame?(): void;
  /**
   * Promote the CURRENT live-frame region into the permanent transcript and clear
   * the live region. Called when the menu hands off to a sub-flow so the just-shown
   * menu lingers in scrollback above the sub-flow's output (legacy scrolling-TTY
   * parity). No-op on sinks without a live region. Invoked as `out.promoteFrame?.()`.
   */
  promoteFrame?(): void;
  /**
   * OPTIONAL (Elite-partner Phase 1): REPLACE the persistent goal board with a fresh
   * GoalStore snapshot, flipping the board ON (`enabled`). Only the Ink sink
   * implements it — it dispatches a `board/sync` action into the reducer store so
   * the board renders across turns; legacy stdout / test sinks have no live region
   * and leave it undefined (byte-for-byte unchanged). The menu invokes it as
   * `out.syncBoard?.(rows)` ONLY when the board flag is on, so when the flag is off
   * the action never fires and `UiState.boardEnabled` stays false.
   */
  syncBoard?(rows: readonly GoalBoardRow[]): void;
  /**
   * OPTIONAL (Phase 4C): REPLACE the capacity snapshot with a fresh observation
   * built from real menu-loop signals (provider env, cooldowns, session
   * consumption, subscriptions, pressure, shed plan). Only the Ink sink
   * implements it — it dispatches a `capacity/sync` action into the reducer store.
   * The menu invokes it as `out.syncCapacity?.(snapshot)` when real signals update.
   */
  syncCapacity?(capacity: UiCapacityState): void;
}

// ---------------------------------------------------------------------------
// Pure envelope / goal-marker stripping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// EnvelopeFilter — stateful streaming writer (pure aside from the injected sink)
// ---------------------------------------------------------------------------

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
export class EnvelopeFilter {
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

  /** DISCARD any held-back, not-yet-flushed tail WITHOUT emitting it. Used on a
   *  mid-stream CANCEL: a canceled answer is incomplete (the user hit ESC) and is
   *  neither persisted nor part of the conversation record, so the renderer must
   *  not flush the held-back trailing prose at the cancel `final`. Already-emitted
   *  bytes cannot be unwritten (live streaming is transient terminal output, like
   *  the spinner), but this guarantees the FINAL flush adds nothing on cancel —
   *  keeping the legacy path consistent with the Ink reducer, which drops the
   *  uncommitted live buffer on cancel. Idempotent. */
  discard(): void {
    this.flushed = this.full.length;
  }
}
