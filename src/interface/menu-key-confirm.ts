/**
 * src/interface/menu-key-confirm.ts
 *
 * Extracted from menu.ts — behavior-preserving.
 *
 * The single-keypress confirm + menu-key layer built on top of the raw-keypress
 * machinery in {@link './menu-readline.js'}: the {@link Confirm} contract, the
 * scoped mid-turn {@link attachChatTurnKeyListener} (bare-ESC interrupt), the
 * yes/no {@link confirmViaKey}, the {@link readMenuKey} single-key menu reader,
 * and the {@link makeConfirm} factory. The pure decision cores it depends on
 * (`parseYesNo` / `interpretYesNoKey`) live in menu-questions.ts.
 */

import readline from 'node:readline';
import type { OutputSink } from './render.js';
import {
  type KeyInputStream,
  readSingleKey,
  rawKeyInputs,
  normalizeMenuKey,
} from './menu-readline.js';
import { parseYesNo, interpretYesNoKey } from './menu-questions.js';

/** A yes/no confirm: resolves true for yes, false for no, honouring a default. */
export type Confirm = (
  defaultYes: boolean,
  opts?: { requireExplicit?: boolean },
) => Promise<boolean>;



/**
 * A keypress event object as emitted by `readline.emitKeypressEvents`. `name`
 * is the logical key (`'escape'`, `'up'`, …); `sequence` is the raw bytes. We
 * declare the slice we read so a fake can drive the listener without a real TTY.
 */
export interface KeypressEvent {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * Attach a SCOPED key listener for the duration of one streaming model turn.
 *
 * Semantics (chat-ux audit §"ESC Interrupt"): the only key it acts on is a bare
 * ESC, which calls `onEscape()` — "interrupt this turn and stay at the chat
 * prompt". It OBSERVES esc only; every printable byte, arrow/function-key escape
 * sequence, Enter, and Ctrl+C is left untouched so line buffering stays owned by
 * readline (no double-submit / stolen-byte class of bug).
 *
 * 3.12.x coexistence — this is a deliberately narrow, non-destructive listener:
 *   - It uses ONLY the given `stdin` (default `process.stdin`); it never reaches
 *     for `/dev/tty` (a second mid-turn reader would violate the single-owner rule).
 *   - It NEVER calls `removeAllListeners`, never `stdin.read()`, never `suspend()`/
 *     `resume()`. It adds exactly one `keypress` listener and removes only that
 *     listener on detach.
 *   - It records `wasRaw`; if raw mode was not already on it enables it for the
 *     turn and restores the prior state on detach. In normal terminal-readline
 *     mode raw is already on, so this is a no-op and ownership stays with readline.
 *   - Off-TTY (no `out.isTty` / `stdin.isTTY` / `setRawMode`) it returns a no-op
 *     detach immediately, so normal line input keeps working unchanged. Mid-turn
 *     interruption is then covered by Ctrl+C / direct helper tests.
 *
 * Returns a detach function; wrap the turn in `try/finally` so detach always runs.
 *
 * @param out     - Output sink (used only for the TTY capability check).
 * @param stdin   - The key stream (injectable for tests; default `process.stdin`).
 * @param onEscape - Invoked once per bare-ESC press while attached.
 */
export function attachChatTurnKeyListener(
  out: OutputSink,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
  onEscape: () => void = (): void => {},
  onEdit: () => void = (): void => {},
): () => void {
  // Degrade cleanly off-TTY: no raw keypresses available → no-op detach. Normal
  // line input (and Ctrl+C) keep working; ESC simply isn't observed.
  if (!out.isTty || stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') {
    return (): void => {};
  }

  // Make readline-style keypress events flow from this stream. Idempotent — safe
  // to call alongside the live readline interface, which already enables them.
  try {
    readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadableStream);
  } catch {
    // If keypress events can't be enabled, fall back to a no-op rather than a
    // raw 'data' parser (which could steal/duplicate bytes from readline).
    return (): void => {};
  }

  const wasRaw = stdin.isRaw === true;
  try {
    if (!wasRaw) stdin.setRawMode(true);
  } catch {
    // Raw mode unavailable → don't risk a half-attached listener; no-op.
    return (): void => {};
  }

  const handler = (str: string | undefined, key: KeypressEvent | undefined): void => {
    // Observe ONLY a bare ESC. A bare ESC arrives as name 'escape' with sequence
    // '\x1b'; arrow/function keys ('up', 'f1', …) carry a longer '\x1b[…' sequence
    // and must be ignored. interpretChatKey is the single classification truth.
    const seq = key?.sequence ?? str ?? '';
    const isBareEscape = key?.name === 'escape' && seq === '\x1b';
    if (isBareEscape) {
      onEscape();
      return;
    }
    setImmediate(onEdit);
  };

