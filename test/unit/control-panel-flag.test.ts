/**
 * test/unit/control-panel-flag.test.ts — the DEFAULT-OFF flag for the
 * control panel surface (src/interface/ui/control-panel-flag.ts).
 *
 * Mirrors the pattern used by goals-panel-flag.test.ts. All pure — no I/O,
 * no model call.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { controlPanelEnabled } from '../../src/interface/ui/control-panel-flag.ts';

// Shorthand for a config that enables the flag.
const ON_CONFIG = { experimentalControlPanel: true } as const;
// Shorthand for a config that explicitly disables it.
const OFF_CONFIG = { experimentalControlPanel: false } as const;

// ---------------------------------------------------------------------------
// OFF by default
// ---------------------------------------------------------------------------

describe('controlPanelEnabled — DEFAULT OFF', () => {
  it('returns false when env and config are both undefined', () => {
    assert.equal(controlPanelEnabled(undefined, undefined), false);
  });

  it('returns false when env is empty and config is absent', () => {
    assert.equal(controlPanelEnabled({}, undefined), false);
  });

  it('returns false when config is an empty object', () => {
    assert.equal(controlPanelEnabled({}, {}), false);
  });
});

// ---------------------------------------------------------------------------
// Opt-in via env var
// ---------------------------------------------------------------------------

describe('controlPanelEnabled — opt-in via MYSHELL_CONTROL_PANEL', () => {
  const truthy = ['1', 'true', 'on', 'yes', 'TRUE', 'YES', 'ON', '  1  ', '  True  '];
  for (const v of truthy) {
    it(`MYSHELL_CONTROL_PANEL="${v}" → true`, () => {
      assert.equal(
        controlPanelEnabled({ MYSHELL_CONTROL_PANEL: v }, undefined),
        true,
      );
    });
  }

  const falsy = ['0', 'false', 'off', 'no', '', '  ', 'nope'];
  for (const v of falsy) {
    it(`MYSHELL_CONTROL_PANEL="${v}" → false`, () => {
      assert.equal(
        controlPanelEnabled({ MYSHELL_CONTROL_PANEL: v }, undefined),
        false,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Opt-in via config
// ---------------------------------------------------------------------------

describe('controlPanelEnabled — opt-in via config.experimentalControlPanel', () => {
  it('returns true when config.experimentalControlPanel === true', () => {
    assert.equal(controlPanelEnabled({}, ON_CONFIG), true);
  });

  it('returns false when config.experimentalControlPanel === false', () => {
    assert.equal(controlPanelEnabled({}, OFF_CONFIG), false);
  });

  it('env opt-in takes precedence when config is false', () => {
    assert.equal(
      controlPanelEnabled({ MYSHELL_CONTROL_PANEL: '1' }, OFF_CONFIG),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe('controlPanelEnabled — never throws', () => {
  it('does not throw when env is null-ish', () => {
    assert.doesNotThrow(() => controlPanelEnabled(undefined, undefined));
    assert.doesNotThrow(() => controlPanelEnabled({}, undefined));
    assert.doesNotThrow(() => controlPanelEnabled({}, {}));
  });
});
