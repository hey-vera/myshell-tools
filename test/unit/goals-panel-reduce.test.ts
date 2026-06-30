/**
 * test/unit/goals-panel-reduce.test.ts — characterization of the goals-panel
 * reducer branches (Phase 1 Slice 2). All paths are pure, default-off, and
 * never mutate state.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { reduce } from '../../src/interface/ui/reduce.ts';
import { initialState, type Action } from '../../src/interface/ui/state.ts';

// ---------------------------------------------------------------------------
// initial state
// ---------------------------------------------------------------------------

describe('goalsPanel initialState', () => {
  it('defaults to enabled=false, open=false, no highlight', () => {
    assert.strictEqual(initialState.goalsPanel.enabled, false);
    assert.strictEqual(initialState.goalsPanel.open, false);
    assert.strictEqual(initialState.goalsPanel.highlightedGoalId, undefined);
  });
});

// ---------------------------------------------------------------------------
// goals-panel/open
// ---------------------------------------------------------------------------

describe('goals-panel/open', () => {
  it('is a no-op when the panel is disabled', () => {
    const st = reduce(initialState, { type: 'goals-panel/open' });
    assert.strictEqual(st.goalsPanel.enabled, false);
    assert.strictEqual(st.goalsPanel.open, false);
  });

  it('opens the panel when enabled', () => {
    const enabled = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    const st = reduce(enabled, { type: 'goals-panel/open' });
    assert.strictEqual(st.goalsPanel.enabled, true);
    assert.strictEqual(st.goalsPanel.open, true);
  });

  it('sets highlightedGoalId when provided on open', () => {
    const enabled = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    const st = reduce(enabled, {
      type: 'goals-panel/open',
      highlightedGoalId: 'g1',
    } as Action);
    assert.strictEqual(st.goalsPanel.open, true);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g1');
  });
});

// ---------------------------------------------------------------------------
// goals-panel/close
// ---------------------------------------------------------------------------

describe('goals-panel/close', () => {
  it('closes an open panel', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/open' });
    assert.strictEqual(st.goalsPanel.open, true);
    st = reduce(st, { type: 'goals-panel/close' });
    assert.strictEqual(st.goalsPanel.open, false);
  });
});

// ---------------------------------------------------------------------------
// goals-panel/toggle
// ---------------------------------------------------------------------------

describe('goals-panel/toggle', () => {
  it('is a no-op when disabled', () => {
    const st = reduce(initialState, { type: 'goals-panel/toggle' });
    assert.strictEqual(st.goalsPanel.open, false);
  });

  it('opens then closes when toggled twice', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/toggle' });
    assert.strictEqual(st.goalsPanel.open, true);
    st = reduce(st, { type: 'goals-panel/toggle' });
    assert.strictEqual(st.goalsPanel.open, false);
  });
});

// ---------------------------------------------------------------------------
// goals-panel/configure
// ---------------------------------------------------------------------------

describe('goals-panel/configure', () => {
  it('force-closes an open panel and clears highlight when disabled', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, {
      type: 'goals-panel/open',
      highlightedGoalId: 'g1',
    } as Action);
    assert.strictEqual(st.goalsPanel.open, true);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g1');

    st = reduce(st, { type: 'goals-panel/configure', enabled: false });
    assert.strictEqual(st.goalsPanel.enabled, false);
    assert.strictEqual(st.goalsPanel.open, false);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });
});

// ---------------------------------------------------------------------------
// goals-panel/highlight
// ---------------------------------------------------------------------------

describe('goals-panel/highlight', () => {
  it('is a no-op when disabled', () => {
    const st = reduce(initialState, {
      type: 'goals-panel/highlight',
      goalId: 'g1',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('is a no-op when enabled but closed', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/highlight', goalId: 'g1' });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('sets highlightedGoalId when enabled and open', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/open' });
    st = reduce(st, { type: 'goals-panel/highlight', goalId: 'g1' });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g1');
  });
});

// ---------------------------------------------------------------------------
// unrelated action preserves goalsPanel
// ---------------------------------------------------------------------------

describe('unrelated actions', () => {
  it('preserve goalsPanel state untouched', () => {
    const st = reduce(initialState, { type: 'turn/start' });
    assert.strictEqual(st.goalsPanel.enabled, false);
    assert.strictEqual(st.goalsPanel.open, false);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });
});
