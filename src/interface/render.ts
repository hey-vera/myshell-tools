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
import { bold, cyan, dim, green, red, yellow } from '../ui/theme.js';
import { createSpinner } from '../ui/spinner.js';
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
 * These are mutually exclusive per turn, but scanning for all is harmless and
 * future-proof.
 */
const CONTROL_ENVELOPE_KEYS = ['confidence', 'ask_user', 'verdict'] as const;

/**
 * The opening signatures a trailing control envelope can have: `{` then optional
 * whitespace then the quoted key. Used to decide whether a still-arriving trailing
 * `{…` fragment could BECOME a control envelope (and so must be held back) or is
 * just ordinary prose/code/JSON (and so should stream immediately).
 */
const CONTROL_ENVELOPE_OPENINGS = ['"confidence', '"ask_user', '"verdict'] as const;

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

// Trailing autonomous-goal control markers. These mirror core/goal.ts's
// COMPLETE_MARKER / CONTINUE_MARKER: the model writes one on its own line at the
// very END of a `/goal` turn to signal status. Like the confidence envelope, it's
// a control token, not prose — so it must never leak into the visible transcript.
const GOAL_MARKER_TOKENS = ['GOAL_COMPLETE', 'GOAL_CONTINUE'] as const;

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

  // NOTE: a plain field assignment, NOT a constructor parameter property
  // (`constructor(private out)`) — the test runner strips types in strip-only
  // mode, which rejects parameter properties even though tsc accepts them.
  constructor(out: OutputSink) {
    this.out = out;
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
      this.out.write(this.full.slice(this.flushed, safeUpto));
      this.flushed = safeUpto;
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
    // Also cut a confirmed trailing goal-control marker line. We only strip it when
    // the last line is genuinely a GOAL_COMPLETE / GOAL_CONTINUE marker (the regex
    // requires the full token), so a non-marker prefix that was briefly held back is
    // released here as normal prose.
    const goalStart = trailingGoalMarkerStart(this.full);
    if (goalStart !== -1 && goalStart < cutEnd) {
      const lastLine = this.full.slice(this.full.lastIndexOf('\n', cutEnd - 1) + 1, cutEnd).trim();
      if (/^GOAL_(COMPLETE|CONTINUE)\b/.test(lastLine)) {
        cutEnd = goalStart;
      }
    }
    if (cutEnd > this.flushed) {
      // Trim trailing whitespace AND a dangling ```json/``` fence-opener that the
      // model put just before the (now-removed) envelope, so no orphan fence leaks.
      const tail = this.full
        .slice(this.flushed, cutEnd)
        .replace(/\s+$/, '')
        .replace(/(?:^|\n)[ \t]*```[a-zA-Z0-9]*[ \t]*$/, '')
        .replace(/\s+$/, '');
      if (tail.length > 0) this.out.write(tail);
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
 */
export async function renderStream(
  events: AsyncIterable<CoreEvent>,
  out: OutputSink,
  verbosity: Verbosity = 'normal',
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

  // Buffers model prose and strips the trailing confidence envelope before it
  // can ever reach the user.
  let prose = new EnvelopeFilter(out);

  // Spinner is only used in TTY mode. It starts at tier-start and STAYS alive
  // through tool/reasoning activity (showing a live step count + elapsed time) so
  // a long, tool-heavy run never looks frozen. It stops only when real answer
  // prose begins streaming, or when the tier finishes/errors.
  const spinner = createSpinner(out);
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

  /** Compose the live indicator label: work verb, step count, and the streamed
   *  token estimate when any prose has arrived. */
  function spinnerLabel(): string {
    const steps = `${stepCount} step${stepCount === 1 ? '' : 's'}`;
    if (streamedChars > 0) {
      const approxTok = formatTokens(Math.ceil(streamedChars / 4));
      return `${workLabel}… ${steps} · ↓ ~${approxTok} tokens`;
    }
    return `${workLabel}… ${steps}`;
  }

  function stopSpinner(): void {
    if (spinnerActive) {
      spinner.stop();
      spinnerActive = false;
    }
  }

  /** Ensure the live indicator is on and showing the current label. Restarts it
   *  if it was stopped when answer prose began — so a tool/reasoning phase that
   *  runs AFTER an answer doesn't leave a dead, frozen-looking line. */
  function ensureAlive(): void {
    if (!out.isTty) return;
    if (!spinnerActive) {
      // resume(), not start(): a tier that streamed an answer and then runs more
      // tools keeps ONE continuous elapsed count instead of restarting at 0s.
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

      case 'tier-start': {
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
        workLabel = isVerbose ? `${ev.tier} (${ev.provider}/${ev.model})` : 'Thinking';
        if (out.isTty) {
          spinner.start(`${workLabel}…`);
          spinnerActive = true;
        }
        break;
      }

      case 'provider-event': {
        const pe = ev.event;
        if (pe.type === 'text') {
          // First real answer prose — clear the indicator and start streaming.
          stopSpinner();
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
        stopSpinner();
        prose.finishAttempt();
        prose = new EnvelopeFilter(out);
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
        // Clear the live indicator before printing a notice so it isn't clobbered.
        if (ev.level === 'error' || isVerbose) stopSpinner();
        // Errors are ALWAYS shown (every verbosity). Info/warn are chrome and
        // only surface in verbose mode.
        if (ev.level === 'error') {
          out.write(`${red('[error]', c)} ${ev.message}\n`);
        } else if (isVerbose) {
          const prefix = ev.level === 'warn' ? yellow('[warn]', c) : dim('[info]', c);
          out.write(`${prefix} ${ev.message}\n`);
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
            out.write(`\n${dim('■ Cancelled', c)}\n`);
          }
          break;
        }

        if (!ev.success) {
          // Surface an ACTIONABLE error in every verbosity mode: the bare
          // category message plus the suggestion from formatErrorMessage().
          if (ev.errorCategory !== undefined) {
            const cliErr = cliErrorForCategory(ev.errorCategory);
            if (cliErr !== null) {
              out.write(`\n${red(formatErrorMessage(cliErr, ev.provider), c)}\n`);
            }
          }
          if (!isQuiet) {
            out.write(
              `\n${bold(red('Failed', c), c)} — ` +
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

        // Success: a single minimal completion line in normal/verbose; nothing
        // in quiet.
        if (isVerbose) {
          out.write(
            `\n${bold(green('Success', c), c)} — ` +
            `tier: ${ev.tier}, ` +
            `${formatTokens(runningTokens)} tokens, ` +
            `attempts: ${ev.attempts}, ` +
            `session: ${ev.sessionId}\n`,
          );
        } else if (!isQuiet) {
          out.write(`\n${dim(`✓ done (${formatTokens(runningTokens)} tokens)`, c)}\n`);
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
