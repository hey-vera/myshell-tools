import type { AgentRunState, ControlPanelSection, GoalBoardRow, GoalBoardTodoRow, StreamPhase, UiCapacityState, UiSettingsSnapshot, UiState } from './state.js';
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

export interface ControlPanelSettingRowBase {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
  readonly note?: string;
}

export interface ControlPanelSegmentedSettingRow extends ControlPanelSettingRowBase {
  readonly kind: 'segmented';
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string; readonly active: boolean }[];
}

export interface ControlPanelToggleSettingRow extends ControlPanelSettingRowBase {
  readonly kind: 'toggle';
  readonly value: boolean;
}

export interface ControlPanelActionSettingRow extends ControlPanelSettingRowBase {
  readonly kind: 'action';
  readonly value: boolean;
}

export interface ControlPanelReadonlySettingRow extends ControlPanelSettingRowBase {
  readonly kind: 'readonly';
  readonly value: string;
}

export type ControlPanelSettingRow =
  | ControlPanelSegmentedSettingRow
  | ControlPanelToggleSettingRow
  | ControlPanelActionSettingRow
  | ControlPanelReadonlySettingRow;

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

export interface ControlPanelStatusRow {
  readonly kind: 'heading' | 'item' | 'unknown' | 'cooldown' | 'tokens';
  readonly text: string;
  readonly provider?: ProviderId;
}

