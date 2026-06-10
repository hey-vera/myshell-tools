/**
 * test/unit/understanding-flag.test.ts — the DEFAULT-ON / explicit-opt-OUT contract
 * for the WHOLE-PICTURE UNDERSTANDING PASS (Elite-partner Part 2). env OR config,
 * default TRUE, never throws. Now that the pass runs CACHE-AHEAD (a non-blocking
 * background warm grounds the next planning moment with zero turn latency),
 * default-on delivers grounding for free. An explicit opt-out
 * (MYSHELL_UNDERSTANDING=0/false/off/no or experimentalUnderstanding===false) leaves
 * the planner ungrounded as the legacy path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { understandingEnabled } from '../../src/interface/ui/understanding-flag.ts';

describe('understandingEnabled — default ON, explicit opt-OUT via env or config', () => {
  it('absent env + absent config ⇒ true (cache-ahead grounding is the shipped default)', () => {
    assert.equal(understandingEnabled(undefined, undefined), true);
    assert.equal(understandingEnabled({}, {}), true);
    assert.equal(understandingEnabled({}, { experimentalUnderstanding: true }), true);
  });

  it('explicit env opt-OUT ⇒ false (case-insensitive, trimmed)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' FALSE ', 'Off']) {
      assert.equal(understandingEnabled({ MYSHELL_UNDERSTANDING: v }, undefined), false, `MYSHELL_UNDERSTANDING=${v}`);
    }
  });

  it('config opt-OUT (experimentalUnderstanding === false) ⇒ false', () => {
    assert.equal(understandingEnabled({}, { experimentalUnderstanding: false }), false);
  });

  it('explicit env opt-IN + ambiguous values ⇒ true (default holds)', () => {
    for (const v of ['1', 'true', 'on', 'yes', '', '   ', 'maybe']) {
      assert.equal(understandingEnabled({ MYSHELL_UNDERSTANDING: v }, undefined), true, `MYSHELL_UNDERSTANDING=${v}`);
    }
  });

  it('env opt-OUT overrides a config opt-in', () => {
    assert.equal(understandingEnabled({ MYSHELL_UNDERSTANDING: 'no' }, { experimentalUnderstanding: true }), false);
  });

  it('never throws on a hostile env bag (defaults ON)', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(understandingEnabled(hostile, undefined), true);
  });
});
