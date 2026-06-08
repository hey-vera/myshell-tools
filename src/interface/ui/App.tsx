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
import { Box, Static, Text } from 'ink';
import { InputBox, createInputBoxBridge, type InputBoxBridge } from './InputBox.js';

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
    commit(line: string): void {
      bridge._setLines?.((prev) => [...prev, line]);
    },
    onSubmit(handler: (line: string) => void): void {
      input.onSubmit(handler);
    },
    setSuspended(value: boolean): void {
      bridge._setSuspended?.(value);
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
}

/**
 * The Ink chat app: a write-once `<Static>` transcript above a pinned, real
 * `<InputBox>` editor (cursor movement, history, multiline-compose, queued
 * indicator). The transcript region is unchanged from Step 1; all input editing
 * now lives in {@link InputBox}.
 */
export function App({ bridge, color = true, isTty = true, columns }: AppProps): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  // When true, an inherited-stdio child (e.g. `claude auth login`) owns the TTY:
  // the InputBox's useInput goes inactive so Ink drops its raw-mode refcount.
  const [suspended, setSuspended] = useState(false);

  // Wire the bridge to this component's state on mount so the Node-side
  // OutputSink can push committed lines in and the LineReader can toggle suspend.
  useEffect(() => {
    bridge._setLines = setLines;
    bridge._setSuspended = setSuspended;
    return () => {
      bridge._setLines = undefined;
      bridge._setSuspended = undefined;
    };
  }, [bridge]);

  return (
    <Box flexDirection="column">
      <Static items={lines}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      <InputBox
        bridge={bridge.input}
        color={color}
        isTty={isTty}
        columns={columns}
        suspended={suspended}
        onStdinControl={bridge.attachStdinControl}
      />
    </Box>
  );
}