export interface ControlPanelModel {
  readonly activeSection: ControlPanelSection;
  readonly activeGoalCount: number;
  readonly executionPhase: StreamPhase;
  readonly turnActive: boolean;
  readonly providers: readonly ControlPanelProviderStatus[];
  /** Phase 4C: structured status rows built from real capacity signals or explicit unknowns. */
  readonly statusRows: readonly ControlPanelStatusRow[];
  /** Short summary line for the header (e.g. "2 active goals | pressure 1/3 | quota remaining unknown"). */
  readonly summaryLine: string;
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
// Settings row builder (Phase 4D)
// ---------------------------------------------------------------------------

function buildSettingsRows(
  snapshot: UiSettingsSnapshot | undefined,
  boardEnabled: boolean,
  selectedIndex: number,
): readonly ControlPanelSettingRow[] {
  const rows: ControlPanelSettingRow[] = [];

  if (snapshot === undefined) {
    rows.push({
      id: 'settings-unknown',
      label: 'Settings snapshot',
      kind: 'readonly',
      value: 'unknown',
      selected: false,
    });
    rows.push({
      id: 'board',
      label: 'Persistent board',
      kind: 'readonly',
      value: boardEnabled ? 'enabled' : 'disabled',
      selected: false,
    });
    return rows;
  }

  let idx = 0;

  rows.push({
    id: 'mode',
    label: 'New conversation mode',
    kind: 'segmented',
    value: snapshot.mode,
    selected: idx === selectedIndex,
    options: [
      { value: 'auto', label: 'Auto', active: snapshot.mode === 'auto' },
      { value: 'budget', label: 'Budget', active: snapshot.mode === 'budget' },
      { value: 'balanced', label: 'Balanced', active: snapshot.mode === 'balanced' },
      { value: 'high', label: 'High', active: snapshot.mode === 'high' },
      { value: 'max', label: 'Max', active: snapshot.mode === 'max' },
    ],
  });
  idx += 1;

  rows.push({
    id: 'oversight',
    label: 'Oversight',
    kind: 'segmented',
    value: snapshot.oversight,
    selected: idx === selectedIndex,
    options: [
      { value: 'review-all', label: 'review-all', active: snapshot.oversight === 'review-all' },
      { value: 'checkpoint', label: 'checkpoint', active: snapshot.oversight === 'checkpoint' },
      { value: 'autonomous', label: 'autonomous', active: snapshot.oversight === 'autonomous' },
    ],
  });
  idx += 1;

  rows.push({
    id: 'verbosity',
    label: 'Output detail',
    kind: 'segmented',
    value: snapshot.verbosity,
    selected: idx === selectedIndex,
    options: [
      { value: 'quiet', label: 'quiet', active: snapshot.verbosity === 'quiet' },
      { value: 'normal', label: 'normal', active: snapshot.verbosity === 'normal' },
      { value: 'verbose', label: 'verbose', active: snapshot.verbosity === 'verbose' },
    ],
  });
  idx += 1;

  rows.push({
    id: 'color-theme',
    label: 'Appearance theme',
    kind: 'toggle',
    value: snapshot.colorTheme === 'light',
    selected: idx === selectedIndex,
    note: 'takes effect next launch',
  });
  idx += 1;

  rows.push({
    id: 'memory',
    label: 'Memory',
    kind: 'toggle',
    value: snapshot.memory,
    selected: idx === selectedIndex,
  });
  idx += 1;

  rows.push({
    id: 'learned-taste',
    label: 'Learned preferences',
    kind: 'toggle',
    value: snapshot.learnedTaste,
    selected: idx === selectedIndex,
  });
  idx += 1;

  rows.push({
    id: 'codebase-awareness',
    label: 'Codebase awareness',
    kind: 'toggle',
    value: snapshot.codebaseAwareness,
    selected: idx === selectedIndex,
  });
  idx += 1;

  rows.push({
    id: 'default-shell',
    label: 'Set as default shell',
    kind: 'action',
    value: snapshot.setAsDefault,
    selected: idx === selectedIndex,
  });
  idx += 1;

  // Diagnostic: persistent board (always read-only after Phase 1-3 promotion)
  rows.push({
    id: 'board',
    label: 'Persistent board',
    kind: 'readonly',
    value: boardEnabled ? 'enabled' : 'disabled',
    selected: false,
  });

  return rows;
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

  // settings rows in fixed order: interactive rows from the snapshot,
  // plus the board diagnostic row (always read-only).
  const settings = buildSettingsRows(state.settings, state.boardEnabled, state.controlPanel.settingsSelectedIndex);

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

  // Phase 4C: build structured status rows from real capacity signals
  const statusRows = buildStatusRows(state.capacity, providers);
  const summaryLine = buildSummaryLine(runningIds.size, state.stream.phase, state.turnActive, state.capacity);

  return {
    activeSection: state.controlPanel.activeSection,
    activeGoalCount: runningIds.size,
    executionPhase: state.stream.phase,
    turnActive: state.turnActive,
    providers,
    statusRows,
    summaryLine,
    settings,
    controlGoals,
  };
}

// ---------------------------------------------------------------------------
// Phase 4C: status row builder
// ---------------------------------------------------------------------------

function buildStatusRows(
  capacity: UiCapacityState | undefined,
  providerFolds: readonly ControlPanelProviderStatus[],
): readonly ControlPanelStatusRow[] {
  const rows: ControlPanelStatusRow[] = [];

  if (capacity === undefined) {
    rows.push({ kind: 'unknown', text: 'Capacity snapshot: unknown' });
    rows.push({ kind: 'unknown', text: 'Quota remaining: unknown' });
    rows.push({ kind: 'unknown', text: 'Cooldowns: unknown' });
    rows.push({ kind: 'unknown', text: 'Plans: unknown' });
    rows.push({ kind: 'unknown', text: 'Session tokens: unknown' });
    return rows;
  }

  // --- Execution (from running providers) ---
  rows.push({ kind: 'heading', text: 'Running providers' });
  if (providerFolds.length === 0) {
    rows.push({ kind: 'item', text: '  No provider observations' });
  } else {
    for (const p of providerFolds) {
      rows.push({ kind: 'item', text: `  ${p.provider}: ${p.state}`, provider: p.provider });
    }
  }

  // --- Provider plans (from capacity snapshot) ---
  rows.push({ kind: 'heading', text: 'Provider plans' });
  const authenticProv = capacity.providers.filter((p) => p.authenticated);
  if (authenticProv.length === 0) {
    rows.push({ kind: 'item', text: '  No authenticated providers' });
  } else {
    for (const p of authenticProv) {
      const conf = p.planConfidence === 'observed' ? '' : ` (${p.planConfidence})`;
      rows.push({ kind: 'item', text: `  ${p.provider}: ${p.planLabel}${conf}`, provider: p.provider });
    }
  }

  // --- Accounts (from capacity snapshot) ---
  rows.push({ kind: 'heading', text: 'Subscription accounts' });
  if (capacity.accounts.length === 0) {
    rows.push({ kind: 'item', text: '  No subscription accounts' });
  } else {
    for (const a of capacity.accounts) {
      const parts = [`  [${a.provider}] ${a.label}`];
      parts.push(`${a.status}`);
      if (a.planLabel !== 'unknown') parts.push(a.planLabel);
      rows.push({ kind: 'item', text: parts.join(' · ') });
    }
  }

  // --- Cooldowns + pressure ---
  rows.push({ kind: 'heading', text: 'Cooldowns' });
  const nowMs = capacity.observedAtMs;
  const providerCooldowns = capacity.providers.filter(
    (p) => p.cooldownUntil !== undefined && p.cooldownUntil > nowMs,
  );
  const accountCooldowns = capacity.accounts.filter(
    (a) => a.cooldownUntil !== undefined && a.cooldownUntil > nowMs,
  );
  if (providerCooldowns.length === 0 && accountCooldowns.length === 0) {
    rows.push({ kind: 'item', text: '  None active' });
  } else {
    for (const p of providerCooldowns) {
      const secs = Math.ceil(((p.cooldownUntil ?? nowMs) - nowMs) / 1000);
      rows.push({
        kind: 'cooldown',
        text: `  ${p.provider} cooldown: ${secs}s remaining`,
        provider: p.provider,
      });
    }
    for (const a of accountCooldowns) {
      const secs = Math.ceil(((a.cooldownUntil ?? nowMs) - nowMs) / 1000);
      rows.push({
        kind: 'cooldown',
        text: `  ${a.provider}/${a.label} cooldown: ${secs}s remaining`,
      });
    }
  }
  rows.push({ kind: 'item', text: `  Pressure: ${capacity.pressure}/3${capacity.pressure > 0 ? ` (${providerCooldowns.length} provider(s) cooling)` : ''}` });

  // --- Session tokens (only when ledger entries exist) ---
  const tokensFromProviders = capacity.providers.filter(
    (p) => p.sessionTokens !== undefined && p.sessionTokens > 0,
  );
  const tokensFromAccounts = capacity.accounts.filter(
    (a) => a.sessionTokens !== undefined && a.sessionTokens > 0,
  );
  if (tokensFromProviders.length > 0 || tokensFromAccounts.length > 0) {
    rows.push({ kind: 'heading', text: 'Observed session tokens' });
    for (const p of tokensFromProviders) {
      rows.push({
        kind: 'tokens',
        text: `  ${p.provider}: ~${formatCapacityTokens(p.sessionTokens ?? 0)}`,
        provider: p.provider,
      });
    }
    for (const a of tokensFromAccounts) {
      rows.push({
        kind: 'tokens',
        text: `  ${a.provider}/${a.label}: ~${formatCapacityTokens(a.sessionTokens ?? 0)}`,
      });
    }
  }

  // --- Explicit unknowns (honesty rule) ---
  rows.push({ kind: 'heading', text: 'Unknowns' });
  rows.push({ kind: 'unknown', text: '  Quota remaining: unknown (not exposed by provider CLIs)' });
  rows.push({ kind: 'unknown', text: '  Reset time: unknown' });
  rows.push({ kind: 'unknown', text: '  Message allowance: unknown' });

  // --- Shed plan (when active) ---
  if (capacity.shedPlan !== undefined && !capacity.shedPlan.recapRefresh) {
    rows.push({ kind: 'heading', text: 'Quota shedding active' });
    const shedRows: string[] = [];
    if (!capacity.shedPlan.recapRefresh) shedRows.push('recap refresh off');
    if (capacity.shedPlan.memoryWidth === 'identity-only') shedRows.push('memory narrowed');
    if (!capacity.shedPlan.intentPass) shedRows.push('intent skipped');
    for (const r of shedRows) {
      rows.push({ kind: 'item', text: `  ${r}` });
    }
  }

  // --- Account fanout disabled ---
  if (capacity.accountParallelismDisabledProviders.length > 0) {
    rows.push({ kind: 'heading', text: 'Account fanout disabled' });
    for (const p of capacity.accountParallelismDisabledProviders) {
      rows.push({ kind: 'item', text: `  ${p}: suspected shared vendor limit` });
    }
  }

  return rows;
}

/** Format a token count for the capacity display (e.g. ~1.2k). */
function formatCapacityTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  return (tokens / 1000).toFixed(1) + 'k';
}

function buildSummaryLine(
  activeGoalCount: number,
  phase: StreamPhase,
  turnActive: boolean,
  capacity: UiCapacityState | undefined,
): string {
  const parts: string[] = [];
  parts.push(`${activeGoalCount} active goals`);
  if (capacity !== undefined) {
    parts.push(`pressure ${capacity.pressure}/3`);
  }
  parts.push('quota remaining unknown');
  // append provider count
  if (capacity !== undefined) {
    const running = capacity.providers.filter((p) => p.cooldownUntil !== undefined).length;
    if (running > 0) parts.push(`${running} providers cooling`);
  }
  return parts.join(' · ');
}
