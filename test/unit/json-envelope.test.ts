/**
 * Unit tests for src/core/json-envelope.ts
 *
 * Verifies that the shared brace-depth JSON-envelope scanner behaves
 * identically to the private extractors it replaced in assess.ts and
 * review.ts, and that the bounds variant used by history.ts is correct.
 *
 * Run with:
 *   node --import ./test/register.mjs --experimental-strip-types --test \
 *     "test/unit/json-envelope.test.ts"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastJsonObjectWithKey,
  lastJsonObjectBoundsWithKey,
} from '../../src/core/json-envelope.ts';

// ---------------------------------------------------------------------------
// lastJsonObjectWithKey — basic cases
// ---------------------------------------------------------------------------

describe('lastJsonObjectWithKey — no object present', () => {
  it('returns null for empty string', () => {
    assert.equal(lastJsonObjectWithKey('', 'confidence'), null);
  });

  it('returns null for plain text with no JSON', () => {
    assert.equal(lastJsonObjectWithKey('hello world', 'confidence'), null);
  });

  it('returns null for a non-string input (type guard)', () => {
    // @ts-expect-error testing runtime robustness
    assert.equal(lastJsonObjectWithKey(null, 'confidence'), null);
    // @ts-expect-error testing runtime robustness
    assert.equal(lastJsonObjectWithKey(undefined, 'confidence'), null);
    // @ts-expect-error testing runtime robustness
    assert.equal(lastJsonObjectWithKey(42, 'confidence'), null);
  });

  it('returns null when JSON object lacks the required key', () => {
    const text = '{"escalate": false, "reason": "no confidence key"}';
    assert.equal(lastJsonObjectWithKey(text, 'confidence'), null);
  });

  it('returns null for a JSON array (not a plain object)', () => {
    assert.equal(lastJsonObjectWithKey('[1, 2, 3]', 'confidence'), null);
  });

  it('returns null for a JSON null literal', () => {
    assert.equal(lastJsonObjectWithKey('null', 'confidence'), null);
  });

  it('returns null for a JSON number literal', () => {
    assert.equal(lastJsonObjectWithKey('0.87', 'confidence'), null);
  });
});

// ---------------------------------------------------------------------------
// lastJsonObjectWithKey — single match
// ---------------------------------------------------------------------------

describe('lastJsonObjectWithKey — single matching object', () => {
  it('finds a simple object with the key', () => {
    const text = '{"confidence": 0.85, "escalate": false}';
    const result = lastJsonObjectWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result['confidence'], 0.85);
  });

  it('finds an object embedded in surrounding text', () => {
    const text = 'Done.\n{"confidence": 0.9, "escalate": false, "reason": "ok", "needs_review": false}\n';
    const result = lastJsonObjectWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result['confidence'], 0.9);
  });

  it('finds a verdict envelope by "verdict" key', () => {
    const text = 'Review done.\n{"verdict": "approve", "notes": "all good", "confidence": 0.95}';
    const result = lastJsonObjectWithKey(text, 'verdict');
    assert.ok(result !== null);
    assert.equal(result['verdict'], 'approve');
  });

  it('returns the full parsed object (all fields accessible)', () => {
    const text = '{"confidence": 0.7, "escalate": true, "reason": "complex", "needs_review": true}';
    const result = lastJsonObjectWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result['confidence'], 0.7);
    assert.equal(result['escalate'], true);
    assert.equal(result['reason'], 'complex');
    assert.equal(result['needs_review'], true);
  });
});

// ---------------------------------------------------------------------------
// lastJsonObjectWithKey — multiple objects → last wins
// ---------------------------------------------------------------------------

describe('lastJsonObjectWithKey — multiple matching objects → last wins', () => {
  it('returns the LAST object when two share the key', () => {
    const text =
      '{"confidence": 0.3, "escalate": true}\n' +
      'Revised:\n' +
      '{"confidence": 0.9, "escalate": false}';
    const result = lastJsonObjectWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result['confidence'], 0.9);
  });

  it('returns the LAST verdict envelope among three', () => {
    const text =
      '{"verdict": "revise", "notes": "first"}\n' +
      '{"verdict": "escalate", "notes": "second"}\n' +
      '{"verdict": "approve", "notes": "third"}';
    const result = lastJsonObjectWithKey(text, 'verdict');
    assert.ok(result !== null);
    assert.equal(result['verdict'], 'approve');
    assert.equal(result['notes'], 'third');
  });

  it('only the last matching key wins — non-matching objects in between are ignored', () => {
    const text =
      '{"confidence": 0.4}\n' +
      '{"other_key": "irrelevant"}\n' +
      '{"confidence": 0.8}';
    const result = lastJsonObjectWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result['confidence'], 0.8);
  });
});

// ---------------------------------------------------------------------------
// lastJsonObjectWithKey — nested braces
// ---------------------------------------------------------------------------

describe('lastJsonObjectWithKey — nested braces', () => {
  it('handles a nested object correctly', () => {
    const text = '{"confidence": 0.75, "meta": {"source": "model"}}';
    const result = lastJsonObjectWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result['confidence'], 0.75);
  });

  it('finds the outer (last) object when nesting is present', () => {
    const text =
      '{"inner": {"confidence": 0.5}}\n' +
      '{"confidence": 0.9, "outer": true}';
    // The second object is last and has the key at top level
    const result = lastJsonObjectWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result['confidence'], 0.9);
  });
});

// ---------------------------------------------------------------------------
// lastJsonObjectWithKey — malformed JSON — never throws
// ---------------------------------------------------------------------------

describe('lastJsonObjectWithKey — malformed / garbage input — never throws', () => {
  const GARBAGE: string[] = [
    '{',
    '}',
    '{"confidence":',
    '{"confidence": 0.5',
    '{ bad json {{{{',
    '<<< not json >>>',
    '\x00\x01\x02binary\xFF\xFE',
    'undefined',
    '[]',
    '{"confidence": NaN}',
    '{"confidence": Infinity}',
    '  ',
    '\n\n\n',
    String.fromCharCode(0),
    'a'.repeat(100_000),
  ];

  for (const input of GARBAGE) {
    const label = input.length > 50 ? input.slice(0, 50) + '…' : JSON.stringify(input);
    it(`never throws for: ${label}`, () => {
      assert.doesNotThrow(() => {
        const result = lastJsonObjectWithKey(input, 'confidence');
        // Result is either null or a valid object — never an exception
        assert.ok(result === null || (typeof result === 'object' && result !== null));
      });
    });
  }
});

// ---------------------------------------------------------------------------
// lastJsonObjectBoundsWithKey — returns correct offsets
// ---------------------------------------------------------------------------

describe('lastJsonObjectBoundsWithKey — correct start/end offsets', () => {
  it('returns null when no matching object', () => {
    assert.equal(lastJsonObjectBoundsWithKey('hello world', 'confidence'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(lastJsonObjectBoundsWithKey('', 'confidence'), null);
  });

  it('start/end slice reproduces the matched block exactly', () => {
    const envelope = '{"confidence": 0.85, "escalate": false}';
    const text = `Some text before.\n${envelope}\nSome text after.`;
    const result = lastJsonObjectBoundsWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(text.slice(result.start, result.end), envelope);
  });

  it('returns value === the parsed object', () => {
    const text = '{"confidence": 0.7, "escalate": true}';
    const result = lastJsonObjectBoundsWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result.value['confidence'], 0.7);
    assert.equal(result.value['escalate'], true);
  });

  it('last-wins: bounds point at the LAST matching object', () => {
    const first = '{"confidence": 0.3}';
    const second = '{"confidence": 0.9}';
    const text = `${first}\nMiddle text.\n${second}`;
    const result = lastJsonObjectBoundsWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(text.slice(result.start, result.end), second);
    assert.equal(result.value['confidence'], 0.9);
  });

  it('text before start is intact (nothing before the object is consumed)', () => {
    const prefix = 'Here is my answer.\n';
    const envelope = '{"confidence": 0.6, "escalate": false}';
    const text = prefix + envelope;
    const result = lastJsonObjectBoundsWithKey(text, 'confidence');
    assert.ok(result !== null);
    assert.equal(result.start, prefix.length);
    assert.equal(result.end, text.length);
  });

  it('never throws on garbage input', () => {
    const inputs = ['{', '}', '{"confidence":', 'null', '[]', '\x00\xFF'];
    for (const inp of inputs) {
      assert.doesNotThrow(() => lastJsonObjectBoundsWithKey(inp, 'confidence'));
    }
  });
});
