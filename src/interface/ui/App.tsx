/**
 * src/interface/ui/App.tsx — Ink chat UI (Ink migration, default ON via flag).
 *
 * Full modern chat surface: <Static> transcript, <StatusBlock> (goals/agents/tokens),
 * live <Stream>, advanced <InputBox> (history, multiline, queued). Supports chat
 * active toggle, single-key reads, interrupts, stdin control for suspend/resume.
 * Legacy path remains byte-identical when flag off. The App is driven imperatively
 * via the bridge from Node side (menu, renderStreamInk).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Static, Text, useStdout } from 'ink';
import { InputBox, createInputBoxBridge, type InputBoxBridge } from './InputBox.js';
import { Stream, CommittedLine } from './Stream.js';
import { StatusBlock } from './StatusBlock.js';
import { GoalsPanel } from './GoalsPanel.js';
import { ControlPanel } from './ControlPanel.js';
import { BottomLegend } from './BottomLegend.js';
import { layoutForHeight, streamWrappedRows, tailStreamToRows, INPUT_ROWS, LEGEND_ROWS } from './layout.js';
import { backfillTerminalSize } from './mount.js';
import type { Action, TranscriptLine, UiState } from './state.js';

export interface InputBoxInfo {
  readonly mode: string;
  readonly hints: readonly string[];
}

function formatInputBoxInfo(info: InputBoxInfo | null): string | undefined {
  if (info === null) return undefined;
  return `Mode: ${info.mode} · ${info.hints.join(' · ')}`;
}

/**
 * The subset of {@link Action} the renderer may route through the bridge for
 * the goals panel. Excludes configure (Node-owned) and open (only toggle opens).
 */
export type GoalsPanelBridgeAction =
  | Extract<Action, { type: 'goals-panel/toggle' }>
  | Extract<Action, { type: 'goals-panel/close' }>
  | Extract<Action, { type: 'goals-panel/highlight' }>;

/**
 * The subset of {@link Action} the renderer may route through the bridge for
 * the Control Panel. Excludes configure (Node-owned) and open (only toggle opens).
 */
export type ControlPanelBridgeAction =
  | Extract<Action, { type: 'control-panel/toggle' }>
  | Extract<Action, { type: 'control-panel/open' }>
  | Extract<Action, { type: 'control-panel/close' }>
  | Extract<Action, { type: 'control-panel/set-section' }>
  | Extract<Action, { type: 'control-panel/highlight-goal' }>;

/**
 * The Ink-side control surface the LineReader's `suspend()`/`resume()` need to
 * perform the inherited-stdio child handoff WITHOUT touching `process.stdin`
 * directly. The `<InputBox>` registers this on mount from inside Ink's
 * `useStdin()` context, so the Node side drives INK's own raw-mode toggle (the
 * one Ink re-applies on every render) and pauses the exact stream Ink reads —
 * whether that is `process.stdin` or the `/dev/tty` fallback passed to
 * `render(node, { stdin })`.
 *
 * Mirrors the legacy menu-readline.ts `KeyInputStream` quirks (setRawMode cycle
 * to re-prime libuv's read handle; pause/resume the stream) but routed through
 * Ink so Ink does not fight the child for fd0.
 */
export interface InkStdinControl {
  /** Ink's `setRawMode` (NOT `process.stdin.setRawMode`) — see useStdin docs. */
  setRawMode(value: boolean): void;
  /** True iff the underlying stdin stream supports raw mode (Ink's TTY signal). */
  readonly isRawModeSupported: boolean;
}

/**
 * The imperative bridge between the React tree and the Node-side adapters
 * (OutputSink / LineReader). Created in mount.tsx BEFORE render() and handed to
 * both the adapters and the <App/>. The App registers its state setters on mount
 * so the Node side can push transcript lines in and receive submitted input out.
 *
 * The input-editing seam (submit, history seed, queued-count, in-progress line)
 * is delegated to a nested {@link InputBoxBridge} (`input`), which the real
 * `<InputBox>` editor drives. The LineReader uses both: `commit`/`onSubmit` for
 * the I/O, and `input` for the read-side `currentLine()`/`beginCapture` mirror.
 */
