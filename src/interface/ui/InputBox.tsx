/**
 * src/interface/ui/InputBox.tsx — the real Ink input editor (Step 2a of the Ink
 * migration, behind the default-OFF MYSHELL_INK flag).
 *
 * A small in-house line editor built on Ink's `useInput` (no extra dependency —
 * see the Step-2a constraint preferring useInput over `ink-text-input`). It
 * mirrors the legacy readline input box surface:
 *   - the bordered box with the `✦` corner glyph and the `❯ ` caret
 *     (see render.ts `renderInputPrompt` / `createTurnInputSurface`);
 *   - legacy `setQueued(N)` bridge (mid-turn prose is live notes now — menu no
 *     longer drives the "⏎ queued (N)" indicator; the API remains for tests);
 *   - cursor movement (left/right, home/end, word-left/right), backspace/delete;
 *   - Up/Down browse prior user messages (seeded + session submits); Enter sends
 *     the selected text (history insert is on Up; Enter = send — two-step UX);
 *   - Alt+Enter / Shift+Enter insert a newline; plain Enter submits.
 *   - empty-buffer `b` / always-hot Ctrl+B → hierarchical back;
 *     empty-buffer `c` → control panel; Ctrl+G always-hot panel toggle.
 *   - ←/→ are cursor only (no empty-buffer nav).
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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { dim, cyan, blue } from '../../ui/theme.js';
import { visibleLength } from '../../ui/tui.js';
import { composerShownPlan, fitComposerInfo, INPUT_BORDER_ROWS } from './layout.js';
import { isMouseInput } from './mouse.js';
import { completeChat, classifyCompletion } from '../menu-completion.js';
import {
  applyGhost,
  GHOST_DEBOUNCE_MS,
  parseModelGhostCompletion,
  proposeGhost,
  shouldOfferModelGhost,
  type GhostSuggestion,
  type SuggestGhost,
} from '../ghost-text.js';
import type { InkStdinControl } from './App.js';

/** Below this, fall back to the plain caret surface. */
const INPUT_BOX_MIN_COLUMNS = 32;
const CARET = '❯';
const PLACEHOLDER = 'Type a message...';
const INFO_FALLBACK = 'Effort: Balanced · /help · Shift+Tab Effort · /speed';

// Smart placeholder based on pressure + dynamic context (final smartness pass)
function smartPlaceholder(pressure: number, hasDynamic: boolean, goalCount: number): string {
  if (pressure >= 3) return 'High pressure — keep it short & focused...';
  if (pressure >= 2) return 'Pressure building — concise please...';
  if (goalCount > 1 || hasDynamic) return '@goal-... or describe next step (parallel aware)...';
  if (pressure === 1) return 'Type a message (balanced)...';
  return PLACEHOLDER;
}
/** Gutter under the `❯ ` caret for continuation rows of a multiline buffer. */
const CONT_GUTTER = '… ';
// The cap on how many LOGICAL buffer rows the box shows at once (so a huge paste
// can't blow past the viewport) now lives in layout.ts as
// INPUT_BODY_MAX_LOGICAL_ROWS and is applied — together with the wrapped-physical
// viewport cap — by composerShownPlan(), the SAME helper the height budget uses.

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
  /**
   * Seed / replace the Up/Down message history (oldest→newest). Safe after mount
   * — updates live editor state when the box is attached.
   */
  seedHistory(lines: readonly string[]): void;
  /**
   * Replace the entire composer buffer (cursor at end). Used to restore a durable
   * draft on chat enter. Empty string clears.
   */
  setLine(text: string): void;
  /**
   * Subscribe to in-progress buffer changes (draft persistence). Fired on every
   * edit and on setLine; NOT fired for submit-clear (submit path clears draft
   * explicitly). Replaces any prior handler.
   */
  onDraftChange(handler: ((text: string) => void) | null): void;
  /**
   * Legacy queued-typeahead count. Mid-turn prose is live notes (not a FIFO
   * turn queue); the chat loop no longer calls this. Kept for bridge/API
   * compatibility and tests — when set >0 still paints "⏎ queued (N)".
   */
  setQueued(n: number): void;
  /** Register a subscriber for the queued count (the box). @internal */
  onQueued(handler: (n: number) => void): void;
  /** The box registers its imperative API here on mount. */
  attach(api: InputBoxApi | null): void;
  /** Read the box's current in-progress line (empty string before mount). */
  currentLine(): string;
  /**
   * Imperatively insert text into the composer's current draft at the cursor
   * position WITHOUT clobbering existing text. Appends with a sensible space
   * separator when the buffer is non-empty. Used by Control Panel "chat about
   * goal" to insert \@goal:&lt;id&gt; tokens.
   */
  insertText(text: string): void;
  // --- wired internally ---
  /** @internal set by onSubmit() */ _submit?: ((line: string) => void) | undefined;
  /** @internal set by onQueued() */ _onQueued?: ((n: number) => void) | undefined;
  /** @internal set by onDraftChange() */ _onDraftChange?: ((text: string) => void) | null;
  /** @internal initial history seed, consumed by the box on mount */ _history: string[];
  /** @internal the attached box API */ _api?: InputBoxApi | null;
  /** @internal set by the InputBox mount effect; invoked by insertText() */
  _insertText?: ((text: string) => void) | undefined;
  /** @internal set by the InputBox mount effect; invoked by setLine() */
  _setLine?: ((text: string) => void) | undefined;
  /** @internal set by the InputBox mount effect; invoked by seedHistory() */
  _setHistory?: ((lines: readonly string[]) => void) | undefined;
  /** @internal pre-mount setLine stash, applied once on attach */
  _pendingLine?: string | undefined;
}

