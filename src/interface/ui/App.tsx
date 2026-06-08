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

/**
 * The imperative bridge between the React tree and the Node-side adapters
 * (OutputSink / LineReader). Created in mount.tsx BEFORE render() and handed to
 * both the adapters and the <App/>. The App registers its state setters on mount
 * so the Node side can push transcript lines in and receive submitted input out.
 */
export interface InkAppBridge {
  /** Append one already-safe committed line to the <Static> transcript. */
  commit(line: string): void;
  /** Register the callback invoked when the user submits an input line. The
   *  LineReader sets this; the App calls it on Enter. */
  onSubmit(handler: (line: string) => void): void;
  // --- wired by <App/> on mount; consumed by commit()/the input box ---
  /** @internal set by App on mount */ _setLines?:
    | ((fn: (prev: string[]) => string[]) => void)
    | undefined;
  /** @internal set by the LineReader via onSubmit() */ _submit?:
    | ((line: string) => void)
    | undefined;
}

/**
 * Build an {@link InkAppBridge}. The App attaches its `_setLines` setter on
 * mount; the LineReader attaches `_submit` via {@link InkAppBridge.onSubmit}.
 */
export function createInkAppBridge(): InkAppBridge {
  const bridge: InkAppBridge = {
    commit(line: string): void {
      bridge._setLines?.((prev) => [...prev, line]);
    },
    onSubmit(handler: (line: string) => void): void {
      bridge._submit = handler;
    },
  };
  return bridge;
}

export interface AppProps {
  readonly bridge: InkAppBridge;
}

/**
 * Minimal Ink chat app: a write-once `<Static>` transcript above a pinned
 * single-line input box. Idle state shows the input caret (`❯`). Input editing
 * is intentionally minimal for Step 1 (printable chars + backspace + Enter);
 * full line-editing/paste/history come with the real input box in Step 2.
 */
export function App({ bridge }: AppProps): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const [value, setValue] = useState('');

  // Wire the bridge to this component's state on mount so the Node-side
  // OutputSink can push committed lines into the transcript.
  useEffect(() => {
    bridge._setLines = setLines;
    return () => {
      bridge._setLines = undefined;
    };
  }, [bridge]);

  useInput((input, key) => {
    if (key.return) {
      const submitted = value;
      setValue('');
      bridge._submit?.(submitted);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    // Ignore other control keys for this minimal step; append printable input.
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Static items={lines}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      <Box>
        <Text color="cyan">{'❯ '}</Text>
        <Text>{value}</Text>
      </Box>
    </Box>
  );
}
