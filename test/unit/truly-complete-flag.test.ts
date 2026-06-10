/**
 * test/unit/truly-complete-flag.test.ts — the DEFAULT-OFF opt-in for the
 * VERIFIED-DONE goal-completion GATE (Elite-partner Part 3, the anti-fabrication
 * backbone). Mirrors the board/auto-goal flag shape: env OR config, default false,
 * never throws. When false the gate never runs and the model's GOAL_COMPLETE settles
 * the goal `done` byte-for-byte as today.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedDoneEnabled } from '../../src/interface/ui/truly-complete-flag.ts';

describe('verifiedDoneEnabled — default OFF, opt-in via env or config', () => {
  it('absent env + absent config ⇒ false (the gate ships dark)', () => {
    assert.equal(verifiedDoneEnabled(undefined, undefined), false);
    assert.equal(verifiedDoneEnabled({}, {}), false);
    assert.equal(verifiedDoneEnabled({}, { experimentalTrulyComplete: false }), false);
  });

  it('explicit env opt-in ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(
        verifiedDoneEnabled({ MYSHELL_TRULY_COMPLETE: v }, undefined),
        true,
        `MYSHELL_TRULY_COMPLETE=${v}`,
      );
    }
  });

  it('config opt-in (experimentalTrulyComplete === true) ⇒ true', () => {
    assert.equal(verifiedDoneEnabled({}, { experimentalTrulyComplete: true }), true);
  });

  it('off-ish env values ⇒ false', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(
        verifiedDoneEnabled({ MYSHELL_TRULY_COMPLETE: v }, undefined),
        false,
        `MYSHELL_TRULY_COMPLETE=${v}`,
      );
    }
  });

  it('never throws on a hostile env bag', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(verifiedDoneEnabled(hostile, undefined), false);
  });
});