/** Build an {@link InputBoxBridge} with empty wiring. */
export function createInputBoxBridge(): InputBoxBridge {
  const bridge: InputBoxBridge = {
    _history: [],
    _onDraftChange: null,
    onSubmit(handler): void {
      bridge._submit = handler;
    },
    seedHistory(lines): void {
      bridge._history = lines.slice();
      bridge._setHistory?.(bridge._history);
    },
    setLine(text): void {
      if (bridge._setLine !== undefined) {
        bridge._setLine(text);
      } else {
        // Pre-mount: stash via a one-shot draft seed consumed on attach.
        bridge._pendingLine = text;
      }
    },
    onDraftChange(handler): void {
      bridge._onDraftChange = handler;
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
    insertText(text): void {
      bridge._insertText?.(text);
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
   * CHAT. `false` → the box renders nothing visible (a single reserved blank line,
   * no `─ chat ─┌ … ┐` rule, no Mode chip, no hint) because every single-key menu /
   * auth-login / settings / confirm read site prints its OWN prompt before blocking;
   * the editor's `useInput` + `useStdin` hooks still stay mounted and ACTIVE, so Ink
   * keeps raw mode armed and the LineReader's suspend()/resume() stdin control stays
   * registered. The App passes `chatActive` here: the full composer appears ONLY in
   * a chat conversation.
   */
  readonly visible?: boolean;
  /**
   * When true the editor is SUSPENDED for an inherited-stdio child handoff: its
   * `useInput` goes `isActive: false` so Ink relinquishes its raw-mode refcount
   * and the child becomes the sole reader of the TTY. Default false.
   */
  readonly suspended?: boolean;
  /**
   * Whether this input consumer is ACTIVE for key handling. Defaults to true.
   * Distinct from `suspended`: `suspended` means an inherited child owns the TTY;
   * `active` only selects which mounted Ink component handles keys. When false,
   * the component stays mounted (editor state/bridge/stdin are preserved) but
   * `useInput` is inactive so keystrokes are ignored here.
   */
  readonly active?: boolean;
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
   * Always-hot Ctrl+G handler (any buffer state). When armed, the bridge routes
   * the Control Panel toggle through it; returns true when consumed. When absent
   * or returning false, the key falls through to the existing handler chain
   * (menu single-key capture when the feature is off). Draft text is preserved.
   */
  readonly onToggleFullscreenPanel?: (() => boolean) | undefined;
  /**
   * Returns `true` while a single-key menu/confirm read is pending (the App's
   * `readKey()`). The editor's single input handler routes that event to the menu
   * resolver instead of mutating the edit buffer. Optional (tests/Step-1 paths may
   * omit it). See App.readKey().
   */
  readonly readPending?: (() => boolean) | undefined;
  /**
   * Hierarchical back (leave chat → menu). Fires on:
   * - empty-buffer bare `b`, OR
   * - always-hot Ctrl+B (any buffer; draft preserved).
   * When the buffer is non-empty, bare `b` types the letter. Optional.
   */
  readonly onEmptyLeft?: (() => void) | undefined;
  /**
   * Open Control Panel. Fires on empty-buffer bare `c` (non-empty `c` types the
   * letter). Always-hot panel toggle remains Ctrl+G via
   * {@link onToggleFullscreenPanel}. Optional.
   */
  readonly onEmptyRight?: (() => void) | undefined;
  /**
   * Shift+Tab handler — cycles THIS conversation's Effort Mode (P0.8). Fires on
   * any buffer state (mode is independent of the draft). Does not insert a tab
   * or advance autocomplete. Optional (tests / legacy path may omit it).
   */
  readonly onShiftTab?: (() => void) | undefined;
  /**
   * Resolve a pending single-key read with a key delivered to the editor's stable
   * `useInput` consumer. The editor itself never mutates for such a key. Only called
   * while `readPending()` is true. Optional. See App.readKey().
   */
  readonly onReadKey?: ((input: string, key: KeyCaptureFlagsLike) => void) | undefined;
  /**
   * The terminal HEIGHT (rows). When the composer's wrapped physical height would
   * alone exceed the viewport (an extreme multiline paste of very long lines), the
   * editor caps its visible PHYSICAL rows to what fits and scrolls to the buffer
   * TAIL so the caret/last row stays visible. Omitted → no viewport cap (the box
   * grows freely, as before). Threaded from App's live rows. Optional.
   */
  readonly rows?: number | undefined;
  /**
   * Report the composer's TRUE rendered PHYSICAL row count (wrapped body + the 2
   * borders) up to the App, which feeds it into the height-budget planner so the
   * dynamic region (panel + stream + this box) never exceeds the viewport. Called
   * whenever the measured height changes (on edits / width / rows changes). The
   * value equals {@link composerPhysicalRows}; App defaults to the single-line
   * {@link INPUT_ROWS} before the first measurement. Optional (tests may omit it).
   */
  readonly onMeasureRows?: ((rows: number) => void) | undefined;
  /** Current pressure (0-3) for smart placeholder / completion tuning. */
  readonly pressure?: number;
  /** Live dynamic items for @-mentions (@goal, @board, etc) from stores. */
  readonly dynamicWorldItems?: ReadonlyArray<{ prefix: string; items: readonly string[] }>;
  /**
   * Empty-prompt goal-aware ghost hints (P0.17). Injected from board/goals when
   * available; omitted → empty buffer has no ghost (history-only while typing).
   */
  readonly goalHints?: readonly string[];
  /**
   * Debounce before showing ghost text (ms). Defaults to {@link GHOST_DEBOUNCE_MS}
   * (300). Tests may pass 0 for immediate ghost after the next microtask tick.
   */
  readonly ghostDebounceMs?: number;
  /**
   * Optional budgeted model ghost (P1.5). Default OFF. When true AND
   * {@link suggestGhost} is wired, a model may fill in after local layers miss.
   * Local always wins; failures are silent.
   */
  readonly modelGhostEnabled?: boolean;
  /**
   * Injected model-ghost port (subscription-native). Absent → model path never
   * fires even if {@link modelGhostEnabled} is true (fail-soft off).
   */
  readonly suggestGhost?: SuggestGhost | undefined;
}

/** The slice of Ink's `key` object {@link InputBoxProps.onReadKey} forwards (a
 *  structural match for App's KeyCaptureFlags — kept local to avoid an import
 *  cycle through App, which imports InkStdinControl from here). */
interface KeyCaptureFlagsLike {
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
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
  const leftTop = '─ chat ';
  const topFill = Math.max(1, width - visibleLength(leftTop));
  const fittedInfo = fitComposerInfo(info, Math.max(0, width - 1));
  const infoWidth = visibleLength(fittedInfo);
  const bottomFill = Math.max(1, width - infoWidth - (infoWidth > 0 ? 1 : 0));
  return {
    top: `${dim(leftTop + '─'.repeat(topFill), color)}`,
    bottom:
      infoWidth > 0
        ? `${dim('─'.repeat(bottomFill), color)}${blue(` ${fittedInfo}`, color)}`
        : `${dim('─'.repeat(width), color)}`,
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
  active = true,
  onStdinControl,
  onEscape,
  onToggleFullscreenPanel,
  readPending,
  onReadKey,
  rows,
  onMeasureRows,
  pressure = 0,
  dynamicWorldItems,
  goalHints,
  ghostDebounceMs = GHOST_DEBOUNCE_MS,
  modelGhostEnabled = false,
  suggestGhost,
  onEmptyLeft,
  onEmptyRight,
  onShiftTab,
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
  // Tab-autocomplete (editor-local, ephemeral): the candidate list currently
  // shown under the composer, the highlighted index, and a cache of the last
  // classified completion token so Tab-accept knows how many trailing chars to
  // splice. Cleared on submit / Esc / any non-Tab edit — suggestions never
  // outlive the keystroke that produced them.
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggIndex, setSuggIndex] = useState(0);
  const lastCompletionRef = useRef<{ token: string } | null>(null);
  // Ghost text (P0.17–P0.18 + optional P1.5 model): dim inline suffix after the
  // typed prefix. Local-first; model only when enabled + local empty. Debounced;
  // dismissed by Esc / typing / Tab-accept. Never blocks input.
  const [ghost, setGhost] = useState<GhostSuggestion | null>(null);
  /** Session-local cache of recently accepted completions (history-layer boost). */
  const recentCompletionsRef = useRef<string[]>([]);
  // Live mirrors of value/cursor so the async completeChat() resolve can race-guard
  // against the LATEST buffer (the .then closure captures stale state otherwise).
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const historyRef = useRef(history);
  historyRef.current = history;
  const goalHintsRef = useRef(goalHints);
  goalHintsRef.current = goalHints;
  const dynamicWorldItemsRef = useRef(dynamicWorldItems);
  dynamicWorldItemsRef.current = dynamicWorldItems;
  const modelGhostEnabledRef = useRef(modelGhostEnabled);
  modelGhostEnabledRef.current = modelGhostEnabled;
  const suggestGhostRef = useRef(suggestGhost);
  suggestGhostRef.current = suggestGhost;

  const notifyDraft = useCallback(
    (text: string): void => {
      try {
        bridge._onDraftChange?.(text);
      } catch {
        /* draft hooks must never break input */
      }
    },
    [bridge],
  );

  // Register the imperative API + queued subscriber; consume the history seed.
  useEffect(() => {
    bridge.attach({ currentLine: () => valueRef.current });
    bridge._insertText = (text: string): void => {
      const current = valueRef.current;
      const cur = cursorRef.current;
      const head = current.slice(0, cur);
      const tail = current.slice(cur);
      const atEnd = cur === current.length;
      const needsSpace = atEnd && head !== '' && !head.endsWith(' ') && !head.endsWith('\n');
      const prefix = needsSpace ? ' ' : '';
      const next = head + prefix + text + tail;
      setValue(next);
      setCursor((head + prefix + text).length);
      setSuggestions([]);
      setSuggIndex(0);
      setGhost(null);
      setHistIndex(null);
      notifyDraft(next);
    };
    bridge._setLine = (text: string): void => {
      const next = typeof text === 'string' ? text : '';
      setValue(next);
      setCursor(next.length);
      setSuggestions([]);
      setSuggIndex(0);
      setGhost(null);
      setHistIndex(null);
      setDraft('');
      notifyDraft(next);
    };
    bridge._setHistory = (lines: readonly string[]): void => {
      setHistory(lines.slice());
      setHistIndex(null);
    };
    // Apply any pre-mount setLine stash once.
    if (typeof bridge._pendingLine === 'string') {
      const pending = bridge._pendingLine;
      bridge._pendingLine = undefined;
      bridge._setLine(pending);
    }
    return () => {
      bridge.attach(null);
      bridge._insertText = undefined;
      bridge._setLine = undefined;
      bridge._setHistory = undefined;
    };
  }, [bridge, notifyDraft]);
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
    // Any edit invalidates the shown completions. The Tab-accept/cycle branch
    // re-sets suggestion state AFTER its replace() call, so React's batching lets
    // those later sets win and the candidate row survives a cycle.
    setSuggestions([]);
    setSuggIndex(0);
    // Typing / edits also dismiss ghost immediately (P0.18).
    setGhost(null);
    notifyDraft(next);
  };

  const rememberCompletion = (text: string): void => {
    if (typeof text !== 'string' || text.trim() === '') return;
    const prev = recentCompletionsRef.current;
    if (prev[prev.length - 1] === text) return;
    recentCompletionsRef.current = [...prev, text].slice(-50);
  };

  // Commit `submitted` as a line: record non-blank history, clear the editor,
  // and notify the bridge. Shared by plain-Enter and the paste-trailing-newline
  // path so both have byte-identical submit semantics (the reader trims).
  // Clearing the buffer notifies draft listeners with '' so durable draft is wiped.
  const submit = (submitted: string): void => {
    if (submitted.trim() !== '') {
      const HISTORY_CAP = 500;
      setHistory((h) => {
        if (h[h.length - 1] === submitted) return h;
        return [...h, submitted].slice(-HISTORY_CAP);
      });
    }
    setValue('');
    setCursor(0);
    setHistIndex(null);
    setDraft('');
    setSuggestions([]);
    setSuggIndex(0);
    setGhost(null);
    lastCompletionRef.current = null;
    notifyDraft('');
    bridge._submit?.(submitted);
  };

  // Debounced local-first ghost (P0.17) with optional model fallback (P1.5).
  // Fail-soft: never blocks typing; async hits race-guarded; AbortController
  // cancels in-flight model ghost on keystroke / unmount.
  useEffect(() => {
    // Multi-candidate Tab row owns the chrome — no parallel ghost.
    if (suggestions.length > 0) {
      setGhost(null);
      return;
    }
    // Only propose when the caret is at the end (ghost is a trailing suffix).
    if (cursor !== value.length) {
      setGhost(null);
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    const delay = Math.max(0, ghostDebounceMs);

    const tryModelGhost = (lineToCursor: string, local: GhostSuggestion | null, kind: string): void => {
      if (cancelled) return;
      const enabled = modelGhostEnabledRef.current === true;
      const port = suggestGhostRef.current;
      if (
        !shouldOfferModelGhost({ enabled, local, line: lineToCursor, kind }) ||
        port === undefined
      ) {
        if (!cancelled && local === null) setGhost(null);
        return;
      }
      const requestedValue = valueRef.current;
      const requestedCursor = cursorRef.current;
      void port(lineToCursor, ac.signal)
        .then((raw) => {
          if (cancelled || ac.signal.aborted) return;
          if (valueRef.current !== requestedValue || cursorRef.current !== requestedCursor) return;
          // Re-check local still empty at resolve time (another path may have filled).
          if (local !== null) return;
          const model = parseModelGhostCompletion(lineToCursor, raw ?? undefined);
          if (model !== null) setGhost(model);
        })
        .catch(() => {
          /* fail-soft: leave ghost as-is (null or prior local) */
        });
    };

    const timer = setTimeout(() => {
      const lineToCursor = valueRef.current.slice(0, cursorRef.current);
      const classified = classifyCompletion(lineToCursor);
      const hints = goalHintsRef.current;
      const ghostInput = {
        line: lineToCursor,
        history: historyRef.current,
        recentCompletions: recentCompletionsRef.current,
        ...(hints !== undefined ? { goalHints: hints } : {}),
      };
      const base = proposeGhost(ghostInput);

      // Prose / empty / pure slash already covered. For path/@ (and slash when
      // pure missed), enrich with completeChat hits — still no model call first.
      const needsAsync =
        classified.kind === 'path' ||
        classified.kind === 'mention' ||
        (classified.kind === 'slash-name' && base === null) ||
        (classified.kind === 'slash-arg' && base === null);

      if (!needsAsync) {
        if (!cancelled) {
          if (base !== null) {
            setGhost(base);
          } else {
            setGhost(null);
            tryModelGhost(lineToCursor, null, classified.kind);
          }
        }
        return;
      }

      if (base && !cancelled) setGhost(base);

      const requestedValue = valueRef.current;
      const requestedCursor = cursorRef.current;
      void completeChat(lineToCursor, {
        dynamicWorldItems: dynamicWorldItemsRef.current ?? [],
      })
        .then(([hits]) => {
          if (cancelled) return;
          if (valueRef.current !== requestedValue || cursorRef.current !== requestedCursor) return;
          const enriched = proposeGhost({
            ...ghostInput,
            completionHits: hits,
          });
          if (enriched !== null) {
            setGhost(enriched);
            return;
          }
          // Local (incl. path/@) empty → optional model (only for prose kinds).
          tryModelGhost(lineToCursor, null, classified.kind);
        })
        .catch(() => {
          /* fail-soft: keep base ghost or try model on prose */
          if (!cancelled && base === null) {
            tryModelGhost(lineToCursor, null, classified.kind);
          }
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      try {
        ac.abort();
      } catch {
        /* abort is best-effort */
      }
    };
  }, [
    value,
    cursor,
    history,
    suggestions.length,
    ghostDebounceMs,
    goalHints,
    dynamicWorldItems,
    modelGhostEnabled,
    suggestGhost,
  ]);

  // Ink subscribes the callback passed to useInput in a passive effect. Keep that
  // callback stable across renders so visibility/menu transitions cannot briefly
  // remove the only stdin listener and drop an EventEmitter input event. The ref is
  // refreshed during render, so the stable subscriber always invokes current editor
  // state and callbacks.
  const inputHandlerRef = useRef<Parameters<typeof useInput>[0]>(() => undefined);
  inputHandlerRef.current = (input, key): void => {
    // Optional mouse reports (P1.3): never type SGR click sequences into the buffer.
    // When a menu/confirm readKey is pending, forward the report so list screens
    // (accounts) can hit-test rows. Legend / ControlPanel still own their own
    // useInput clicks when no menu read is pending.
    if (input.length > 0 && isMouseInput(input)) {
      if (readPending?.() === true) {
        onReadKey?.(input, key as KeyCaptureFlagsLike);
      }
      return;
    }

    // --- Always-hot Ctrl+G → toggle Control Panel (any buffer) -----------------
    // Draft-preserving panel chord. When the callback is absent or returns false,
    // fall through to the existing handler chain (menu single-key capture when off).
    if (key.ctrl && input === 'g') {
      if (onToggleFullscreenPanel?.() === true) return;
    }

    // --- Always-hot Ctrl+B → hierarchical back (any buffer; draft preserved) --
    if (key.ctrl && (input === 'b' || input === '\x02')) {
      onEmptyLeft?.();
      return;
    }

    // --- Pending menu/confirm read -------------------------------------------
    // This is the first dispatch branch: exactly one continuously-mounted input
    // consumer serves both menu capture and editor input, with no listener handoff.
    if (readPending?.() === true) {
      onReadKey?.(input, key as KeyCaptureFlagsLike);
      return;
    }

    // --- Bare ESC → process exit / interrupt (App installs the handler) ------
    // Multi-chat PR-A: Esc exits the myshell process after draft flush (menu
    // installs control.exit). Mid-turn the same chord aborts the foreground turn
    // and exits. Suggestions / ghost dismiss first so Esc never black-holes.
    // Only the standalone Escape key is intercepted (key.escape && no input
    // payload): typed-ahead characters and Alt-chord escapes are untouched.
    if (key.escape && input === '' && suggestions.length > 0) {
      setSuggestions([]);
      setSuggIndex(0);
      lastCompletionRef.current = null;
      setGhost(null);
      return;
    }
    if (key.escape && input === '' && ghost !== null) {
      setGhost(null);
      return;
    }
    if (key.escape && input === '' && onEscape?.() === true) return;

    // --- Submit vs newline ---------------------------------------------------
    if (key.return) {
      if (key.meta || key.shift) {
        // Alt/Option+Enter or Shift+Enter → insert a newline (multiline compose).
        // NEVER submits, even on a multiline buffer.
        replace(value.slice(0, cursor) + '\n' + value.slice(cursor), cursor + 1);
        return;
      }
      // A plain single Enter keypress submits the whole (possibly multiline)
      // buffer. When browsing history (Up filled the buffer), Enter sends that
      // selection — message-select: Up inserts, Enter sends.
      // `key.return` is only set for a SINGLE-char `\r`/`\x1b\r` keypress
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

    // --- Empty-buffer letter nav (multi-chat PR-A product keys) ---------------
    // - empty buffer + bare `b` → hierarchical back (onEmptyLeft)
    // - empty buffer + bare `c` → control panel (onEmptyRight)
    // - non-empty buffer: b/c type as letters (fall through to printable)
    // - ←/→ are always cursor movement (empty-buffer arrow nav removed)
    // - Ctrl+G remains always-hot panel toggle; Ctrl+B always-hot back (above)
    if (
      value === '' &&
      !key.meta &&
      !key.ctrl &&
      !key.shift &&
      input.length === 1
    ) {
      const ch = input.toLowerCase();
      if (ch === 'b') {
        onEmptyLeft?.();
        return;
      }
      if (ch === 'c') {
        onEmptyRight?.();
        return;
      }
    }

    // --- Cursor movement -----------------------------------------------------
    // ←/→ are cursor only (no nav). Word-movement is Ctrl+arrow.
    if (key.leftArrow) {
      if (key.ctrl) setCursor(wordLeft(value, cursor));
      else setCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      if (key.ctrl) setCursor(wordRight(value, cursor));
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

    // --- Shift+Tab → cycle conversation Effort Mode (P0.8) -------------------
    // Distinct from plain Tab autocomplete. Consumed even with a non-empty buffer
    // so the mode dial is always reachable mid-compose. Does not change global
    // config.mode — the Node-side handler persists via ConversationStore.setMode.
    if (key.tab && key.shift) {
      onShiftTab?.();
      return;
    }

    // --- Tab → ghost accept (P0.18) then autocomplete (T1–T4 engine) ---------
    // When a ghost is showing, Tab accepts it into the buffer (Claude Code class).
    // Otherwise fall through to the existing slash/path/@ multi-candidate path.
    // Plain prose with NO ghost remains a strict no-op (never insert a literal '\t').
    // Shift+Tab is handled above and never reaches here.
    if (key.tab) {
      if (ghost !== null && ghost.suffix.length > 0) {
        const applied = applyGhost(value, cursor, ghost);
        rememberCompletion(applied.value.slice(0, applied.cursor));
        setGhost(null);
        replace(applied.value, applied.cursor);
        return;
      }

      const lineToCursor = value.slice(0, cursor);
      const classified = classifyCompletion(lineToCursor);
      if (classified.kind === 'none') {
        // Plain prose (or a free-text slash arg) without a ghost → deliberate no-op.
        // Do NOT fall through to the printable catch-all (which would insert '\t').
        return;
      }
      lastCompletionRef.current = { token: classified.token };

      // Splice `candidate` over the trailing token (length cached above), preserving
      // any text to the RIGHT of the cursor. For slash-NAME the token is the whole
      // line-to-cursor and the candidate is the full command, so this replaces it.
      const accept = (candidate: string): void => {
        const tokenLen = lastCompletionRef.current?.token.length ?? 0;
        const head = value.slice(0, Math.max(0, cursor - tokenLen));
        const tail = value.slice(cursor);
        const next = head + candidate + tail;
        rememberCompletion(next.slice(0, head.length + candidate.length));
        replace(next, head.length + candidate.length);
      };

      if (suggestions.length > 0) {
        // Cycle: advance the highlight (wrap) and splice the now-selected candidate.
        const nextIdx = (suggIndex + 1) % suggestions.length;
        const candidate = suggestions[nextIdx];
        if (candidate !== undefined) {
          accept(candidate);
          // replace() cleared suggestions; re-show them so the row survives the
          // cycle (React batches these later sets to win).
          setSuggestions(suggestions);
          setSuggIndex(nextIdx);
        }
        return;
      }

      // No candidates yet → ask the engine. Fire-and-forget; ignore a stale resolve.
      const requestedValue = value;
      const requestedCursor = cursor;
      void completeChat(lineToCursor, { dynamicWorldItems: dynamicWorldItems ?? [] }).then(([hits]) => {
        // Race guard: drop the resolve if the buffer/cursor moved since the request
        // (compare against the LIVE refs, not the stale captured render state).
        if (valueRef.current !== requestedValue || cursorRef.current !== requestedCursor) return;
        if (hits.length === 0) return;
        if (hits.length === 1) {
          // Exactly one hit → auto-accept immediately, no candidate row.
          accept(hits[0] ?? '');
          return;
        }
        setSuggestions(hits);
        setSuggIndex(0);
      });
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
  };
  const stableInputHandler = useCallback<Parameters<typeof useInput>[0]>((input, key) => {
    inputHandlerRef.current(input, key);
  }, []);
  useInput(stableInputHandler, { isActive: active && !suspended });

  // Eager raw-mode arm for the (Replit /dev/tty) stream the instant the editor
  // is live. Ink's internal effect will also do this, but doing it here on mount
  // (and on !suspended flips) removes any 1-frame window after chat resume or
  // after a single-key handoff where keystrokes could be delayed or dropped.
  useEffect(() => {
    if (!suspended && isRawModeSupported) {
      try {
        setRawMode(true);
      } catch {
        /* best-effort; Ink will also attempt */
      }
    }
  }, [suspended, isRawModeSupported, setRawMode]);

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  // The shown-rows plan (the SAME pure helper the height budget uses) — computed
  // unconditionally (before any early return) so the measurement effect below runs
  // on EVERY render path and the React hook order never changes.
  const shownPlan = composerShownPlan(value, columns ?? 80, rows);
  const firstShown = shownPlan.firstShown;
  const shownRows = shownPlan.shown;
  const canBox = isTty && color && (columns ?? 80) >= INPUT_BOX_MIN_COLUMNS;

  // The TRUE rendered PHYSICAL height to report up to App's height-budget planner
  // (BUG 1): when hidden (menu prompt) the box is ONE plain row; the bordered box
  // draws `physical` wrapped body rows between its 2 rule rows; the `⏎ queued (N)`
  // indicator collapses the body to ONE row; the plain (non-box) fallback has NO
  // borders. App defaults to INPUT_ROWS before the first measurement. This effect is
  // placed ABOVE all early returns so the hook order is identical on every path
  // (React forbids a changing hook count between renders).
  const measuredRows = !visible
    ? 1
    : queued > 0
      ? 1 + INPUT_BORDER_ROWS
      : canBox
        ? shownPlan.physical + INPUT_BORDER_ROWS + (suggestions.length > 0 ? 1 : 0)
        : shownPlan.physical;
  useEffect(() => {
    onMeasureRows?.(measuredRows);
  }, [onMeasureRows, measuredRows]);

  // Composer hidden (NOT a chat conversation: menu / auth-login / settings). The
  // composer chrome (full-width rules, Mode chip, ❯ caret) belongs to an active chat
  // ONLY — here we render NOTHING visible. We deliberately do NOT print a `❯ press a
  // key` hint: every single-key read site (main menu `> `, settings `[1/2/3 …]`,
  // welcome/mode, raw-session, conversations, auth sign-in, y/n confirms) already
  // writes its OWN visible prompt before blocking on the key, so an extra hint here
  // is REDUNDANT — it stacked a stray dim `❯ press a key` under the menu's own `>`
  // prompt (looked like a glitch) and also flashed at the very top during the
  // pre-menu mount window (Ink mounts before the banner/menu paints). We still return
  // exactly ONE <Box> line (NOT literal null / a bare string child — either crashes
  // Ink) holding a single space, so the `useInput`/`useStdin` hooks above stay
  // mounted and active: Ink keeps raw mode armed (single-key menu nav via
  // menu-key capture works) and the LineReader's suspend()/resume() stdin control stays
  // registered. Keeping one <Box> also avoids forcing a re-mount when visibility
  // toggles (the hooks persist).
  if (!visible) {
    return (
      <Box>
        <Text> </Text>
      </Box>
    );
  }

  // The display rows (shownPlan) and `canBox` were computed above (before the early
  // returns) so the measurement effect's hook order is stable. The caret row/col is
  // derived from the flat cursor so movement lands on the correct row; the tail
  // logical rows shown — and their wrapped physical height — fit the viewport, so a
  // huge/long paste can't blow past it AND the reported height matches the planner's
  // reservation exactly.
  // Ghost is a trailing dim suffix only when caret is at end and we have a proposal.
  const ghostSuffix =
    ghost !== null &&
    ghost.suffix.length > 0 &&
    cursor === value.length &&
    suggestions.length === 0
      ? ghost.suffix
      : '';
  const lastBufferRow = Math.max(0, value.split('\n').length - 1);

  if (!canBox) {
    return (
      <Box flexDirection="column">
        {shownRows.map((line, i) => {
          const absRow = firstShown + i;
          const prefix = absRow === 0 ? `${CARET} ` : CONT_GUTTER;
          const tail = absRow === lastBufferRow && ghostSuffix ? ghostSuffix : '';
          return <Text key={absRow}>{`${prefix}${line}${tail}`}</Text>;
        })}
      </Box>
    );
  }

  const width = composerWidth(columns);
  const inputWidth = Math.max(1, width - 2);
  const rules = composerRules(width, info ?? INFO_FALLBACK, color);
  // NOTE: composerContentWidth(columns) === inputWidth - 2 — the SAME wrap width
  // used by composerShownPlan above, so the rendered physical height equals the
  // measured (reported) height to the row.

  // Compact Tab-completion candidate row: rendered ABOVE the composer's top rule
  // when suggestions are showing. Capped to ~6 candidates, space-separated, dim;
  // the selected one (suggIndex) is highlighted cyan.
  const SUGGESTION_CAP = 6;
  const suggestionRow =
    suggestions.length > 0 ? (
      <Text>
        {suggestions.slice(0, SUGGESTION_CAP).map((s, i) => (
          <Text key={s}>
            {i > 0 ? ' ' : ''}
            {i === suggIndex ? cyan(s, color) : dim(s, color)}
          </Text>
        ))}
      </Text>
    ) : null;

  return (
    <Box flexDirection="column">
      {suggestionRow}
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
          const showGhostHere = absRow === lastBufferRow && ghostSuffix.length > 0;
          // Empty prompt with a goal-aware ghost: show the dim ghost (not the
          // generic "Type a message..." placeholder) so Tab-on-empty is discoverable.
          const isPlaceholder = line === '' && isFirst && value === '' && !showGhostHere;
          const dynCount = (dynamicWorldItems ?? []).length;
          const ph = smartPlaceholder(pressure, dynCount > 0, dynCount);
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
                {isPlaceholder ? (
                  <Text wrap="truncate-end">{dim(ph, color)}</Text>
                ) : showGhostHere ? (
                  <Text wrap="wrap">
                    {line}
                    {dim(ghostSuffix, color)}
                  </Text>
                ) : (
                  <Text wrap="wrap">{line}</Text>
                )}
              </Box>
            </Box>
          );
        })
      )}
      <Text>{rules.bottom}</Text>
    </Box>
  );
}
