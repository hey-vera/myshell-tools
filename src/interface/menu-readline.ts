/**
 * src/interface/menu-readline.ts
 *
 * Extracted from menu.ts — behavior-preserving.
 *
 * The line-reader + raw-keypress machinery for the interactive menu: the
 * event-driven {@link LineReader} (buffered, suspend/resume, mid-turn capture),
 * the narrow {@link KeyInputStream} stdin slice, the single-raw-keypress reader
 * {@link readSingleKey}, and the TTY-capability helpers. This module owns the
 * file's only module-level mutable (`controllingTtyInput`, the cached /dev/tty
 * fallback stream) together with its three consumers.
 */

import readline from 'node:readline';
import fs from 'node:fs';
import tty from 'node:tty';
import type { OutputSink } from './render.js';

/**
 * An event-driven line reader over a single readline interface.
 *
 * This is the proven-correct pattern (mirrors `repl.ts`): instead of a
 * per-prompt `rl.question()` — which (a) throws `ERR_USE_AFTER_CLOSE` if the
 * interface has already closed and (b) loses lines that `readline` eagerly
 * drains from a pipe before the first prompt is even written — we attach a
 * single `'line'` listener that buffers every line and a single `'close'`
 * listener that marks EOF.
 *
 * `nextLine()` returns the next buffered/awaited line, or `null` once the
 * stream is closed/EOF. It NEVER throws and returns `null` for every call after
 * close, so callers can treat `null` as a clean end-of-input sentinel.
 */
export interface LineReader {
  /** Resolve with the next line, or `null` on EOF (and for every call after). */
  nextLine(): Promise<string | null>;
  /**
   * Stop consuming `process.stdin` so an inherited-stdio child process (e.g.
   * `claude auth login`) becomes the SOLE reader of the terminal. Without this,
   * the readline interface and the child race for the same bytes and a pasted
   * value lands split/garbled on the child's prompt (the classic "first paste
   * fails, second works" bug). Idempotent.
   */
  suspend(): void;
  /** Resume consuming stdin after a {@link suspend}. Idempotent. */
  resume(): void;
  /** Close the underlying readline interface (idempotent). */
  close(): void;
  /**
   * Begin capturing lines typed DURING a model turn (typed-ahead queueing). While
   * a capture is active, every non-blank line goes to `onLine` instead of the
   * `nextLine()` buffer/waiters, so mid-turn input can NEVER leak into a later
   * question/auth/menu prompt or auto-answer an unseen selector. Returns a detach
   * function; call it (in a `finally`) when the turn settles.
   *
   * Exclusive: throwing if a capture is already active is a real-bug guard — two
   * concurrent owners of mid-turn input would be a logic error.
   */
  beginCapture(onLine: (line: string) => void): () => void;
  /** Current readline edit buffer. Used only to mirror mid-turn typeahead into
   * managed terminal chrome while readline remains the sole line parser. */
  currentLine(): string;
  /**
   * Remove and return any lines buffered by `nextLine()` (incidental stale input,
   * e.g. a stray Enter) so a selector or child handoff starts from a clean slate.
   */
  drainBuffered(): string[];
  /** Drop any buffered lines without returning them. */
  clearBuffered(): void;
}

export interface ReadlineEchoController {
  muted: boolean;
}

/**
 * Build a {@link LineReader} backed by a single `node:readline` interface.
 *
 * Lines that arrive before they are awaited are buffered (fixing the eager
 * pipe-drain line loss); awaiters that arrive before a line block on a queued
 * resolver. On `close`, every pending and future awaiter resolves to `null`.
 */
