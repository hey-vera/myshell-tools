import React from 'react';
import { Box, Text } from 'ink';
import { dim } from '../../ui/theme.js';

export interface BottomLegendProps {
  readonly color: boolean;
  readonly columns?: number | undefined;
}

export function BottomLegend({ color, columns = 80 }: BottomLegendProps): React.ReactElement {
  const left = '\u2190 back to menu';
  const right = 'control panel \u2192';
  const padding = Math.max(1, columns - left.length - right.length);
  const text = left + ' '.repeat(padding) + right;
  return (
    <Box>
      <Text>{dim(text, color)}</Text>
    </Box>
  );
}