export interface InkAppBridge {
  /** Append one already-safe committed line to the <Static> transcript. */
  commit(line: string): void;
  /**
   * Push the latest reducer {@link UiState} so the App renders the structured
   * transcript (committed lines via `<Static>`, colour-by-kind) AND the live
   * answer buffer via `<Stream>`. This is the STEP-3b streaming seam: the Node
   * side runs `renderStreamInk` into the pure reducer and mirrors each snapshot
   * here. When unused, the App falls back to the plain string `commit` transcript
   * (the Step-1 scaffolding), so the flag-off path and the input-only mode are
   * unaffected.
   */
  pushState(state: UiState): void;
  /** Register the callback invoked when the user submits an input line. The
   *  LineReader sets this; the InputBox calls it on Enter (UNTRIMMED). */
  onSubmit(handler: (line: string) => void): void;
  /** The nested input-editor bridge (history, queued indicator, currentLine). */
  readonly input: InputBoxBridge;
  /**
   * Flip the App's suspended state. When `true`, `<InputBox>`'s `useInput`
   * becomes `isActive: false` so Ink relinquishes its raw-mode refcount (the
   * inherited-stdio child can then own the TTY). Set by `<App/>` on mount; called
   * by the LineReader's `suspend()`/`resume()`. No-op before the App mounts.
   */
  setSuspended(value: boolean): void;
  setInputInfo(info: InputBoxInfo | null): void;
  /**
   * Flip whether an ACTIVE CHAT CONVERSATION is in progress. When `true`, the App
   * renders the full chat composer (the `─ chat ─┌ Mode … ┐` rule + `❯` caret +
   * closing rule). When `false` (the DEFAULT — the app opens at the menu, and
   * during auth/login/settings sub-flows and raw-session), NO composer is shown.
   *
   * The menu loop sets this `true` at `runChatLoop` entry and `false` in a
   * `finally` on exit, mirroring how {@link InkAppBridge.setInputInfo} is threaded.
   * Menu single-key nav (`readKey`) and the transcript/status/stream
   * regions work in BOTH modes — a hidden input keeps Ink's raw mode + stdin
   * control armed while the composer chrome is gone. No-op before the App mounts.
   */
  setChatActive(active: boolean): void;
  /**
   * Read EXACTLY ONE keypress through Ink's OWN input pipeline (no competing raw
   * `process.stdin` listener that would fight Ink). Resolves with a string shaped
   * like the legacy menu-readline.ts `readSingleKey` output so `readMenuKey` /
   * `confirmViaKey` interpret it unchanged:
   *   - a printable char → that char (e.g. `'n'`, `'5'`),
   *   - Enter → `'\r'`, Escape → `'\x1b'`,
   *   - Ctrl-C → `'\x03'`, Ctrl-D → `'\x04'`,
   *   - arrows / other non-printables → a multi-byte sentinel (`length > 1`) so the
   *     menu treats them as a no-op, exactly like a raw `'\x1b[A'` arrow sequence.
   *
   * The continuously-mounted `<InputBox>` input consumer checks the pending resolver
   * before editing, so the NEXT key resolves the read and exactly one key is consumed.
   * A read started while suspended (a child owns the TTY) stays parked until resume().
   *
   * The Node side (menu loop) drives this in place of the legacy single-key raw
   * read on the Ink path; chat-message input still flows through the InputBox.
   */
  readKey(): Promise<string>;
  /**
   * Set (or clear with `null`) the turn-interrupt handler. While a model turn is
   * in flight the menu loop installs a handler that aborts the turn's
   * AbortController (the Ink twin of the legacy raw-mode ESC→`currentAc.abort()`
   * listener); it clears the handler when the turn settles. When a handler is set,
   * the `<InputBox>` treats a bare ESC as "interrupt this turn" instead of an edit
   * — typed-ahead characters still queue, only ESC interrupts. `null` (idle) → ESC
   * is a no-op at the prompt (no regression).
   */
  setInterrupt(handler: (() => void) | null): void;
  /**
   * Invoke the installed turn-interrupt handler if one is set. Returns `true` when
   * a handler ran (ESC was consumed as an interrupt), `false` when idle (no handler
   * → the caller should not treat ESC as an interrupt). Called by the `<InputBox>`
   * on a bare ESC keypress during a turn.
   */
  interrupt(): boolean;
  /**
   * Register (or clear with `null`) the Node-side handler for goals-panel
   * actions. When a handler is set, `routeGoalsPanelAction` forwards the action
   * there; when null, routing returns false (off path). Called by the mount
   * once at init; never changed afterward.
   */
  onGoalsPanelAction(handler: ((action: GoalsPanelBridgeAction) => void) | null): void;
  /**
   * Route a goals-panel action through the bridge from the React tree (InputBox
   * Ctrl+G). Returns `false` when no handler is armed (feature off — the caller
   * falls through to the existing key handler). When a handler is set, invokes it
   * once and returns `true`.
   */
  routeGoalsPanelAction(action: GoalsPanelBridgeAction): boolean;
  /**
   * Register (or clear with `null`) the Node-side handler for control-panel
   * actions. When a handler is set, `routeControlPanelAction` forwards the action
   * there; when null, routing returns false (off path). Called by the mount
   * once at init; never changed afterward.
   */
  onControlPanelAction(handler: ((action: ControlPanelBridgeAction) => void) | null): void;
  /**
   * Route a control-panel action through the bridge from the React tree (InputBox
   * Ctrl+G). Returns `false` when no handler is armed (feature off — the caller
   * falls through to the existing key handler). When a handler is set, invokes it
   * once and returns `true`.
   */
  routeControlPanelAction(action: ControlPanelBridgeAction): boolean;
  /**
   * Register the Ink-side stdin control (raw-mode toggle + stream pause/resume).
   * The `<InputBox>` calls this from inside `useStdin()` on mount; the LineReader
   * reads it in `suspend()`/`resume()`. `null` after unmount.
   */
  attachStdinControl(control: InkStdinControl | null): void;
  /** The currently-attached Ink stdin control, or null before mount. @internal */
  readonly stdinControl: InkStdinControl | null;
  // --- wired by <App/> on mount; consumed by commit() ---
  /** @internal set by App on mount */ _setLines?:
    | ((fn: (prev: string[]) => string[]) => void)
    | undefined;
  /** @internal set by App on mount */ _setSuspended?: ((value: boolean) => void) | undefined;
  /** @internal set by App on mount */ _setInputInfo?: ((value: InputBoxInfo | null) => void) | undefined;
  /** @internal set by App on mount */ _setChatActive?: ((value: boolean) => void) | undefined;
  /** @internal set by App on mount */ _setUiState?: ((state: UiState) => void) | undefined;
  /** @internal the pending single-key resolver, set by readKey(), consumed (once)
   *  by the InputBox input consumer. Cleared after exactly one key is delivered. */
  _keyResolver?: ((key: string) => void) | null;
  /** @internal the installed turn-interrupt handler, set by setInterrupt(); read
   *  by the InputBox's bare-ESC branch. `null`/undefined when idle. */
  _interrupt?: (() => void) | null;
  /** @internal the installed goals-panel action handler, set by
   *  onGoalsPanelAction(); read by routeGoalsPanelAction(). `null` when the
   *  feature flag is off. */
  _goalsPanelAction?: ((action: GoalsPanelBridgeAction) => void) | null;
  /** @internal the installed control-panel action handler, set by
   *  onControlPanelAction(); read by routeControlPanelAction(). `null` when the
   *  feature flag is off. */
  _controlPanelAction?: ((action: ControlPanelBridgeAction) => void) | null;
  /** @internal the attached Ink stdin control */ _stdinControl?: InkStdinControl | null;
  /**
   * Enable or disable the main-menu key-capture window. While active, a printable
   * key arriving while NO readKey resolver is pending is queued in a small FIFO
   * (instead of falling into the hidden InputBox editor) so it is consumed by the
   * NEXT readKey() in the menu loop. The menu loop sets this true at the top of
   * each iteration (before any awaited paint/I/O) and false before entering a
   * sub-flow (chat, settings, login, readLine prompts). Undefined on the legacy
   * (non-Ink) path where no capture is needed.
   */
  setMenuCaptureActive(active: boolean): void;
  /** @internal one-key FIFO drained by readKey() while menu capture is active */
  _menuKeyQueue: string[];
  /** @internal true when the main menu loop has armed capture */
  _menuCaptureActive: boolean;
}

