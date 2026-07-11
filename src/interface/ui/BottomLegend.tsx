import React from 'react';
import { Box, Text, useInput } from 'ink';
import { dim } from '../../ui/theme.js';
import {
  hitTestLegend,
  isLegendRow,
  isMouseInput,
  isPrimaryClick,
  parseMouseInput,
  type LegendClickAction,
} from './mouse.js';

export interface BottomLegendProps {
  readonly color: boolean;
  readonly columns?: number | undefined;
  /** Terminal height (rows) for bottom-row hit testing. */
  readonly rows?: number | undefined;
  /** When false, mouse clicks are ignored (e.g. suspended TTY handoff). */
  readonly active?: boolean | undefined;
  /** Legend segment click (mouse). Keyboard remains primary via InputBox. */
  readonly onLegendClick?: ((action: LegendClickAction) => void) | undefined;
}

/**
 * Clustered chat key legend — multi-chat PR-A product keys.
 * empty-buffer b back · empty-buffer c panel · Shift+Tab mode · Esc exit.
 * Always-hot (work with draft): Ctrl+B back, Ctrl+G panel (not all listed when narrow).
 */
const FULL_LEGEND =
  'b back  \u00b7  c panel  \u00b7  Shift+Tab mode  \u00b7  Esc exit';
/** Narrow terminals keep back + panel + exit. */
const NARROW_LEGEND = 'b back  \u00b7  c panel  \u00b7  Esc exit';
/** Columns below this threshold drop mode. */
const NARROW_COLUMNS = 60;

export function buildBottomLegendText(columns: number): string {
  return columns < NARROW_COLUMNS ? NARROW_LEGEND : FULL_LEGEND;
}

export function BottomLegend({
  color,
  columns = 80,
  rows = 24,
  active = true,
  onLegendClick,
}: BottomLegendProps): React.ReactElement {
  const text = buildBottomLegendText(columns);

  useInput(
    (input) => {
      if (onLegendClick === undefined) return;
      if (!isMouseInput(input)) return;
      const ev = parseMouseInput(input);
      if (ev === null || !isPrimaryClick(ev)) return;
      if (!isLegendRow(ev.row, rows)) return;
      const action = hitTestLegend(ev.col, columns);
      if (action !== null) onLegendClick(action);
    },
    { isActive: active && onLegendClick !== undefined },
  );

  return (
    <Box>
      <Text>{dim(text, color)}</Text>
    </Box>
  );
}
