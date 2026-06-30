import type { AgentRunState, ControlPanelSection, StreamPhase, UiState } from './state.js';
import type { ProviderId } from '../../providers/port.js';
import { buildGoalsPanelModel, type GoalsPanelModel } from './goals-panel-model.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONTROL_PANEL_SECTIONS = [
  'status',
  'goals',
  'settings',
] as const;

// ---------------------------------------------------------------------------
// Model shapes
// ---------------------------------------------------------------------------

export interface ControlPanelProviderStatus {
  readonly provider: ProviderId;
  readonly state: AgentRunState;
}

export interface ControlPanelSettingRow {
  readonly id: 'board' | 'goals-panel' | 'control-panel';
  readonly label: string;
  readonly enabled: boolean;
  readonly note?: string;
}

export interface ControlPanelModel {
  readonly activeSection: ControlPanelSection;
  readonly activeGoalCount: number;
  readonly executionPhase: StreamPhase;
  readonly turnActive: boolean;
  readonly providers: readonly ControlPanelProviderStatus[];
  readonly quotaLabel: 'unavailable in UI state';
  readonly settings: readonly ControlPanelSettingRow[];
  readonly goals: GoalsPanelModel;
}

// ---------------------------------------------------------------------------
// Section navigation
// ---------------------------------------------------------------------------

export function nextControlPanelSection(
  current: ControlPanelSection,
  direction: 'forward' | 'backward',
): ControlPanelSection {
  const sections = CONTROL_PANEL_SECTIONS;
  const delta = direction === 'forward' ? 1 : -1;
  const nextIdx =
    (sections.indexOf(current) + delta + sections.length) % sections.length;
  return sections[nextIdx] ?? sections[0];
}

// ---------------------------------------------------------------------------
// Provider folding precedence
// ---------------------------------------------------------------------------

const PRECEDENCE: Record<AgentRunState, number> = {
  running: 0,
  failed: 1,
  queued: 2,
  done: 3,
};

function foldProviderStatus(
  agents: readonly { provider: ProviderId; state: AgentRunState }[],
): ControlPanelProviderStatus[] {
  const bestState = new Map<ProviderId, AgentRunState>();
  const order: ProviderId[] = [];

  for (const agent of agents) {
    const current = bestState.get(agent.provider);
    if (current === undefined) {
      bestState.set(agent.provider, agent.state);
      order.push(agent.provider);
    } else if (PRECEDENCE[agent.state] < PRECEDENCE[current]) {
      bestState.set(agent.provider, agent.state);
    }
  }

  const result: ControlPanelProviderStatus[] = [];
  for (const p of order) {
    const s = bestState.get(p);
    if (s !== undefined) {
      result.push({ provider: p, state: s });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

export function buildControlPanelModel(state: UiState): ControlPanelModel {
  // activeGoalCount: union of running IDs from board + live goals
  const runningIds = new Set<string>();
  for (const row of state.board) {
    if (row.state === 'running') runningIds.add(row.id);
  }
  for (const goal of state.goals) {
    if (goal.state === 'running') runningIds.add(goal.id);
  }

  // provider health: stream.panelists first, then goals.flatMap(g => g.agents)
  const allAgents: { provider: ProviderId; state: AgentRunState }[] = [
    ...state.stream.panelists,
  ];
  for (const goal of state.goals) {
    for (const agent of goal.agents) {
      allAgents.push(agent);
    }
  }
  const providers = foldProviderStatus(allAgents);

  // settings rows in fixed order
  const settings: ControlPanelSettingRow[] = [
    { id: 'board', label: 'Persistent board', enabled: state.boardEnabled },
    {
      id: 'goals-panel',
      label: 'Standalone Goals Panel',
      enabled: state.goalsPanel.enabled,
      ...(state.goalsPanel.enabled && state.controlPanel.enabled
        ? { note: 'superseded' as const }
        : {}),
    },
    {
      id: 'control-panel',
      label: 'Control Panel',
      enabled: state.controlPanel.enabled,
    },
  ];

  const goals = buildGoalsPanelModel({
    board: state.board,
    ...(state.goalsPanel.highlightedGoalId !== undefined
      ? { highlightedGoalId: state.goalsPanel.highlightedGoalId }
      : {}),
  });

  return {
    activeSection: state.controlPanel.activeSection,
    activeGoalCount: runningIds.size,
    executionPhase: state.stream.phase,
    turnActive: state.turnActive,
    providers,
    quotaLabel: 'unavailable in UI state',
    settings,
    goals,
  };
}
