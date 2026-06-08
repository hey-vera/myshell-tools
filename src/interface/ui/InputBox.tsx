/**
 * src/interface/ui/InputBox.tsx — the real Ink input editor (Step 2a of the Ink
 * migration, behind the default-OFF MYSHELL_INK flag).
 *
 * A small in-house line editor built on Ink's `useInput` (no extra dependency —
 * see the Step-2a constraint preferring useInput over `ink-text-input`). It
 * mirrors the legacy readline input box surface:
 *   - the bordered box with the `✦` corner glyph and the `❯ ` caret
 *     (see render.ts `renderInputPrompt` / `createTurnInputSurface`);
 *   - a "⏎ queued (N)" indicator while a model turn is capturing typed-ahead
 *     (render.ts `renderQueuedIndicator`);
 *   - cursor movement (left/right, home/end, word-left/right), backspace/delete;
 *   - Up/Down history over previously submitted lines;
 *   - Alt+Enter (a.k.a. Meta+Return) inserts a newline; plain Enter submits.
 *
 * MULTILINE SEMANTICS (documented choice): the legacy reader is a single
 * `node:readline` interface — Enter ALWAYS submits and there is no
 * newline-insertion (`createLineReader` delivers one trimmed line per `'line'`
 * event). To stay faithful while still letting a user compose a multi-line
 * prompt (and to accept bracketed-paste blobs that carry embedded `\n`), this
 * editor keeps a single edit buffer that MAY contain `\n`:
 *   - plain Enter (`key.return` without meta) SUBMITS the whole buffer;
 *   - Alt/Option+Enter (`key.return && key.meta`) INSERTS a newline;
 *   - a paste whose chunk contains `\n` inserts those newlines verbatim.
 * On submit the buffer is passed UNTRIMMED to the bridge; the LineReader applies
 * the same `.trim()` the legacy `createLineReader` does, so downstream semantics
 * are byte-identical to the legacy single-line case (a plain typed line has no
 * embedded newline and trims to exactly what readline would have delivered).
 *
 * The editor is intentionally rendered only via tui/theme primitives (gated on
 * `color`/`isTty`) so the flag-off legacy path is untouched.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { dim, cyan } from '../../ui/theme.js';
import type { InkStdinControl } from './App.js';

/** Min/max box width — mirrors render.ts INPUT_BOX_MIN/MAX_COLUMNS. */
const INPUT_BOX_MIN_COLUMNS = 32;
const INPUT_BOX_MAX_COLUMNS = 84;
const INPUT_BOX_GLYPH = '✦';
const CARET = '❯';

/**
 * The imperative editor handle the LineReader/menu side uses to read in-progress
 * text and push history/queue state IN without React knowing about Node streams.
 * Registered by {@link InputBox} on mount via {@link InputBoxBridge.attach}.
 */
interface InputBoxApi {
  /** The current in-progress edit buffer (mirrors readline's `.line`). */
  currentLine(): string;
}

/**
 * The bridge between the React {@link InputBox} and the Node-side LineReader.
 * The reader registers `onSubmit`/seeds history/sets the queued count; the box
 * registers its {@link InputBoxApi} via `attach`.
 */
export interface InputBoxBridge {
  /** Invoked by the box when the user submits a line (UNTRIMMED — the reader
   *  trims, matching legacy createLineReader). */
  onSubmit(handler: (line: string) => void): void;
  /** Seed the Up/Down history with previously submitted lines (oldest→newest). */
  seedHistory(lines: readonly string[]): void;
  /** Set the queued-typeahead count; >0 paints the "⏎ queued (N)" indicator. */
  setQueued(n: number): void;
  /** Register a subscriber for the queued count (the box). @internal */
  onQueued(handler: (n: number) => void): void;
  /** The box registers its imperative API here on mount. */
  attach(api: InputBoxApi | null): void;
  /** Read the box's current in-progress line (empty string before mount). */
  currentLine(): string;
  // --- wired internally ---
  /** @internal set by onSubmit() */ _submit?: ((line: string) => void) | undefined;
  /** @internal set by onQueued() */ _onQueued?: ((n: number) => void) | undefined;
  /** @internal initial history seed, consumed by the box on mount */ _history: string[];
  /** @internal the attached box API */ _api?: InputBoxApi | null;
}