export function createLineReader(
  rl: readline.Interface,
  input: KeyInputStream = process.stdin as unknown as KeyInputStream,
  echo?: ReadlineEchoController,
): LineReader {
  // Lines received but not yet consumed by a nextLine() caller.
  const buffered: string[] = [];
  // nextLine() callers waiting for a line that hasn't arrived yet.
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;
  let suppressEmptyUntil = 0;
  let suppressGeneration = 0;
  // When non-null, a model turn is active and full lines typed mid-turn are
  // routed here (typed-ahead capture) instead of the nextLine() buffer/waiters.
  // This keeps mid-turn input out of question/auth/menu prompts entirely.
  let capture: ((line: string) => void) | null = null;

  rl.on('line', (raw: string) => {
    const line = raw.trim();
    if (line === '' && Date.now() <= suppressEmptyUntil) {
      // Some inherited-stdio CLIs leave the submit Enter queued as they exit.
      // Drop only that immediate blank line so the next prompt is not auto-answered.
      // The blank-line suppression intentionally wins over capture: a leftover
      // submit Enter must never be queued as a typed-ahead turn.
      suppressEmptyUntil = 0;
      suppressGeneration += 1;
      return;
    }
    suppressEmptyUntil = 0;
    suppressGeneration += 1;
    if (capture !== null) {
      // Mid-turn typed-ahead. Blank lines are dropped (a bare Enter is not a
      // queued turn); non-blank lines go to the capture sink, never to the
      // buffer/waiters. This is the single line-mode owner — no second
      // stdin.on('data') consumer is added.
      if (line !== '') capture(line);
      return;
    }
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      buffered.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    // Drain every pending awaiter with the EOF sentinel.
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(null);
    }
  });

  return {
    nextLine(): Promise<string | null> {
      // Deliver any buffered line first (FIFO).
      if (buffered.length > 0) {
        const next = buffered.shift();
        return Promise.resolve(next ?? null);
      }
      // Once closed with nothing buffered, every call yields EOF — never throws.
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    suspend(): void {
      // Pause readline AND hand the raw TTY back to cooked mode + stop Node
      // reading, so an inherited-stdio child owns stdin alone. Best-effort:
      // every step is guarded so a non-TTY / test stream never throws.
      try {
        rl.pause();
      } catch {
        /* readline may already be paused/closed */
      }
      try {
        if (input.isTTY === true && typeof input.setRawMode === 'function') input.setRawMode(false);
      } catch {
        /* setRawMode unsupported on this platform */
      }
      // Drop any line we'd already buffered (e.g. a stray Enter) so it can't bleed
      // into the next prompt after the child exits.
      buffered.length = 0;
      // NOTE: we deliberately do NOT call stdin.read() to "drain" here. On a TTY,
      // read() can leave a pending libuv read on fd0 that competes with the
      // inherited child — siphoning off the first chunk of a paste so it reaches
      // the child split/truncated (seen as claude's "Invalid code" / a paste
      // landing in the wrong spot in its TUI). Just pause; the child owns fd0.
      try {
        input.pause();
      } catch {
        /* already paused */
      }
    },
    resume(): void {
      // Take stdin back after an inherited-stdio child (e.g. `claude auth login`)
      // owned the terminal. Two things must happen, or the NEXT prompt "dead-
      // pauses": it's written but the reader doesn't wake until the user presses
      // Enter to nudge the stream.
      //
      // 1. Drop any line the child left buffered — typically the trailing Enter
      //    the user pressed to submit a pasted code — so it can't bleed into or
      //    desync the next prompt.
      buffered.length = 0;
      if (input.isTTY === true) {
        suppressEmptyUntil = Date.now() + 250;
        const generation = suppressGeneration;
        setTimeout(() => {
          if (suppressGeneration === generation) {
            suppressEmptyUntil = 0;
            buffered.length = 0;
          }
        }, 250).unref?.();
      }
      // 2. Re-PRIME the TTY. A bare `input.resume()` is not enough: after a child
      //    held fd0, the tty read handle is left dormant and the next keypress
      //    won't emit 'data' until Enter kicks it. Cycling raw mode off→on forces
      //    libuv to re-arm the read handle. This also restores the raw mode a
      //    `terminal: true` readline needs for line editing (suspend() set cooked).
      try {
        if (input.isTTY === true && typeof input.setRawMode === 'function') {
          input.setRawMode(false);
          input.setRawMode(true);
        }
      } catch {
        /* setRawMode unsupported on this platform */
      }
      try {
        input.resume();
      } catch {
        /* already flowing */
      }
      try {
        rl.resume();
      } catch {
        /* readline may be closed */
      }
    },
    close(): void {
      rl.close();
    },
    beginCapture(onLine: (line: string) => void): () => void {
      // Exclusive: a second concurrent capture owner would be a real bug (two
      // turns claiming mid-turn input at once). Throw rather than silently steal.
      if (capture !== null) {
        throw new Error('createLineReader: capture already active');
      }
      capture = onLine;
      if (echo !== undefined) echo.muted = true;
      let detached = false;
      return (): void => {
        if (detached) return;
        detached = true;
        // Only clear OUR capture — never another owner's (defensive against an
        // out-of-order detach).
        if (capture === onLine) capture = null;
        if (echo !== undefined) echo.muted = false;
      };
    },
    currentLine(): string {
      const line = (rl as readline.Interface & { line?: unknown }).line;
      return typeof line === 'string' ? line : '';
    },
    drainBuffered(): string[] {
      const drained = buffered.slice();
      buffered.length = 0;
      return drained;
    },
    clearBuffered(): void {
      buffered.length = 0;
    },
  };
}

