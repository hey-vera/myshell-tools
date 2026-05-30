/**
 * Unit tests for src/ui/banner.ts
 *
 * Verifies:
 *  - The real version string passed in appears in the output.
 *  - When color:false, no ANSI escape codes are emitted.
 *  - When color:true, ANSI codes may appear (smoke test only).
 *  - No digit-% literal appears in either variant.
 *
 * Honesty Contract: the banner must contain only the version passed in —
 * no hardcoded version, no fabricated statistics.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { banner } from '../../src/ui/banner.ts';

// ---------------------------------------------------------------------------
// ANSI-detection helper
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[\d;]*m/;

// ---------------------------------------------------------------------------
// 1. Plain (color:false)
// ---------------------------------------------------------------------------

describe('banner — color:false', () => {
  it('contains the supplied version string', () => {
    const out = banner('9.9.9', false);
    assert.ok(out.includes('9.9.9'), 'banner must contain the version passed in');
  });

  it('contains no ANSI escape codes', () => {
    const out = banner('9.9.9', false);
    assert.ok(!ANSI_RE.test(out), 'banner(color:false) must contain no ANSI codes');
  });

  it('contains no digit-% pattern', () => {
    const out = banner('9.9.9', false);
    assert.ok(!/\d+%/.test(out), 'banner must not contain hardcoded percentage literals');
  });

  it('contains the product name', () => {
    const out = banner('9.9.9', false);
    assert.ok(out.includes('myshell-tools'), 'banner must contain the product name');
  });

  it('does not hardcode a version — different versions produce different banners', () => {
    const a = banner('1.0.0', false);
    const b = banner('2.0.0', false);
    assert.notEqual(a, b, 'Different version strings must produce different banners');
    assert.ok(a.includes('1.0.0'), 'First banner must contain 1.0.0');
    assert.ok(b.includes('2.0.0'), 'Second banner must contain 2.0.0');
  });
});

// ---------------------------------------------------------------------------
// 2. Coloured (color:true)
// ---------------------------------------------------------------------------

describe('banner — color:true', () => {
  it('contains the supplied version string', () => {
    const out = banner('9.9.9', true);
    assert.ok(out.includes('9.9.9'), 'banner must contain the version passed in');
  });

  it('contains no digit-% pattern', () => {
    const out = banner('9.9.9', true);
    assert.ok(!/\d+%/.test(out), 'banner must not contain hardcoded percentage literals');
  });

  it('may contain ANSI codes (smoke test)', () => {
    const out = banner('9.9.9', true);
    // We just verify it is non-empty and contains the version — ANSI presence
    // is optional but expected.
    assert.ok(out.length > 0, 'banner(color:true) must return a non-empty string');
    assert.ok(out.includes('9.9.9'), 'banner(color:true) must contain the version');
  });
});

// ---------------------------------------------------------------------------
// 3. No forbidden mock substrings
// ---------------------------------------------------------------------------

describe('banner — honesty guard', () => {
  const FORBIDDEN = ['JWT', 'Authentication bug', 'sess-abc', '8m 23s', '12 exchanges'];

  for (const f of FORBIDDEN) {
    it(`must not contain "${f}"`, () => {
      const out = banner('9.9.9', false);
      assert.ok(!out.includes(f), `banner must not contain forbidden string: "${f}"`);
    });
  }
});
