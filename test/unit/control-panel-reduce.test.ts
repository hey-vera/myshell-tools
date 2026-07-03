/**
 * test/unit/control-panel-reduce.test.ts — characterization of the control-panel
 * reducer branches (Phase 2 Slice 10). All paths are pure, default-off, and
 * never mutate state. Mirrors the goals-panel-reduce.test.ts style.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { reduce } from '../../src/interface/ui/reduce.ts';
import { initialState, type Action } from '../../src/interface/ui/state.ts';

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
