import React from 'react';
import { Box, Text } from 'ink';
import { type GoalsPanelModel } from './goals-panel-model.js';

export interface GoalsPanelBodyProps {
  readonly model: GoalsPanelModel;
}

export function GoalsPanelBody(props: GoalsPanelBodyProps): React.ReactElement {
  const { model } = props;

  return (
    <Box flexDirection="column">
      <Text bold>Goals · To-dos</Text>
      <Text dimColor>↑↓ navigate · esc close</Text>
      {model.rows.length === 0 ? (
        <Text dimColor>No goals yet</Text>
      ) : (
        model.rows.map((row) =>
          row.depth === 0 ? (
            <Text
              key={row.id}
              bold
              inverse={row.goalId === model.highlightedGoalId}
            >
              {row.title}  {row.statusLabel}  {row.todoSummary ?? ''}
            </Text>
          ) : (
            <Box key={row.id} marginLeft={2}>
              <Text dimColor>• {row.title}  {row.statusLabel}</Text>
            </Box>
          ),
        )
      )}
    </Box>
  );
}

