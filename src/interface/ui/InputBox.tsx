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
 *   - a paste whose chunk contains INTERNAL `\n` inserts those newlines verbatim
 *     (multiline compose); a paste whose chunk ENDS in CR/LF inserts the
 *     preceding text and then SUBMITS, mirroring a real terminal paste of
 *     "authcode\r" and how readline submits on the trailing newline.
 * The bordered box GROWS VERTICALLY to show every row of the buffer (caret on
 * the first row, a dim `… ` gutter on continuation rows), capped at
 * MAX_VISIBLE_ROWS so a huge paste can't blow past the viewport.
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
import { dim, cyan, blue } from '../../ui/theme.js';
import { truncateToWidth, visibleLength } from '../../ui/tui.js';
import type { InkStdinControl } from './App.js';

/** Below this, fall back to the plain caret surface. */
const INPUT_BOX_MIN_COLUMNS = 32;
const CARET = '❯';
const PLACEHOLDER = 'Type a message...';
/** The minimal menu-prompt hint shown when the composer is hidden (chatActive
 *  false). SINGLE-KEY selection — must NOT imply free-text typing. */
const MENU_HINT = 'press a key';
const INFO_FALLBACK = 'Mode Balanced · /goal · /help · /back';
/** Gutter under the `❯ ` caret for continuation rows of a multiline buffer. */
const CONT_GUTTER = '… ';
/**
 * Cap on the number of buffer rows the box renders at once so a huge paste can't
 * blow past the viewport. When the buffer has more rows than this we show the
 * LAST N rows (keeping the caret row visible), mirroring a terminal editor that
 * scrolls. The caret always falls within the shown window because the cursor is
 * at the very end of a fresh paste (and edits keep it on a visible row).
 */
const MAX_VISIBLE_ROWS = 10;

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
  /** Right-pinned composer chip. Omitted keeps the default chat hints. */
  readonly info?: string | undefined;
  /**
   * Whether the composer CHROME is rendered. `true` (default) → the full chat
   * surface (bordered box / caret / Mode chip) is shown — used during an ACTIVE
   * CHAT. `false` → the box renders a MINIMAL one-line menu prompt (`❯ press a
   * key`, no `─ chat ─┌ … ┐` rule, no Mode chip) so the user sees input is awaited
   * at the menu; the editor's `useInput` + `useStdin` hooks stay mounted and ACTIVE,
   * so Ink keeps raw mode armed and the LineReader's suspend()/resume() stdin
   * control stays registered. The App passes `chatActive` here: the full composer
   * appears ONLY in a chat conversation, the menu prompt in the menu / auth-login /
   * settings sub-flows.
   */
  readonly visible?: boolean;
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
  /**
   * Bare-ESC handler. When a model turn is in flight the App installs a turn
   * interrupt; on a bare ESC the editor calls this INSTEAD of editing. Returns
   * `true` when the ESC was consumed as an interrupt (a turn was aborted) so the
   * editor must not also treat ESC as input; `false` when idle (no turn) → ESC is
   * a no-op at the prompt, exactly as before. Typed-ahead characters are NOT
   * affected: only the bare ESC key routes here, normal chars still queue. Optional.
   */
  readonly onEscape?: (() => boolean) | undefined;
  /**
   * Returns `true` while a single-key menu/confirm read is pending (the App's
   * `readKey()`). The editor's input handler stops editing while this is true so a
   * key that arrives in the sub-frame window after `readKey()` flips `awaitingKey`
   * — but before the `isActive:false` re-render propagates — cannot mutate the edit
   * buffer. Optional (tests/Step-1 paths may omit it). See App.readKey().
   */
  readonly readPending?: (() => boolean) | undefined;
  /**
   * Resolve a pending single-key read with a key delivered to the editor's
   * `useInput` in the sub-frame window BEFORE the dedicated `<KeyCapture>` hook has
   * mounted (M2). The App wires this to its key-capture resolver (which nulls the
   * resolver first, so a later double-delivery via KeyCapture is a safe no-op). The
   * editor itself never mutates for such a key — it is forwarded here instead. Only
   * called while `readPending()` is true. Optional. See App.readKey()/KeyCapture.
   */
  readonly onReadKey?: ((input: string, key: KeyCaptureFlagsLike) => void) | undefined;
}

