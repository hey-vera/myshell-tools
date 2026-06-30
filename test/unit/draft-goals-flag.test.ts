/**
 * test/unit/draft-goals-flag.test.ts — the DEFAULT-OFF flag for the draft-
 * goal-skeleton feature (src/interface/ui/draft-goals-flag.ts).
 *
 * Mirrors the pattern used by byproduct-fallback-flag.test.ts and
 * auto-brain-flag.test.ts. All pure — no I/O, no model call.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { draftGoalsEnabled } from '../../src/interface/ui/draft-goals-flag.ts';

// Shorthand for a config that enables the flag.
const ON_CONFIG = { experimentalDraftGoals: true } as const;
// Shorthand for a config that explicitly disables it.
const OFF_CONFIG = { experimentalDraftGoals: false } as const;

// ---------------------------------------------------------------------------
// OFF by default
// ---------------------------------------------------------------------------

describe('draftGoalsEnabled — DEFAULT OFF', () => {
  it('returns false when env and config are both undefined', () => {
    assert.equal(draftGoalsEnabled(undefined, undefined), false);
  });

  it('returns false when env is empty and config is absent', () => {
    assert.equal(draftGoalsEnabled({}, undefined), false);
  });

  it('returns false when config is an empty object', () => {
    assert.equal(draftGoalsEnabled({}, {}), false);
  });

  it('returns false when config.experimentalDraftGoals is absent', () => {
    assert.equal(draftGoalsEnabled({}, { onboarded: true } as never), false);
  });
});

// ---------------------------------------------------------------------------
// Opt-in via env var
// ---------------------------------------------------------------------------

describe('draftGoalsEnabled — opt-in via MYSHELL_DRAFT_GOALS', () => {
  const truthy = ['1', 'true', 'on', 'yes', 'TRUE', 'YES', 'ON', '  1  ', '  True  '];
  for (const v of truthy) {
    it(`MYSHELL_DRAFT_GOALS="${v}" → true`, () => {
      assert.equal(
        draftGoalsEnabled({ MYSHELL_DRAFT_GOALS: v }, undefined),
        true,
      );
    });
  }

  const falsy = ['0', 'false', 'off', 'no', '', '  ', 'nope', 'enabled'];
  for (const v of falsy) {
    it(`MYSHELL_DRAFT_GOALS="${v}" → false`, () => {
      assert.equal(
        draftGoalsEnabled({ MYSHELL_DRAFT_GOALS: v }, undefined),
        false,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Opt-in via config
// ---------------------------------------------------------------------------

describe('draftGoalsEnabled — opt-in via config.experimentalDraftGoals', () => {
  it('returns true when config.experimentalDraftGoals === true', () => {
    assert.equal(draftGoalsEnabled({}, ON_CONFIG), true);
  });

  it('returns false when config.experimentalDraftGoals === false', () => {
    assert.equal(draftGoalsEnabled({}, OFF_CONFIG), false);
  });

  it('env opt-in takes precedence when config is false', () => {
    assert.equal(
      draftGoalsEnabled({ MYSHELL_DRAFT_GOALS: '1' }, OFF_CONFIG),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Rollback kill-switch
// ---------------------------------------------------------------------------

describe('draftGoalsEnabled — rollback forces OFF', () => {
  it('MYSHELL_ROLLBACK=1 + config on → false', () => {
    assert.equal(
      draftGoalsEnabled(
        { MYSHELL_ROLLBACK: '1', MYSHELL_DRAFT_GOALS: '1' },
        ON_CONFIG,
      ),
      false,
    );
  });

  it('config.rollback=true + env opt-in → false', () => {
    assert.equal(
      draftGoalsEnabled(
        { MYSHELL_DRAFT_GOALS: '1' },
        { ...ON_CONFIG, rollback: true },
      ),
      false,
    );
  });

  it('MYSHELL_ROLLBACK=true → false regardless of config', () => {
    assert.equal(
      draftGoalsEnabled({ MYSHELL_ROLLBACK: 'true' }, ON_CONFIG),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe('draftGoalsEnabled — never throws', () => {
  it('does not throw when env is null-ish', () => {
    assert.doesNotThrow(() => draftGoalsEnabled(undefined, undefined));
    assert.doesNotThrow(() => draftGoalsEnabled({}, undefined));
    assert.doesNotThrow(() => draftGoalsEnabled({}, {}));
  });
});