/** Build an {@link InputBoxBridge} with empty wiring. */
export function createInputBoxBridge(): InputBoxBridge {
  const bridge: InputBoxBridge = {
    _history: [],
    onSubmit(handler): void {
      bridge._submit = handler;
    },
    seedHistory(lines): void {
      bridge._history = lines.slice();
    },
    setQueued(n): void {
      bridge._onQueued?.(n);
    },
    onQueued(handler): void {
      bridge._onQueued = handler;
    },
    attach(api): void {
      bridge._api = api;
    },
    currentLine(): string {
      return bridge._api?.currentLine() ?? '';
    },
  };
  return bridge;
}

export interface InputBoxProps {
  readonly bridge: InputBoxBridge;
  readonly color: boolean;
  readonly isTty: boolean;
  readonly columns?: number | undefined;
  /**
   * When true the editor is SUSPENDED for an inherited-stdio child handoff: its
   * `useInput` goes `isActive: false` so Ink relinquishes its raw-mode refcount
   * and the child becomes the sole reader of the TTY. Default false.
   */
  readonly suspended?: boolean;
  /**
   * Register the Ink-side stdin control (raw-mode toggle + stream pause/resume)
   * the LineReader's suspend()/resume() drive. Called from inside `useStdin()`
   * on mount; called with `null` on unmount. Optional (tests may omit it).
   */
  readonly onStdinControl?: ((control: InkStdinControl | null) => void) | undefined;
}

function boxWidth(columns: number | undefined): number {
  const width = columns ?? 80;
  return Math.max(INPUT_BOX_MIN_COLUMNS, Math.min(INPUT_BOX_MAX_COLUMNS, width));
}

/** Index of the start of the word at or before `pos` (word = run of non-spaces). */
function wordLeft(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && text[i - 1] === ' ') i--;
  while (i > 0 && text[i - 1] !== ' ') i--;
  return i;
}

/** Index of the end of the word at or after `pos`. */
function wordRight(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && text[i] === ' ') i++;
  while (i < text.length && text[i] !== ' ') i++;
  return i;
}

/**
 * The real input editor. Renders the bordered box (TTY+colour) or a plain caret
 * (non-TTY / NO_COLOR), exactly mirroring render.ts `canRenderInputBox`.
 */
