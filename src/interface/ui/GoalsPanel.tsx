/**
 * src/interface/ui/GoalsPanel.tsx — fullscreen Ink component for the Goals · To-dos
 * panel (Slice 6). Renders the persistent goal board as a keyboard-navigable list
 * with highlighted-goal todo expansion. PURE: reads props, builds a model, paints.
 * Keyboard: ↑↓/jk navigate goals, esc/ctrl-g close.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import {
  buildGoalsPanelModel,
  nextGoalId,
  type GoalsPanelModel,
} from './goals-panel-model.js';
import type { UiState } from './state.js';

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

export interface GoalsPanelProps {
  readonly board: UiState['board'];
  readonly highlightedGoalId?: string;
  readonly onHighlightGoal: (goalId: string) => void;
  readonly onClose: () => void;
  readonly active?: boolean;
}

export function GoalsPanel(props: GoalsPanelProps) {
  const { board, highlightedGoalId, onHighlightGoal, onClose, active } = props;

  const model = buildGoalsPanelModel({
    board,
    ...(highlightedGoalId !== undefined ? { highlightedGoalId } : {}),
  });

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'g')) {
        onClose();
        return;
      }
      if (key.upArrow || input === 'k') {
        const id = nextGoalId({
          goalIds: model.goalIds,
          currentGoalId: model.highlightedGoalId,
          direction: 'up',
        });
        if (id !== undefined) onHighlightGoal(id);
        return;
      }
      if (key.downArrow || input === 'j') {
        const id = nextGoalId({
          goalIds: model.goalIds,
          currentGoalId: model.highlightedGoalId,
          direction: 'down',
        });
        if (id !== undefined) onHighlightGoal(id);
        return;
      }
      // leftArrow / rightArrow → ignore
    },
    { isActive: active !== false },
  );

  return <GoalsPanelBody model={model} />;
}
