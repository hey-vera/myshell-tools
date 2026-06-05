/**
 * Unit tests for src/ui/theme.ts — the glyph + turn-marker vocabulary.
 *
 * Pure-function table tests: each turn state maps to the `●` glyph in the right
 * colour when colour is ON, to a bare `●` (no ANSI) when colour is OFF, and to
 * the empty string under MYSHELL_PLAIN (colour already off). No animation, no
 * timers — the formatting seam is fully deterministic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { turnMarker, isPlainMode, GLYPHS, formatRecapLine, type TurnState } from '../../src/ui/theme.ts';

const DOT = '●'; // ● U+25CF BLACK CIRCLE

// State → expected SGR colour code when colour is enabled.
const COLOR_CODE: Record<TurnState, string> = {
  streaming: '\x1b[36m', // cyan
  success: '\x1b[32m', // green
  fail: '\x1b[31m', // red
  ask: '\x1b[33m', // yellow
  cancel: '\x1b[2m', // dim
};

describe('theme — GLYPHS vocabulary', () => {
  it('uses the exact single-cell, emoji-free glyphs from the spec', () => {
    assert.equal(GLYPHS.turn, DOT, 'turn marker is ● U+25CF');
    assert.equal(GLYPHS.user, '›', 'user echo is › U+203A');
    assert.equal(GLYPHS.success, '✓', 'success is ✓');
    assert.equal(GLYPHS.fail, '✗', 'fail is ✗');
    assert.equal(GLYPHS.cancel, '■', 'cancel is ■');
    assert.equal(GLYPHS.recap, '※', 'recap orientation marker is ※ U+203B');
    // No emoji / multi-codepoint glyphs (width stability).
    for (const g of Object.values(GLYPHS)) {
      assert.equal([...g].length, 1, `glyph "${g}" must be a single code point`);
    }
  });

  it('the recap marker is distinct from the turn and outcome glyphs', () => {
    assert.notEqual(GLYPHS.recap, GLYPHS.turn, '※ must not collide with ●');
    assert.notEqual(GLYPHS.recap, GLYPHS.success);
    assert.notEqual(GLYPHS.recap, GLYPHS.fail);
    assert.notEqual(GLYPHS.recap, GLYPHS.cancel);
  });
});

describe('theme — formatRecapLine', () => {
  it('renders "※ recap  <text>" with colour when colour is ON', () => {
    const out = formatRecapLine('where we were', true);
    assert.ok(out.includes('※'), 'contains the ※ marker');
    assert.ok(out.includes('recap'), 'contains the recap label');
    assert.ok(out.includes('where we were'), 'contains the body');
    assert.ok(out.includes('\x1b['), 'colour bytes present when colour on');
  });

  it('degrades to a plain "※ recap  <text>" with NO ANSI when colour is OFF', () => {
    const orig = process.env['MYSHELL_PLAIN'];
    delete process.env['MYSHELL_PLAIN'];
    try {
      const out = formatRecapLine('where we were', false);
      assert.equal(out, '※ recap  where we were');
      assert.ok(!out.includes('\x1b['), 'no ANSI bytes when colour off');
    } finally {
      if (orig === undefined) delete process.env['MYSHELL_PLAIN'];
      else process.env['MYSHELL_PLAIN'] = orig;
    }
  });

  it('drops the ※ glyph under MYSHELL_PLAIN (colour off), keeping the text', () => {
    const orig = process.env['MYSHELL_PLAIN'];
    process.env['MYSHELL_PLAIN'] = '1';
    try {
      const out = formatRecapLine('where we were', false);
      assert.ok(!out.includes('※'), 'plain mode drops the glyph');
      assert.ok(out.includes('where we were'), 'plain mode keeps the text');
      assert.equal(out, 'recap  where we were');
    } finally {
      if (orig === undefined) delete process.env['MYSHELL_PLAIN'];
      else process.env['MYSHELL_PLAIN'] = orig;
    }
  });

  it('returns "" for an empty / whitespace-only body', () => {
    assert.equal(formatRecapLine('', false), '');
    assert.equal(formatRecapLine('   ', false), '');
  });
});

describe('theme — turnMarker (colour ON)', () => {
  for (const state of Object.keys(COLOR_CODE) as TurnState[]) {
    it(`renders ${state} as a coloured ●`, () => {
      const out = turnMarker(state, true);
      assert.ok(out.includes(DOT), `must contain the ● glyph (state ${state})`);
      assert.ok(out.startsWith(COLOR_CODE[state]), `must use the ${state} colour code`);
      assert.ok(out.endsWith('\x1b[0m'), 'must reset SGR');
    });
  }
});

describe('theme — turnMarker (colour OFF / NO_COLOR / non-TTY)', () => {
  it('returns a bare ● with NO ANSI for every state', () => {
    for (const state of Object.keys(COLOR_CODE) as TurnState[]) {
      const out = turnMarker(state, false);
      assert.equal(out, DOT, `state ${state} must degrade to a bare ● off-colour`);
      assert.ok(!out.includes('\x1b['), 'no ANSI bytes when colour is off');
    }
  });
});

describe('theme — MYSHELL_PLAIN drops the marker', () => {
  it('isPlainMode reflects the env var (set / unset / "0")', () => {
    const orig = process.env['MYSHELL_PLAIN'];
    try {
      delete process.env['MYSHELL_PLAIN'];
      assert.equal(isPlainMode(), false, 'unset → not plain');
      process.env['MYSHELL_PLAIN'] = '';
      assert.equal(isPlainMode(), false, 'empty string → not plain');
      process.env['MYSHELL_PLAIN'] = '0';
      assert.equal(isPlainMode(), false, '"0" → not plain');
      process.env['MYSHELL_PLAIN'] = '1';
      assert.equal(isPlainMode(), true, '"1" → plain');
    } finally {
      if (orig === undefined) delete process.env['MYSHELL_PLAIN'];
      else process.env['MYSHELL_PLAIN'] = orig;
    }
  });

  it('turnMarker returns "" under MYSHELL_PLAIN when colour is off', () => {
    const orig = process.env['MYSHELL_PLAIN'];
    process.env['MYSHELL_PLAIN'] = '1';
    try {
      for (const state of Object.keys(COLOR_CODE) as TurnState[]) {
        assert.equal(turnMarker(state, false), '', `${state}: plain mode drops the marker`);
      }
      // A coloured interactive terminal keeps the marker even with the flag set.
      assert.ok(
        turnMarker('streaming', true).includes(DOT),
        'plain flag must NOT strip the marker when colour is on',
      );
    } finally {
      if (orig === undefined) delete process.env['MYSHELL_PLAIN'];
      else process.env['MYSHELL_PLAIN'] = orig;
    }
  });
});