/**
 * Build an {@link InkAppBridge}. The App attaches its `_setLines` setter on
 * mount; the LineReader attaches submit via {@link InkAppBridge.onSubmit} (which
 * forwards to the nested input bridge).
 */
export function createInkAppBridge(): InkAppBridge {
  const input = createInputBoxBridge();
  const bridge: InkAppBridge = {
    input,
    _stdinControl: null,
    _keyResolver: null,
    _interrupt: null,
    _goalsPanelAction: null,
    _controlPanelAction: null,
    _menuKeyQueue: [],
    _menuCaptureActive: false,
    commit(line: string): void {
      bridge._setLines?.((prev) => [...prev, line]);
    },
    pushState(state: UiState): void {
      bridge._setUiState?.(state);
    },
    onSubmit(handler: (line: string) => void): void {
      input.onSubmit(handler);
    },
    setSuspended(value: boolean): void {
      bridge._setSuspended?.(value);
    },
    setInputInfo(info: InputBoxInfo | null): void {
      bridge._setInputInfo?.(info);
    },
    setChatActive(active: boolean): void {
      bridge._setChatActive?.(active);
    },
    readKey(): Promise<string> {
      // Drain the menu FIFO before awaiting a new key. A key queued during paint
      // or ledger refresh (while menu capture was active but no resolver pending)
      // is returned immediately; otherwise the resolver arms for the next key.
      if (bridge._menuCaptureActive && bridge._menuKeyQueue.length > 0) {
        const queued = bridge._menuKeyQueue.shift();
        if (queued !== undefined) return Promise.resolve(queued);
      }
      if (bridge._keyResolver != null) {
        return Promise.reject(new Error('InkAppBridge: readKey already pending'));
      }
      return new Promise<string>((resolve) => {
        bridge._keyResolver = resolve;
      });
    },
    setMenuCaptureActive(active: boolean): void {
      bridge._menuCaptureActive = active;
      if (!active) bridge._menuKeyQueue.length = 0;
    },
    setInterrupt(handler: (() => void) | null): void {
      bridge._interrupt = handler;
    },
    interrupt(): boolean {
      const handler = bridge._interrupt;
      if (handler == null) return false;
      handler();
      return true;
    },
    onGoalsPanelAction(handler: ((action: GoalsPanelBridgeAction) => void) | null): void {
      bridge._goalsPanelAction = handler;
    },
    routeGoalsPanelAction(action: GoalsPanelBridgeAction): boolean {
      const handler = bridge._goalsPanelAction;
      if (handler == null) return false;
      handler(action);
      return true;
    },
    onControlPanelAction(handler: ((action: ControlPanelBridgeAction) => void) | null): void {
      bridge._controlPanelAction = handler;
    },
    routeControlPanelAction(action: ControlPanelBridgeAction): boolean {
      const handler = bridge._controlPanelAction;
      if (handler == null) return false;
      handler(action);
      return true;
    },
    attachStdinControl(control: InkStdinControl | null): void {
      bridge._stdinControl = control;
    },
    get stdinControl(): InkStdinControl | null {
      return bridge._stdinControl ?? null;
    },
  };
  return bridge;
}

