/**
 * test/unit/auto-goal-flag.test.ts — the DEFAULT-OFF opt-in for the PLANNING BRAIN
 * / AUTO-STAGE pass (Elite-partner Phase 6). Mirrors the board/tribunal flag shape:
 * env OR config, default false, never throws. When false the planner never runs and
 * the post-turn slot is byte-for-byte today's.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autoStageEnabled } from '../../src/interface/ui/auto-goal-flag.ts';

describe('autoStageEnabled — default OFF, opt-in via env or config', () => {
  it('absent env + absent config ⇒ false (auto-stage ships dark)', () => {
    assert.equal(autoStageEnabled(undefined, undefined), false);
    assert.equal(autoStageEnabled({}, {}), false);
    assert.equal(autoStageEnabled({}, { experimentalAutoGoal: false }), false);
  });

  it('explicit env opt-in ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(autoStageEnabled({ MYSHELL_AUTO_GOAL: v }, undefined), true, `MYSHELL_AUTO_GOAL=${v}`);
    }
  });

  it('config opt-in (experimentalAutoGoal === true) ⇒ true', () => {
    assert.equal(autoStageEnabled({}, { experimentalAutoGoal: true }), true);
  });

  it('off-ish env values ⇒ false', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(autoStageEnabled({ MYSHELL_AUTO_GOAL: v }, undefined), false, `MYSHELL_AUTO_GOAL=${v}`);
    }
  });

  it('never throws on a hostile env bag', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(autoStageEnabled(hostile, undefined), false);
  });
});