/**
 * The slice of `process.stdin` the single-key reader touches. Declaring it as a
 * narrow interface (rather than `NodeJS.ReadStream`) lets tests inject a fake
 * stream and verify the listener detach/restore + raw-mode toggling without a
 * real TTY.
 */
export interface KeyInputStream {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  pause(): void;
  resume(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners(event: string): unknown;
  listeners(event: string): Array<(...args: never[]) => void>;
}

let controllingTtyInput: KeyInputStream | null | undefined;

function canReadRawKey(out: OutputSink, stdin: KeyInputStream): boolean {
  return out.isTty && stdin.isTTY === true && typeof stdin.setRawMode === 'function';
}

function controllingTtyRawInput(out: OutputSink): KeyInputStream | null {
  if (!out.isTty || process.platform === 'win32') return null;
  if (controllingTtyInput !== undefined) return controllingTtyInput;
  try {
    const fd = fs.openSync('/dev/tty', 'r');
    controllingTtyInput = new tty.ReadStream(fd) as unknown as KeyInputStream;
  } catch {
    controllingTtyInput = null;
  }
  return controllingTtyInput;
}

export function resolveRawKeyInput(
  out: OutputSink,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
): KeyInputStream | null {
  if (!out.isTty) return null;
  if (canReadRawKey(out, stdin)) return stdin;
  const fallback = controllingTtyRawInput(out);
  return fallback !== null && canReadRawKey(out, fallback) ? fallback : null;
}

export function rawKeyInputs(
  out: OutputSink,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
): KeyInputStream[] {
  const input = resolveRawKeyInput(out, stdin);
  return input === null ? [] : [input];
}

export function __resetControllingTtyRawInputForTest(): void {
  controllingTtyInput = undefined;
}

export function normalizeMenuKey(input: string | null): string | null {
  if (input === null) return null;
  return input.trim().toLowerCase();
}

/**
 * Read exactly one raw keypress from the TTY.
 *
 * The live `node:readline` interface is briefly detached (its `data`/`keypress`
 * listeners are removed and restored afterwards) so the byte isn't ALSO consumed
 * as line input or echoed. The previous raw-mode flag is always restored. On any
 * failure the promise rejects so the caller can fall back to line mode.
 *
 * `stdin` is injectable for testing; in production it is `process.stdin`.
 */
export function readSingleKey(
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const prevData = stdin.listeners('data');
    const prevKeypress = stdin.listeners('keypress');
    const wasRaw = stdin.isRaw === true;
    let settled = false;

    const onData = (buf: Buffer): void => {
      restore();
      resolve(buf.toString('utf8'));
    };
    const onClose = (): void => {
      restore();
      reject(new Error('stdin closed while waiting for a keypress'));
    };
    const onError = (err: Error): void => {
      restore();
      reject(err);
    };

    function restore(): void {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData as (...a: never[]) => void);
      stdin.removeListener('end', onClose as (...a: never[]) => void);
      stdin.removeListener('close', onClose as (...a: never[]) => void);
      stdin.removeListener('error', onError as (...a: never[]) => void);
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
      } catch {
        /* best-effort — never throw on mode restore */
      }
      for (const l of prevData) stdin.on('data', l);
      for (const l of prevKeypress) stdin.on('keypress', l);
    }

    try {
      // Detach readline's grip for the duration of this single read.
      stdin.removeAllListeners('data');
      stdin.removeAllListeners('keypress');
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData as (...a: never[]) => void);
      stdin.on('end', onClose as (...a: never[]) => void);
      stdin.on('close', onClose as (...a: never[]) => void);
      stdin.on('error', onError as (...a: never[]) => void);
    } catch (err) {
      restore();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