// ---------------------------------------------------------------------------
// ErrorBoundary — keep a render/reducer throw from leaving the TTY in raw mode.
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  /** The teardown to run on a caught render error — mirrors mount.tsx's unmount:
   *  resolve any pending readKey with '\x03', close the reader (resolve nextLine
   *  waiters with null), and restore cooked mode. Best-effort; never throws. */
  readonly onError: (error: Error) => void;
  /** Emit colour in the fallback line (mirrors OutputSink.color). Default true. */
  readonly color?: boolean;
  readonly children?: React.ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * A minimal React error boundary around the App body. If `reduce()` or any view
 * throws during render, Ink would otherwise unmount UNCAUGHT — the pending
 * readKey() resolver would never resolve and reader.close() would never run,
 * leaving stdin in raw mode and any awaiting read hung. This boundary catches the
 * throw, renders a concise fallback line, and invokes the SAME teardown the
 * unmount path does (via `onError`), so a render crash degrades cleanly instead of
 * wedging the terminal.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Run the unmount-path teardown so the TTY is restored and no reader hangs.
    try {
      this.props.onError(error);
    } catch {
      /* teardown is best-effort — never re-throw out of the boundary */
    }
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (error !== null) {
      const color = this.props.color ?? true;
      const message = error.message || String(error);
      return (
        <Box>
          <Text {...(color ? { color: 'red' as const } : {})}>{`[error] interface crashed: ${message}`}</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}

export interface AppProps {
  readonly bridge: InkAppBridge;
  /** Emit ANSI colour in the input box (mirrors OutputSink.color). Default true. */
  readonly color?: boolean;
  /** Whether stdout is a TTY (gates the bordered box). Default true. */
  readonly isTty?: boolean;
  /** Terminal width for the input box (defaults to stdout columns at render). */
  readonly columns?: number | undefined;
  /** Terminal height (rows) for the StatusBlock height cap. Defaults to stdout
   *  rows at mount; mount backfills it so it is always >= 2. */
  readonly rows?: number | undefined;
  /**
   * An INJECTED wall-clock (ms) for the StatusBlock's live elapsed `· Ns` (never
   * `Date.now` inside the React tree). Supplied by the impure mount boundary.
   * Omitted in tests → no fabricated elapsed.
   */
  readonly clock?: (() => number) | undefined;
  /**
   * Injected by mount.tsx: the part of the unmount-path teardown the React tree
   * cannot do itself — close the LineReader (resolve every pending/future
   * nextLine() with null) and unmount the Ink instance. The {@link ErrorBoundary}
   * calls this after it has restored cooked mode + resolved any pending readKey,
   * so a render/reducer throw tears down exactly like a normal unmount. Omitted in
   * tests → the boundary still restores the TTY but skips reader/instance teardown.
   */
  readonly onFatalError?: ((error: Error) => void) | undefined;
}

/**
 * Normalize one Ink `useInput(input, key)` event into a string shaped like the
 * legacy menu-readline.ts `readSingleKey` output, so `readMenuKey` /
 * `confirmViaKey` (and `interpretYesNoKey`) interpret the Ink path identically to
 * the legacy raw-TTY path. Pure; the single source of truth for the mapping.
 */
export function normalizeInkKey(input: string, key: KeyCaptureFlags): string {
  // Control bytes first — Ctrl-C / Ctrl-D map to the legacy ETX / EOT so the menu
  // exits and a confirm aborts exactly as on a raw TTY.
  if (key.ctrl && (input === 'c' || input === '\x03')) return '\x03';
  if (key.ctrl && (input === 'd' || input === '\x04')) return '\x04';
  // Enter → CR (legacy readSingleKey reports '\r'); the menu treats it as a no-op
  // re-render and a confirm takes the default.
  if (key.return) return '\r';
  // Escape → the bare-ESC byte (length 1 but not printable → menu no-op).
  if (key.escape) return '\x1b';
  // Arrows / Tab / function keys → a multi-byte sentinel (length > 1) so the menu
  // ignores them, mirroring how a raw '\x1b[A' arrow sequence is ignored.
  if (key.upArrow) return '\x1b[A';
  if (key.downArrow) return '\x1b[B';
  if (key.leftArrow) return '\x1b[D';
  if (key.rightArrow) return '\x1b[C';
  if (key.tab) return '\x1b[tab';
  // A single printable char → that char (the menu choice / y/n letter). Anything
  // empty or multi-char (a paste/escape blob) falls through unchanged: an empty
  // string and a multi-char string are both menu no-ops.
  return input;
}

/** The slice of Ink's `key` object the single-key capture reads. */
export interface KeyCaptureFlags {
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly ctrl?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly tab?: boolean;
}

/**
 * The Ink chat app, wrapped in an {@link ErrorBoundary} so a render/reducer throw
 * restores the TTY (cooked mode, resolved readKey, closed reader) instead of
 * leaving stdin wedged in raw mode. The boundary's teardown mirrors mount.tsx's
 * unmount path: resolve any pending readKey with '\x03' + restore cooked mode here
 * (the bits the React tree owns), then delegate reader.close()/instance.unmount()
 * to the injected `onFatalError`.
 */
export function App(props: AppProps): React.ReactElement {
  const { bridge, color = true, onFatalError } = props;
  const onBoundaryError = (error: Error): void => {
    // 1. Resolve a pending single-key read so the awaiting readMenuKey/confirm does
    //    not orphan and hang forever (mount.tsx unmount M1). Null the resolver
    //    BEFORE invoking so a double-resolve is a safe no-op.
    const pendingKey = bridge._keyResolver;
    bridge._keyResolver = null;
    bridge._menuKeyQueue.length = 0;
    bridge._menuCaptureActive = false;
    if (pendingKey != null) pendingKey('\x03');
    // 2. Restore cooked mode via Ink's stdin control (never process.stdin directly),
    //    if one is attached — so the terminal is not left in raw mode.
    try {
      bridge.stdinControl?.setRawMode(false);
    } catch {
      /* best-effort */
    }
    // 3. Delegate the rest of the unmount-path teardown (reader.close() + Ink
    //    instance.unmount()) to the mount boundary.
    onFatalError?.(error);
  };
  return (
    <ErrorBoundary onError={onBoundaryError} color={color}>
      <AppBody {...props} />
    </ErrorBoundary>
  );
}

const CommittedTranscript = React.memo(function CommittedTranscript({
  lines,
  color,
}: {
  readonly lines: readonly TranscriptLine[];
  readonly color: boolean;
}): React.ReactElement {
  const items = React.useMemo(
    () => lines.map((line, index) => ({ line, key: index })),
    [lines],
  );
  return (
    <Static items={items}>
      {(item) => <CommittedLine key={item.key} line={item.line} color={color} />}
    </Static>
  );
});

/**
 * The Ink chat app body: a write-once `<Static>` transcript above a pinned, real
 * `<InputBox>` editor (cursor movement, history, multiline-compose, queued
 * indicator). The transcript region is unchanged from Step 1; all input editing
 * now lives in {@link InputBox}.
 */
function AppBody({
  bridge,
  color = true,
  isTty = true,
  columns,
  rows,
  clock,
}: AppProps): React.ReactElement {
  const { stdout } = useStdout();
  const [lines, setLines] = useState<string[]>([]);
  // The structured reducer snapshot (STEP 3b). `null` until the Node side pushes
  // one — until then the App uses the plain string `lines` transcript (Step 1).
  const [uiState, setUiState] = useState<UiState | null>(null);
  // When true, an inherited-stdio child (e.g. `claude auth login`) owns the TTY:
  // the InputBox's useInput goes inactive so Ink drops its raw-mode refcount.
  const [suspended, setSuspended] = useState(false);
  const [inputInfo, setInputInfo] = useState<InputBoxInfo | null>(null);
  // When true, an active chat conversation is in progress and the full composer
  // (chat rule + caret + closing rule) is shown. FALSE by default — the app opens
  // at the menu, and auth/login/settings sub-flows run with the composer hidden.
  // Toggled by the menu loop via bridge.setChatActive() at runChatLoop entry/exit.
  const [chatActive, setChatActive] = useState(false);
  // The <InputBox>'s TRUE rendered PHYSICAL height (wrapped body + borders),
  // reported up via onMeasureRows (BUG 1). A wrapped/pasted composer occupies more
  // physical rows than the old constant INPUT_ROWS_MAX assumed (it counted 1
  // physical row per shown logical row), which let the dynamic region overflow the
  // viewport and re-trigger Ink's scrollback-duplication glitch. Threading the
  // MEASURED height into layoutForHeight lets the planner shrink the stream/status
  // region to make room so total dynamic rows <= viewport, ALWAYS. Defaults to the
  // single-line INPUT_ROWS until the first measurement lands.
  const [inputBoxRows, setInputBoxRows] = useState(INPUT_ROWS);
  // Bumped on every SIGWINCH (terminal resize). Ink's useStdout does NOT subscribe
  // to 'resize', so without this the cached columns/rows below would go stale after
  // a resize — the layout cap + InputBox width would never re-measure. The counter
  // is read in the render body so a bump forces a re-render that re-reads stdout.
  const [, setResizeNonce] = useState(0);
  const inputInfoText = formatInputBoxInfo(inputInfo);
  const liveColumns = columns ?? stdout.columns ?? process.stdout.columns ?? 80;
  const liveRows = rows ?? stdout.rows ?? process.stdout.rows ?? 24;
  const controlPanelOpen = uiState?.controlPanel.enabled === true && uiState.controlPanel.open === true;
  const goalsPanelOpen = uiState?.controlPanel.enabled !== true &&
    uiState?.goalsPanel.enabled === true && uiState.goalsPanel.open === true;
  const fullscreenPanelOpen = controlPanelOpen || goalsPanelOpen;

  // Wire the bridge to this component's state on mount so the Node-side
  // OutputSink can push committed lines in and the LineReader can toggle suspend.
  useEffect(() => {
    bridge._setLines = setLines;
    bridge._setSuspended = setSuspended;
    bridge._setInputInfo = setInputInfo;
    bridge._setUiState = setUiState;
    bridge._setChatActive = setChatActive;
    return () => {
      bridge._setLines = undefined;
      bridge._setSuspended = undefined;
      bridge._setInputInfo = undefined;
      bridge._setUiState = undefined;
      bridge._setChatActive = undefined;
    };
  }, [bridge]);

  // Subscribe to terminal resizes (SIGWINCH). Ink's useStdout does not, so after a
  // resize the cached liveColumns/liveRows (read once per render above) go stale —
  // the layout cap and InputBox width would never re-measure. On each resize we
  // re-apply backfillTerminalSize (so a resize down to columns 0/1, common under
  // `script`/odd PTYs, recovers to a sane 80×24) and bump a nonce to force ONE
  // re-render that re-reads stdout. The bump is a no-op idempotent state set guarded
  // by the listener firing only on real resize events, so there is no render loop.
  useEffect(() => {
    const onResize = (): void => {
      backfillTerminalSize(stdout);
      setResizeNonce((n) => n + 1);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Derive the live status-region layout ONCE per real content change, memoized so
  // an 80ms spinner tick (now owned by the SpinnerStatusLine leaf, not this tree)
  // and any re-render that does NOT change the inputs below reuses the prior plan
  // instead of re-walking the (growing) stream buffer + re-running the planner
  // TWICE (App + StatusBlock). The same `plan` reference is threaded into
  // <StatusBlock>, so its <Panels> memo stays stable across ticks. The memo key is
  // the FULL set of inputs that affect the plan/stream output — buffer, geometry,
  // and the reducer fields layoutForHeight reads (turnActive, goals, tokens.turn,
  // the panelist count) — so a real update never reuses a stale plan.
  //
  // layoutForHeight is PURE, so memoizing the caller cannot change its return value
  // (ui-layout.test.ts stays green); this only avoids recomputing an identical plan.
  const liveLayout = useMemo(() => {
    if (uiState === null) return null;
    const streamLines = streamWrappedRows(uiState.stream.buffer, liveColumns);
    // BUG 3: the live-frame chrome[] region (the menu's ~30-line frame) renders in a
    // plain <Box> between <Static> and StatusBlock but was OUTSIDE the height budget.
    // turn/start clears chrome (a turn and the menu frame should never coexist — see
    // reduce.ts), but any OTHER action that flips turnActive true (tier-start, panel,
    // …) leaves a lingering frame; if a turn then paints StatusBlock+Stream the total
    // (chrome + plannedRows + input) could exceed the viewport → the duplication
    // glitch. So we SUBTRACT chrome.length from the rows budget here, at the render
    // boundary that emits BOTH regions — provably enforcing total <= viewport
    // independent of reducer event ordering.
    const chromeRows = uiState.chrome.length;
    const budgetRows = Math.max(2, liveRows - chromeRows);
    // BUG 1: reserve the InputBox's MEASURED physical height (not the constant
    // INPUT_ROWS_MAX) so a wrapped/pasted composer cannot push the dynamic region
    // past the viewport. The planner shrinks the stream/status region to fit; the
    // InputBox itself caps its own visible physical rows to the viewport (keeping
    // the caret/tail row) for an extreme paste, so the total is ALWAYS <= viewport.
    const plan = layoutForHeight(uiState, budgetRows, streamLines, inputBoxRows + LEGEND_ROWS);
    const cappedStreamBuffer = tailStreamToRows(uiState.stream.buffer, liveColumns, plan.streamCap);
    return { streamLines, plan, cappedStreamBuffer };
    // The keys are EXACTLY the inputs layoutForHeight / streamWrappedRows /
    // tailStreamToRows read: the live buffer, the geometry, and the reducer fields
    // the planner consults (turnActive gates visibility; goals drive the panel
    // plan; tokens.turn + panelists feed the compact summary / agent count). A push
    // that changes none of these (e.g. a chrome-only commit) safely reuses the plan.
  }, [
    uiState?.stream.buffer,
    uiState?.turnActive,
    uiState?.goals,
    uiState?.tokens.turn,
    uiState?.stream.panelists,
    uiState?.chrome,
    // The persistent board (Elite-partner Phase 1) feeds layoutForHeight too: a
    // board/sync changes the planned region, so the plan must recompute when the
    // board snapshot or its enabled flag changes (off → these never change → no-op).
    uiState?.board,
    uiState?.boardEnabled,
    liveColumns,
    liveRows,
    inputBoxRows,
  ]);

  // Structured mode (the single source of truth once the Node side has pushed any
  // state): render committed lines (write-once via <Static>, coloured by kind)
  // plus the live answer buffer (<Stream>, repaints as prose streams). The
  // <Static> item is a {line,key} pair so a stable React key survives appends.
  //
  // committed[] is the ONE growing transcript: BOTH the reducer's prose/chrome
  // commits AND the OutputSink's out.write chrome (a `commit/raw` action) append
  // to it, and a `turn/start` between turns resets only the per-turn slice while
  // PRESERVING committed[]. So this array is MONOTONICALLY NON-DECREASING across
  // turns — it never shrinks then regrows, which is exactly what Ink 6's <Static>
  // append-only contract requires (the old per-turn reset re-triggered the
  // scrollback-duplication bug). The `uiState !== null` check is therefore no
  // longer a one-way latch that LOSES chrome: the string `lines` path below is
  // only the pre-first-state fallback (e.g. the idle skeleton before any state),
  // and committed[] is the sole <Static> source the instant a turn or chrome lands.
  if (uiState !== null && liveLayout !== null) {
    // The live-status layout was computed ONCE above (memoized): `streamLines` is
    // the buffer's TRUE wrapped-row count at the live width; `plan` is the SAME
    // layoutForHeight result the StatusBlock now consumes via a prop (no second
    // pass); `cappedStreamBuffer` is the buffer truncated to the plan's `streamCap`
    // last wrapped rows. An empty buffer → 0 rows → renders nothing; a buffer that
    // fits → rendered whole. This keeps the always-visible dynamic region <= the
    // viewport so Ink never re-emits the overflow into the scrollback on repaint.
    //
    // `inputBoxRows` is the InputBox's MEASURED physical height (wrapped body +
    // borders, reported via onMeasureRows — BUG 1), reserved by layoutForHeight so a
    // wrapped/pasted composer can never push the dynamic region past the viewport;
    // the SAME plan flows into StatusBlock so its panel plan and this stream cap
    // agree (see layout.ts).
    const { streamLines, plan, cappedStreamBuffer } = liveLayout;
    return (
      <Box flexDirection="column">
        <CommittedTranscript lines={uiState.committed} color={color} />
        {controlPanelOpen ? (
          <Box height={Math.max(1, liveRows - 1)} overflowY="hidden">
            <ControlPanel
              state={uiState}
              onSetSection={(section) => { bridge.routeControlPanelAction({ type: 'control-panel/set-section', section }); }}
              onHighlightGoal={(goalId) => { bridge.routeControlPanelAction({ type: 'control-panel/highlight-goal', goalId }); }}
              onClose={() => { bridge.routeControlPanelAction({ type: 'control-panel/close' }); }}
              active={!suspended}
            />
          </Box>
        ) : goalsPanelOpen ? (
          <Box height={Math.max(1, liveRows - 1)} overflowY="hidden">
            <GoalsPanel
              board={uiState.board}
              {...(uiState.goalsPanel.highlightedGoalId !== undefined ? { highlightedGoalId: uiState.goalsPanel.highlightedGoalId } : {})}
              onHighlightGoal={(goalId) => bridge.routeGoalsPanelAction({ type: 'goals-panel/highlight', goalId })}
              onClose={() => { bridge.routeGoalsPanelAction({ type: 'goals-panel/close' }); }}
              active={!suspended}
            />
          </Box>
        ) : (
          <>
            {uiState.chrome.length > 0 ? (
              <Box flexDirection="column">
                {uiState.chrome.map((line, index) => (
                  <CommittedLine key={index} line={line} color={color} />
                ))}
              </Box>
            ) : null}
            {uiState.goals.length > 1 && (
              <Text dimColor={ (uiState.pressure ?? 0) >= 2 }>
                {'  Goal DAG active — ' + uiState.goals.length + ' branches' + ((uiState.pressure ?? 0) >= 2 ? ' (pressure shedding)' : '') + ' (j/k to navigate branches in review)'}
              </Text>
            )}
            <StatusBlock
              state={uiState}
              color={color}
              rows={liveRows}
              streamLines={streamLines}
              inputRows={inputBoxRows}
              plan={plan}
              {...(clock !== undefined ? { clock } : {})}
            />
            <Stream buffer={cappedStreamBuffer} color={color} />
          </>
        )}
        <InputBox
          bridge={bridge.input}
          color={color}
          isTty={isTty}
          columns={liveColumns}
          rows={liveRows}
          onMeasureRows={setInputBoxRows}
          info={inputInfoText}
          visible={fullscreenPanelOpen ? false : chatActive}
          suspended={suspended}
          active={!fullscreenPanelOpen}
          pressure={uiState?.pressure ?? 0}
          dynamicWorldItems={uiState?.dynamicWorldItems ?? []}
          onStdinControl={bridge.attachStdinControl}
          onEscape={() => bridge.interrupt()}
          onToggleFullscreenPanel={() => bridge.routeControlPanelAction({ type: 'control-panel/toggle' }) || bridge.routeGoalsPanelAction({ type: 'goals-panel/toggle' })}
          onEmptyLeft={() => { bridge.input._submit?.('/back'); }}
          onEmptyRight={() => { bridge.routeControlPanelAction({ type: 'control-panel/open' }); }}
          readPending={() => bridge._keyResolver != null || bridge._menuCaptureActive}
          onReadKey={(input, key) => {
            const normalized = normalizeInkKey(input, key);
            const resolver = bridge._keyResolver;
            if (resolver != null) {
              bridge._keyResolver = null;
              resolver(normalized);
            } else if (bridge._menuCaptureActive) {
              bridge._menuKeyQueue.push(normalized);
            }
          }}
        />
        {!fullscreenPanelOpen && chatActive && (
          <BottomLegend color={color} columns={liveColumns} />
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Static items={lines}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      <InputBox
        bridge={bridge.input}
        color={color}
        isTty={isTty}
        columns={liveColumns}
        rows={liveRows}
        info={inputInfoText}
        visible={chatActive}
        suspended={suspended}
        onStdinControl={bridge.attachStdinControl}
        onEscape={() => bridge.interrupt()}
        onToggleFullscreenPanel={() => bridge.routeControlPanelAction({ type: 'control-panel/toggle' }) || bridge.routeGoalsPanelAction({ type: 'goals-panel/toggle' })}
        onEmptyLeft={() => { bridge.input._submit?.('/back'); }}
        onEmptyRight={() => { bridge.routeControlPanelAction({ type: 'control-panel/open' }); }}
        readPending={() => bridge._keyResolver != null || bridge._menuCaptureActive}
        onReadKey={(input, key) => {
          const normalized = normalizeInkKey(input, key);
          const resolver = bridge._keyResolver;
          if (resolver != null) {
            bridge._keyResolver = null;
            resolver(normalized);
          } else if (bridge._menuCaptureActive) {
            bridge._menuKeyQueue.push(normalized);
          }
        }}
        pressure={0}
        dynamicWorldItems={[]}
      />
      {chatActive && (
        <BottomLegend color={color} columns={liveColumns} />
      )}
    </Box>
  );
}
