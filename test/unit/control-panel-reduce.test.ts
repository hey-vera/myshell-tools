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
  it('defaults to enabled=false, open=false, activeSection=goals', () => {
    assert.strictEqual(initialState.controlPanel.enabled, false);
    assert.strictEqual(initialState.controlPanel.open, false);
    assert.strictEqual(initialState.controlPanel.activeSection, 'goals');
  });
});

// ---------------------------------------------------------------------------
// control-panel/configure
// ---------------------------------------------------------------------------

describe('control-panel/configure', () => {
  it('enables while preserving existing open/activeSection', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    assert.strictEqual(st.controlPanel.enabled, true);
    // open stays false (was false before)
    assert.strictEqual(st.controlPanel.open, false);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
    // open the panel on settings, then reconfigure
    st = reduce(st, { type: 'control-panel/open', section: 'settings' } as Action);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    assert.strictEqual(st.controlPanel.enabled, true);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
  });

  it('disables, closes, and resets activeSection to goals', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, {
      type: 'control-panel/open',
      section: 'status',
    } as Action);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'status');
    st = reduce(st, { type: 'control-panel/configure', enabled: false });
    assert.strictEqual(st.controlPanel.enabled, false);
    assert.strictEqual(st.controlPanel.open, false);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('disable preserves goalsPanel unchanged', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/configure', enabled: false });
    assert.strictEqual(st.goalsPanel.enabled, true);
    assert.strictEqual(st.goalsPanel.open, false);
  });

  it('enable force-closes goalsPanel.open while preserving enabled + highlight', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/open', highlightedGoalId: 'g42' } as Action);
    assert.strictEqual(st.goalsPanel.open, true);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g42');
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    assert.strictEqual(st.controlPanel.enabled, true);
    assert.strictEqual(st.goalsPanel.enabled, true);
    assert.strictEqual(st.goalsPanel.open, false);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g42');
  });

  it('enable force-closes goalsPanel.open even when no highlight exists', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/open' });
    assert.strictEqual(st.goalsPanel.open, true);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    assert.strictEqual(st.goalsPanel.open, false);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('enable does not mutate goalsPanel.enabled=false', () => {
    const st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    assert.strictEqual(st.goalsPanel.enabled, false);
    assert.strictEqual(st.goalsPanel.open, false);
  });
});

// ---------------------------------------------------------------------------
// control-panel/open
// ---------------------------------------------------------------------------

