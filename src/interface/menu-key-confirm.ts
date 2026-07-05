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

// ---------------------------------------------------------------------------
// Menu navigation stack (Slice 4): ESC exits the app from any menu/subflow;
// Left arrow pops one stack level from any non-root depth. Root only shows
// `ESC to exit`. The stack is a simple depth counter + sticky exit flag — no
// history list, no screen-id registry. depth starts at 1 (root).
// ---------------------------------------------------------------------------

/** Bare ESC — sentinel returned by {@link readMenuKey} signalling exit intent. */
export const NAV_ESC = '\x1b';
/** Left-arrow sequence — sentinel returned by {@link readMenuKey} signalling
 *  "pop one nav level" intent (a no-op at the root depth). */
export const NAV_LEFT = '\x1b[D';

export interface MenuStack {
  readonly depth: number;
  push(): void;
  pop(): void;
  requestExit(): void;
  readonly exitRequested: boolean;
}

export function createMenuStack(): MenuStack {
  let depth = 1;
  let exitRequested = false;
  return {
    get depth(): number { return depth; },
    push(): void { depth += 1; },
    pop(): void { if (depth > 1) depth -= 1; },
    requestExit(): void { exitRequested = true; },
    get exitRequested(): boolean { return exitRequested; },
  };
}

let menuStack: MenuStack = createMenuStack();

export function getMenuStack(): MenuStack { return menuStack; }
export function resetMenuStack(): void { menuStack = createMenuStack(); }

/**
 * Pure classification of one raw keypress (the legacy `readSingleKey`-shaped
 * string) into a menu-nav decision. The single source of truth shared by both
 * the Ink and legacy branches of {@link readMenuKey} so menu nav feels identical.
 *
 *   - `'\x03'` / `'\x04'`        → `null`  (Ctrl-C / Ctrl-D / EOF → exit)
 *   - `'\x1b'`   (bare ESC)      → {@link NAV_ESC}  (exit intent)
 *   - `'\x1b[D'` (left arrow)    → {@link NAV_LEFT} (pop one level)
 *   - `'\r'` / `'\n'` (Enter)    → `''`    (no-op re-render)
 *   - single printable char      → that char, lower-cased (the menu choice)
 *   - anything else (up/right/down arrows, Tab, escape blobs) → `''` (no-op)
 */
export function classifyMenuKey(raw: string): string | null {
  if (raw === '\x03' || raw === '\x04') return null;
  if (raw === NAV_ESC) return NAV_ESC;
  if (raw === NAV_LEFT) return NAV_LEFT;
  if (raw === '\r' || raw === '\n') return '';
  if (raw.length === 1 && raw >= ' ') return raw.toLowerCase();
  return '';
}



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
  // Surface any unterminated prompt (e.g. "Set as default? (y/N) ") before we
  // block on the keypress (no-op for legacy/test sinks without flush).
  out.flush?.();
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
 *   - {@link NAV_ESC} for a bare ESC (caller exits the app / cascades),
 *   - {@link NAV_LEFT} for the left-arrow (caller pops one nav level),
 *   - `''` for Enter / up-right-down arrows / other no-ops (caller re-renders),
 *   - `null` for Ctrl-C / Ctrl-D / EOF (caller exits).
 *
 * `stdin` is injectable for testing.
 */
export async function readMenuKey(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
  // When true, skip raw-keypress reads entirely and resolve the choice from a
  // full line read. Used by the Ink path ONLY when no single-key reader is wired
  // (the fallback). Default false → the legacy single-keypress path is byte-identical.
  forceLine = false,
  // Single-key reader for the Ink path. When provided, read ONE key through Ink's
  // own input pipeline (resolving a legacy-readSingleKey-shaped string) instead of
  // grabbing the raw TTY (which would fight Ink). The interpretation below is the
  // SAME as the legacy raw read, so menu nav feels identical. When absent, the
  // legacy path is unchanged (byte-identical).
  inkReadKey?: () => Promise<string>,
): Promise<string | null> {
  // Make any just-written, not-yet-newline-terminated prompt visible before we
  // block on a key (no-op for legacy/test sinks that lack flush).
  out.flush?.();
  if (inkReadKey !== undefined) {
    try {
      const raw = await inkReadKey();
      const verdict = classifyMenuKey(raw);
      if (verdict !== null && verdict !== '' && verdict !== NAV_ESC && verdict !== NAV_LEFT) {
        out.write(verdict + '\n'); // echo (Ink's editor was inactive for this read)
      }
      return verdict;
    } catch {
      // Any Ink read hiccup falls back to a full line read (type the letter + Enter).
      return normalizeMenuKey(await readLine());
    }
  }
  if (forceLine) return normalizeMenuKey(await readLine());
  const inputs = rawKeyInputs(out, stdin);
  if (inputs.length === 0) return normalizeMenuKey(await readLine());
  for (const input of inputs) {
    try {
      const raw = await readSingleKey(input);
      const verdict = classifyMenuKey(raw);
      if (verdict !== null && verdict !== '' && verdict !== NAV_ESC && verdict !== NAV_LEFT) {
        out.write(verdict + '\n'); // echo — raw mode suppressed the terminal's echo
      }
      return verdict;
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
  // When true, never do a single-key raw read — confirm from a full line read.
  // The Ink path passes this ONLY when no single-key reader is wired (the
  // fallback). Default false → legacy single-key confirm unchanged.
  forceLine = false,
  // Single-key reader for the Ink path. When provided, the confirm decides on a
  // SINGLE keypress read through Ink's own input pipeline (y/n decide instantly,
  // Enter takes the default) — matching the legacy single-key confirm feel — using
  // the SAME interpretYesNoKey core. When absent, the legacy path is unchanged.
  inkReadKey?: () => Promise<string>,
): Confirm {
  if (injected !== undefined) return injected;

  return async (defaultYes: boolean, opts?: { requireExplicit?: boolean }): Promise<boolean> => {
    const requireExplicit = opts?.requireExplicit ?? false;
    if (inkReadKey !== undefined) {
      try {
        return await confirmViaInkKey(out, defaultYes, inkReadKey, requireExplicit);
      } catch {
        // Any Ink read hiccup falls back to a full line read.
      }
      return parseYesNo(normalizeMenuKey(await readLine()), defaultYes, requireExplicit);
    }
    for (const input of (forceLine ? [] : rawKeyInputs(out))) {
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

/**
 * The Ink twin of {@link confirmViaKey}: drive a single-key yes/no confirm whose
 * keystrokes come from Ink's own input pipeline (`inkReadKey`, which resolves a
 * legacy-`readSingleKey`-shaped string) instead of a raw `process.stdin`. Same
 * decision core ({@link interpretYesNoKey}), same echo + Ctrl-C → SIGINT
 * semantics, so a confirm on the Ink path behaves exactly like the legacy one.
 */
async function confirmViaInkKey(
  out: OutputSink,
  defaultYes: boolean,
  inkReadKey: () => Promise<string>,
  requireExplicit: boolean,
): Promise<boolean> {
  // Surface any unterminated prompt before blocking on the Ink keypress read.
  out.flush?.();
  for (;;) {
    const key = await inkReadKey();
    const verdict = interpretYesNoKey(key, defaultYes, requireExplicit);
    if (verdict === 'ignore') continue;
    if (verdict === 'abort') {
      out.write('\n');
      process.kill(process.pid, 'SIGINT');
      return defaultYes;
    }
    const yes = verdict === 'yes';
    out.write((yes ? 'y' : 'n') + '\n');
    return yes;
  }
}
