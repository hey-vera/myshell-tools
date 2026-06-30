import React from 'react';
import { Box, Text, useInput } from 'ink';
import {
  buildControlPanelModel,
  nextControlPanelSection,
} from './index.js';
import { nextGoalId } from './goals-panel-model.js';
import type { ControlPanelSection, UiState } from './state.js';
import type { ControlPanelModel } from './control-panel-model.js';
import { GoalsPanelBody } from './GoalsPanel.js';

function providerSummary(model: ControlPanelModel): string {
  if (model.providers.length === 0) return 'none';
  return model.providers
    .map((p) => `${p.provider}:${p.state}`)
    .join(', ');
}

function sectionLabel(section: ControlPanelSection): string {
  switch (section) {
    case 'status':
      return 'Status';
    case 'goals':
      return 'Goals';
    case 'settings':
      return 'Settings';
  }
}

export interface ControlPanelProps {
  readonly state: UiState;
  readonly onSetSection: (section: ControlPanelSection) => void;
  readonly onHighlightGoal: (goalId: string) => void;
  readonly onClose: () => void;
  readonly active?: boolean;
}

export function ControlPanel(props: ControlPanelProps): React.ReactElement {
  const { state, onSetSection, onHighlightGoal, onClose, active } = props;

  const model = buildControlPanelModel(state);

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'g')) {
        onClose();
        return;
      }
      if (key.tab) {
        onSetSection(
          nextControlPanelSection(
            model.activeSection,
            key.shift ? 'backward' : 'forward',
          ),
        );
        return;
      }
      if (model.activeSection === 'goals') {
        if (key.upArrow || input === 'k') {
          const id = nextGoalId({
            goalIds: model.goals.goalIds,
            currentGoalId: model.goals.highlightedGoalId,
            direction: 'up',
          });
          if (id !== undefined) onHighlightGoal(id);
          return;
        }
        if (key.downArrow || input === 'j') {
          const id = nextGoalId({
            goalIds: model.goals.goalIds,
            currentGoalId: model.goals.highlightedGoalId,
            direction: 'down',
          });
          if (id !== undefined) onHighlightGoal(id);
          return;
        }
      }
    },
    { isActive: active !== false },
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>CONTROL PANEL</Text>
      </Box>
      <Box>
        <Text dimColor>
          {model.activeGoalCount} active goals · mode: execution/{model.executionPhase} · providers: {providerSummary(model)} · quota: {model.quotaLabel}
        </Text>
      </Box>

      <Box>
        <Text>{'  '}</Text>
        {(['status', 'goals', 'settings'] as const).map((s) =>
          s === model.activeSection ? (
            <Text key={s} inverse>
              {' '}{sectionLabel(s)}{' '}
            </Text>
          ) : (
            <Text key={s}>{' '}{sectionLabel(s)}{' '}</Text>
          ),
        )}
      </Box>

      {model.activeSection === 'status' ? (
        <ControlPanelStatus model={model} />
      ) : model.activeSection === 'goals' ? (
        <GoalsPanelBody model={model.goals} />
      ) : (
        <ControlPanelSettings model={model} />
      )}

      <Text dimColor>
        Tab/Shift+Tab navigate sections · ↑↓/jk select goal · Esc close
      </Text>
    </Box>
  );
}

function ControlPanelStatus(
  { model }: { readonly model: ControlPanelModel }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>Status</Text>
      <Text>Active goals (running): {model.activeGoalCount}</Text>
      <Text>
        Mode: execution/{model.executionPhase}
        {model.turnActive ? ' (turn active)' : ''}
      </Text>
      <Text bold>Provider health (observed)</Text>
      {model.providers.length === 0 ? (
        <Text dimColor>No provider observations</Text>
      ) : (
        model.providers.map((p) => (
          <Text key={p.provider}>
            {p.provider}: {p.state}
          </Text>
        ))
      )}
      <Text>Quota: {model.quotaLabel}</Text>
    </Box>
  );
}

function ControlPanelSettings(
  { model }: { readonly model: ControlPanelModel }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>Settings</Text>
      {model.settings.map((row) => (
        <Text key={row.id}>
          {row.label}: {row.enabled ? 'enabled' : 'disabled'}
          {row.note !== undefined ? ` (${row.note})` : ''}
        </Text>
      ))}
      <Text dimColor>Settings are read-only in this release</Text>
    </Box>
  );
}
