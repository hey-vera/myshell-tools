import type { AgentRunState, ControlPanelSection, GoalBoardRow, GoalBoardTodoRow, StreamPhase, UiState } from './state.js';
import type { ProviderId } from '../../providers/port.js';

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
  readonly id: 'board';
  readonly label: string;
  readonly enabled: boolean;
  readonly note?: string;
}

export interface ControlPanelGoalRow {
  readonly id: string;
  readonly title: string;
  readonly state: GoalBoardRow['state'];
  readonly glyph: string;
  readonly done: number;
  readonly total: number;
  readonly agents: number;
  readonly scope: GoalBoardRow['scope'];
  readonly depth: number;
  readonly selected: boolean;
  readonly verdict?: string;
}

export interface ControlPanelGoalDetail {
  readonly id: string;
  readonly title: string;
  readonly state: GoalBoardRow['state'];
  readonly done: number;
  readonly total: number;
  readonly agents: number;
  readonly scope: GoalBoardRow['scope'];
  readonly verdict?: string;
  readonly approach?: GoalBoardRow['approach'];
  readonly todos: readonly GoalBoardTodoRow[];
  readonly todoOverflow: number;
}

export interface ControlPanelGoalsModel {
  readonly goalIds: readonly string[];
  readonly highlightedGoalId?: string;
  readonly rows: readonly ControlPanelGoalRow[];
  readonly detail?: ControlPanelGoalDetail;
}

export interface ControlPanelModel {
  readonly activeSection: ControlPanelSection;
  readonly activeGoalCount: number;
  readonly executionPhase: StreamPhase;
  readonly turnActive: boolean;
  readonly providers: readonly ControlPanelProviderStatus[];
  readonly quotaLabel: 'unavailable in UI state';
  readonly settings: readonly ControlPanelSettingRow[];
  readonly controlGoals: ControlPanelGoalsModel;
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
  ];

  // Build the native Control Panel goals model from the board snapshot.
  const goalIds: readonly string[] = state.board.map((r) => r.id);
  let effectiveHighlight: string | undefined;
  if (
    state.goalsPanel.highlightedGoalId !== undefined &&
    goalIds.includes(state.goalsPanel.highlightedGoalId)
  ) {
    effectiveHighlight = state.goalsPanel.highlightedGoalId;
  } else if (goalIds.length > 0) {
    effectiveHighlight = goalIds[0];
  }

  const rows: ControlPanelGoalRow[] = [];
  let detail: ControlPanelGoalDetail | undefined;
  for (const row of state.board) {
    const selected = row.id === effectiveHighlight;
    rows.push({
      id: row.id,
      title: row.title,
      state: row.state,
      glyph: row.glyph,
      done: row.done,
      total: row.total,
      agents: row.agents,
      scope: row.scope,
      depth: row.depth ?? 0,
      selected,
      ...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
    });
    if (selected) {
      detail = {
        id: row.id,
        title: row.title,
        state: row.state,
        done: row.done,
        total: row.total,
        agents: row.agents,
        scope: row.scope,
        ...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
        ...(row.approach !== undefined ? { approach: row.approach } : {}),
        todos: row.todos ?? [],
        todoOverflow: row.todoOverflow ?? 0,
      };
    }
  }

  const controlGoals: ControlPanelGoalsModel = {
    goalIds,
    ...(effectiveHighlight !== undefined ? { highlightedGoalId: effectiveHighlight } : {}),
    rows,
    ...(detail !== undefined ? { detail } : {}),
  };

  return {
    activeSection: state.controlPanel.activeSection,
    activeGoalCount: runningIds.size,
    executionPhase: state.stream.phase,
    turnActive: state.turnActive,
    providers,
    quotaLabel: 'unavailable in UI state',
    settings,
    controlGoals,
  };
}