export function InputBox({
  bridge,
  color,
  isTty,
  columns,
  suspended = false,
  onStdinControl,
}: InputBoxProps): React.ReactElement {
  const { setRawMode, isRawModeSupported } = useStdin();
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [queued, setQueued] = useState(0);
  // History: committed lines (oldest→newest). `histIndex === null` means "editing
  // a fresh line"; a number indexes into history. `draft` preserves the in-progress
  // line while browsing history (restored when navigating back past the newest).
  const [history, setHistory] = useState<string[]>(() => bridge._history.slice());
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  // Register the imperative API + queued subscriber; consume the history seed.
  useEffect(() => {
    bridge.attach({ currentLine: () => value });
    return () => bridge.attach(null);
  });
  useEffect(() => {
    bridge.onQueued((n) => setQueued(n));
    return () => {
      bridge._onQueued = undefined;
    };
  }, [bridge]);

  // Register the Ink-side stdin control so the LineReader's suspend()/resume()
  // can drive INK's raw-mode toggle (NOT process.stdin's — Ink re-applies its own
  // on every render and would fight the child). Captured from inside useStdin() so
  // the /dev/tty fallback stream passed to render() is handled for free. We do NOT
  // expose stream pause/resume: Ink 6 reads via a `'readable'` listener it
  // adds/removes by raw-mode refcount, so the isActive toggle alone releases and
  // re-primes the stream; pausing/resuming would switch it to flowing mode and
  // break those reads.
  useEffect(() => {
    if (onStdinControl === undefined) return;
    const control: InkStdinControl = {
      setRawMode: (v: boolean): void => {
        // Best-effort: Ink's setRawMode throws if raw mode is unsupported.
        try {
          if (isRawModeSupported) setRawMode(v);
        } catch {
          /* raw mode unsupported on this stream */
        }
      },
      isRawModeSupported,
    };
    onStdinControl(control);
    return () => onStdinControl(null);
  }, [onStdinControl, setRawMode, isRawModeSupported]);

  const replace = (next: string, nextCursor: number): void => {
    setValue(next);
    setCursor(Math.max(0, Math.min(next.length, nextCursor)));
  };

  useInput((input, key) => {
    // --- Submit vs newline ---------------------------------------------------
    if (key.return) {
      if (key.meta) {
        // Alt/Option+Enter → insert a newline (multiline compose).
        replace(value.slice(0, cursor) + '\n' + value.slice(cursor), cursor + 1);
        return;
      }
      const submitted = value;
      // Record non-blank submissions in history (no consecutive duplicate),
      // matching readline's removeHistoryDuplicates-style behaviour.
      if (submitted.trim() !== '') {
        setHistory((h) => (h[h.length - 1] === submitted ? h : [...h, submitted]));
      }
      setValue('');
      setCursor(0);
      setHistIndex(null);
      setDraft('');
      bridge._submit?.(submitted);
      return;
    }

    // --- Deletion ------------------------------------------------------------
    if (key.backspace) {
      if (cursor > 0) replace(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (key.delete) {
      // Some terminals map the Backspace key to `key.delete`. Ink reports the
      // forward-delete key as `delete` too; we treat `delete` as backspace when
      // it carries the DEL char (0x7f), else forward-delete. To stay simple and
      // match the legacy single-line feel, treat bare delete as backspace.
      if (cursor > 0) replace(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }

    // --- Cursor movement -----------------------------------------------------
    if (key.leftArrow) {
      if (key.meta || key.ctrl) setCursor(wordLeft(value, cursor));
      else setCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      if (key.meta || key.ctrl) setCursor(wordRight(value, cursor));
      else setCursor(Math.min(value.length, cursor + 1));
      return;
    }
    // Home / End (Ctrl+A / Ctrl+E too — readline's emacs bindings).
    if ((key.ctrl && input === 'a') || (input === '\x01')) {
      setCursor(0);
      return;
    }
    if ((key.ctrl && input === 'e') || (input === '\x05')) {
      setCursor(value.length);
      return;
    }

    // --- History (Up/Down) ---------------------------------------------------
    if (key.upArrow) {
      if (history.length === 0) return;
      if (histIndex === null) {
        setDraft(value);
        const idx = history.length - 1;
        setHistIndex(idx);
        replace(history[idx] ?? '', (history[idx] ?? '').length);
      } else if (histIndex > 0) {
        const idx = histIndex - 1;
        setHistIndex(idx);
        replace(history[idx] ?? '', (history[idx] ?? '').length);
      }
      return;
    }
    if (key.downArrow) {
      if (histIndex === null) return;
      if (histIndex < history.length - 1) {
        const idx = histIndex + 1;
        setHistIndex(idx);
        replace(history[idx] ?? '', (history[idx] ?? '').length);
      } else {
        // Past the newest → restore the in-progress draft.
        setHistIndex(null);
        replace(draft, draft.length);
      }
      return;
    }

    // --- Printable input (incl. pasted chunks with embedded newlines) --------
    if (input && !key.ctrl && !key.meta) {
      replace(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      return;
    }
    // When `suspended`, this handler is inert (isActive:false below also stops Ink
    // from delivering input), so an inherited-stdio child owns the TTY alone.
  }, { isActive: !suspended });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  // Plain caret for non-TTY / NO_COLOR / narrow terminals (mirrors
  // render.ts canRenderInputBox → `❯ value`).
  const canBox = isTty && color && (columns ?? 80) >= INPUT_BOX_MIN_COLUMNS;
  if (!canBox) {
    return (
      <Box>
        <Text>{`${CARET} ${value}`}</Text>
      </Box>
    );
  }

  const outerWidth = boxWidth(columns);
  const innerWidth = outerWidth - 2;
  const topFill = Math.max(1, innerWidth - INPUT_BOX_GLYPH.length - 1);
  const top = `╭${'─'.repeat(topFill)} ${INPUT_BOX_GLYPH}╮`;
  const bottom = `╰${'─'.repeat(innerWidth)}╯`;

  return (
    <Box flexDirection="column">
      <Text>{dim(top, color)}</Text>
      <Box>
        <Text>{dim('│ ', color)}</Text>
        {queued > 0 ? (
          <Text>{dim(`⏎ queued (${queued})`, color)}</Text>
        ) : (
          <Text>
            {cyan(CARET, color)}
            {` ${value}`}
          </Text>
        )}
      </Box>
      <Text>{dim(bottom, color)}</Text>
    </Box>
  );
}
