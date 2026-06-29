/**
 * test/unit/board-flag.test.ts — the DEFAULT-ON / explicit-opt-OUT contract for the
 * persistent goal BOARD (Elite-partner Phase 1). env OR config, default TRUE, never
 * throws. The board is the shipped experience; an explicit opt-out
 * (MYSHELL_BOARD=0/false/off/no or experimentalBoard===false) restores the
 * byte-for-byte legacy fake-card UI.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { boardEnabled } from '../../src/interface/ui/board-flag.ts';

describe('boardEnabled — default ON, explicit opt-OUT via env or config', () => {
  it('absent env + absent config ⇒ true (the board is the shipped default)', () => {
    assert.equal(boardEnabled(undefined, undefined), true);
    assert.equal(boardEnabled({}, {}), true);
    assert.equal(boardEnabled({}, { experimentalBoard: true }), true);
  });

  it('explicit env opt-OUT ⇒ false (case-insensitive, trimmed) — restores legacy', () => {
    for (const v of ['0', 'false', 'off', 'no', ' FALSE ', 'Off']) {
      assert.equal(boardEnabled({ MYSHELL_BOARD: v }, undefined), false, `MYSHELL_BOARD=${v}`);
    }
  });

  it('config opt-OUT (experimentalBoard === false) ⇒ false', () => {
    assert.equal(boardEnabled({}, { experimentalBoard: false }), false);
  });

  it('explicit env opt-IN + ambiguous values ⇒ true (default holds)', () => {
    for (const v of ['1', 'true', 'on', 'yes', '', '   ', 'maybe']) {
      assert.equal(boardEnabled({ MYSHELL_BOARD: v }, undefined), true, `MYSHELL_BOARD=${v}`);
    }
  });

  it('env opt-OUT overrides a config opt-in', () => {
    assert.equal(boardEnabled({ MYSHELL_BOARD: '0' }, { experimentalBoard: true }), false);
  });

  it('never throws on a hostile env bag (defaults ON)', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(boardEnabled(hostile, undefined), true);
  });
});
