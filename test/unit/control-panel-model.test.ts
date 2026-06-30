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
    goalsPanel: { enabled: false, open: false },
    controlPanel: { enabled: false, open: false, activeSection: 'goals' },
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

describe('buildControlPanelModel quotaLabel', () => {
  it('always returns "unavailable in UI state"', () => {
    assert.strictEqual(
      buildControlPanelModel(baseState()).quotaLabel,
      'unavailable in UI state',
    );
    assert.strictEqual(
      buildControlPanelModel(
        baseState({ stream: { ...initialStreamView, phase: 'streaming' } }),
      ).quotaLabel,
      'unavailable in UI state',
    );
  });
});

// ---------------------------------------------------------------------------
// buildControlPanelModel — settings
// ---------------------------------------------------------------------------

describe('buildControlPanelModel settings', () => {
  it('fixed order: board, standalone Goals Panel, Control Panel', () => {
    const m = buildControlPanelModel(baseState());
    assert.strictEqual(m.settings.length, 3);
    assert.strictEqual(m.settings[0].id, 'board');
    assert.strictEqual(m.settings[1].id, 'goals-panel');
    assert.strictEqual(m.settings[2].id, 'control-panel');
  });

  it('board row has label "Persistent board" and real enabled value', () => {
    const off = buildControlPanelModel(baseState({ boardEnabled: false }));
    assert.strictEqual(off.settings[0].label, 'Persistent board');
    assert.strictEqual(off.settings[0].enabled, false);

    const on = buildControlPanelModel(baseState({ boardEnabled: true }));
    assert.strictEqual(on.settings[0].label, 'Persistent board');
    assert.strictEqual(on.settings[0].enabled, true);
  });

  it('Goals Panel row has label "Standalone Goals Panel" and real enabled value', () => {
    const off = buildControlPanelModel(
      baseState({ goalsPanel: { enabled: false, open: false } }),
    );
    assert.strictEqual(off.settings[1].label, 'Standalone Goals Panel');
    assert.strictEqual(off.settings[1].enabled, false);

    const on = buildControlPanelModel(
      baseState({ goalsPanel: { enabled: true, open: false } }),
    );
    assert.strictEqual(on.settings[1].label, 'Standalone Goals Panel');
    assert.strictEqual(on.settings[1].enabled, true);
  });

  it('Control Panel row has label "Control Panel" and real enabled value', () => {
    const off = buildControlPanelModel(
      baseState({
        controlPanel: { enabled: false, open: false, activeSection: 'goals' },
      }),
    );
    assert.strictEqual(off.settings[2].label, 'Control Panel');
    assert.strictEqual(off.settings[2].enabled, false);

    const on = buildControlPanelModel(
      baseState({
        controlPanel: { enabled: true, open: false, activeSection: 'goals' },
      }),
    );
    assert.strictEqual(on.settings[2].label, 'Control Panel');
    assert.strictEqual(on.settings[2].enabled, true);
  });

  it('note is omitted when standalone Goals is not superseded', () => {
    const m = buildControlPanelModel(
      baseState({
        goalsPanel: { enabled: true, open: false },
        controlPanel: { enabled: false, open: false, activeSection: 'goals' },
      }),
    );
    assert.strictEqual('note' in m.settings[1], false);
  });

  it('note is omitted when only Control Panel is enabled', () => {
    const m = buildControlPanelModel(
      baseState({
        goalsPanel: { enabled: false, open: false },
        controlPanel: { enabled: true, open: false, activeSection: 'goals' },
      }),
    );
    assert.strictEqual('note' in m.settings[1], false);
  });

  it('note is omitted when both are disabled', () => {
    const m = buildControlPanelModel(baseState());
    assert.strictEqual('note' in m.settings[1], false);
  });

  it('note = "superseded" when both goalsPanel.enabled and controlPanel.enabled are true', () => {
    const m = buildControlPanelModel(
      baseState({
        goalsPanel: { enabled: true, open: false },
        controlPanel: { enabled: true, open: false, activeSection: 'goals' },
      }),
    );
    assert.strictEqual(m.settings[1].note, 'superseded');
  });


});

// ---------------------------------------------------------------------------
// buildControlPanelModel — goals composition
// ---------------------------------------------------------------------------

describe('buildControlPanelModel goals', () => {
  it('reuses buildGoalsPanelModel with board', () => {
    const s = baseState({
      board: [br('g1', 'Ship')],
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.goals.rows.length, 1);
    assert.strictEqual(m.goals.rows[0].id, 'g1');
  });

  it('passes shared highlight from goalsPanel', () => {
    const s = baseState({
      board: [
        br('g1', 'Alpha', {
          todos: [{ id: 't1', text: 'task', status: 'done' }],
        }),
        br('g2', 'Beta', {
          todos: [{ id: 't2', text: 'other', status: 'pending' }],
        }),
      ],
      goalsPanel: { enabled: true, open: true, highlightedGoalId: 'g1' },
    });
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.goals.highlightedGoalId, 'g1');
    // g1 todos expanded
    assert.strictEqual(m.goals.rows.length, 3);
  });

  it('empty board => empty goals model with undefined highlight', () => {
    const s = baseState();
    const m = buildControlPanelModel(s);
    assert.strictEqual(m.goals.rows.length, 0);
    assert.strictEqual(m.goals.highlightedGoalId, undefined);
  });

  it('activeSection reflects controlPanel.activeSection', () => {
    const s = baseState({
      controlPanel: {
        enabled: true,
        open: true,
        activeSection: 'settings',
      },
    });
    assert.strictEqual(
      buildControlPanelModel(s).activeSection,
      'settings',
    );
  });
});
