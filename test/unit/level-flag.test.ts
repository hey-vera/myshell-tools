/**
 * test/unit/level-flag.test.ts — the DEFAULT-OFF / explicit-opt-IN contract for the
 * 5-level firepower dial (redesign Phase 0, slice 2). env OR config, default FALSE,
 * rollback forces off, never throws. Mirrors the role/verify flag shape.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { levelDialEnabled } from '../../src/interface/ui/level-flag.ts';

describe('levelDialEnabled — default OFF, explicit opt-IN via env or config', () => {
  it('absent env + absent config ⇒ false (scaffolding is off by default)', () => {
    assert.equal(levelDialEnabled(undefined, undefined), false);
    assert.equal(levelDialEnabled({}, {}), false);
  });

  it('explicit env opt-IN ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(
        levelDialEnabled({ MYSHELL_LEVEL_DIAL: v }, undefined),
        true,
        `MYSHELL_LEVEL_DIAL=${v}`,
      );
    }
  });

  it('config opt-IN (experimentalLevelDial === true) ⇒ true', () => {
    assert.equal(levelDialEnabled({}, { experimentalLevelDial: true }), true);
  });

  it('ambiguous / opt-out env values ⇒ false (default holds)', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(
        levelDialEnabled({ MYSHELL_LEVEL_DIAL: v }, undefined),
        false,
        `MYSHELL_LEVEL_DIAL=${v}`,
      );
    }
  });

  it('rollback forces it OFF even with an opt-in', () => {
    assert.equal(levelDialEnabled({ MYSHELL_LEVEL_DIAL: '1' }, { rollback: true }), false);
    assert.equal(levelDialEnabled({}, { experimentalLevelDial: true, rollback: true }), false);
    assert.equal(
      levelDialEnabled({ MYSHELL_ROLLBACK: '1', MYSHELL_LEVEL_DIAL: '1' }, undefined),
      false,
    );
  });

  it('never throws on a hostile env bag (defaults OFF)', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    ) as NodeJS.ProcessEnv;
    assert.equal(levelDialEnabled(hostile, undefined), false);
  });
});