/** The slice of Ink's `key` object {@link InputBoxProps.onReadKey} forwards (a
 *  structural match for App's KeyCaptureFlags — kept local to avoid an import
 *  cycle through App, which imports InkStdinControl from here). */
interface KeyCaptureFlagsLike {
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly ctrl?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly tab?: boolean;
}

function composerWidth(columns: number | undefined): number {
  return Math.max(INPUT_BOX_MIN_COLUMNS, columns ?? 80);
}

export function composerRules(width: number, info: string, color: boolean): { top: string; bottom: string } {
  const chipText = ` ${truncateToWidth(info, Math.max(12, width - 12))} `;
  const topChip = `┌${chipText}┐`;
  const bottomChip = `└${'─'.repeat(visibleLength(chipText))}┘`;
  const leftTop = '─ chat ';
  const topFill = Math.max(1, width - visibleLength(leftTop) - visibleLength(topChip));
  const bottomFill = Math.max(1, width - visibleLength(bottomChip));
  return {
    top: `${dim(leftTop + '─'.repeat(topFill), color)}${blue(topChip, color)}`,
    bottom: `${dim('─'.repeat(bottomFill), color)}${blue(bottomChip, color)}`,
  };
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
 * Map a flat cursor index into `(row, col)` over the `\n`-split rows of `text`.
 * `row` is the 0-based line containing the cursor; `col` is the offset within
 * that line (0..line.length). A cursor sitting exactly on a `\n` belongs to the
 * END of the preceding line (col === line.length), matching a terminal editor.
 */
function cursorRowCol(text: string, cursor: number): { row: number; col: number } {
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < cursor; i++) {
    if (text[i] === '\n') {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, col: cursor - lineStart };
}

/** Flat index of the start of `row` (0-based) in the `\n`-split `text`. */
function rowStartIndex(text: string, row: number): number {
  let idx = 0;
  for (let r = 0; r < row; r++) {
    const nl = text.indexOf('\n', idx);
    if (nl === -1) return idx; // fewer rows than requested → last row start
    idx = nl + 1;
  }
  return idx;
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
  info,
  visible = true,
  suspended = false,
  onStdinControl,
  onEscape,
  readPending,
  onReadKey,
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

  // Commit `submitted` as a line: record non-blank history, clear the editor,
  // and notify the bridge. Shared by plain-Enter and the paste-trailing-newline
  // path so both have byte-identical submit semantics (the reader trims).
  const submit = (submitted: string): void => {
    if (submitted.trim() !== '') {
      setHistory((h) => (h[h.length - 1] === submitted ? h : [...h, submitted]));
    }
    setValue('');
    setCursor(0);
    setHistIndex(null);
    setDraft('');
    bridge._submit?.(submitted);
  };

  useInput((input, key) => {
    // --- Sub-frame mode-switch guard (M2) ------------------------------------
    // A single-key menu/confirm read (App.readKey()) flips `awaitingKey` on, which
    // sets this box's `isActive:false` — but only on the NEXT render+effect pass.
    // A key delivered in that sub-frame window would otherwise land here and mutate
    // the editor (a stray char + the read waits for the NEXT key). Bail at the very
    // top so the editor consumes nothing while a read is pending, and FORWARD the
    // key to resolve the read directly (the dedicated <KeyCapture> hook has not
    // mounted yet in this sub-frame). onReadKey nulls the resolver before resolving,
    // so a later double-delivery via KeyCapture is a safe no-op. The editor itself
    // never mutates for this key.
    if (readPending?.() === true) {
      onReadKey?.(input, key as KeyCaptureFlagsLike);
      return;
    }

    // --- Bare ESC → interrupt the in-flight turn (H1) ------------------------
    // During a model turn the App installs an interrupt handler (the Ink twin of
    // the legacy raw-mode ESC→currentAc.abort()). A BARE Escape keypress routes
    // there and aborts the turn instead of editing. Only the standalone Escape key
    // is intercepted (key.escape && no input payload): typed-ahead characters and
    // Alt-chord escapes are untouched, so the typed-ahead queue is preserved. When
    // idle (no handler installed) onEscape returns false → ESC is a no-op as before.
    if (key.escape && input === '' && onEscape?.() === true) return;

    // --- Submit vs newline ---------------------------------------------------
    if (key.return) {
      if (key.meta) {
        // Alt/Option+Enter → insert a newline (multiline compose). This is the
        // intentional chord and NEVER submits, even on a multiline buffer.
        replace(value.slice(0, cursor) + '\n' + value.slice(cursor), cursor + 1);
        return;
      }
      // A plain single Enter keypress submits the whole (possibly multiline)
      // buffer. `key.return` is only set for a SINGLE-char `\r`/`\x1b\r` keypress
      // (Ink's parseKeypress matches `s === '\r'` exactly) — a multi-char paste
      // ending in `\r` does NOT set key.return; that case is handled below.
      submit(value);
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
    // Home / End (Ctrl+A / Ctrl+E too — readline's emacs bindings). On a
    // multiline buffer these move to the start/end of the CURRENT row.
    if ((key.ctrl && input === 'a') || (input === '\x01')) {
      const { row } = cursorRowCol(value, cursor);
      setCursor(rowStartIndex(value, row));
      return;
    }
    if ((key.ctrl && input === 'e') || (input === '\x05')) {
      const { row } = cursorRowCol(value, cursor);
      const start = rowStartIndex(value, row);
      const nl = value.indexOf('\n', start);
      setCursor(nl === -1 ? value.length : nl);
      return;
    }

    // --- Up/Down: multiline cursor movement, else history --------------------
    // On a multiline buffer Up/Down move the caret between rows (preserving the
    // column where possible). Only when the caret is already on the FIRST row
    // (Up) or LAST row (Down) do we fall through to history navigation — so a
    // single-line buffer behaves exactly as before.
    if (key.upArrow) {
      const { row, col } = cursorRowCol(value, cursor);
      if (row > 0) {
        const prevStart = rowStartIndex(value, row - 1);
        const prevNl = value.indexOf('\n', prevStart);
        const prevLen = (prevNl === -1 ? value.length : prevNl) - prevStart;
        setCursor(prevStart + Math.min(col, prevLen));
        return;
      }
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
      const { row, col } = cursorRowCol(value, cursor);
      const totalRows = value.split('\n').length;
      if (row < totalRows - 1) {
        const nextStart = rowStartIndex(value, row + 1);
        const nextNl = value.indexOf('\n', nextStart);
        const nextLen = (nextNl === -1 ? value.length : nextNl) - nextStart;
        setCursor(nextStart + Math.min(col, nextLen));
        return;
      }
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
      // Paste-trailing-newline submit (residual risk #3, the auth-code-paste
      // case). Ink delivers a paste as ONE useInput call carrying the whole
      // chunk as `input`; a single keypress carries one char (and Enter/Alt+Enter
      // are handled above via key.return, never reaching here). So we treat a
      // multi-char chunk whose content ENDS in CR or LF as: insert the preceding
      // text, then SUBMIT — mirroring a real terminal paste of "code\r" and the
      // way readline submits on the trailing newline. Internal newlines (no
      // trailing one) are inserted verbatim for multiline compose.
      const isPaste = input.length > 1;
      if (isPaste && (input.endsWith('\r') || input.endsWith('\n'))) {
        const body = input.slice(0, -1);
        // A leading CR of a CRLF-terminated paste ("code\r\n") would otherwise
        // leave a stray '\r'; normalize a trailing CRLF to a single submit.
        const cleaned = body.endsWith('\r') ? body.slice(0, -1) : body;
        submit(value.slice(0, cursor) + cleaned + value.slice(cursor));
        return;
      }
      replace(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      return;
    }
    // When `suspended`, this handler is inert (isActive:false below also stops Ink
    // from delivering input), so an inherited-stdio child owns the TTY alone.
  }, { isActive: !suspended });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  // Composer hidden (NOT a chat conversation: menu / auth-login / settings). Render
  // a MINIMAL single-line prompt affordance — a dim `❯ press a key` — so the user
  // sees input is awaited (the menu is single-key: you press one bracketed key, you
  // do NOT type+Enter, so the hint must NOT imply free-text typing). NO full-width
  // rules and NO Mode chip here — that's the composer, reserved for an active chat.
  // The `useInput`/`useStdin` hooks above stay mounted and active, so Ink keeps raw
  // mode armed (menu single-key nav via <KeyCapture> works) and the LineReader's
  // suspend()/resume() stdin control stays registered. We keep ONE <Box> line (not
  // literal null) so this component still returns a ReactElement — and so a re-mount
  // isn't forced when toggling visibility (the hooks persist).
  if (!visible) {
    // Non-TTY / NO_COLOR / very-narrow degrades to a bare caret (no colour codes),
    // mirroring the composer's plain-caret fallback — never a crash, never blank.
    const canColor = isTty && color;
    return (
      <Box>
        <Text>{canColor ? `${dim(CARET, color)} ${dim(MENU_HINT, color)}` : CARET}</Text>
      </Box>
    );
  }

  // Split the edit buffer into its display rows. The caret row/col is derived
  // from the flat cursor so movement lands on the correct row. When the buffer
  // has more rows than the height cap, show the LAST MAX_VISIBLE_ROWS rows so a
  // huge paste can't blow past the viewport (terminal-editor scroll feel); the
  // caret sits at the buffer end after a paste, so it stays within the window.
  const allRows = value.split('\n');
  const overflow = allRows.length > MAX_VISIBLE_ROWS;
  const firstShown = overflow ? allRows.length - MAX_VISIBLE_ROWS : 0;
  const shownRows = allRows.slice(firstShown);

  // Plain caret for non-TTY / NO_COLOR / narrow terminals (mirrors
  // render.ts canRenderInputBox → `❯ value`). Multiline buffers render the
  // first row after the caret and each continuation row under a gutter.
  const canBox = isTty && color && (columns ?? 80) >= INPUT_BOX_MIN_COLUMNS;
  if (!canBox) {
    return (
      <Box flexDirection="column">
        {shownRows.map((line, i) => {
          const absRow = firstShown + i;
          const prefix = absRow === 0 ? `${CARET} ` : CONT_GUTTER;
          return <Text key={absRow}>{`${prefix}${line}`}</Text>;
        })}
      </Box>
    );
  }

  const width = composerWidth(columns);
  const inputWidth = Math.max(1, width - 2);
  const rules = composerRules(width, info ?? INFO_FALLBACK, color);

  return (
    <Box flexDirection="column">
      <Text>{rules.top}</Text>
      {queued > 0 ? (
        <Text>{dim(`⏎ queued (${queued})`, color)}</Text>
      ) : (
        shownRows.map((line, i) => {
          const absRow = firstShown + i;
          // First buffer row carries the cyan `❯` caret; continuation rows get a
          // dim gutter aligned under it so the multiline block reads as one input.
          // The line `<Text>` soft-wraps inside a width-bounded box so a long
          // logical row spills onto multiple physical rows (the box grows
          // vertically) instead of being hard-truncated with an ellipsis — the
          // owner sees everything they type. The 2-col caret/gutter sits in a
          // fixed-width sibling so wrapped continuation rows stay aligned.
          const isFirst = absRow === 0;
          const isPlaceholder = line === '' && isFirst;
          const display = isPlaceholder ? dim(PLACEHOLDER, color) : line;
          const gutter =
            isFirst ? (
              <Text>
                {cyan(CARET, color)}
                {' '}
              </Text>
            ) : (
              <Text>{dim(CONT_GUTTER, color)}</Text>
            );
          return (
            <Box key={absRow}>
              {gutter}
              <Box width={Math.max(1, inputWidth - 2)}>
                <Text wrap={isPlaceholder ? 'truncate-end' : 'wrap'}>{display}</Text>
              </Box>
            </Box>
          );
        })
      )}
      <Text>{rules.bottom}</Text>
    </Box>
  );
}
