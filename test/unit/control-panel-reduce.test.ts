/**
 * test/unit/control-panel-reduce.test.ts — characterization of the control-panel
 * reducer branches (Phase 2 Slice 10). All paths are pure, default-off, and
 * never mutate state. Mirrors the goals-panel-reduce.test.ts style.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { reduce } from '../../src/interface/ui/reduce.ts';
import { initialState, type Action, type UiCapacityState, type UiSettingsSnapshot } from '../../src/interface/ui/state.ts';

// ---------------------------------------------------------------------------
// initial state
// ---------------------------------------------------------------------------

describe('controlPanel initialState', () => {
  it('defaults to open=false, activeSection=goals', () => {
    assert.strictEqual(initialState.controlPanel.open, false);
    assert.strictEqual(initialState.controlPanel.activeSection, 'goals');
  });
});

// ---------------------------------------------------------------------------
// control-panel/open
// ---------------------------------------------------------------------------

describe('control-panel/open', () => {
  it('opens on Goals by default when section is omitted', () => {
    const st = reduce(initialState, { type: 'control-panel/open' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('opens on the requested section', () => {
    const st = reduce(initialState, {
      type: 'control-panel/open',
      section: 'status',
    } as Action);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'status');
  });

  it('can re-open and change section without closing first', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'status' } as Action);
    assert.strictEqual(st.controlPanel.activeSection, 'status');
    st = reduce(st, { type: 'control-panel/open', section: 'settings' } as Action);
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
    assert.strictEqual(st.controlPanel.open, true);
  });
});

// ---------------------------------------------------------------------------
// control-panel/close
// ---------------------------------------------------------------------------

describe('control-panel/close', () => {
  it('is a no-op when already closed', () => {
    const st = reduce(initialState, { type: 'control-panel/close' });
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('closes an open panel and preserves activeSection', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'settings' } as Action);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
    st = reduce(st, { type: 'control-panel/close' });
    assert.strictEqual(st.controlPanel.open, false);
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
  });

  it('preserves the shared highlight on close', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g7',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g7');
    st = reduce(st, { type: 'control-panel/close' });
    assert.strictEqual(st.controlPanel.open, false);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g7');
  });
});

// ---------------------------------------------------------------------------
// control-panel/toggle
// ---------------------------------------------------------------------------

describe('control-panel/toggle', () => {
  it('opens on Goals when closed (regardless of prior section)', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, { type: 'control-panel/close' });
    assert.strictEqual(st.controlPanel.activeSection, 'status');
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('closes when open', () => {
    let st = reduce(initialState, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('can toggle open/close/open repeatedly', () => {
    let st = reduce(initialState, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, false);
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });
});

// ---------------------------------------------------------------------------
// control-panel/set-section
// ---------------------------------------------------------------------------

describe('control-panel/set-section', () => {
  it('is a no-op when closed', () => {
    const st = reduce(initialState, {
      type: 'control-panel/set-section',
      section: 'status',
    });
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('sets the section to status when open', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/set-section',
      section: 'status',
    });
    assert.strictEqual(st.controlPanel.activeSection, 'status');
  });

  it('sets the section to settings when open', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/set-section',
      section: 'settings',
    });
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
  });

  it('sets the section to goals when open', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, {
      type: 'control-panel/set-section',
      section: 'goals',
    });
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });
});

// ---------------------------------------------------------------------------
// control-panel/highlight-goal
// ---------------------------------------------------------------------------

describe('control-panel/highlight-goal', () => {
  it('is a no-op when closed', () => {
    const st = reduce(initialState, {
      type: 'control-panel/highlight-goal',
      goalId: 'g1',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('is a no-op when open but on a non-goals section', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g1',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('updates shared highlight when open and on goals', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g1',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g1');
  });

  it('can overwrite a previous highlight', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g1',
    });
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g2',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g2');
  });
});

// ---------------------------------------------------------------------------
// unrelated actions preserve controlPanel
// ---------------------------------------------------------------------------

describe('unrelated actions', () => {
  it('turn/start preserves controlPanel untouched', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, { type: 'turn/start' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'status');
  });

  it('turn/reset preserves controlPanel untouched', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, { type: 'turn/reset' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('board/sync preserves controlPanel untouched', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'board/sync',
      rows: [],
      enabled: true,
    });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('stream actions preserve controlPanel untouched', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, { type: 'stream/prose', text: 'hello' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('turn/final preserves controlPanel untouched', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'turn/final',
      success: true,
      tier: 'worker',
      attempts: 1,
      sessionId: 's1',
      verbosity: 'normal',
    });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });
});

// ---------------------------------------------------------------------------
// control-panel/scroll
// ---------------------------------------------------------------------------

describe('control-panel/scroll', () => {
  it('is a no-op when closed', () => {
    const st = reduce(initialState, {
      type: 'control-panel/scroll',
      section: 'goals',
      delta: 5,
    });
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 0);
  });

  it('is a no-op when the section does not match active', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'status',
      delta: 5,
    });
    assert.strictEqual(st.controlPanel.statusScroll, 0);
  });

  it('scrolls goalsDetailScroll when target=detail on goals section', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'goals',
      target: 'detail',
      delta: 3,
    });
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 3);
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'goals',
      target: 'detail',
      delta: 2,
    });
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 5);
  });

  it('scrolls goalsListScroll when target=list on goals section', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'goals',
      target: 'list',
      delta: 4,
    });
    assert.strictEqual(st.controlPanel.goalsListScroll, 4);
  });

  it('scrolls statusScroll on status section without target', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'status',
      delta: 10,
    });
    assert.strictEqual(st.controlPanel.statusScroll, 10);
  });

  it('scrolls settingsScroll on settings section', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'settings' } as Action);
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'settings',
      delta: 7,
    });
    assert.strictEqual(st.controlPanel.settingsScroll, 7);
  });

  it('clamps scroll offsets to non-negative', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'goals',
      target: 'detail',
      delta: 5,
    });
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 5);
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'goals',
      target: 'detail',
      delta: -10,
    });
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 0);
  });
});

// ---------------------------------------------------------------------------
// control-panel/highlight-goal resets detail scroll
// ---------------------------------------------------------------------------

describe('control-panel/highlight-goal scroll reset', () => {
  it('resets goalsDetailScroll to 0 on highlight change', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'goals',
      target: 'detail',
      delta: 12,
    } as Action);
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 12);
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g2',
    });
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 0);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g2');
  });

  it('does not affect list scroll when highlight changes', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'goals',
      target: 'list',
      delta: 5,
    } as Action);
    assert.strictEqual(st.controlPanel.goalsListScroll, 5);
    st = reduce(st, { type: 'control-panel/highlight-goal', goalId: 'g2' });
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 0);
    assert.strictEqual(st.controlPanel.goalsListScroll, 5);
  });
});

// ---------------------------------------------------------------------------
// scroll offsets initialized to 0 on panel open/toggle
// ---------------------------------------------------------------------------

describe('scroll offsets initialization', () => {
  it('control-panel/open resets all scrolls to 0', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'status',
      delta: 15,
    } as Action);
    assert.strictEqual(st.controlPanel.statusScroll, 15);
    st = reduce(st, { type: 'control-panel/close' });
    st = reduce(st, { type: 'control-panel/open' });
    assert.strictEqual(st.controlPanel.statusScroll, 0);
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 0);
  });

  it('control-panel/toggle resets scrolls on open', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/scroll',
      section: 'goals',
      target: 'detail',
      delta: 8,
    } as Action);
    st = reduce(st, { type: 'control-panel/close' });
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.goalsDetailScroll, 0);
  });
});

// ---------------------------------------------------------------------------
// board/sync preserves todoOverflow (Phase 4A)
// ---------------------------------------------------------------------------

describe('board/sync todoOverflow preservation', () => {
  it('preserves todoOverflow on rows through sync', () => {
    let st = reduce(initialState, { type: 'board/sync', rows: [], enabled: true });
    st = reduce(st, {
      type: 'board/sync',
      rows: [
        {
          id: 'g1',
          title: 'Big',
          state: 'running' as const,
          done: 2,
          total: 12,
          glyph: '\u25B6',
          scope: 'global' as const,
          agents: 0,
          todos: [{ id: 't1', text: 'x', status: 'pending' as const }],
          todoOverflow: 7,
        },
      ],
      enabled: true,
    });
    const row = st.board[0];
    assert.ok(row !== undefined);
    assert.strictEqual(row.todoOverflow, 7);
    assert.ok(row.todos !== undefined);
    assert.strictEqual(row.todos!.length, 1);
  });

  it('board/sync for inactive goal preserves todos', () => {
    const st = reduce(initialState, {
      type: 'board/sync',
      rows: [
        {
          id: 'g1',
          title: 'Parked',
          state: 'parked' as const,
          done: 0,
          total: 4,
          glyph: '\u25CB',
          scope: 'global' as const,
          agents: 0,
          todos: [
            { id: 't1', text: 'step 1', status: 'pending' as const },
            { id: 't2', text: 'step 2', status: 'pending' as const },
          ],
        },
      ],
      enabled: true,
    });
    const row = st.board[0];
    assert.ok(row !== undefined);
    assert.strictEqual(row.state, 'parked');
    assert.ok(row.todos !== undefined);
    assert.strictEqual(row.todos!.length, 2);
  });
});

// ---------------------------------------------------------------------------
// capacity/sync
// ---------------------------------------------------------------------------

describe('capacity/sync', () => {
  function capacitySnapshot(over?: Partial<UiCapacityState>): UiCapacityState {
    return {
      observedAtMs: 5000,
      providers: [],
      accounts: [],
      pressure: 0 as const,
      accountParallelismDisabledProviders: [],
      ...over,
    };
  }

  it('replaces the capacity slice', () => {
    const c1 = capacitySnapshot({ pressure: 0 });
    const st1 = reduce(initialState, { type: 'capacity/sync', capacity: c1 });
    assert.ok(st1.capacity !== undefined);
    assert.strictEqual(st1.capacity!.pressure, 0);

    const c2 = capacitySnapshot({ pressure: 2 });
    const st2 = reduce(st1, { type: 'capacity/sync', capacity: c2 });
    assert.ok(st2.capacity !== undefined);
    assert.strictEqual(st2.capacity!.pressure, 2);
  });

  it('syncs pressure to the top-level pressure field', () => {
    const c = capacitySnapshot({ pressure: 3 });
    const st = reduce(initialState, { type: 'capacity/sync', capacity: c });
    assert.strictEqual(st.pressure, 3);
  });

  it('carries provider data through', () => {
    const c = capacitySnapshot({
      providers: [
        {
          provider: 'claude',
          installed: true,
          authenticated: true,
          planRaw: 'pro',
          planLabel: 'Pro',
          planConfidence: 'observed',
          availableModelCount: 5,
          sessionTokens: 1000,
        },
      ],
    });
    const st = reduce(initialState, { type: 'capacity/sync', capacity: c });
    assert.ok(st.capacity !== undefined);
    assert.strictEqual(st.capacity!.providers.length, 1);
    assert.strictEqual(st.capacity!.providers[0]!.planLabel, 'Pro');
  });

  it('carries account data through', () => {
    const c = capacitySnapshot({
      accounts: [
        {
          id: 'acct-1',
          provider: 'claude',
          label: 'work',
          enabled: true,
          status: 'active',
          planRaw: 'max_20x',
          planLabel: 'Max 20x',
          priority: 'high',
        },
      ],
    });
    const st = reduce(initialState, { type: 'capacity/sync', capacity: c });
    assert.ok(st.capacity !== undefined);
    assert.strictEqual(st.capacity!.accounts.length, 1);
    assert.strictEqual(st.capacity!.accounts[0]!.label, 'work');
  });

  it('carries shed plan when present', () => {
    const c = capacitySnapshot({
      shedPlan: {
        recapRefresh: false,
        memoryWidth: 'identity-only',
        intentPass: false,
        coreAnswer: true,
      },
    });
    const st = reduce(initialState, { type: 'capacity/sync', capacity: c });
    assert.ok(st.capacity !== undefined);
    assert.ok(st.capacity!.shedPlan !== undefined);
    assert.strictEqual(st.capacity!.shedPlan!.recapRefresh, false);
    assert.strictEqual(st.capacity!.shedPlan!.memoryWidth, 'identity-only');
    assert.strictEqual(st.capacity!.shedPlan!.coreAnswer, true);
  });

  it('initial state has no capacity', () => {
    assert.strictEqual(initialState.capacity, undefined);
  });
});

// ---------------------------------------------------------------------------
// control-panel/settings-select (Phase 4D)
// ---------------------------------------------------------------------------

describe('control-panel/settings-select', () => {
  it('no-op when closed', () => {
    const st = reduce(initialState, { type: 'control-panel/settings-select', index: 2 });
    assert.strictEqual(st.controlPanel.settingsSelectedIndex, -1);
  });

  it('no-op when on a non-settings section', () => {
    let st = reduce(initialState, { type: 'control-panel/open' });
    st = reduce(st, { type: 'control-panel/settings-select', index: 2 });
    assert.strictEqual(st.controlPanel.settingsSelectedIndex, -1);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('updates selected index when open on settings', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'settings' });
    st = reduce(st, { type: 'control-panel/settings-select', index: 3 });
    assert.strictEqual(st.controlPanel.settingsSelectedIndex, 3);
  });

  it('clamps below 0 to -1', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'settings' });
    st = reduce(st, { type: 'control-panel/settings-select', index: -5 });
    assert.strictEqual(st.controlPanel.settingsSelectedIndex, -1);
  });

  it('resets to -1 on set-section', () => {
    let st = reduce(initialState, { type: 'control-panel/open', section: 'settings' });
    st = reduce(st, { type: 'control-panel/settings-select', index: 2 });
    st = reduce(st, { type: 'control-panel/set-section', section: 'goals' });
    assert.strictEqual(st.controlPanel.settingsSelectedIndex, -1);
  });
});

// ---------------------------------------------------------------------------
// settings/sync (Phase 4D)
// ---------------------------------------------------------------------------

describe('settings/sync', () => {
  it('initial state has no settings', () => {
    assert.strictEqual(initialState.settings, undefined);
  });

  it('replaces the settings snapshot', () => {
    const snapshot: UiSettingsSnapshot = {
      mode: 'balanced',
      oversight: 'checkpoint',
      verbosity: 'normal',
      colorTheme: 'dark',
      memory: true,
      learnedTaste: false,
      codebaseAwareness: true,
      setAsDefault: false,
    };
    const st = reduce(initialState, { type: 'settings/sync', settings: snapshot });
    assert.ok(st.settings !== undefined);
    assert.strictEqual(st.settings!.mode, 'balanced');
    assert.strictEqual(st.settings!.oversight, 'checkpoint');
    assert.strictEqual(st.settings!.memory, true);
    assert.strictEqual(st.settings!.learnedTaste, false);
  });

  it('overwrites a previous snapshot', () => {
    const s1: UiSettingsSnapshot = {
      mode: 'auto', oversight: 'autonomous', verbosity: 'verbose',
      colorTheme: 'light', memory: false, learnedTaste: true,
      codebaseAwareness: false, setAsDefault: true,
    };
    const s2: UiSettingsSnapshot = {
      mode: 'max', oversight: 'review-all', verbosity: 'quiet',
      colorTheme: 'dark', memory: true, learnedTaste: false,
      codebaseAwareness: true, setAsDefault: false,
    };
    const st = reduce(
      reduce(initialState, { type: 'settings/sync', settings: s1 }),
      { type: 'settings/sync', settings: s2 },
    );
    assert.strictEqual(st.settings!.mode, 'max');
    assert.strictEqual(st.settings!.colorTheme, 'dark');
  });
});
