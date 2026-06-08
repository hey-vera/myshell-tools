/**
 * src/interface/ui/App.tsx — minimal Ink chat skeleton (Step 1 of the Ink
 * migration, behind the default-OFF MYSHELL_INK flag).
 *
 * This is SCAFFOLDING, not the real UI: a `<Static>` transcript region fed by
 * committed lines, plus a single-line pinned input box at the bottom driven by
 * Ink's built-in `useInput` (no extra dependency). No goals, panels, streaming,
 * or token meters yet — those are later steps. The legacy (flag-off)
 * render.ts/menu-readline.ts path is 100% unchanged.
 *
 * The App exposes its mutable seams (commit a transcript line; subscribe to
 * submitted input lines) through a small imperative handle passed in via props,
 * so the OutputSink adapter and createInkLineReader (in mount.tsx) can drive it
 * without React knowing about Node streams.
 */

import React, { useEffect, useState } from 'react';
import { Box, Static, Text, useInput } from 'ink';
import { InputBox, createInputBoxBridge, type InputBoxBridge } from './InputBox.js';
import { Stream, CommittedLine } from './Stream.js';
import { StatusBlock } from './StatusBlock.js';
import type { TranscriptLine, UiState } from './state.js';

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
   * While a read is pending the App flips `awaitingKey` on: the `<InputBox>` editor
   * goes inactive and a dedicated capture hook consumes the NEXT key, resolves, and
   * the App flips `awaitingKey` off so the editor resumes cleanly — exactly one key
   * is consumed. A read started while suspended (a child owns the TTY) stays parked
   * until resume(): the capture hook is inactive while suspended.
   *
   * The Node side (menu loop) drives this in place of the legacy single-key raw
   * read on the Ink path; chat-message input still flows through the InputBox.
   */
  readKey(): Promise<string>;
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
  /** @internal set by App on mount */ _setUiState?: ((state: UiState) => void) | undefined;
  /** @internal set by App on mount: flip the single-key capture state */
  _setAwaitingKey?: ((value: boolean) => void) | undefined;
  /** @internal the pending single-key resolver, set by readKey(), consumed (once)
   *  by the App's capture hook. Cleared after exactly one key is delivered. */
  _keyResolver?: ((key: string) => void) | null;
  /** @internal the attached Ink stdin control */ _stdinControl?: InkStdinControl | null;
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
    readKey(): Promise<string> {
      // Exactly-one-key guarantee: a second readKey() while one is pending would
      // leave two resolvers racing for one keystroke — a real logic error in the
      // caller (the menu loop is strictly sequential). Reject rather than steal.
      if (bridge._keyResolver != null) {
        return Promise.reject(new Error('InkAppBridge: readKey already pending'));
      }
      return new Promise<string>((resolve) => {
        bridge._keyResolver = resolve;
        // Flip the App into single-key capture: InputBox editor goes inactive,
        // the capture hook becomes active and consumes the next key.
        bridge._setAwaitingKey?.(true);
      });
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
 * A headless single-key capture mounted ONLY while the App is awaiting a key
 * (`awaitingKey && !suspended`). Its `useInput` consumes the NEXT keypress through
 * Ink's own pipeline (cooperating with raw mode + the /dev/tty fallback), resolves
 * the pending resolver with the normalized key, and the App flips `awaitingKey`
 * off — so EXACTLY ONE key is consumed and the InputBox editor resumes cleanly.
 *
 * It renders nothing. While suspended it is not mounted (the App gates it), so a
 * single-key read started before/over an inherited-stdio child handoff never
 * steals the child's keystroke.
 */
function KeyCapture({
  resolve,
}: {
  readonly resolve: (key: string) => void;
}): null {
  useInput((input, key) => {
    resolve(normalizeInkKey(input, key as KeyCaptureFlags));
  });
  return null;
}

/**
 * The Ink chat app: a write-once `<Static>` transcript above a pinned, real
 * `<InputBox>` editor (cursor movement, history, multiline-compose, queued
 * indicator). The transcript region is unchanged from Step 1; all input editing
 * now lives in {@link InputBox}.
 */
export function App({
  bridge,
  color = true,
  isTty = true,
  columns,
  rows,
  clock,
}: AppProps): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  // The structured reducer snapshot (STEP 3b). `null` until the Node side pushes
  // one — until then the App uses the plain string `lines` transcript (Step 1).
  const [uiState, setUiState] = useState<UiState | null>(null);
  // When true, an inherited-stdio child (e.g. `claude auth login`) owns the TTY:
  // the InputBox's useInput goes inactive so Ink drops its raw-mode refcount.
  const [suspended, setSuspended] = useState(false);
  // When true, a single-key menu/confirm read is pending: the InputBox editor goes
  // inactive and <KeyCapture> consumes the next key (see bridge.readKey()).
  const [awaitingKey, setAwaitingKey] = useState(false);

  // Wire the bridge to this component's state on mount so the Node-side
  // OutputSink can push committed lines in and the LineReader can toggle suspend.
  useEffect(() => {
    bridge._setLines = setLines;
    bridge._setSuspended = setSuspended;
    bridge._setUiState = setUiState;
    bridge._setAwaitingKey = setAwaitingKey;
    return () => {
      bridge._setLines = undefined;
      bridge._setSuspended = undefined;
      bridge._setUiState = undefined;
      bridge._setAwaitingKey = undefined;
    };
  }, [bridge]);

  // Deliver exactly one captured key to the pending readKey() resolver, then exit
  // capture mode so the InputBox editor resumes. Guards against a double-fire (the
  // resolver is nulled before resolving, so a stray second event is a no-op) — the
  // exactly-one-key guarantee.
  const onCapturedKey = (rawKey: string): void => {
    const resolver = bridge._keyResolver;
    bridge._keyResolver = null;
    setAwaitingKey(false);
    if (resolver != null) resolver(rawKey);
  };

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
  if (uiState !== null) {
    const committed: Array<{ readonly line: TranscriptLine; readonly key: number }> =
      uiState.committed.map((line, index) => ({ line, key: index }));
    return (
      <Box flexDirection="column">
        <Static items={committed}>
          {(item) => <CommittedLine key={item.key} line={item.line} color={color} />}
        </Static>
        <StatusBlock
          state={uiState}
          color={color}
          {...(rows !== undefined ? { rows } : {})}
          {...(clock !== undefined ? { clock } : {})}
        />
        <Stream buffer={uiState.stream.buffer} color={color} />
        <InputBox
          bridge={bridge.input}
          color={color}
          isTty={isTty}
          columns={columns}
          suspended={suspended || awaitingKey}
          onStdinControl={bridge.attachStdinControl}
        />
        {awaitingKey && !suspended ? <KeyCapture resolve={onCapturedKey} /> : null}
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
        columns={columns}
        suspended={suspended || awaitingKey}
        onStdinControl={bridge.attachStdinControl}
      />
      {awaitingKey && !suspended ? <KeyCapture resolve={onCapturedKey} /> : null}
    </Box>
  );
}
