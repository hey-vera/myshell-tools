/**
 * test/unit/manager-flag.test.ts — the DEFAULT-ON / explicit-opt-OUT contract for
 * the PER-GOAL MANAGER CYCLE (elite-partner Part 7). env OR config, default TRUE,
 * never throws. An activated goal with a roadmap executes its to-dos to
 * verified-done by default; an explicit opt-out (MYSHELL_MANAGER=0/false/off/no or
 * experimentalManager===false) restores the legacy free GOAL_COMPLETE loop. (The
 * cycle still only engages on EXPLICIT activation with a non-empty roadmap.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { managerCycleEnabled } from '../../src/interface/ui/manager-flag.ts';

describe('managerCycleEnabled — default ON, explicit opt-OUT via env or config', () => {
  it('absent env + absent config ⇒ true (the cycle is the shipped default)', () => {
    assert.equal(managerCycleEnabled(undefined, undefined), true);
    assert.equal(managerCycleEnabled({}, {}), true);
    assert.equal(managerCycleEnabled({}, { experimentalManager: true }), true);
  });

  it('explicit env opt-OUT ⇒ false (case-insensitive, trimmed)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' FALSE ', 'Off']) {
      assert.equal(managerCycleEnabled({ MYSHELL_MANAGER: v }, undefined), false, `MYSHELL_MANAGER=${v}`);
    }
  });

  it('config opt-OUT (experimentalManager === false) ⇒ false', () => {
    assert.equal(managerCycleEnabled({}, { experimentalManager: false }), false);
  });

  it('explicit env opt-IN + ambiguous values ⇒ true (default holds)', () => {
    for (const v of ['1', 'true', 'on', 'yes', '', '   ', 'maybe']) {
      assert.equal(managerCycleEnabled({ MYSHELL_MANAGER: v }, undefined), true, `MYSHELL_MANAGER=${v}`);
    }
  });

  it('env opt-OUT overrides a config opt-in', () => {
    assert.equal(managerCycleEnabled({ MYSHELL_MANAGER: 'false' }, { experimentalManager: true }), false);
  });

  it('never throws on a hostile env bag (defaults ON)', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(managerCycleEnabled(hostile, undefined), true);
  });
});
