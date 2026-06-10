/**
 * test/unit/board-flag.test.ts — the DEFAULT-OFF opt-in for the persistent goal
 * BOARD (Elite-partner Phase 1). Mirrors the tribunal/judgment flag shape: env OR
 * config, default false, never throws. When false the whole board feature is dark
 * and the live UI is byte-for-byte today's (the fake per-turn card included).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boardEnabled } from '../../src/interface/ui/board-flag.ts';

describe('boardEnabled — default OFF, opt-in via env or config', () => {
  it('absent env + absent config ⇒ false (the board ships dark)', () => {
    assert.equal(boardEnabled(undefined, undefined), false);
    assert.equal(boardEnabled({}, {}), false);
    assert.equal(boardEnabled({}, { experimentalBoard: false }), false);
  });

  it('explicit env opt-in ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(boardEnabled({ MYSHELL_BOARD: v }, undefined), true, `MYSHELL_BOARD=${v}`);
    }
  });

  it('config opt-in (experimentalBoard === true) ⇒ true', () => {
    assert.equal(boardEnabled({}, { experimentalBoard: true }), true);
  });

  it('off-ish env values ⇒ false', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(boardEnabled({ MYSHELL_BOARD: v }, undefined), false, `MYSHELL_BOARD=${v}`);
    }
  });

  it('never throws on a hostile env bag', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(boardEnabled(hostile, undefined), false);
  });
});
