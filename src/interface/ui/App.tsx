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
  // --- wired by <App/> on mount; consumed by commit() ---
  /** @internal set by App on mount */ _setLines?:
    | ((fn: (prev: string[]) => string[]) => void)
    | undefined;
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
    commit(line: string): void {
      bridge._setLines?.((prev) => [...prev, line]);
    },
    onSubmit(handler: (line: string) => void): void {
      input.onSubmit(handler);
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

  // Wire the bridge to this component's state on mount so the Node-side
  // OutputSink can push committed lines into the transcript.
  useEffect(() => {
    bridge._setLines = setLines;
    return () => {
      bridge._setLines = undefined;
    };
  }, [bridge]);

  return (
    <Box flexDirection="column">
      <Static items={lines}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      <InputBox bridge={bridge.input} color={color} isTty={isTty} columns={columns} />
    </Box>
  );
}
