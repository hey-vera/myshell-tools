/**
 * test/unit/manager-flag.test.ts — the DEFAULT-OFF opt-in for the PER-GOAL
 * MANAGER CYCLE (elite-partner Part 7). Mirrors the truly-complete / board /
 * auto-goal flag shape: env OR config, default false, never throws. When false
 * runGoalLoop is byte-for-byte today's free turn loop (the cycle never drives).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { managerCycleEnabled } from '../../src/interface/ui/manager-flag.ts';

describe('managerCycleEnabled — default OFF, opt-in via env or config', () => {
  it('absent env + absent config ⇒ false (the cycle ships dark)', () => {
    assert.equal(managerCycleEnabled(undefined, undefined), false);
    assert.equal(managerCycleEnabled({}, {}), false);
    assert.equal(managerCycleEnabled({}, { experimentalManager: false }), false);
  });

  it('explicit env opt-in ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(managerCycleEnabled({ MYSHELL_MANAGER: v }, undefined), true, `MYSHELL_MANAGER=${v}`);
    }
  });

  it('config opt-in (experimentalManager === true) ⇒ true', () => {
    assert.equal(managerCycleEnabled({}, { experimentalManager: true }), true);
  });

  it('off-ish env values ⇒ false', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(managerCycleEnabled({ MYSHELL_MANAGER: v }, undefined), false, `MYSHELL_MANAGER=${v}`);
    }
  });

  it('never throws on a hostile env bag', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(managerCycleEnabled(hostile, undefined), false);
  });
});
