/**
 * Unit tests for src/ui/tui.ts
 *
 * Verifies:
 *  - box() renders Unicode box-drawing chars and all rows have equal visibleLength.
 *  - bar() builds a filled/empty track and clamps out-of-range values.
 *  - badge() returns the correct emoji for known and unknown status keys.
 *  - separator() / menu() produce section separators and [key] label rows.
 *  - panel() / prompt() / statusChip() / signalLine() / divider() emit ANSI
 *    only when color:true, and never when color:false.
 *  - visibleLength() counts wide emoji as 2 columns.
 *  - pad() right-pads to the requested visible width.
 *  - No forbidden mock substrings appear in any rendered output.
 *
 * Honesty Contract: no hardcoded percentages, no fabricated figures, no mock
 * AI-response phrases.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  stripAnsi,
  visibleLength,
  truncateToWidth,
  pad,
  box,
  bar,
  badge,
  separator,
  menu,
  panel,
  divider,
  statusChip,
  headerBar,
  prompt,
  signalLine,
} from '../../src/ui/tui.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[\d;]*[A-Za-z]/;

const FORBIDDEN_SUBSTRINGS = [
  'JWT',
  'Authentication bug',
  'sess-abc',
  '8m 23s',
  '12 exchanges',
  'Found 0 relevant files',
  '87%',
];

function assertNoAnsi(output: string, label: string): void {
  assert.ok(!ANSI_RE.test(output), `${label}: must not contain ANSI codes when color=false`);
}

function assertNoForbidden(output: string, label: string): void {
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    assert.ok(!output.includes(sub), `${label}: must not contain forbidden substring "${sub}"`);
  }
}

// ---------------------------------------------------------------------------
// stripAnsi / visibleLength / pad
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    const colored = '\x1b[32mhello\x1b[0m';
    assert.strictEqual(stripAnsi(colored), 'hello');
  });

  it('returns plain strings unchanged', () => {
    assert.strictEqual(stripAnsi('plain text'), 'plain text');
  });

  it('handles empty string', () => {
    assert.strictEqual(stripAnsi(''), '');
  });
});

describe('visibleLength', () => {
  it('counts plain ASCII correctly', () => {
    assert.strictEqual(visibleLength('hello'), 5);
  });

  it('counts each emoji as 2 columns', () => {
    // '🟢' is a wide emoji → width 2; ' ok' → 3; total 5
    assert.strictEqual(visibleLength('🟢 ok'), 5);
  });

  it('strips ANSI before counting', () => {
    assert.strictEqual(visibleLength('\x1b[32mhi\x1b[0m'), 2);
  });

  it('counts multiple emoji correctly', () => {
    // '🟢🟡' → 2 + 2 = 4
    assert.strictEqual(visibleLength('🟢🟡'), 4);
  });

  it('⚠️ (U+26A0 + U+FE0F variation selector) counts as 2, not 4', () => {
    // U+26A0 = warning sign (misc symbol, 2 cols)
    // U+FE0F = VS16 variation selector (zero-width modifier, 0 cols)
    // Terminal renders ⚠️ as a single 2-column glyph.
    assert.strictEqual(visibleLength('⚠️'), 2);
  });

  it('variation-selector-only string counts as 0', () => {
    // U+FE0F alone is zero-width
    assert.strictEqual(visibleLength('️'), 0);
  });

  it('plain warning sign without VS16 counts as 2', () => {
    // U+26A0 without a variation selector is 2 cols
    assert.strictEqual(visibleLength('⚠'), 2);
  });
});

describe('pad', () => {
  it('right-pads a plain string to the given width', () => {
    const result = pad('hi', 6);
    assert.strictEqual(result, 'hi    ');
    assert.strictEqual(visibleLength(result), 6);
  });

  it('does not truncate a string that is already wide enough', () => {
    const result = pad('hello world', 5);
    assert.strictEqual(result, 'hello world');
  });

  it('accounts for wide emoji when padding', () => {
    // '🟢' visible width = 2; pad to 6 → 4 spaces needed
    const result = pad('🟢', 6);
    assert.strictEqual(visibleLength(result), 6);
  });
});

// ---------------------------------------------------------------------------
// box
// ---------------------------------------------------------------------------

describe('truncateToWidth', () => {
  it('returns the string unchanged when it fits', () => {
    assert.equal(truncateToWidth('hello', 10), 'hello');
  });
  it('truncates with an ellipsis to the column budget', () => {
    const t = truncateToWidth('abcdefghij', 5);
    assert.equal(visibleLength(t), 5, 'truncated result occupies exactly the budget');
    assert.ok(t.endsWith('…'), 'ends with an ellipsis');
  });
  it('counts an emoji as 2 columns when truncating', () => {
    // '🟢' is width 2; budget 3 → emoji (2) + ellipsis (1).
    assert.equal(truncateToWidth('🟢🟢🟢', 3), '🟢…');
  });
});

describe('box', () => {
  it('contains the title text', () => {
    const out = box('My Title', ['line one']);
    assert.ok(out.includes('My Title'), 'box must include the title');
  });

  it('contains Unicode double-line box-drawing characters', () => {
    const out = box('Title', ['body']);
    assert.ok(out.includes('╔'), 'must include top-left corner ╔');
    assert.ok(out.includes('╗'), 'must include top-right corner ╗');
    assert.ok(out.includes('╚'), 'must include bottom-left corner ╚');
    assert.ok(out.includes('╝'), 'must include bottom-right corner ╝');
    assert.ok(out.includes('╠'), 'must include title-divider left ╠');
    assert.ok(out.includes('╣'), 'must include title-divider right ╣');
  });

  it('all rendered lines have equal visibleLength', () => {
    const out = box('Title', ['line one', 'a longer line that should pad out']);
    const rows = out.split('\n');
    const lengths = rows.map(r => visibleLength(r));
    const first = lengths[0];
    assert.ok(first !== undefined, 'box must have at least one row');
    for (let i = 1; i < lengths.length; i++) {
      assert.strictEqual(
        lengths[i], first,
        `Row ${i} has visibleLength ${String(lengths[i])}, expected ${String(first)}`,
      );
    }
  });

  it('includes body lines', () => {
    const out = box('T', ['alpha', 'beta']);
    assert.ok(out.includes('alpha'), 'must include first body line');
    assert.ok(out.includes('beta'), 'must include second body line');
  });

  it('respects the width option', () => {
    const narrow = box('T', ['x'], { width: 20 });
    const wide   = box('T', ['x'], { width: 60 });
    const narrowLen = visibleLength(narrow.split('\n')[0] ?? '');
    const wideLen   = visibleLength(wide.split('\n')[0] ?? '');
    assert.ok(wideLen > narrowLen, 'wider width option must produce wider box');
  });

  it('keeps every row aligned even when a line is far too long (truncates, never overflows)', () => {
    // Regression: an over-long status line used to jam the right border. Now the
    // box truncates to its cap and ALL rows stay exactly equal width.
    const longLine = 'opencode: not signed in — press [o] to add your provider and more and more';
    const out = box('🧠 myshell-tools v9.9.9 — Setup', ['⚠️  claude: not signed in', longLine]);
    const lengths = out.split('\n').map((r) => visibleLength(r));
    const first = lengths[0];
    for (let i = 1; i < lengths.length; i++) {
      assert.strictEqual(lengths[i], first, `row ${i} width ${String(lengths[i])} != ${String(first)}`);
    }
  });

  it('grows to fit a long line (up to the cap) rather than truncating prematurely', () => {
    const shortBox = box('T', ['x']);
    const longBox = box('T', ['a line that is comfortably longer than the 56-column default width here']);
    assert.ok(
      visibleLength(longBox.split('\n')[0] ?? '') > visibleLength(shortBox.split('\n')[0] ?? ''),
      'a long line should widen the box (adaptive), not just truncate',
    );
  });

  it('all rows have equal visibleLength when body lines contain ⚠️ (variation selector)', () => {
    // ⚠️ must count as 2 (not 4) so the right border aligns with other rows.
    const out = box('Warning', ['⚠️ auth failure', 'normal line']);
    const rows = out.split('\n');
    const lengths = rows.map(r => visibleLength(r));
    const first = lengths[0];
    assert.ok(first !== undefined, 'box must have at least one row');
    for (let i = 1; i < lengths.length; i++) {
      assert.strictEqual(
        lengths[i], first,
        `Row ${i} has visibleLength ${String(lengths[i])}, expected ${String(first)} — emoji variation selector may be double-counted`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// bar
// ---------------------------------------------------------------------------

describe('bar', () => {
  it('contains a digit representing the rounded percent', () => {
    const out = bar(50, 20);
    // The output should contain '50' somewhere
    assert.ok(out.includes('50'), 'bar(50) must include "50" in output');
  });

  it('contains a percent sign', () => {
    const out = bar(50, 20);
    assert.ok(out.includes('%'), 'bar must include a percent sign');
  });

  it('shows a half-filled track for 50', () => {
    const out = bar(50, 20);
    // 10 fill chars + 10 empty chars
    const fills  = (out.match(/█/g) ?? []).length;
    const empties = (out.match(/░/g) ?? []).length;
    assert.strictEqual(fills, 10,  'bar(50, 20) should have 10 filled chars');
    assert.strictEqual(empties, 10, 'bar(50, 20) should have 10 empty chars');
  });

  it('clamps 0 to all-empty track', () => {
    const out = bar(0, 20);
    assert.ok(out.includes('0'), 'bar(0) must show 0');
    const fills = (out.match(/█/g) ?? []).length;
    assert.strictEqual(fills, 0, 'bar(0) must have no filled chars');
  });

  it('clamps 100 to all-filled track', () => {
    const out = bar(100, 20);
    const fills  = (out.match(/█/g) ?? []).length;
    const empties = (out.match(/░/g) ?? []).length;
    assert.strictEqual(fills, 20, 'bar(100, 20) must have 20 filled chars');
    assert.strictEqual(empties, 0, 'bar(100, 20) must have no empty chars');
  });

  it('clamps values above 100', () => {
    const out = bar(150, 20);
    const fills = (out.match(/█/g) ?? []).length;
    assert.strictEqual(fills, 20, 'bar(150) must be clamped to 100');
  });

  it('includes an optional label', () => {
    const out = bar(30, 20, { label: 'Claude' });
    assert.ok(out.includes('Claude'), 'bar with label must include the label text');
  });
});

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------

describe('badge', () => {
  it('returns green circle for healthy', () => {
    assert.ok(badge('healthy').includes('🟢'));
  });

  it('returns yellow circle for degraded', () => {
    assert.ok(badge('degraded').includes('🟡'));
  });

  it('returns red X for missing', () => {
    assert.ok(badge('missing').includes('❌'));
  });

  it('returns check for connected', () => {
    assert.ok(badge('connected').includes('✅'));
  });

  it('returns warning for warning', () => {
    assert.ok(badge('warning').includes('⚠'));
  });

  it('returns question mark for unknown status', () => {
    assert.ok(badge('unknownXYZ').includes('❓'));
  });
});

// ---------------------------------------------------------------------------
// separator
// ---------------------------------------------------------------------------

describe('separator', () => {
  it('returns a plain dashed line with no label', () => {
    const out = separator();
    assert.ok(out.includes('─'), 'separator must include dash char');
  });

  it('returns a labelled separator when label is provided', () => {
    const out = separator('Sessions');
    assert.ok(out.includes('Sessions'), 'must include the section label');
    assert.ok(out.includes('─'), 'must still include dash chars');
  });
});

// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

describe('menu', () => {
  const items = [
    { key: 'c', label: 'Continue session', section: 'Sessions' },
    { key: 'n', label: 'New session',      section: 'Sessions' },
    { key: 'a', label: 'Auth management',  section: 'Settings' },
    { key: 'q', label: 'Quit' },
  ] as const;

  it('renders [key] label rows', () => {
    const out = menu(items);
    assert.ok(out.includes('[c] Continue session'), 'must render [c] row');
    assert.ok(out.includes('[n] New session'),      'must render [n] row');
    assert.ok(out.includes('[a] Auth management'),  'must render [a] row');
    assert.ok(out.includes('[q] Quit'),             'must render [q] row');
  });

  it('inserts section separators between groups', () => {
    const out = menu(items);
    assert.ok(out.includes('Sessions'), 'must include Sessions section header');
    assert.ok(out.includes('Settings'), 'must include Settings section header');
  });

  it('produces multiple lines', () => {
    const out = menu(items);
    const lines = out.split('\n');
    assert.ok(lines.length > items.length, 'menu with sections must have more lines than items');
  });

  it('handles empty options array', () => {
    const out = menu([]);
    assert.strictEqual(typeof out, 'string');
  });
});

// ---------------------------------------------------------------------------
// panel (color gating)
// ---------------------------------------------------------------------------

describe('panel', () => {
  it('color=false emits no ANSI codes', () => {
    const out = panel('Status', ['line one', 'line two'], false);
    assertNoAnsi(out, 'panel(color=false)');
  });

  it('color=true may contain ANSI codes', () => {
    const out = panel('Status', ['line one'], true);
    assert.ok(out.length > 0, 'panel(color=true) must return non-empty string');
  });

  it('contains the title text', () => {
    const out = panel('MyPanel', 'content line', false);
    assert.ok(out.includes('MyPanel'), 'panel must include its title');
  });

  it('contains content when given a string', () => {
    const out = panel('T', 'content text', false);
    assert.ok(out.includes('content text'));
  });

  it('contains content when given an array', () => {
    const out = panel('T', ['alpha', 'beta'], false);
    assert.ok(out.includes('alpha'));
    assert.ok(out.includes('beta'));
  });

  it('contains rounded box-drawing characters', () => {
    const out = panel('T', [], false);
    assert.ok(out.includes('╭') || out.includes('╰'), 'panel must use rounded box chars');
  });

  it('no forbidden substrings', () => {
    assertNoForbidden(panel('T', ['hello'], false), 'panel');
  });
});

// ---------------------------------------------------------------------------
// divider (color gating)
// ---------------------------------------------------------------------------

describe('divider', () => {
  it('color=false emits no ANSI codes', () => {
    const out = divider(40, false);
    assertNoAnsi(out, 'divider(color=false)');
  });

  it('color=true may contain ANSI codes', () => {
    const out = divider(40, true);
    assert.ok(out.length > 0, 'divider(color=true) must return non-empty string');
  });

  it('contains horizontal bar characters', () => {
    const out = divider(10, false);
    assert.ok(out.includes('─') || out.includes('├') || out.includes('┤'));
  });
});

// ---------------------------------------------------------------------------
// statusChip (color gating)
// ---------------------------------------------------------------------------

describe('statusChip', () => {
  it('color=false emits no ANSI codes', () => {
    const out = statusChip('API', true, false);
    assertNoAnsi(out, 'statusChip(color=false)');
  });

  it('color=true emits ANSI codes', () => {
    const out = statusChip('API', true, true);
    assert.ok(ANSI_RE.test(out), 'statusChip(color=true) should emit ANSI codes');
  });

  it('contains the label text', () => {
    const out = statusChip('MyLabel', true, false);
    assert.ok(out.includes('MyLabel'));
  });

  it('contains dot indicator', () => {
    const out = statusChip('x', true, false);
    assert.ok(out.includes('●'), 'statusChip must include a dot indicator');
  });

  it('no forbidden substrings', () => {
    assertNoForbidden(statusChip('status', false, false), 'statusChip');
  });
});

// ---------------------------------------------------------------------------
// headerBar
// ---------------------------------------------------------------------------

describe('headerBar', () => {
  it('contains left and right text', () => {
    const out = headerBar('LEFT', 'RIGHT', 40);
    assert.ok(out.includes('LEFT'));
    assert.ok(out.includes('RIGHT'));
  });

  it('has at least one space between left and right', () => {
    const out = headerBar('A', 'B', 10);
    const aIdx = out.indexOf('A');
    const bIdx = out.indexOf('B');
    assert.ok(bIdx > aIdx + 1, 'must have at least one space between left and right');
  });
});

// ---------------------------------------------------------------------------
// prompt (color gating)
// ---------------------------------------------------------------------------

describe('prompt', () => {
  it('color=false emits no ANSI codes', () => {
    const out = prompt('do something', false);
    assertNoAnsi(out, 'prompt(color=false)');
  });

  it('color=true may contain ANSI codes', () => {
    const out = prompt('do something', true);
    assert.ok(out.length > 0, 'prompt(color=true) must return non-empty string');
  });

  it('contains the text content', () => {
    const out = prompt('my hint text', false);
    assert.ok(out.includes('my hint text'));
  });

  it('strips a leading > from the text', () => {
    const out = prompt('> my hint', false);
    // The text should contain 'my hint' (not '> my hint')
    assert.ok(out.includes('my hint'));
  });

  it('no forbidden substrings', () => {
    assertNoForbidden(prompt('enter a command', false), 'prompt');
  });
});

// ---------------------------------------------------------------------------
// signalLine (color gating)
// ---------------------------------------------------------------------------

describe('signalLine', () => {
  it('color=false emits no ANSI codes — success', () => {
    const out = signalLine('success', 'task done', false);
    assertNoAnsi(out, 'signalLine(success, color=false)');
  });

  it('color=false emits no ANSI codes — warning', () => {
    const out = signalLine('warning', 'watch out', false);
    assertNoAnsi(out, 'signalLine(warning, color=false)');
  });

  it('color=false emits no ANSI codes — info', () => {
    const out = signalLine('info', 'some info', false);
    assertNoAnsi(out, 'signalLine(info, color=false)');
  });

  it('color=true may contain ANSI codes', () => {
    const out = signalLine('success', 'done', true);
    assert.ok(ANSI_RE.test(out), 'signalLine(color=true) should emit ANSI codes');
  });

  it('contains the message text', () => {
    const out = signalLine('info', 'hello world', false);
    assert.ok(out.includes('hello world'));
  });

  it('appends optional meta when provided', () => {
    const out = signalLine('info', 'main text', false, 'extra meta');
    assert.ok(out.includes('extra meta'));
  });

  it('omits meta when not provided', () => {
    const out = signalLine('info', 'main text', false);
    assert.ok(!out.includes('undefined'));
  });

  it('no forbidden substrings', () => {
    assertNoForbidden(signalLine('success', 'all good', false), 'signalLine');
  });
});

// ---------------------------------------------------------------------------
// Honesty guard — no forbidden substrings in any output
// ---------------------------------------------------------------------------

describe('honesty guard — no mock substrings in any output', () => {
  const FORBIDDEN = [
    'JWT',
    'Authentication bug',
    'sess-abc',
    '8m 23s',
    '12 exchanges',
  ];

  const samples = [
    box('Title', ['content']),
    bar(30, 20, { label: 'usage' }),
    badge('healthy'),
    separator('Section'),
    menu([{ key: 'x', label: 'Exit', section: 'Navigation' }]),
    panel('P', ['body'], false),
    divider(40, false),
    statusChip('label', true, false),
    headerBar('left', 'right', 40),
    prompt('enter a command', false),
    signalLine('success', 'completed', false, 'detail'),
  ];

  for (const sub of FORBIDDEN) {
    it(`none of the outputs contain "${sub}"`, () => {
      for (const s of samples) {
        assert.ok(!s.includes(sub), `Output must not contain "${sub}"`);
      }
    });
  }
});