  stdin.on('keypress', handler as (...a: never[]) => void);

  let detached = false;
  return (): void => {
    if (detached) return;
    detached = true;
    // Remove ONLY our listener — never removeAllListeners (that destructive
    // pattern is safe only for the isolated readSingleKey prompt).
    stdin.removeListener('keypress', handler as (...a: never[]) => void);
    // Restore only the raw-mode state we changed. If readline already owned raw
    // mode, leave it; we never took ownership.
    if (!wasRaw) {
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      } catch {
        /* best-effort — never throw on mode restore */
      }
    }
  };
}

/**
 * Drive a single-key yes/no confirm on a TTY: Enter accepts the default, `y`/`n`
 * decide immediately (no Enter), any other key is ignored, and Ctrl-C/Ctrl-D
 * re-raise SIGINT to exit. The chosen letter is echoed (raw mode suppresses the
 * terminal's own echo). Rejects if the raw read is unavailable so the caller can
 * fall back to line mode.
 *
 * When `requireExplicit` is set (strict / destructive prompts) there is no Enter
 * default — Enter and every key but y/n/Ctrl-C is ignored, so the user must
 * deliberately press `y` or `n`.
 *
 * `stdin` is injectable for testing; in production it is `process.stdin`.
 */
export async function confirmViaKey(
  out: OutputSink,
  defaultYes: boolean,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
  requireExplicit = false,
): Promise<boolean> {
  for (;;) {
    const key = await readSingleKey(stdin);
    const verdict = interpretYesNoKey(key, defaultYes, requireExplicit);
    if (verdict === 'ignore') continue;
    if (verdict === 'abort') {
      out.write('\n');
      // Honour Ctrl-C: re-raise SIGINT so the process exits as expected.
      process.kill(process.pid, 'SIGINT');
      return defaultYes;
    }
    const yes = verdict === 'yes';
    out.write((yes ? 'y' : 'n') + '\n');
    return yes;
  }
}

/**
 * Read the user's main-menu choice. On a real interactive TTY this resolves on a
 * SINGLE keypress — press `c`/`n`/`j`/a digit and it fires immediately, no Enter
 * (matching the muscle memory of session managers like DATA Tools). The pressed
 * key is echoed (raw mode suppresses the terminal's own echo). Falls back to a
 * full line read when stdin isn't a raw-capable TTY (pipes, tests), so scripted
 * input keeps working exactly as before.
 *
 * Returns:
 *   - the chosen key (a single lower-cased char) to act on,
 *   - `''` for Enter / arrow keys / other no-ops (caller just re-renders),
 *   - `null` for Ctrl-C / Ctrl-D / EOF (caller exits).
 *
 * `stdin` is injectable for testing.
 */
export async function readMenuKey(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
): Promise<string | null> {
  const inputs = rawKeyInputs(out, stdin);
  if (inputs.length === 0) return normalizeMenuKey(await readLine());
  for (const input of inputs) {
    try {
      const raw = await readSingleKey(input);
      if (raw === '\x03' || raw === '\x04') return null; // Ctrl-C / Ctrl-D → exit
      if (raw === '\r' || raw === '\n') return ''; // bare Enter → no-op (re-render)
      // Only a single printable char is a menu choice; ignore escape sequences
      // (arrow keys arrive as multi-byte '\x1b[A' and must not echo or match).
      if (raw.length === 1 && raw >= ' ') {
        const choice = raw.toLowerCase();
        out.write(choice + '\n'); // echo — raw mode suppressed the terminal's echo
        return choice;
      }
      return '';
    } catch {
      // Try the next raw-capable stream, then fall back to a normalized line.
    }
  }
  return normalizeMenuKey(await readLine());
}

/**
 * Build the {@link Confirm} used for yes/no prompts.
 *
 *   - `injected` (tests) wins.
 *   - On a real interactive TTY → single-key reader (Enter = default, y/n decide
 *     instantly, other keys ignored) with a line-mode fallback if it ever fails.
 *   - Otherwise (piped input / tests / no setRawMode) → line read + parseYesNo,
 *     so EOF and scripted `y`/`n`/blank lines keep working exactly as before.
 */
export function makeConfirm(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  injected?: Confirm,
): Confirm {
  if (injected !== undefined) return injected;

  return async (defaultYes: boolean, opts?: { requireExplicit?: boolean }): Promise<boolean> => {
    const requireExplicit = opts?.requireExplicit ?? false;
    for (const input of rawKeyInputs(out)) {
      try {
        return await confirmViaKey(out, defaultYes, input, requireExplicit);
      } catch {
        // Any raw-mode hiccup must never break onboarding — try the fallback TTY,
        // then fall back to a line.
      }
    }
    return parseYesNo(normalizeMenuKey(await readLine()), defaultYes, requireExplicit);
  };
}
