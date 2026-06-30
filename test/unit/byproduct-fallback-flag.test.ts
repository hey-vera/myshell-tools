/**
 * test/unit/byproduct-fallback-flag.test.ts — the DEFAULT-OFF flag for the
 * capability parse-from-text fallback (src/interface/ui/byproduct-fallback-flag.ts).
 *
 * Mirrors the pattern used by role-flag.test.ts and level-flag.test.ts.
 * All pure — no I/O, no model call.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { byproductFallbackEnabled } from '../../src/interface/ui/byproduct-fallback-flag.ts';

// Shorthand for a config that enables the flag.
const ON_CONFIG = { experimentalByproductFallback: true } as const;
// Shorthand for a config that explicitly disables it.
const OFF_CONFIG = { experimentalByproductFallback: false } as const;

// ---------------------------------------------------------------------------
// OFF by default
// ---------------------------------------------------------------------------

describe('byproductFallbackEnabled — DEFAULT OFF', () => {
  it('returns false when env and config are both undefined', () => {
    assert.equal(byproductFallbackEnabled(undefined, undefined), false);
  });

  it('returns false when env is empty and config is absent', () => {
    assert.equal(byproductFallbackEnabled({}, undefined), false);
  });

  it('returns false when config is an empty object', () => {
    assert.equal(byproductFallbackEnabled({}, {}), false);
  });

  it('returns false when config.experimentalByproductFallback is absent', () => {
    assert.equal(byproductFallbackEnabled({}, { onboarded: true } as never), false);
  });
});

// ---------------------------------------------------------------------------
// Opt-in via env var
// ---------------------------------------------------------------------------

describe('byproductFallbackEnabled — opt-in via MYSHELL_BYPRODUCT_FALLBACK', () => {
  const truthy = ['1', 'true', 'on', 'yes', 'TRUE', 'YES', 'ON', '  1  ', '  True  '];
  for (const v of truthy) {
    it(`MYSHELL_BYPRODUCT_FALLBACK="${v}" → true`, () => {
      assert.equal(
        byproductFallbackEnabled({ MYSHELL_BYPRODUCT_FALLBACK: v }, undefined),
        true,
      );
    });
  }

  const falsy = ['0', 'false', 'off', 'no', '', '  ', 'nope', 'enabled'];
  for (const v of falsy) {
    it(`MYSHELL_BYPRODUCT_FALLBACK="${v}" → false`, () => {
      assert.equal(
        byproductFallbackEnabled({ MYSHELL_BYPRODUCT_FALLBACK: v }, undefined),
        false,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Opt-in via config
// ---------------------------------------------------------------------------

describe('byproductFallbackEnabled — opt-in via config.experimentalByproductFallback', () => {
  it('returns true when config.experimentalByproductFallback === true', () => {
    assert.equal(byproductFallbackEnabled({}, ON_CONFIG), true);
  });

  it('returns false when config.experimentalByproductFallback === false', () => {
    assert.equal(byproductFallbackEnabled({}, OFF_CONFIG), false);
  });

  it('env opt-in takes precedence when config is false', () => {
    assert.equal(
      byproductFallbackEnabled({ MYSHELL_BYPRODUCT_FALLBACK: '1' }, OFF_CONFIG),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Rollback kill-switch
// ---------------------------------------------------------------------------

describe('byproductFallbackEnabled — rollback forces OFF', () => {
  it('MYSHELL_ROLLBACK=1 + config on → false', () => {
    assert.equal(
      byproductFallbackEnabled(
        { MYSHELL_ROLLBACK: '1', MYSHELL_BYPRODUCT_FALLBACK: '1' },
        ON_CONFIG,
      ),
      false,
    );
  });

  it('config.rollback=true + env opt-in → false', () => {
    assert.equal(
      byproductFallbackEnabled(
        { MYSHELL_BYPRODUCT_FALLBACK: '1' },
        { ...ON_CONFIG, rollback: true },
      ),
      false,
    );
  });

  it('MYSHELL_ROLLBACK=true → false regardless of config', () => {
    assert.equal(
      byproductFallbackEnabled({ MYSHELL_ROLLBACK: 'true' }, ON_CONFIG),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe('byproductFallbackEnabled — never throws', () => {
  it('does not throw when env is null-ish', () => {
    assert.doesNotThrow(() => byproductFallbackEnabled(undefined, undefined));
    assert.doesNotThrow(() => byproductFallbackEnabled({}, undefined));
    assert.doesNotThrow(() => byproductFallbackEnabled({}, {}));
  });
});
