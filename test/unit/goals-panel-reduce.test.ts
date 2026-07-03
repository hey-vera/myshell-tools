/**
 * test/unit/goals-panel-reduce.test.ts — characterization of the goals-panel
 * state slice (Phase 3). goalsPanel only holds shared highlight via
 * control-panel/highlight-goal. No standalone goals-panel actions exist.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { reduce } from '../../src/interface/ui/reduce.ts';
import { initialState } from '../../src/interface/ui/state.ts';

// ---------------------------------------------------------------------------
// initial state
// ---------------------------------------------------------------------------

describe('goalsPanel initialState', () => {
  it('defaults to empty object (no enabled, no open, no highlight)', () => {
    assert.deepEqual(initialState.goalsPanel, {});
  });
});

// ---------------------------------------------------------------------------
// unrelated action preserves goalsPanel
// ---------------------------------------------------------------------------

describe('unrelated actions', () => {
  it('preserve goalsPanel state untouched', () => {
    const st = reduce(initialState, { type: 'turn/start' });
    assert.deepEqual(st.goalsPanel, {});
  });
});
