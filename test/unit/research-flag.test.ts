/**
 * test/unit/research-flag.test.ts — the DEFAULT-OFF / explicit-opt-IN contract for
 * RESEARCH-UNTIL-CONFIDENT's second-angle web re-research (master-plan Phase 3b).
 * env OR config, default FALSE, never throws — mirrors the judgment/verify rollout.
 * Flag-off is the load-bearing neutrality contract: the brain's `'web'` move is never
 * emitted.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { researchEnabled } from '../../src/core/research-flag.ts';

describe('researchEnabled — default OFF, explicit opt-IN via env or config', () => {
  it('absent env + absent config ⇒ false (ships dark)', () => {
    assert.equal(researchEnabled(undefined, undefined), false);
    assert.equal(researchEnabled({}, {}), false);
  });

  it('explicit env opt-IN ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(researchEnabled({ MYSHELL_RESEARCH: v }, undefined), true, `MYSHELL_RESEARCH=${v}`);
    }
  });

  it('config opt-IN (experimentalResearch === true) ⇒ true', () => {
    assert.equal(researchEnabled({}, { experimentalResearch: true }), true);
  });

  it('ambiguous / off values ⇒ false (default holds)', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(researchEnabled({ MYSHELL_RESEARCH: v }, undefined), false, `MYSHELL_RESEARCH=${v}`);
    }
  });

  it('never throws on a hostile env bag (defaults OFF)', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(researchEnabled(hostile, undefined), false);
  });
});
