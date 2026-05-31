/**
 * src/interface/render.ts — Human-readable event stream renderer.
 *
 * Consumes the AsyncIterable<CoreEvent> produced by orchestrate() and writes
 * a clean, truthful transcript to an OutputSink. All displayed values come
 * directly from CoreEvent data — no fabricated metrics, no hardcoded strings.
 *
 * Honesty Contract: confidence is rendered as a computed percentage or the
 * literal word "unrated" when null. No digit-% literals appear in this file.
 */

import type { CoreEvent } from '../core/types.js';
import { bold, cyan, dim, green, red, yellow } from '../ui/theme.js';
import { createSpinner } from '../ui/spinner.js';

// ---------------------------------------------------------------------------
// OutputSink
// ---------------------------------------------------------------------------

export interface OutputSink {
  write(s: string): void;
  readonly color: boolean;
  readonly isTty: boolean;
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

// ---------------------------------------------------------------------------
// renderStream
// ---------------------------------------------------------------------------

/**
 * Iterate events from orchestrate() and write a human-readable, truthful
 * transcript to the OutputSink. Returns the success flag and the final event
 * once the stream is exhausted.
 */
export async function renderStream(
  events: AsyncIterable<CoreEvent>,
  out: OutputSink,
): Promise<{ success: boolean; final?: Extract<CoreEvent, { type: 'final' }> }> {
  const c = out.color;

  let finalEvent: Extract<CoreEvent, { type: 'final' }> | undefined;
  let runningUsd = 0;

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
        out.write(
          dim(`▶ ${ev.tier} (${ev.provider}/${ev.model})`, c) +
          `\n`,
        );
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
          // Stream the real model output verbatim.
          out.write(pe.delta);
        } else if (pe.type === 'tool') {
          stopSpinner();
          out.write(dim(`[tool] ${pe.name} ${pe.phase}`, c) + `\n`);
        } else if (pe.type === 'reasoning') {
          stopSpinner();
          out.write(dim(pe.delta, c));
        }
        // 'usage', 'done', 'error' are handled via tier-done / final
        break;
      }

      case 'tier-done': {
        stopSpinner();
        runningUsd += ev.costUsd;
        const confidenceStr = renderConfidence(ev.confidence, c);
        const costStr = `$${ev.costUsd.toFixed(4)}`;
        const runningStr = `$${runningUsd.toFixed(4)}`;
        const successMark = ev.success ? green('✓', c) : red('✗', c);
        out.write(
          `\n${successMark} ${bold('tier done', c)} — ` +
          `confidence: ${confidenceStr}, ` +
          `cost: ${costStr}, ` +
          `duration: ${ev.durationMs}ms  ·  session so far: ${runningStr}\n`,
        );
        break;
      }

      case 'escalate': {
        out.write(
          yellow(`↑ Escalating ${ev.from} → ${ev.to}: ${ev.reason}`, c) + `\n`,
        );
        break;
      }

      case 'failover': {
        out.write(
          yellow(`⇄ Failing over ${ev.from} → ${ev.to} (${ev.tier}): ${ev.reason}`, c) + `\n`,
        );
        break;
      }

      case 'notice': {
        const prefix =
          ev.level === 'error' ? red('[error]', c) :
          ev.level === 'warn'  ? yellow('[warn]', c) :
          dim('[info]', c);
        out.write(`${prefix} ${ev.message}\n`);
        break;
      }

      case 'final': {
        finalEvent = ev;
        const successLabel = ev.success
          ? bold(green('Success', c), c)
          : bold(red('Failed', c), c);
        const costStr = `$${ev.totalCostUsd.toFixed(4)}`;
        out.write(
          `\n${successLabel} — ` +
          `tier: ${ev.tier}, ` +
          `cost: ${costStr}, ` +
          `attempts: ${ev.attempts}, ` +
          `session: ${ev.sessionId}\n`,
        );
        break;
      }
    }
  }

  // Safety: ensure spinner is stopped if stream ended without a terminal event.
  stopSpinner();

  if (finalEvent !== undefined) {
    return { success: finalEvent.success, final: finalEvent };
  }
  return { success: false };
}
