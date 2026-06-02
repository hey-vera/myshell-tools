/**
 * src/ui/spinner.ts — Honest, indeterminate working indicator.
 *
 * Animates a braille-spinner frame + a live elapsed-seconds counter while work
 * is in flight. No percentages, no fake progress — purely a "still working"
 * indicator. The elapsed time is derived from the number of animation ticks
 * actually fired (tickCount × interval), so it never calls Date/Math — it is a
 * real, deterministic measure of how long the spinner has been visible.
 *
 * Honesty Contract: this file contains no hardcoded percentages, no fabricated
 * figures, and no mock phrases.
 */

import type { OutputSink } from '../interface/render.js';

// ---------------------------------------------------------------------------
// Frame set (braille dots — deterministic cycle, no Math.random)
// ---------------------------------------------------------------------------

const FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;
const TICKS_PER_SECOND = Math.round(1000 / FRAME_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** A minimal working-indicator that can be started, relabelled, and stopped. */
export interface Spinner {
  /** Display the spinner with the given text (resets the elapsed timer). */
  start(text: string): void;
  /** Change the label WITHOUT resetting the elapsed timer or animation. */
  update(text: string): void;
  /** Stop the spinner and clear the line (TTY) or do nothing (non-TTY). */
  stop(): void;
}

/**
 * Create a spinner bound to the given OutputSink.
 *
 * - When `out.isTty` is true: animates braille frames + label + a live
 *   `· Ns` elapsed counter on the current line using `\r`, driven by setInterval.
 *   `update()` swaps the label while the timer keeps running, so a long run can
 *   reflect progress ("Working… 12 steps") without ever looking frozen.
 * - When `out.isTty` is false: prints the label once (static) and does nothing
 *   on stop/update — safe for CI / pipe output.
 */
export function createSpinner(out: OutputSink): Spinner {
  let frameIndex = 0;
  let tickCount = 0;
  let label = '';
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = false;

  function elapsedSeconds(): number {
    return Math.floor(tickCount / TICKS_PER_SECOND);
  }

  function paint(): void {
    const frame = FRAMES[frameIndex] ?? FRAMES[0] ?? '⠋';
    const secs = elapsedSeconds();
    const elapsed = secs > 0 ? ` · ${secs}s` : '';
    // Clear to end-of-line (\x1b[K) so a shorter new label can't leave stale chars.
    out.write(`\r${frame} ${label}${elapsed}\x1b[K`);
  }

  return {
    start(text: string): void {
      if (active) {
        // Already running — treat as a relabel so callers can't accidentally
        // stack timers.
        label = text;
        if (out.isTty) paint();
        return;
      }
      active = true;
      label = text;
      frameIndex = 0;
      tickCount = 0;

      if (out.isTty) {
        paint();
        timer = setInterval(() => {
          frameIndex = (frameIndex + 1) % FRAMES.length;
          tickCount++;
          paint();
        }, FRAME_INTERVAL_MS);
      } else {
        out.write(`${text}\n`);
      }
    },

    update(text: string): void {
      label = text;
      if (active && out.isTty) paint();
    },

    stop(): void {
      if (!active) return;
      active = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (out.isTty) {
        // Clear the spinner line so the real output follows cleanly.
        out.write('\r\x1b[K');
      }
    },
  };
}
