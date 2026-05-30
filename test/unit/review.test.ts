/**
 * Unit tests for src/core/review.ts
 * Run with: node --import ./test/register.mjs --test "test/unit/review.test.ts"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewVerdict, buildReviewPrompt } from '../../src/core/review.ts';

// ---------------------------------------------------------------------------
// parseReviewVerdict — valid envelopes
// ---------------------------------------------------------------------------

describe('parseReviewVerdict — valid verdict envelopes', () => {
  it('parses an approve verdict', () => {
    const output = 'The IC work looks good.\n{"verdict": "approve", "notes": "All checks pass.", "confidence": 0.95}';
    const verdict = parseReviewVerdict(output);
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.notes, 'All checks pass.');
    assert.ok(verdict.confidence !== null);
    assert.ok(Math.abs(verdict.confidence - 0.95) < 1e-9);
  });

  it('parses a revise verdict', () => {
    const output = 'Found issues in auth.ts.\n{"verdict": "revise", "notes": "auth.ts:42 — missing null check on token", "confidence": 0.8}';
    const verdict = parseReviewVerdict(output);
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.notes, 'auth.ts:42 — missing null check on token');
    assert.ok(verdict.confidence !== null);
    assert.ok(Math.abs(verdict.confidence - 0.8) < 1e-9);
  });

  it('parses an escalate verdict', () => {
    const output = 'Critical architecture issue detected.\n{"verdict": "escalate", "notes": "Requires cross-cutting schema change", "confidence": 0.6}';
    const verdict = parseReviewVerdict(output);
    assert.equal(verdict.verdict, 'escalate');
    assert.equal(verdict.notes, 'Requires cross-cutting schema change');
    assert.ok(verdict.confidence !== null);
    assert.ok(Math.abs(verdict.confidence - 0.6) < 1e-9);
  });

  it('confidence is clamped to [0, 1] — value above 1.0', () => {
    const output = '{"verdict": "approve", "notes": "ok", "confidence": 1.5}';
    const verdict = parseReviewVerdict(output);
    assert.equal(verdict.confidence, 1.0);
  });

  it('confidence is clamped to [0, 1] — value below 0.0', () => {
    const output = '{"verdict": "approve", "notes": "ok", "confidence": -0.5}';
    const verdict = parseReviewVerdict(output);
    assert.equal(verdict.confidence, 0.0);
  });

  it('picks the LAST envelope when multiple are present', () => {
    const output =
      'First pass:\n{"verdict": "revise", "notes": "old notes", "confidence": 0.5}\n' +
      'Second pass:\n{"verdict": "approve", "notes": "all good", "confidence": 0.9}';
    const verdict = parseReviewVerdict(output);
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.notes, 'all good');
  });

  it('handles missing notes field — defaults to empty string', () => {
    const output = '{"verdict": "approve", "confidence": 0.9}';
    const verdict = parseReviewVerdict(output);
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.notes, '');
  });

  it('handles missing confidence field — confidence is null', () => {
    const output = '{"verdict": "revise", "notes": "fix it"}';
    const verdict = parseReviewVerdict(output);
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.confidence, null);
  });
});

// ---------------------------------------------------------------------------
// parseReviewVerdict — fail-open on malformed / missing input
// ---------------------------------------------------------------------------

describe('parseReviewVerdict — fail-open (broken reviewer must not block user)', () => {
  it('missing envelope → fail-open approve with confidence null', () => {
    const verdict = parseReviewVerdict('No JSON here at all.');
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.notes, '');
    assert.equal(verdict.confidence, null);
  });

  it('empty string → fail-open approve', () => {
    const verdict = parseReviewVerdict('');
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.confidence, null);
  });

  it('malformed JSON → fail-open approve', () => {
    const verdict = parseReviewVerdict('{"verdict": "approve", "notes": broken json}');
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.confidence, null);
  });

  it('truncated JSON → fail-open approve', () => {
    const verdict = parseReviewVerdict('{"verdict": "approve"');
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.confidence, null);
  });

  it('invalid verdict value → fail-open approve', () => {
    const verdict = parseReviewVerdict('{"verdict": "reject", "notes": "nope", "confidence": 0.5}');
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.confidence, null);
  });

  it('verdict is a number → fail-open approve', () => {
    const verdict = parseReviewVerdict('{"verdict": 42, "notes": "", "confidence": 0.5}');
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.confidence, null);
  });

  it('never throws on garbage input — random junk string', () => {
    const junks = [
      '🤖🤖🤖',
      '\x00\x01\x02',
      'null',
      '[]',
      '{}',
      '{"confidence": 0.9}',   // has confidence but no verdict — should fail-open
      '{"verdict": null}',
      '{"verdict": true}',
      'SELECT * FROM users;',
      '<html><body>Error 500</body></html>',
      '   ',
    ];

    for (const junk of junks) {
      // Must never throw
      let verdict;
      try {
        verdict = parseReviewVerdict(junk);
      } catch (err) {
        assert.fail(`parseReviewVerdict threw on input: ${JSON.stringify(junk)} — error: ${String(err)}`);
      }
      // All junk should fail-open
      assert.ok(
        verdict !== undefined,
        `parseReviewVerdict returned undefined for: ${JSON.stringify(junk)}`,
      );
      assert.equal(
        verdict.verdict,
        'approve',
        `Expected fail-open 'approve' for junk: ${JSON.stringify(junk)}, got: ${verdict.verdict}`,
      );
      assert.equal(
        verdict.confidence,
        null,
        `Expected confidence null for junk: ${JSON.stringify(junk)}, got: ${verdict.confidence}`,
      );
    }
  });

  it('non-string input — null — returns fail-open', () => {
    // @ts-expect-error Testing runtime robustness with wrong type
    const verdict = parseReviewVerdict(null);
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.confidence, null);
  });

  it('non-string input — number — returns fail-open', () => {
    // @ts-expect-error Testing runtime robustness with wrong type
    const verdict = parseReviewVerdict(12345);
    assert.equal(verdict.verdict, 'approve');
    assert.equal(verdict.confidence, null);
  });
});

// ---------------------------------------------------------------------------
// buildReviewPrompt — basic structure checks
// ---------------------------------------------------------------------------

describe('buildReviewPrompt — structure', () => {
  it('contains the original task', () => {
    const prompt = buildReviewPrompt('refactor auth module', 'IC did some work');
    assert.ok(prompt.includes('refactor auth module'));
  });

  it('contains the IC output', () => {
    const prompt = buildReviewPrompt('task here', 'IC specific output ABC');
    assert.ok(prompt.includes('IC specific output ABC'));
  });

  it('instructs the model to end with a JSON verdict envelope', () => {
    const prompt = buildReviewPrompt('task', 'output');
    assert.ok(prompt.includes('"verdict"'));
    assert.ok(prompt.includes('approve'));
    assert.ok(prompt.includes('revise'));
    assert.ok(prompt.includes('escalate'));
  });

  it('mentions correctness, quality, security, and completeness', () => {
    const prompt = buildReviewPrompt('task', 'output').toLowerCase();
    assert.ok(prompt.includes('correctness'));
    assert.ok(prompt.includes('quality'));
    assert.ok(prompt.includes('security'));
    assert.ok(prompt.includes('completeness'));
  });
});
