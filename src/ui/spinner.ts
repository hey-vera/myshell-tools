/**
 * src/ui/spinner.ts — Honest, indeterminate working indicator.
 *
 * Animates a braille-spinner frame while waiting for the first real output.
 * No percentages, no fake progress — purely a "working" indicator.
 * Frame cycling is deterministic (index-based); Math.random is never used.
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

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** A minimal working-indicator that can be started and stopped. */
export interface Spinner {
  /** Display the spinner with the given text. */
  start(text: string): void;
  /** Stop the spinner and clear the line (TTY) or do nothing (non-TTY). */
  stop(): void;
}

/**
 * Create a spinner bound to the given OutputSink.
 *
 * - When `out.isTty` is true: animates braille frames + text on the current
 *   line using `\r`, driven by `setInterval`.
 * - When `out.isTty` is false: prints the text once (static) and does nothing
 *   on stop — safe for CI / pipe output.
 */
export function createSpinner(out: OutputSink): Spinner {
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = false;

  /** Exposed for deterministic testing: advance one frame and write it. */
  function tick(text: string): void {
    frameIndex = (frameIndex + 1) % FRAMES.length;
    const frame = FRAMES[frameIndex] ?? FRAMES[0] ?? '⠋';
    out.write(`\r${frame} ${text}`);
  }

  return {
    start(text: string): void {
      if (active) return;
      active = true;

      if (out.isTty) {
        // Write the first frame immediately so there is no blank gap.
        const frame = FRAMES[frameIndex] ?? FRAMES[0] ?? '⠋';
        out.write(`\r${frame} ${text}`);

        timer = setInterval(() => {
          tick(text);
        }, FRAME_INTERVAL_MS);
      } else {
        // Non-TTY: print once, no animation.
        out.write(`${text}\n`);
      }
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
