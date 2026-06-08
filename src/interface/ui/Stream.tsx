/**
 * src/interface/ui/Stream.tsx — the Ink view for the LIVE (not-yet-committed)
 * answer region + the colour-by-kind styling for COMMITTED transcript lines
 * (STEP 3b of the Ink migration, behind the default-OFF MYSHELL_INK flag).
 *
 * Two pieces, both PURE view (they read reducer state and paint — no I/O, no
 * dispatch):
 *
 *   - {@link Stream}: renders `state.stream.buffer` (the live, still-streaming
 *     answer) headed by the cyan streaming `●` marker, mirroring render.ts which
 *     writes a cyan `●` immediately before the first prose delta. Empty buffer →
 *     renders nothing (a turn that hasn't produced prose yet shows only the
 *     spinner/status, which is a later step). The live buffer is WRITE-MANY (it
 *     repaints as prose streams), so it is a normal `<Text>`, NOT inside
 *     `<Static>` — only finished lines are write-once.
 *
 *   - {@link committedLineColor} / {@link CommittedLine}: the colour-by-kind map
 *     for a {@link TranscriptLine} the App renders inside `<Static>` (write-once).
 *     The colour choices mirror render.ts exactly: prose plain, the completion
 *     line dim with its outcome dot, errors red, notices dim, warnings yellow,
 *     escalate dim, telemetry dim. The dot/marker placement matches the legacy
 *     `●`/`■` markers so the eye tracks one object from "working" → "answer" →
 *     outcome.
 *
 * Colour gating: every style honours the `color` prop exactly like the theme
 * helpers, so a NO_COLOR / non-TTY mount paints bare text — keeping the Ink path
 * as faithful to the legacy pipe output as the reducer text already is.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { GLYPHS } from '../../ui/theme.js';
import type { TranscriptLine } from './state.js';

const DOT = GLYPHS.turn; // '●'

export interface StreamProps {
  /** The live, not-yet-committed answer prose (reducer `state.stream.buffer`). */
  readonly buffer: string;
  /** Emit colour (mirrors OutputSink.color). Default true. */
  readonly color?: boolean;
  /** Drop the structural `●` marker entirely (MYSHELL_PLAIN parity). Default
   *  false; honoured only when colour is off, exactly like theme.isPlainMode. */
  readonly plain?: boolean;
}

/**
 * The live answer region. The streaming `●` is cyan (the assistant is answering),
 * matching render.ts's `turnMarker('streaming', …)`. When the buffer is empty
 * nothing is rendered.
 */
export function Stream({ buffer, color = true, plain = false }: StreamProps): React.ReactElement | null {
  if (buffer.length === 0) return null;
  const showMarker = !(plain && !color);
  const markerProps = color ? { color: 'cyan' as const } : {};
  return (
    <Box>
      <Text>
        {showMarker ? <Text {...markerProps}>{`${DOT} `}</Text> : null}
        <Text>{buffer}</Text>
      </Text>
    </Box>
  );
}

/**
 * The Ink colour for a committed line's `kind`, mirroring render.ts's per-line
 * colour. Returns undefined for the default (no colour / plain prose). The
 * completion line's outcome colour is applied by {@link CommittedLine} via its
 * leading dot, not here, since a completion line's body is dim in render.ts.
 */
function committedLineColor(kind: TranscriptLine['kind']): string | undefined {
  switch (kind) {
    case 'error':
      return 'red';
    case 'warn':
      return 'yellow';
    case 'notice':
    case 'escalate':
    case 'failover':
    case 'telemetry':
    case 'classified':
    case 'completion':
      return undefined; // dim (applied via dimColor on the <Text>), not a hue
    case 'prose':
      return undefined;
  }
}

/** Whether a committed line renders dim (render.ts uses `dim(...)` for notices,
 *  telemetry, the completion metrics, the escalate refining note). */
function isDim(kind: TranscriptLine['kind']): boolean {
  return (
    kind === 'notice' ||
    kind === 'escalate' ||
    kind === 'failover' ||
    kind === 'telemetry' ||
    kind === 'classified' ||
    kind === 'completion'
  );
}

export interface CommittedLineProps {
  readonly line: TranscriptLine;
  readonly color?: boolean;
}

/**
 * Render one COMMITTED transcript line with colour-by-kind. The App maps these
 * inside `<Static>` so each is painted exactly once (write-once), matching the
 * legacy append-only transcript.
 */
export function CommittedLine({ line, color = true }: CommittedLineProps): React.ReactElement {
  const hue = color ? committedLineColor(line.kind) : undefined;
  const dim = color && isDim(line.kind);
  const hueProps = hue !== undefined ? { color: hue } : {};
  return (
    <Text {...hueProps} dimColor={dim}>
      {line.text}
    </Text>
  );
}