describe('control-panel/open', () => {
  it('is a no-op when disabled', () => {
    const st = reduce(initialState, { type: 'control-panel/open' });
    assert.strictEqual(st.controlPanel.enabled, false);
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('opens on Goals by default when section is omitted', () => {
    const enabled = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    const st = reduce(enabled, { type: 'control-panel/open' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('opens on the requested section', () => {
    const enabled = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    const st = reduce(enabled, {
      type: 'control-panel/open',
      section: 'status',
    } as Action);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'status');
  });

  it('can re-open and change section without closing first', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open', section: 'status' } as Action);
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
  it('is a no-op when disabled', () => {
    const st = reduce(initialState, { type: 'control-panel/close' });
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('is a no-op when already closed', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    // already closed
    st = reduce(st, { type: 'control-panel/close' });
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('closes an open panel and preserves activeSection', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open', section: 'settings' } as Action);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
    st = reduce(st, { type: 'control-panel/close' });
    assert.strictEqual(st.controlPanel.open, false);
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
  });

  it('preserves the shared highlight on close', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
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
  it('is a no-op when disabled', () => {
    const st = reduce(initialState, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('opens on Goals when closed (regardless of prior section)', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    // Set section to status, close, then toggle — should open on goals
    st = reduce(st, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, { type: 'control-panel/close' });
    assert.strictEqual(st.controlPanel.activeSection, 'status');
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('closes when open', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('can toggle open/close/open repeatedly', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/toggle' });
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
  it('is a no-op when disabled', () => {
    const st = reduce(initialState, {
      type: 'control-panel/set-section',
      section: 'status',
    });
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('is a no-op when enabled but closed', () => {
    const enabled = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    const st = reduce(enabled, {
      type: 'control-panel/set-section',
      section: 'status',
    });
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('sets the section to status when enabled and open', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/set-section',
      section: 'status',
    });
    assert.strictEqual(st.controlPanel.activeSection, 'status');
  });

  it('sets the section to settings when enabled and open', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/set-section',
      section: 'settings',
    });
    assert.strictEqual(st.controlPanel.activeSection, 'settings');
  });

  it('sets the section to goals when enabled and open', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open', section: 'status' } as Action);
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
  it('is a no-op when disabled', () => {
    const st = reduce(initialState, {
      type: 'control-panel/highlight-goal',
      goalId: 'g1',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('is a no-op when enabled but closed', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g1',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('is a no-op when open but on a non-goals section', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g1',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('updates shared highlight when enabled, open, and on goals', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'control-panel/highlight-goal',
      goalId: 'g1',
    });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g1');
  });

  it('can overwrite a previous highlight', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
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
// precedence: goals-panel guarded when controlPanel enabled
// ---------------------------------------------------------------------------

describe('goals-panel precedence guards', () => {
  it('goals-panel/open is a no-op when controlPanel.enabled', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    st = reduce(st, { type: 'goals-panel/open' });
    // goalsPanel.open must stay false under CP supersession
    assert.strictEqual(st.goalsPanel.open, false);
    // controlPanel must stay closed (only CP.open opens it)
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('goals-panel/toggle is a no-op when controlPanel.enabled', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    st = reduce(st, { type: 'goals-panel/toggle' });
    assert.strictEqual(st.goalsPanel.open, false);
  });

  it('goals-panel/configure keeps open=false when controlPanel is enabled', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    // Try to enable goals-panel — should allow enabled but keep open false
    st = reduce(st, { type: 'goals-panel/configure', enabled: true });
    assert.strictEqual(st.goalsPanel.enabled, true);
    assert.strictEqual(st.goalsPanel.open, false);
  });

  it('goals-panel/configure still forces open=false when re-disabling', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    st = reduce(st, { type: 'goals-panel/configure', enabled: false });
    assert.strictEqual(st.goalsPanel.enabled, false);
    assert.strictEqual(st.goalsPanel.open, false);
  });

  it('goals-panel cases are byte-identical when controlPanel is disabled', () => {
    // Enable goals-panel, open it, set a highlight
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/open', highlightedGoalId: 'g1' } as Action);
    assert.strictEqual(st.goalsPanel.open, true);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g1');

    // Toggle closes
    st = reduce(st, { type: 'goals-panel/toggle' });
    assert.strictEqual(st.goalsPanel.open, false);
    // Highlight preserved while closed
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g1');

    // Toggle opens
    st = reduce(st, { type: 'goals-panel/toggle' });
    assert.strictEqual(st.goalsPanel.open, true);

    // Highlight when open
    st = reduce(st, { type: 'goals-panel/highlight', goalId: 'g2' });
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g2');

    // Close preserves highlight
    st = reduce(st, { type: 'goals-panel/close' });
    assert.strictEqual(st.goalsPanel.open, false);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'g2');

    // Disable clears highlight
    st = reduce(st, { type: 'goals-panel/configure', enabled: false });
    assert.strictEqual(st.goalsPanel.enabled, false);
    assert.strictEqual(st.goalsPanel.open, false);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });

  it('goals-panel/highlight is still no-op when CP is on but goalsPanel is open=false', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    // goalsPanel is force-closed by CP configure
    st = reduce(st, { type: 'goals-panel/highlight', goalId: 'gX' });
    // highlight should NOT be set because goalsPanel.open is false
    assert.strictEqual(st.goalsPanel.highlightedGoalId, undefined);
  });
});

// ---------------------------------------------------------------------------
// unrelated actions preserve controlPanel
// ---------------------------------------------------------------------------

describe('unrelated actions', () => {
  it('turn/start preserves controlPanel untouched', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open', section: 'status' } as Action);
    st = reduce(st, { type: 'turn/start' });
    assert.strictEqual(st.controlPanel.enabled, true);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'status');
  });

  it('turn/reset preserves controlPanel untouched', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
    st = reduce(st, { type: 'turn/reset' });
    assert.strictEqual(st.controlPanel.enabled, true);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('board/sync preserves controlPanel untouched', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'board/sync',
      rows: [],
      enabled: true,
    });
    assert.strictEqual(st.controlPanel.enabled, true);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('stream actions preserve controlPanel untouched', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
    st = reduce(st, { type: 'stream/prose', text: 'hello' });
    assert.strictEqual(st.controlPanel.enabled, true);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });

  it('turn/final preserves controlPanel untouched', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/open' });
    st = reduce(st, {
      type: 'turn/final',
      success: true,
      tier: 'worker',
      attempts: 1,
      sessionId: 's1',
      verbosity: 'normal',
    });
    assert.strictEqual(st.controlPanel.enabled, true);
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
  });
});

// ---------------------------------------------------------------------------
// combined precedence matrix (enable × open)
// ---------------------------------------------------------------------------

describe('precedence matrix', () => {
  it('both disabled: goals-panel behaves independently', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/open' });
    assert.strictEqual(st.goalsPanel.open, true);
    assert.strictEqual(st.controlPanel.open, false);
  });

  it('CP enabled, GP disabled: CP toggle opens CP, GP stays closed', () => {
    let st = reduce(initialState, {
      type: 'control-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.goalsPanel.enabled, false);
    assert.strictEqual(st.goalsPanel.open, false);
  });

  it('both enabled: CP supersedes — CP toggle works, GP toggle is no-op', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    // CP toggle opens
    st = reduce(st, { type: 'control-panel/toggle' });
    assert.strictEqual(st.controlPanel.open, true);
    assert.strictEqual(st.controlPanel.activeSection, 'goals');
    assert.strictEqual(st.goalsPanel.open, false);
    // GP toggle is no-op
    st = reduce(st, { type: 'goals-panel/toggle' });
    assert.strictEqual(st.goalsPanel.open, false);
  });

  it('configure(true) with GP enabled+open+highlight preserves GP state minus open', () => {
    let st = reduce(initialState, {
      type: 'goals-panel/configure',
      enabled: true,
    });
    st = reduce(st, { type: 'goals-panel/open', highlightedGoalId: 'h99' } as Action);
    st = reduce(st, { type: 'control-panel/configure', enabled: true });
    assert.strictEqual(st.goalsPanel.enabled, true);
    assert.strictEqual(st.goalsPanel.open, false);
    assert.strictEqual(st.goalsPanel.highlightedGoalId, 'h99');
    assert.strictEqual(st.controlPanel.enabled, true);
  });
});
