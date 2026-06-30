/**
 * Unit tests for src/core/assess.ts
 * Run with: node --experimental-strip-types --test test/unit/assess.test.ts
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { assess } from '../../src/core/assess.ts';

// ---------------------------------------------------------------------------
// Happy-path: valid envelope
// ---------------------------------------------------------------------------

describe('assess — valid envelope', () => {
  it('parses a well-formed envelope at the end of output', () => {
    const output =
      'Here is the analysis.\n' +
      '{"confidence": 0.85, "escalate": false, "reason": "looks good", "needs_review": false}';
    const result = assess(output);
    assert.equal(result.confidence, 0.85);
    assert.equal(result.escalate, false);
    assert.equal(result.reason, 'looks good');
    assert.equal(result.needsReview, false);
  });

  it('clamps confidence above 1.0 to 1.0', () => {
    const output =
      '{"confidence": 1.5, "escalate": false, "reason": "over confident", "needs_review": false}';
    const result = assess(output);
    assert.equal(result.confidence, 1.0);
  });

  it('clamps confidence below 0.0 to 0.0', () => {
    const output =
      '{"confidence": -0.2, "escalate": false, "reason": "negative", "needs_review": false}';
    const result = assess(output);
    assert.equal(result.confidence, 0.0);
  });

  it('parses escalate: true correctly', () => {
    const output =
      'Analysis done.\n' +
      '{"confidence": 0.4, "escalate": true, "reason": "too complex for IC", "needs_review": true}';
    const result = assess(output);
    assert.equal(result.escalate, true);
    assert.equal(result.needsReview, true);
    assert.ok(result.confidence !== null);
    assert.ok((result.confidence as number) < 0.5);
  });

  it('picks the LAST envelope when multiple are present (handles model regeneration)', () => {
    const output =
      '{"confidence": 0.3, "escalate": true, "reason": "first attempt", "needs_review": true}\n' +
      'Corrected analysis:\n' +
      '{"confidence": 0.9, "escalate": false, "reason": "second attempt", "needs_review": false}';
    const result = assess(output);
    assert.equal(result.confidence, 0.9);
    assert.equal(result.escalate, false);
    assert.equal(result.reason, 'second attempt');
  });

  it('ignores a non-trailing confidence JSON example', () => {
    const output =
      'Example config: {"confidence": 0.2, "escalate": true, "reason": "example", "needs_review": true}\n' +
      'The actual answer continues after the example.';
    const result = assess(output);
    assert.equal(result.confidence, null);
    assert.equal(result.escalate, false);
    assert.equal(result.reason, 'no confidence envelope');
  });

  it('reads a genuine trailing confidence envelope after prose examples', () => {
    const output =
      'Example config: {"confidence": 0.2, "escalate": true, "reason": "example", "needs_review": true}\n' +
      'The actual answer.\n' +
      '{"confidence": 0.91, "escalate": false, "reason": "final", "needs_review": false}';
    const result = assess(output);
    assert.equal(result.confidence, 0.91);
    assert.equal(result.escalate, false);
    assert.equal(result.reason, 'final');
  });

  it('parses an envelope with extra whitespace around it', () => {
    const output =
      'Done.\n\n  \n' +
      '{"confidence": 0.75, "escalate": false, "reason": "ok", "needs_review": false}\n\n';
    const result = assess(output);
    assert.equal(result.confidence, 0.75);
  });

  it('coerces string "true" for escalate to boolean true', () => {
    const output =
      '{"confidence": 0.6, "escalate": "true", "reason": "string bool", "needs_review": "false"}';
    const result = assess(output);
    assert.equal(result.escalate, true);
    assert.equal(result.needsReview, false);
  });

  it('coerces numeric 1 for escalate to boolean true', () => {
    const output =
      '{"confidence": 0.6, "escalate": 1, "reason": "numeric bool", "needs_review": 0}';
    const result = assess(output);
    assert.equal(result.escalate, true);
    assert.equal(result.needsReview, false);
  });
});

// ---------------------------------------------------------------------------
// Missing envelope → confidence null
// ---------------------------------------------------------------------------

describe('assess — missing envelope', () => {
  it('returns confidence=null when no JSON is present', () => {
    const result = assess('This is just plain text with no envelope.');
    assert.equal(result.confidence, null);
    assert.equal(result.escalate, false);
    assert.equal(result.reason, 'no confidence envelope');
    assert.equal(result.needsReview, false);
  });

  it('returns confidence=null for empty string', () => {
    const result = assess('');
    assert.equal(result.confidence, null);
  });

  it('returns confidence=null when JSON present but lacks "confidence" key', () => {
    const output = '{"escalate": false, "reason": "no confidence key", "needs_review": false}';
    const result = assess(output);
    assert.equal(result.confidence, null);
  });

  it('returns confidence=null when confidence is null in the JSON', () => {
    const output = '{"confidence": null, "escalate": false, "reason": "null conf", "needs_review": false}';
    const result = assess(output);
    assert.equal(result.confidence, null);
  });

  it('returns confidence=null when confidence is a string (not a number)', () => {
    const output = '{"confidence": "high", "escalate": false, "reason": "string conf", "needs_review": false}';
    const result = assess(output);
    assert.equal(result.confidence, null);
  });

  it('returns confidence=null when confidence is NaN', () => {
    const output = '{"confidence": NaN, "escalate": false, "reason": "NaN", "needs_review": false}';
    // NaN in JSON is invalid — JSON.parse will throw or produce undefined
    const result = assess(output);
    assert.equal(result.confidence, null);
  });
});

// ---------------------------------------------------------------------------
// Malformed / truncated / garbage input — must never throw
// ---------------------------------------------------------------------------

describe('assess — malformed/truncated/garbage — NEVER throws', () => {
  const GARBAGE_INPUTS = [
    '{',
    '}',
    '{"confidence":',
    '{"confidence": 0.5',
    '{"confidence": 0.5, "escalate":',
    '{"confidence": 0.5, "escalate": tru',
    '{ bad json {{{{',
    'undefined',
    'null',
    '[]',
    '[1, 2, 3]',
    '<<< not json >>>',
    '\x00\x01\x02binary\xFF\xFE',
    '{"confidence": {}, "escalate": [], "reason": 42, "needs_review": "maybe"}',
    '0.87',
    '  ',
    '\n\n\n',
    '{"confidence": Infinity, "escalate": false, "reason": "inf", "needs_review": false}',
    String.fromCharCode(0),
    'a'.repeat(100_000), // long garbage string
  ];

  for (const input of GARBAGE_INPUTS) {
    const label = input.length > 40 ? input.slice(0, 40) + '…' : input;
    it(`does not throw for: ${JSON.stringify(label)}`, () => {
      assert.doesNotThrow(() => {
        const result = assess(input);
        // When the input is garbage, confidence must be null (never fabricated)
        assert.equal(result.confidence, null);
        assert.equal(typeof result.escalate, 'boolean');
        assert.equal(typeof result.reason, 'string');
        assert.equal(typeof result.needsReview, 'boolean');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Fuzz-ish loop: 50 random-ish junk strings
// ---------------------------------------------------------------------------

describe('assess — fuzz loop over junk strings', () => {
  it('never throws on 50 pseudo-random junk strings', () => {
    // Deterministic pseudo-random using a simple LCG so tests are reproducible
    let seed = 0xdeadbeef;
    function nextInt(): number {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    }
    function randChar(): string {
      const chars =
        'abcdefghijklmnopqrstuvwxyz0123456789{}[]":,.!@#$%^&*()_+-=<>?/\\|~`\n\r\t ';
      return chars[nextInt() % chars.length] ?? '';
    }

    for (let i = 0; i < 50; i++) {
      const len = (nextInt() % 200) + 1;
      let s = '';
      for (let j = 0; j < len; j++) {
        s += randChar();
      }
      assert.doesNotThrow(() => {
        const result = assess(s);
        // If confidence is not null it must be a number in [0,1]
        if (result.confidence !== null) {
          assert.ok(result.confidence >= 0 && result.confidence <= 1);
        }
      }, `assess() threw on input: ${JSON.stringify(s.slice(0, 60))}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — assess() IGNORES the remember_user key (no-op wrt memory)
// ---------------------------------------------------------------------------

describe('assess — remember_user is a no-op (Phase 5)', () => {
  it('parses confidence normally even when remember_user rides in the same envelope', () => {
    const output =
      'Answer.\n' +
      '{"confidence":0.91,"escalate":false,"reason":"done","needs_review":false,' +
      '"remember_user":{"facts":[{"scope":"global","kind":"preference",' +
      '"text":"Prefers concise answers","reason":"stable pref"}]}}';
    const result = assess(output);
    // The memory key must not change confidence parsing in any way.
    assert.equal(result.confidence, 0.91);
    assert.equal(result.escalate, false);
    assert.equal(result.needsReview, false);
    // Assessment has no memory field — it never reads remember_user.
    assert.equal(Object.hasOwn(result, 'remember_user'), false);
    assert.equal(Object.hasOwn(result, 'memoryProposal'), false);
  });

  it('a bare remember_user block (no confidence) → confidence null (envelope absent)', () => {
    const output =
      'Answer.\n' +
      '{"remember_user":{"facts":[{"scope":"global","kind":"preference",' +
      '"text":"Prefers concise answers","reason":"pref"}]}}';
    const result = assess(output);
    assert.equal(result.confidence, null);
  });
});
