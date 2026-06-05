/**
 * test/unit/teach.test.ts — the one "error that teaches" formatter
 * (whole-tool-finish-5.5.md §0.2, §2.5).
 *
 * The format is stable; `info` is dim, `warn` is yellow, NEVER red; `you?`
 * omitted renders cleanly; `color:false` strips ANSI (off-TTY parity); never
 * throws on garbage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { teach } from '../../src/core/teach.ts';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

describe('teach — format', () => {
  it('renders what · did · you in one line', () => {
    const s = teach(
      { what: 'Memory was busy', did: 'I answered without it', you: 'Run /memory.', severity: 'info' },
      false,
    );
    assert.equal(s, '· Memory was busy — I answered without it. Run /memory.');
  });

  it('omits the `you` clause cleanly when absent', () => {
    const s = teach({ what: 'Recap unavailable', did: 'showed the last note', severity: 'info' }, false);
    assert.equal(s, '· Recap unavailable — showed the last note');
    assert.ok(!s.includes('. .'), 'no dangling separators');
  });

  it('collapses internal whitespace/newlines so it stays single-line', () => {
    const s = teach({ what: 'Line\none\ttwo', did: 'did  thing', severity: 'info' }, false);
    assert.ok(!s.includes('\n'), 'no embedded newline');
    assert.ok(s.includes('Line one two'), 'whitespace collapsed');
  });
});

describe('teach — severity colour (never red)', () => {
  it('info is dim', () => {
    const s = teach({ what: 'x', did: 'y', severity: 'info' }, true);
    assert.ok(s.startsWith(DIM), 'info wrapped in dim');
    assert.ok(!s.includes(YELLOW) && !s.includes(RED));
  });

  it('warn is yellow', () => {
    const s = teach({ what: 'x', did: 'y', severity: 'warn' }, true);
    assert.ok(s.startsWith(YELLOW), 'warn wrapped in yellow');
    assert.ok(!s.includes(RED), 'never red');
  });

  it('the warn glyph is ⚠ and the info glyph is ·', () => {
    assert.ok(teach({ what: 'x', did: 'y', severity: 'warn' }, false).startsWith('⚠'));
    assert.ok(teach({ what: 'x', did: 'y', severity: 'info' }, false).startsWith('·'));
  });

  it('an unknown severity defaults to info (dim, never red)', () => {
    const s = teach({ what: 'x', did: 'y', severity: 'boom' as 'info' }, true);
    assert.ok(s.startsWith(DIM));
    assert.ok(!s.includes(RED));
  });
});

describe('teach — color gate (off-TTY parity)', () => {
  it('color:false strips all ANSI', () => {
    for (const sev of ['info', 'warn'] as const) {
      const s = teach({ what: 'a', did: 'b', you: 'c', severity: sev }, false);
      assert.ok(!/\x1b\[/.test(s), `${sev} has no ANSI under color:false`);
    }
  });

  it('color:true wraps but never emits red', () => {
    const s = teach({ what: 'a', did: 'b', severity: 'warn' }, true);
    assert.ok(/\x1b\[/.test(s), 'has ANSI under color:true');
    assert.ok(!s.includes(RED));
  });
});

describe('teach — fail-soft (never throws)', () => {
  it('returns a string on a fully malformed notice', () => {
    const s = teach({} as never, false);
    assert.equal(typeof s, 'string');
  });

  it('returns "" when there is genuinely nothing to say', () => {
    assert.equal(teach({ what: '', did: '', severity: 'info' }, false), '');
    assert.equal(teach({ what: '   ', did: '  ', severity: 'warn' }, true), '');
  });

  it('does not throw on null/undefined inputs', () => {
    assert.doesNotThrow(() => teach(null as never, false));
    assert.doesNotThrow(() => teach(undefined as never, true));
    assert.doesNotThrow(() =>
      teach({ what: 123 as never, did: {} as never, you: [] as never, severity: 'info' }, false),
    );
  });
});
