import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type {
  AgentView,
  ControlPanelSection,
  GoalBoardRow,
  GoalView,
  UiState,
} from '../../src/interface/ui/state.ts';
import { initialStreamView } from '../../src/interface/ui/state.ts';
import {
  buildControlPanelModel,
  CONTROL_PANEL_SECTIONS,
  nextControlPanelSection,
} from '../../src/interface/ui/control-panel-model.ts';


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function br(
  id: string,
  title: string,
  over: Partial<GoalBoardRow> = {},
): GoalBoardRow {
  return {
    id,
    title,
    state: 'running',
    done: 0,
    total: 3,
    glyph: '\u25B6',
    scope: 'global' as const,
    agents: 0,
    ...over,
  };
}

function agentView(provider: string, state: AgentView['state']): AgentView {
  return {
    provider: provider as AgentView['provider'],
    model: 'test-model',
    state,
    tokens: 0,
    attempt: 1,
  };
}

function goalView(
  id: string,
  state: GoalView['state'],
  agents: readonly AgentView[] = [],
): GoalView {
  return {
    id,
    label: `Goal ${id}`,
    state,
    tokens: 0,
    toolCount: 0,
    agents: [...agents],
    tier: 'worker' as const,
    dependsOn: [],
  };
}

function baseState(over: Partial<UiState> = {}): UiState {
  return {
    committed: [],
    chrome: [],
    goals: [],
    stream: { ...initialStreamView },
    turnActive: false,
    tokens: { turn: 0, session: 0 },
    board: [],
    boardEnabled: false,
    goalsPanel: {},
    controlPanel: {
      open: false,
      activeSection: 'goals',
      statusScroll: 0,
      goalsListScroll: 0,
      goalsDetailScroll: 0,
      settingsScroll: 0,
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// CONTROL_PANEL_SECTIONS
// ---------------------------------------------------------------------------

describe('CONTROL_PANEL_SECTIONS', () => {
  it('contains the three sections in fixed order', () => {
    assert.deepStrictEqual(CONTROL_PANEL_SECTIONS, [
      'status',
      'goals',
      'settings',
    ]);
  });


});

// ---------------------------------------------------------------------------
// nextControlPanelSection
// ---------------------------------------------------------------------------

describe('nextControlPanelSection', () => {
  const forwardCases: [ControlPanelSection, ControlPanelSection][] = [
    ['status', 'goals'],
    ['goals', 'settings'],
    ['settings', 'status'],
  ];

  for (const [current, expected] of forwardCases) {
    it(`forward from ${current} => ${expected}`, () => {
      assert.strictEqual(
        nextControlPanelSection(current, 'forward'),
        expected,
      );
    });
  }

  const backwardCases: [ControlPanelSection, ControlPanelSection][] = [
    ['status', 'settings'],
    ['settings', 'goals'],
    ['goals', 'status'],
  ];

  for (const [current, expected] of backwardCases) {
    it(`backward from ${current} => ${expected}`, () => {
      assert.strictEqual(
        nextControlPanelSection(current, 'backward'),
        expected,
      );
    });
  }

  it('wraps forward from last to first', () => {
    assert.strictEqual(nextControlPanelSection('settings', 'forward'), 'status');
  });

  it('wraps backward from first to last', () => {
    assert.strictEqual(nextControlPanelSection('status', 'backward'), 'settings');
  });
});

// ---------------------------------------------------------------------------
// buildControlPanelModel — activeGoalCount
// ---------------------------------------------------------------------------

describe('buildControlPanelModel activeGoalCount', () => {
  it('empty state => 0', () => {
    const s = baseState();
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.activeGoalCount, 0);
  });

  it('counts running goals from board', () => {
    const s = baseState({
      board: [
        br('g1', 'Alpha', { state: 'running' }),
        br('g2', 'Beta', { state: 'running' }),
        br('g3', 'Gamma', { state: 'done' }),
      ],
    });
    assert.strictEqual(buildControlPanelModel(s).activeGoalCount, 2);
  });

  it('counts running goals from live goals', () => {
    const s = baseState({
      goals: [
        goalView('a', 'running'),
        goalView('b', 'queued'),
        goalView('c', 'running'),
        goalView('d', 'failed'),
      ],
    });
    assert.strictEqual(buildControlPanelModel(s).activeGoalCount, 2);
  });

  it('unions board + live goals, does not double-count same ID', () => {
    const s = baseState({
      board: [br('g1', 'Alpha', { state: 'running' })],
      goals: [goalView('g1', 'running')],
    });
    assert.strictEqual(buildControlPanelModel(s).activeGoalCount, 1);
  });

  it('excludes parked, queued, done, failed, blocked, superseded board goals', () => {
    const s = baseState({
      board: [
        br('g1', 'Running', { state: 'running' }),
        br('g2', 'Parked', { state: 'parked' }),
        br('g3', 'Queued', { state: 'queued' }),
        br('g4', 'Done', { state: 'done' }),
        br('g5', 'Failed', { state: 'failed' }),
        br('g6', 'Blocked', { state: 'blocked' }),
        br('g7', 'Superseded', { state: 'superseded' }),
      ],
    });
    assert.strictEqual(buildControlPanelModel(s).activeGoalCount, 1);
  });

  it('excludes queued, done, failed live goals', () => {
    const s = baseState({
      goals: [
        goalView('a', 'running'),
        goalView('b', 'queued'),
        goalView('c', 'done'),
        goalView('d', 'failed'),
      ],
    });
    assert.strictEqual(buildControlPanelModel(s).activeGoalCount, 1);
  });
});

// ---------------------------------------------------------------------------
// buildControlPanelModel — providers
// ---------------------------------------------------------------------------

describe('buildControlPanelModel providers', () => {
  it('empty state => empty providers', () => {
    const s = baseState();
    const m = buildControlPanelModel(s);
    assert.deepStrictEqual(m.providers, []);
  });

  it('collects panelists only', () => {
    const s = baseState({
      stream: {
        ...initialStreamView,
        panelists: [
          agentView('claude', 'running'),
          agentView('codex', 'done'),
        ],
      },
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.providers.length, 2);
    assert.deepStrictEqual(m.providers[0], {
      provider: 'claude',
      state: 'running',
    });
    assert.deepStrictEqual(m.providers[1], {
      provider: 'codex',
      state: 'done',
    });
  });

  it('collects agents from live goals after panelists', () => {
    const s = baseState({
      stream: {
        ...initialStreamView,
        panelists: [agentView('claude', 'done')],
      },
      goals: [
        goalView('g1', 'running', [agentView('opencode', 'running')]),
        goalView('g2', 'queued', [agentView('grok', 'failed')]),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.providers.length, 3);
    assert.deepStrictEqual(m.providers, [
      { provider: 'claude', state: 'done' },
      { provider: 'opencode', state: 'running' },
      { provider: 'grok', state: 'failed' },
    ]);
  });

  it('deduplicates by provider, preserving first-seen order', () => {
    const s = baseState({
      stream: {
        ...initialStreamView,
        panelists: [
          agentView('claude', 'done'),
          agentView('codex', 'queued'),
        ],
      },
      goals: [
        goalView('g1', 'running', [agentView('claude', 'running')]),
        goalView('g2', 'queued', [agentView('codex', 'running')]),
      ],
    });
    const m = buildControlPanelModel(s);
    // claude seen first in panelists as 'done', later as 'running' — folds to running
    // codex seen first in panelists as 'queued', later as 'running' — folds to running
    // order is still claude, codex (first-seen)
    assert.strictEqual(m.providers.length, 2);
    assert.deepStrictEqual(m.providers, [
      { provider: 'claude', state: 'running' },
      { provider: 'codex', state: 'running' },
    ]);
  });

  it('applies precedence: running > failed > queued > done', () => {
    const s = baseState({
      goals: [
        goalView('g1', 'running', [
          agentView('claude', 'done'),
          agentView('claude', 'queued'),
          agentView('claude', 'failed'),
          agentView('claude', 'running'),
        ]),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.providers.length, 1);
    assert.deepStrictEqual(m.providers[0], {
      provider: 'claude',
      state: 'running',
    });
  });

  it('worse state does not overwrite better (failed does not replace running)', () => {
    const s = baseState({
      stream: {
        ...initialStreamView,
        panelists: [agentView('codex', 'running')],
      },
      goals: [
        goalView('g1', 'running', [agentView('codex', 'failed')]),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.providers.length, 1);
    assert.deepStrictEqual(m.providers[0], {
      provider: 'codex',
      state: 'running',
    });
  });

  it('better state later in input overwrites worse (running replaces done)', () => {
    const s = baseState({
      stream: {
        ...initialStreamView,
        panelists: [agentView('claude', 'done')],
      },
      goals: [
        goalView('g1', 'running', [agentView('claude', 'running')]),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.providers.length, 1);
    assert.deepStrictEqual(m.providers[0], {
      provider: 'claude',
      state: 'running',
    });
  });

  it('first-seen provider order is preserved regardless of later state folding', () => {
    const s = baseState({
      goals: [
        goalView('g1', 'running', [
          agentView('grok', 'queued'),
          agentView('claude', 'done'),
          agentView('codex', 'failed'),
        ]),
        goalView('g2', 'running', [
          agentView('codex', 'running'),
          agentView('grok', 'running'),
        ]),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.providers.length, 3);
    assert.strictEqual(m.providers[0].provider, 'grok');
    assert.strictEqual(m.providers[1].provider, 'claude');
    assert.strictEqual(m.providers[2].provider, 'codex');
    // grok: first-seen as queued, later running -> folds to running
    assert.strictEqual(m.providers[0].state, 'running');
  });
});

// ---------------------------------------------------------------------------
// buildControlPanelModel — execution phase / turnActive
// ---------------------------------------------------------------------------

describe('buildControlPanelModel execution phase and turnActive', () => {
  it('copies stream.phase', () => {
    const s = baseState({
      stream: {
        ...initialStreamView,
        phase: 'thinking',
      },
    });
    assert.strictEqual(buildControlPanelModel(s).executionPhase, 'thinking');
  });

  it('copies turnActive false', () => {
    const s = baseState({ turnActive: false });
    assert.strictEqual(buildControlPanelModel(s).turnActive, false);
  });

  it('copies turnActive true', () => {
    const s = baseState({ turnActive: true });
    assert.strictEqual(buildControlPanelModel(s).turnActive, true);
  });
});

// ---------------------------------------------------------------------------
// buildControlPanelModel — quota
// ---------------------------------------------------------------------------

describe('buildControlPanelModel statusRows (no capacity snapshot)', () => {
  it('returns unknowns when capacity is absent', () => {
    const m = buildControlPanelModel(baseState());
    assert.strictEqual(m.statusRows.length > 0, true);
    const unknownRows = m.statusRows.filter(r => r.kind === 'unknown');
    assert.strictEqual(unknownRows.length >= 3, true);
    assert.strictEqual(unknownRows.some(r => r.text.includes('Capacity snapshot: unknown')), true);
    assert.strictEqual(unknownRows.some(r => r.text.includes('Quota remaining: unknown')), true);
    assert.strictEqual(unknownRows.some(r => r.text.includes('Cooldowns: unknown')), true);
  });

  it('summary line notes quota remaining unknown', () => {
    const m = buildControlPanelModel(baseState());
    assert.strictEqual(m.summaryLine.includes('quota remaining unknown'), true);
  });
});

describe('buildControlPanelModel statusRows (with capacity snapshot)', () => {
  it('with authenticated providers, shows observed plan labels', () => {
    const capacity = {
      observedAtMs: 1000,
      providers: [
        { provider: 'claude' as const, installed: true, authenticated: true, planRaw: 'max_20x', planLabel: 'Max 20x', planConfidence: 'observed' as const, availableModelCount: 5 },
        { provider: 'codex' as const, installed: true, authenticated: true, planRaw: 'pro', planLabel: 'Pro', planConfidence: 'observed' as const, availableModelCount: 3 },
      ],
      accounts: [],
      pressure: 0 as const,
      accountParallelismDisabledProviders: [] as readonly [],
    };
    const state = baseState({
      capacity,
      boardEnabled: true,
    });
    const m = buildControlPanelModel(state);
    const planRows = m.statusRows.filter(r => r.kind === 'item' && (r.text.includes('Max 20x') || r.text.includes('Pro')));
    assert.strictEqual(planRows.length, 2);
  });

  it('after a rate-limit, shows provider cooldown and pressure', () => {
    const nowMs = 5000;
    const capacity = {
      observedAtMs: nowMs,
      providers: [
        { provider: 'claude' as const, installed: true, authenticated: true, planRaw: 'pro', planLabel: 'Pro', planConfidence: 'observed' as const, availableModelCount: 3, cooldownUntil: nowMs + 300_000 },
        { provider: 'codex' as const, installed: true, authenticated: true, planRaw: null, planLabel: 'Unknown', planConfidence: 'none' as const, availableModelCount: 0 },
      ],
      accounts: [],
      pressure: 1 as const,
      accountParallelismDisabledProviders: [] as readonly [],
    };
    const state = baseState({
      capacity,
      boardEnabled: true,
    });
    const m = buildControlPanelModel(state);
    const cooldownRows = m.statusRows.filter(r => r.kind === 'cooldown');
    assert.strictEqual(cooldownRows.length, 1);
    assert.strictEqual(cooldownRows[0].text.includes('claude'), true);
    assert.strictEqual(cooldownRows[0].text.includes('cooldown'), true);
    const pressureRows = m.statusRows.filter(r => r.text.includes('Pressure: 1/3'));
    assert.strictEqual(pressureRows.length, 1);
    assert.strictEqual(pressureRows[0].text.includes('1 provider(s) cooling'), true);
  });

  it('session token rows appear only when tokens > 0', () => {
    const capacity = {
      observedAtMs: 5000,
      providers: [
        { provider: 'claude' as const, installed: true, authenticated: true, planRaw: 'pro', planLabel: 'Pro', planConfidence: 'observed' as const, availableModelCount: 3, sessionTokens: 1234567 },
        { provider: 'codex' as const, installed: true, authenticated: true, planRaw: null, planLabel: 'Unknown', planConfidence: 'none' as const, availableModelCount: 0, sessionTokens: 0 },
      ],
      accounts: [],
      pressure: 0 as const,
      accountParallelismDisabledProviders: [] as readonly [],
    };
    const state = baseState({ capacity, boardEnabled: true });
    const m = buildControlPanelModel(state);
    const tokenRows = m.statusRows.filter(r => r.kind === 'tokens');
    assert.strictEqual(tokenRows.length, 1);
    assert.strictEqual(tokenRows[0].text.includes('claude'), true);
    assert.strictEqual(tokenRows[0].text.includes('1234.6k'), true); // ~1.2M
  });

  it('session token rows absent when no tokens exist', () => {
    const capacity = {
      observedAtMs: 5000,
      providers: [
        { provider: 'claude' as const, installed: true, authenticated: true, planRaw: 'pro', planLabel: 'Pro', planConfidence: 'observed' as const, availableModelCount: 3 },
      ],
      accounts: [],
      pressure: 0 as const,
      accountParallelismDisabledProviders: [] as readonly [],
    };
    const state = baseState({ capacity, boardEnabled: true });
    const m = buildControlPanelModel(state);
    const tokenRows = m.statusRows.filter(r => r.kind === 'tokens');
    assert.strictEqual(tokenRows.length, 0);
  });

  it('no fake percentages appear anywhere', () => {
    const capacity = {
      observedAtMs: 5000,
      providers: [
        { provider: 'claude' as const, installed: true, authenticated: true, planRaw: 'pro', planLabel: 'Pro', planConfidence: 'observed' as const, availableModelCount: 3, sessionTokens: 1000 },
      ],
      accounts: [],
      pressure: 1 as const,
      accountParallelismDisabledProviders: [] as readonly [],
    };
    const state = baseState({ capacity, boardEnabled: true });
    const m = buildControlPanelModel(state);
    for (const row of m.statusRows) {
      assert.strictEqual(/%/.test(row.text), false);
    }
    assert.strictEqual(/%/.test(m.summaryLine), false);
  });

  it('shows account cooldowns when present', () => {
    const nowMs = 5000;
    const capacity = {
      observedAtMs: nowMs,
      providers: [],
      accounts: [
        { id: 'acct-1', provider: 'claude' as const, label: 'work', enabled: true, status: 'active' as const, planRaw: 'pro', planLabel: 'Pro', priority: 'high' as const, cooldownUntil: nowMs + 300_000 },
      ],
      pressure: 1 as const,
      accountParallelismDisabledProviders: [] as readonly [],
    };
    const state = baseState({ capacity, boardEnabled: true });
    const m = buildControlPanelModel(state);
    const cooldownRows = m.statusRows.filter(r => r.kind === 'cooldown');
    assert.strictEqual(cooldownRows.length, 1);
    assert.strictEqual(cooldownRows[0].text.includes('work'), true);
  });

  it('explicit unknown rows for quota remaining, reset time, message allowance', () => {
    const capacity = {
      observedAtMs: 5000,
      providers: [{ provider: 'claude' as const, installed: true, authenticated: true, planRaw: 'pro', planLabel: 'Pro', planConfidence: 'observed' as const, availableModelCount: 3 }],
      accounts: [],
      pressure: 0 as const,
      accountParallelismDisabledProviders: [] as readonly [],
    };
    const state = baseState({ capacity, boardEnabled: true });
    const m = buildControlPanelModel(state);
    const unknownRows = m.statusRows.filter(r => r.kind === 'unknown');
    assert.strictEqual(unknownRows.some(r => r.text.includes('Quota remaining: unknown')), true);
    assert.strictEqual(unknownRows.some(r => r.text.includes('Reset time: unknown')), true);
    assert.strictEqual(unknownRows.some(r => r.text.includes('Message allowance: unknown')), true);
  });

  it('subscription account rows present when accounts exist', () => {
    const capacity = {
      observedAtMs: 5000,
      providers: [],
      accounts: [
        { id: 'acct-1', provider: 'claude' as const, label: 'work', enabled: true, status: 'active' as const, planRaw: 'max_20x', planLabel: 'Max 20x', priority: 'high' as const },
        { id: 'acct-2', provider: 'opencode' as const, label: 'personal', enabled: true, status: 'active' as const, planRaw: null, planLabel: 'unknown', priority: 'medium' as const },
      ],
      pressure: 0 as const,
      accountParallelismDisabledProviders: [] as readonly [],
    };
    const state = baseState({ capacity, boardEnabled: true });
    const m = buildControlPanelModel(state);
    const acctRows = m.statusRows.filter(r => r.text.includes('[claude]') || r.text.includes('[opencode]'));
    assert.strictEqual(acctRows.length, 2);
    assert.strictEqual(acctRows.some(r => r.text.includes('Max 20x')), true);
    // planLabel 'unknown' is intentionally omitted from the display row
    const opencodeRow = acctRows.find(r => r.text.includes('[opencode]'));
    assert.ok(opencodeRow !== undefined);
    assert.strictEqual(opencodeRow.text.includes('unknown'), false);
  });
});

// ---------------------------------------------------------------------------
// buildControlPanelModel — settings
// ---------------------------------------------------------------------------

describe('buildControlPanelModel settings', () => {
  it('when no snapshot: shows fallback rows with board diagnostic', () => {
    const m = buildControlPanelModel(baseState());
    assert.strictEqual(m.settings.length, 2);
    assert.strictEqual(m.settings[0].id, 'settings-unknown');
    assert.strictEqual(m.settings[0].kind, 'readonly');
    assert.strictEqual(m.settings[1].id, 'board');
    assert.strictEqual(m.settings[1].kind, 'readonly');
  });

  it('board diagnostic row reflects boardEnabled', () => {
    const off = buildControlPanelModel(baseState({ boardEnabled: false }));
    const boardRow = off.settings[off.settings.length - 1];
    assert.strictEqual(boardRow.id, 'board');
    assert.strictEqual(boardRow.kind, 'readonly');
    assert.strictEqual(boardRow.value, 'disabled');

    const on = buildControlPanelModel(baseState({ boardEnabled: true }));
    const boardRow2 = on.settings[on.settings.length - 1];
    assert.strictEqual(boardRow2.id, 'board');
    assert.strictEqual(boardRow2.value, 'enabled');
  });

  it('interactive rows built from settings snapshot', () => {
    const snapshot = {
      mode: 'auto',
      intensity: 'auto',
      oversight: 'checkpoint',
      verbosity: 'normal',
      colorTheme: 'dark' as const,
      memory: true,
      learnedTaste: true,
      codebaseAwareness: true,
      setAsDefault: false,
      modelGhost: false,
    };
    const m = buildControlPanelModel(baseState({ settings: snapshot }));
    // 10 interactive rows + 1 board read-only = 11 (D1 added Speed/intensity)
    assert.strictEqual(m.settings.length, 11);
    const modelGhost = m.settings.find((r) => r.id === 'model-ghost');
    assert.ok(modelGhost);
    assert.strictEqual(modelGhost.kind, 'toggle');
    assert.strictEqual(modelGhost.value, false);
    // First row: Effort (segmented, storage key mode)
    const mode = m.settings[0];
    assert.strictEqual(mode.id, 'mode');
    assert.strictEqual(mode.kind, 'segmented');
    assert.strictEqual(mode.value, 'auto');
    assert.strictEqual(mode.label, 'New conversation Effort');
    // Second row: Speed (storage key intensity)
    const speed = m.settings[1];
    assert.strictEqual(speed.id, 'intensity');
    assert.strictEqual(speed.kind, 'segmented');
    assert.strictEqual(speed.label, 'New conversation Speed');
    // Third row: oversight
    const oversight = m.settings[2];
    assert.strictEqual(oversight.id, 'oversight');
    assert.strictEqual(oversight.kind, 'segmented');
    // Fifth row: color-theme (toggle) with note
    const theme = m.settings[4];
    assert.strictEqual(theme.id, 'color-theme');
    assert.strictEqual(theme.kind, 'toggle');
    assert.strictEqual(theme.note, 'takes effect next launch');
    // Last row: board diagnostic
    const boardRow = m.settings[m.settings.length - 1];
    assert.strictEqual(boardRow.id, 'board');
    assert.strictEqual(boardRow.kind, 'readonly');
  });




});

// ---------------------------------------------------------------------------
// buildControlPanelModel — controlGoals (Phase 4)
// ---------------------------------------------------------------------------

describe('buildControlPanelModel controlGoals', () => {
  it('projects goal rows from the board', () => {
    const s = baseState({
      board: [br('g1', 'Alpha', { state: 'parked' })],
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.controlGoals.rows.length, 1);
    assert.strictEqual(m.controlGoals.rows[0].id, 'g1');
    assert.strictEqual(m.controlGoals.rows[0].state, 'parked');
    assert.strictEqual(m.controlGoals.rows[0].selected, true);
    assert.strictEqual(m.controlGoals.goalIds.length, 1);
    assert.strictEqual(m.controlGoals.highlightedGoalId, 'g1');
  });

  it('first goal is highlighted by default', () => {
    const s = baseState({
      board: [
        br('a', 'First'),
        br('b', 'Second'),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.controlGoals.highlightedGoalId, 'a');
    assert.strictEqual(m.controlGoals.rows[0].selected, true);
    assert.strictEqual(m.controlGoals.rows[1].selected, false);
  });

  it('respects explicit highlightedGoalId from goalsPanel', () => {
    const s = baseState({
      board: [
        br('a', 'First'),
        br('b', 'Second'),
      ],
      goalsPanel: { highlightedGoalId: 'b' },
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.controlGoals.highlightedGoalId, 'b');
    assert.strictEqual(m.controlGoals.rows[0].selected, false);
    assert.strictEqual(m.controlGoals.rows[1].selected, true);
  });

  it('builds detail for the highlighted goal', () => {
    const s = baseState({
      board: [
        br('g1', 'Alpha', {
          state: 'running',
          done: 1,
          total: 3,
          todos: [
            { id: 't1', text: 'task one', status: 'done' },
            { id: 't2', text: 'task two', status: 'pending' },
          ],
        }),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.ok(m.controlGoals.detail !== undefined);
    assert.strictEqual(m.controlGoals.detail!.id, 'g1');
    assert.strictEqual(m.controlGoals.detail!.todos.length, 2);
    assert.strictEqual(m.controlGoals.detail!.todos[0].text, 'task one');
    assert.strictEqual(m.controlGoals.detail!.todoOverflow, 0);
  });

  it('inactive goal detail includes todos', () => {
    const s = baseState({
      board: [
        br('g1', 'Parked', {
          state: 'parked',
          done: 0,
          total: 4,
          todos: [
            { id: 't1', text: 'wire API', status: 'pending' },
            { id: 't2', text: 'write docs', status: 'pending' },
            { id: 't3', text: 'add tests', status: 'pending' },
            { id: 't4', text: 'deploy', status: 'pending' },
          ],
        }),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.ok(m.controlGoals.detail !== undefined);
    assert.strictEqual(m.controlGoals.detail!.state, 'parked');
    assert.strictEqual(m.controlGoals.detail!.todos.length, 4);
    assert.strictEqual(m.controlGoals.detail!.todoOverflow, 0);
  });

  it('todoOverflow is surfaced from board rows', () => {
    const s = baseState({
      board: [
        br('g1', 'Big Plan', {
          state: 'running',
          done: 2,
          total: 12,
          todos: [
            { id: 't1', text: 'a', status: 'done' },
            { id: 't2', text: 'b', status: 'done' },
            { id: 't3', text: 'c', status: 'pending' },
          ],
          todoOverflow: 9,
        }),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.ok(m.controlGoals.detail !== undefined);
    assert.strictEqual(m.controlGoals.detail!.todoOverflow, 9);
    assert.strictEqual(m.controlGoals.detail!.total, 12);
    assert.strictEqual(m.controlGoals.detail!.done, 2);
  });

  it('verdict is carried to detail when present', () => {
    const s = baseState({
      board: [
        br('g1', 'Verified', {
          state: 'done',
          todos: [{ id: 't1', text: 'x', status: 'done' }],
          verdict: '\u2713 verified',
        }),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.ok(m.controlGoals.detail !== undefined);
    assert.strictEqual(m.controlGoals.detail!.verdict, '\u2713 verified');
  });

  it('approach is carried to detail when present', () => {
    const s = baseState({
      board: [
        br('g1', 'With Approach', {
          state: 'running',
          todos: [{ id: 't1', text: 'x', status: 'pending' }],
          approach: { chosen: 'monorepo', rationale: 'keeps things together' },
        }),
      ],
    });
    const m = buildControlPanelModel(s);
    assert.ok(m.controlGoals.detail !== undefined);
    assert.strictEqual(m.controlGoals.detail!.approach?.chosen, 'monorepo');
    assert.strictEqual(m.controlGoals.detail!.approach?.rationale, 'keeps things together');
  });

  it('unknown highlightedGoalId falls back to first goal', () => {
    const s = baseState({
      board: [
        br('a', 'First', { todos: [{ id: 't1', text: 'x', status: 'pending' }] }),
        br('b', 'Second'),
      ],
      goalsPanel: { highlightedGoalId: 'unknown' },
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.controlGoals.highlightedGoalId, 'a');
    // g1 has todos in detail
    assert.ok(m.controlGoals.detail !== undefined);
    assert.strictEqual(m.controlGoals.detail!.todos.length, 1);
  });

  it('empty board => empty controlGoals', () => {
    const s = baseState();
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.controlGoals.rows.length, 0);
    assert.strictEqual(m.controlGoals.goalIds.length, 0);
    assert.strictEqual(m.controlGoals.highlightedGoalId, undefined);
    assert.strictEqual(m.controlGoals.detail, undefined);
  });
});
