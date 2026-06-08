/**
 * src/interface/ui/mount.tsx — the Node-side mount path for the Ink chat UI
 * (Step 1, behind the default-OFF MYSHELL_INK flag).
 *
 * Owns three concerns kept OUT of the React tree so the pure App stays testable:
 *   1. the width-backfill bootstrap (headless/odd PTYs report columns===0, which
 *      makes Ink wrap everything to one column — MANDATORY before render());
 *   2. the {@link OutputSink} adapter that pushes committed transcript lines into
 *      the App via the {@link InkAppBridge};
 *   3. {@link createInkLineReader}, a {@link LineReader}-shaped adapter whose
 *      `nextLine()` resolves with the App's submitted input. The suspend/resume/
 *      capture/drain semantics are minimal stubs in Step 1 — full child-handoff
 *      and typed-ahead capture land in Step 2.
 *
 * Nothing here runs unless `inkEnabled(...)` is true, and that is wired behind a
 * dynamic import at the menu launch site so the default (flag-off) path pays no
 * startup cost.
 */

import React from 'react';
import { render } from 'ink';
import type { OutputSink } from '../stream-filter.js';
import type { LineReader, KeyInputStream } from '../menu-readline.js';
import { App, createInkAppBridge, type InkAppBridge } from './App.js';

// ---------------------------------------------------------------------------
// 1. Width-backfill bootstrap
// ---------------------------------------------------------------------------

/**
 * Backfill `process.stdout.columns`/`rows` when a headless/odd PTY reports a
 * width < 2 (commonly 0 under `script`/CI), which would make Ink wrap every line
 * to a single column. Prefer the `COLUMNS`/`LINES` env, else default to 80×24.
 * Idempotent and side-effect-scoped to the stdout dimensions; never throws.
 *
 * Exported so the PTY smoke + tests can assert the backfill independently of a
 * real render().
 */
export function backfillTerminalSize(
  stream: { columns?: number; rows?: number } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const envCols = Number.parseInt(env['COLUMNS'] ?? '', 10);
    const envRows = Number.parseInt(env['LINES'] ?? '', 10);
    if (!(typeof stream.columns === 'number' && stream.columns >= 2)) {
      stream.columns = Number.isFinite(envCols) && envCols >= 2 ? envCols : 80;
    }
    if (!(typeof stream.rows === 'number' && stream.rows >= 2)) {
      stream.rows = Number.isFinite(envRows) && envRows >= 2 ? envRows : 24;
    }
  } catch {
    /* dimensions are best-effort; never block the mount */
  }
}

// ---------------------------------------------------------------------------
// 2. OutputSink adapter
// ---------------------------------------------------------------------------

/**
 * An {@link OutputSink} whose `write(s)` commits transcript lines into the Ink
 * App via the bridge. Writes are split on newlines so each committed line is a
 * separate `<Static>` item; a trailing partial line (no newline yet) is buffered
 * and flushed when its newline arrives. `color`/`isTty` mirror the real stdout.
 */
export function createInkOutputSink(
  bridge: InkAppBridge,
  opts: { readonly color: boolean; readonly isTty: boolean },
): OutputSink {
  let pending = '';
  return {
    write(s: string): void {
      pending += s;
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        bridge.commit(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
    },
    get color(): boolean {
      return opts.color;
    },
    get isTty(): boolean {
      return opts.isTty;
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Ink-backed LineReader
// ---------------------------------------------------------------------------

/**
 * Build a {@link LineReader} whose `nextLine()` resolves with the next line the
 * user submits in the Ink input box. Submitted lines that arrive before they are
 * awaited are buffered (FIFO), mirroring {@link createLineReader}'s pipe-drain
 * fix.
 *
 * Step 1 implements only `nextLine()` + buffering + `close()`. The remaining
 * LineReader methods are type-complete minimal stubs — full suspend/resume
 * child-handoff and mid-turn typed-ahead capture/queue semantics come in Step 2.
 */
export function createInkLineReader(bridge: InkAppBridge): LineReader {
  const buffered: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;

  bridge.onSubmit((line: string) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else buffered.push(line);
  });

  return {
    nextLine(): Promise<string | null> {
      if (buffered.length > 0) {
        const next = buffered.shift();
        return Promise.resolve(next ?? null);
      }
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    // TODO(step 2): release stdin so an inherited-stdio child owns the TTY —
    // drive Ink's OWN setRawMode(false), not process.stdin's.
    suspend(): void {
      /* TODO(step 2) */
    },
    // TODO(step 2): re-arm Ink's raw input after a child handoff.
    resume(): void {
      /* TODO(step 2) */
    },
    close(): void {
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(null);
      }
    },
    // TODO(step 2): route mid-turn typed-ahead lines to `onLine` instead of the
    // nextLine() buffer/waiters (exclusive capture, blank lines dropped).
    beginCapture(_onLine: (line: string) => void): () => void {
      return () => {
        /* TODO(step 2) */
      };
    },
    // TODO(step 2): mirror the in-progress Ink input value for managed chrome.
    currentLine(): string {
      return '';
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

// ---------------------------------------------------------------------------
// Mount entry point
// ---------------------------------------------------------------------------

export interface InkMountHandle {
  readonly out: OutputSink;
  readonly reader: LineReader;
  /** Resolves when the Ink app unmounts (e.g. Ctrl-C / explicit unmount). */
  waitUntilExit(): Promise<void>;
  /** Tear down the Ink render and the LineReader. */
  unmount(): void;
}

export interface InkMountOptions {
  readonly color: boolean;
  readonly isTty: boolean;
  /**
   * Custom raw-input stream for Ink's `render(node, { stdin })`. Used for the
   * `/dev/tty` fallback when process.stdin isn't a usable raw TTY (see
   * menu-readline.ts `controllingTtyRawInput`). Optional in Step 1; fully wired
   * in Step 2.
   */
  readonly stdin?: KeyInputStream;
}

/**
 * Bootstrap + mount the Ink chat app. Backfills the terminal size FIRST (Ink
 * reads stdout dimensions at render time), then renders the App and returns the
 * OutputSink + LineReader adapters plus lifecycle handles for the menu loop.
 */
export function mountInk(opts: InkMountOptions): InkMountHandle {
  backfillTerminalSize();

  const bridge = createInkAppBridge();
  const out = createInkOutputSink(bridge, { color: opts.color, isTty: opts.isTty });
  const reader = createInkLineReader(bridge);

  const instance = render(<App bridge={bridge} />, {
    // Pass a custom stdin (e.g. the /dev/tty ReadStream) when supplied so Ink
    // reads raw input from the controlling terminal. `render` accepts a Node
    // ReadStream; the KeyInputStream slice is a structural superset for our use.
    ...(opts.stdin !== undefined
      ? { stdin: opts.stdin as unknown as NodeJS.ReadStream }
      : {}),
  });

  return {
    out,
    reader,
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
    unmount(): void {
      reader.close();
      instance.unmount();
    },
  };
}
