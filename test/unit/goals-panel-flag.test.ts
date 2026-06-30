/**
 * test/unit/goals-panel-flag.test.ts — the DEFAULT-OFF flag for the
 * goals panel surface (src/interface/ui/goals-panel-flag.ts).
 *
 * Mirrors the pattern used by byproduct-fallback-flag.test.ts and
 * governor-flag.test.ts. All pure — no I/O, no model call.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { goalsPanelEnabled } from '../../src/interface/ui/goals-panel-flag.ts';

// Shorthand for a config that enables the flag.
const ON_CONFIG = { experimentalGoalsPanel: true } as const;
// Shorthand for a config that explicitly disables it.
const OFF_CONFIG = { experimentalGoalsPanel: false } as const;

// ---------------------------------------------------------------------------
// OFF by default
// ---------------------------------------------------------------------------

describe('goalsPanelEnabled — DEFAULT OFF', () => {
  it('returns false when env and config are both undefined', () => {
    assert.equal(goalsPanelEnabled(undefined, undefined), false);
  });

  it('returns false when env is empty and config is absent', () => {
    assert.equal(goalsPanelEnabled({}, undefined), false);
  });

  it('returns false when config is an empty object', () => {
    assert.equal(goalsPanelEnabled({}, {}), false);
  });
});

// ---------------------------------------------------------------------------
// Opt-in via env var
// ---------------------------------------------------------------------------

describe('goalsPanelEnabled — opt-in via MYSHELL_GOALS_PANEL', () => {
  const truthy = ['1', 'true', 'on', 'yes', 'TRUE', 'YES', 'ON', '  1  ', '  True  '];
  for (const v of truthy) {
    it(`MYSHELL_GOALS_PANEL="${v}" → true`, () => {
      assert.equal(
        goalsPanelEnabled({ MYSHELL_GOALS_PANEL: v }, undefined),
        true,
      );
    });
  }

  const falsy = ['0', 'false', 'off', 'no', '', '  ', 'nope'];
  for (const v of falsy) {
    it(`MYSHELL_GOALS_PANEL="${v}" → false`, () => {
      assert.equal(
        goalsPanelEnabled({ MYSHELL_GOALS_PANEL: v }, undefined),
        false,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Opt-in via config
// ---------------------------------------------------------------------------

describe('goalsPanelEnabled — opt-in via config.experimentalGoalsPanel', () => {
  it('returns true when config.experimentalGoalsPanel === true', () => {
    assert.equal(goalsPanelEnabled({}, ON_CONFIG), true);
  });

  it('returns false when config.experimentalGoalsPanel === false', () => {
    assert.equal(goalsPanelEnabled({}, OFF_CONFIG), false);
  });

  it('env opt-in takes precedence when config is false', () => {
    assert.equal(
      goalsPanelEnabled({ MYSHELL_GOALS_PANEL: '1' }, OFF_CONFIG),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe('goalsPanelEnabled — never throws', () => {
  it('does not throw when env is null-ish', () => {
    assert.doesNotThrow(() => goalsPanelEnabled(undefined, undefined));
    assert.doesNotThrow(() => goalsPanelEnabled({}, undefined));
    assert.doesNotThrow(() => goalsPanelEnabled({}, {}));
  });
});
