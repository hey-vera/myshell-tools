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
import type { CliError, ErrorCategory } from '../providers/errors.js';
import { classifyError, formatErrorMessage } from '../providers/errors.js';
import { lastJsonObjectBoundsWithKey } from '../core/json-envelope.js';
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
 * A streaming writer that holds back any trailing fragment of model prose that
 * could be the start of the confidence envelope, then strips the envelope at
 * the terminal event.
 *
 * The envelope is a trailing `{ … }` JSON object containing `"confidence"`. It
 * arrives at the very end of the `text` delta stream and may be split across
 * the last few deltas. To avoid leaking a half-arrived envelope, we hold back
 * only the trailing OPEN-brace fragment (a `{…` whose `}` hasn't arrived yet);
 * a balanced `{…}` with text after it is inline content and streams normally.
 * At the terminal event we run the brace-aware `lastJsonObjectBoundsWithKey`
 * scanner (the same one history.ts uses) to excise a genuine trailing envelope
 * before flushing the remainder.
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
    //   (b) the start of an already-complete trailing confidence envelope
    //       (balanced `{…confidence…}` with only whitespace after) — flushing
    //       it would leak the envelope before the terminal flush() can strip it.
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
    const open = trailingOpenBraceIndex(this.full);
    if (open !== -1 && open < boundary) boundary = open;
    const match = lastJsonObjectBoundsWithKey(this.full, 'confidence');
    if (
      match !== null &&
      this.full.slice(match.end).trim().length === 0 &&
      match.start < boundary
    ) {
      boundary = match.start;
    }
    return boundary;
  }

  /** Flush any held-back tail, excising ONLY a confirmed trailing confidence
   *  envelope first. Idempotent.
   *
   *  Unlike the streaming boundary, at the terminal event we know no more text
   *  is coming, so a trailing OPEN `{` that is NOT a confidence envelope is just
   *  legitimate prose (e.g. "the set {1, 2") and must be shown — we only cut a
   *  genuine, complete, trailing `{…confidence…}` block. */
  flush(): void {
    if (this.flushed >= this.full.length) return;
    const match = lastJsonObjectBoundsWithKey(this.full, 'confidence');
    let cutEnd = this.full.length;
    if (match !== null && this.full.slice(match.end).trim().length === 0) {
      cutEnd = match.start;
    }
    if (cutEnd > this.flushed) {
      // Trim trailing whitespace left by the (now-removed) envelope.
      const tail = this.full.slice(this.flushed, cutEnd).replace(/\s+$/, '');
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
): Promise<{ success: boolean; final?: Extract<CoreEvent, { type: 'final' }> }> {
  const c = out.color;
  const isVerbose = verbosity === 'verbose';
  const isQuiet = verbosity === 'quiet';

  let finalEvent: Extract<CoreEvent, { type: 'final' }> | undefined;
  // Accumulate REAL tokens across tiers so the final summary shows a measured
  // total instead of an estimated dollar figure (subscription tool, not API).
  let runningTokens = 0;

  // Buffers model prose and strips the trailing confidence envelope before it
  // can ever reach the user.
  const prose = new EnvelopeFilter(out);

  // Spinner is only used in TTY mode; we create one per tier-start and stop it
  // when the first real output arrives or when tier-done fires.
  const spinner = createSpinner(out);
  let spinnerActive = false;

  function stopSpinner(): void {
    if (spinnerActive) {
      spinner.stop();
      spinnerActive = false;
    }
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
        // Start spinner while waiting for the first provider output.
        if (out.isTty) {
          spinner.start(`${ev.tier} (${ev.provider}/${ev.model}) working…`);
          spinnerActive = true;
        }
        break;
      }

      case 'provider-event': {
        const pe = ev.event;
        if (pe.type === 'text') {
          // First real output — clear the spinner line.
          stopSpinner();
          // Stream prose, holding back any trailing envelope fragment.
          prose.push(pe.delta);
        } else if (pe.type === 'tool') {
          stopSpinner();
          // Tool activity is control-plane noise — only in verbose mode.
          if (isVerbose) {
            out.write(dim(`[tool] ${pe.name} ${pe.phase}`, c) + `\n`);
          }
        } else if (pe.type === 'reasoning') {
          stopSpinner();
          // Reasoning deltas are internal — only in verbose mode.
          if (isVerbose) {
            out.write(dim(pe.delta, c));
          }
        }
        // 'usage', 'done', 'error' are handled via tier-done / final
        break;
      }

      case 'tier-done': {
        stopSpinner();
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

  if (finalEvent !== undefined) {
    return { success: finalEvent.success, final: finalEvent };
  }
  return { success: false };
}
