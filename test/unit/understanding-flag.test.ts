/**
 * test/unit/understanding-flag.test.ts — the DEFAULT-OFF opt-in for the WHOLE-
 * PICTURE UNDERSTANDING PASS (Elite-partner Part 2). Mirrors the auto-goal flag
 * shape: env OR config, default false, never throws. When false the understanding
 * pass never runs and the planner is invoked exactly as today (ungrounded).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { understandingEnabled } from '../../src/interface/ui/understanding-flag.ts';

describe('understandingEnabled — default OFF, opt-in via env or config', () => {
  it('absent env + absent config ⇒ false (understanding ships dark)', () => {
    assert.equal(understandingEnabled(undefined, undefined), false);
    assert.equal(understandingEnabled({}, {}), false);
    assert.equal(understandingEnabled({}, { experimentalUnderstanding: false }), false);
  });

  it('explicit env opt-in ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(understandingEnabled({ MYSHELL_UNDERSTANDING: v }, undefined), true, `MYSHELL_UNDERSTANDING=${v}`);
    }
  });

  it('config opt-in (experimentalUnderstanding === true) ⇒ true', () => {
    assert.equal(understandingEnabled({}, { experimentalUnderstanding: true }), true);
  });

  it('off-ish env values ⇒ false', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(understandingEnabled({ MYSHELL_UNDERSTANDING: v }, undefined), false, `MYSHELL_UNDERSTANDING=${v}`);
    }
  });

  it('never throws on a hostile env bag', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(understandingEnabled(hostile, undefined), false);
  });
});
