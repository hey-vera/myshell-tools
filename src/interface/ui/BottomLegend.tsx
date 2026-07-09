import React from 'react';
import { Box, Text } from 'ink';
import { dim } from '../../ui/theme.js';

export interface BottomLegendProps {
  readonly color: boolean;
  readonly columns?: number | undefined;
}

/** Clustered chat key legend — no edge-padding that exiles control panel right. */
const FULL_LEGEND = '\u2190 menu  \u00b7  Shift+Tab mode  \u00b7  \u2192 panel  \u00b7  Esc interrupt';
/** Narrow terminals keep the essential back + panel affordances. */
const NARROW_LEGEND = '\u2190 menu  \u00b7  \u2192 panel';
/** Columns below this threshold drop mode/interrupt hints. */
const NARROW_COLUMNS = 60;

export function buildBottomLegendText(columns: number): string {
  return columns < NARROW_COLUMNS ? NARROW_LEGEND : FULL_LEGEND;
}

export function BottomLegend({ color, columns = 80 }: BottomLegendProps): React.ReactElement {
  const text = buildBottomLegendText(columns);
  return (
    <Box>
      <Text>{dim(text, color)}</Text>
    </Box>
  );
}
