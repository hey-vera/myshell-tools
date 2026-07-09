/**
 * Bottom-docked conversation recap orientation line — sits above the chat
 * composer (where the lesser GoalQuickStrip used to live). Renders the real
 * `※ recap  <text>` line when the menu has supplied recap text; collapses to
 * nothing when absent. Never fabricates content.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatRecapLine } from '../../ui/theme.js';
import { truncateToWidth } from '../../ui/tui.js';

export interface RecapDockProps {
  /** Real recap body text, or null/empty when no recap is available. */
  readonly text: string | null | undefined;
  readonly color: boolean;
  readonly columns?: number | undefined;
}

/**
 * One-row dock: `※ recap  <body>` (via {@link formatRecapLine}), width-bounded
 * so a long orientation never blows the viewport.
 */
export function RecapDock({
  text,
  color,
  columns = 80,
}: RecapDockProps): React.ReactElement | null {
  const body = typeof text === 'string' ? text.trim() : '';
  if (body.length === 0) return null;
  // Reserve a little headroom for glyph + "recap  " prefix; clamp body to fit.
  const maxBody = Math.max(8, Math.floor(columns) - 10);
  const line = formatRecapLine(truncateToWidth(body, maxBody), color);
  if (line.length === 0) return null;
  return (
    <Box>
      <Text>{line}</Text>
    </Box>
  );
}
