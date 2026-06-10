/**
 * test/unit/truly-complete-flag.test.ts — the DEFAULT-ON / explicit-opt-OUT contract
 * for the VERIFIED-DONE goal-completion GATE (Elite-partner Part 3, the
 * anti-fabrication backbone). env OR config, default TRUE, never throws. A goal is
 * `done` only with real evidence by default; an explicit opt-out
 * (MYSHELL_TRULY_COMPLETE=0/false/off/no or experimentalTrulyComplete===false)
 * restores the legacy model-said-so completion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedDoneEnabled } from '../../src/interface/ui/truly-complete-flag.ts';

describe('verifiedDoneEnabled — default ON, explicit opt-OUT via env or config', () => {
  it('absent env + absent config ⇒ true (the gate is the shipped default)', () => {
    assert.equal(verifiedDoneEnabled(undefined, undefined), true);
    assert.equal(verifiedDoneEnabled({}, {}), true);
    assert.equal(verifiedDoneEnabled({}, { experimentalTrulyComplete: true }), true);
  });

  it('explicit env opt-OUT ⇒ false (case-insensitive, trimmed)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' FALSE ', 'Off']) {
      assert.equal(verifiedDoneEnabled({ MYSHELL_TRULY_COMPLETE: v }, undefined), false, `MYSHELL_TRULY_COMPLETE=${v}`);
    }
  });

  it('config opt-OUT (experimentalTrulyComplete === false) ⇒ false', () => {
    assert.equal(verifiedDoneEnabled({}, { experimentalTrulyComplete: false }), false);
  });

  it('explicit env opt-IN + ambiguous values ⇒ true (default holds)', () => {
    for (const v of ['1', 'true', 'on', 'yes', '', '   ', 'maybe']) {
      assert.equal(verifiedDoneEnabled({ MYSHELL_TRULY_COMPLETE: v }, undefined), true, `MYSHELL_TRULY_COMPLETE=${v}`);
    }
  });

  it('env opt-OUT overrides a config opt-in', () => {
    assert.equal(verifiedDoneEnabled({ MYSHELL_TRULY_COMPLETE: '0' }, { experimentalTrulyComplete: true }), false);
  });

  it('never throws on a hostile env bag (defaults ON)', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(verifiedDoneEnabled(hostile, undefined), true);
  });
});
