/**
 * test/unit/auto-goal-flag.test.ts — the DEFAULT-ON / explicit-opt-OUT contract for
 * the PLANNING BRAIN / AUTO-STAGE pass (Elite-partner Phase 6). env OR config,
 * default TRUE, never throws. The partner judges + stages goals by default; an
 * explicit opt-out (MYSHELL_AUTO_GOAL=0/false/off/no or experimentalAutoGoal===false)
 * restores the byte-for-byte legacy post-turn slot.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { autoStageEnabled } from '../../src/interface/ui/auto-goal-flag.ts';

describe('autoStageEnabled — default ON, explicit opt-OUT via env or config', () => {
  it('absent env + absent config ⇒ true (auto-stage is the shipped default)', () => {
    assert.equal(autoStageEnabled(undefined, undefined), true);
    assert.equal(autoStageEnabled({}, {}), true);
    assert.equal(autoStageEnabled({}, { experimentalAutoGoal: true }), true);
  });

  it('explicit env opt-OUT ⇒ false (case-insensitive, trimmed)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' FALSE ', 'Off']) {
      assert.equal(autoStageEnabled({ MYSHELL_AUTO_GOAL: v }, undefined), false, `MYSHELL_AUTO_GOAL=${v}`);
    }
  });

  it('config opt-OUT (experimentalAutoGoal === false) ⇒ false', () => {
    assert.equal(autoStageEnabled({}, { experimentalAutoGoal: false }), false);
  });

  it('explicit env opt-IN + ambiguous values ⇒ true (default holds)', () => {
    for (const v of ['1', 'true', 'on', 'yes', '', '   ', 'maybe']) {
      assert.equal(autoStageEnabled({ MYSHELL_AUTO_GOAL: v }, undefined), true, `MYSHELL_AUTO_GOAL=${v}`);
    }
  });

  it('env opt-OUT overrides a config opt-in', () => {
    assert.equal(autoStageEnabled({ MYSHELL_AUTO_GOAL: 'off' }, { experimentalAutoGoal: true }), false);
  });

  it('never throws on a hostile env bag (defaults ON)', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(autoStageEnabled(hostile, undefined), true);
  });
});
