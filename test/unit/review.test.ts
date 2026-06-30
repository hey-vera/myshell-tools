/**
 * Unit tests for src/core/review.ts
 * Run with: node --import ./test/register.mjs --test "test/unit/review.test.ts"
 */

import { describe, it } from 'vitest';
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
    assert.equal(verdict.parsed, true, 'parsed must be true when envelope was found');
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
    assert.equal(verdict.parsed, true);
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
// parseReviewVerdict — fail-safe on malformed / missing input
//
// A broken/unparseable reviewer must NEVER be flattened into a silent
// `approve`. The fail-safe default is `revise` (with parsed:false), so lower
// tiers re-run/escalate rather than ship unreviewed work, while the
// high/critical guard still keys off parsed:false.
// ---------------------------------------------------------------------------

describe('parseReviewVerdict — fail-safe (broken reviewer must not silently approve)', () => {
  it('missing envelope → fail-safe revise with confidence null AND parsed:false', () => {
    const verdict = parseReviewVerdict('No JSON here at all.');
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.notes, '');
    assert.equal(verdict.confidence, null);
    assert.equal(verdict.parsed, false, 'fail-safe must set parsed:false');
  });

  it('empty string → fail-safe revise with parsed:false', () => {
    const verdict = parseReviewVerdict('');
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.confidence, null);
    assert.equal(verdict.parsed, false);
  });

  it('malformed JSON → fail-safe revise', () => {
    const verdict = parseReviewVerdict('{"verdict": "approve", "notes": broken json}');
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.confidence, null);
    assert.equal(verdict.parsed, false);
  });

  it('truncated JSON → fail-safe revise', () => {
    const verdict = parseReviewVerdict('{"verdict": "approve"');
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.confidence, null);
    assert.equal(verdict.parsed, false);
  });

  it('invalid verdict value → fail-safe revise', () => {
    const verdict = parseReviewVerdict('{"verdict": "reject", "notes": "nope", "confidence": 0.5}');
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.confidence, null);
    assert.equal(verdict.parsed, false);
  });

  it('verdict is a number → fail-safe revise', () => {
    const verdict = parseReviewVerdict('{"verdict": 42, "notes": "", "confidence": 0.5}');
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.confidence, null);
    assert.equal(verdict.parsed, false);
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
      // All junk should fail-safe
      assert.ok(
        verdict !== undefined,
        `parseReviewVerdict returned undefined for: ${JSON.stringify(junk)}`,
      );
      assert.equal(
        verdict.verdict,
        'revise',
        `Expected fail-safe 'revise' for junk: ${JSON.stringify(junk)}, got: ${verdict.verdict}`,
      );
      assert.equal(
        verdict.confidence,
        null,
        `Expected confidence null for junk: ${JSON.stringify(junk)}, got: ${verdict.confidence}`,
      );
      assert.equal(
        verdict.parsed,
        false,
        `Expected parsed:false for junk: ${JSON.stringify(junk)}, got: ${String(verdict.parsed)}`,
      );
    }
  });

  it('non-string input — null — returns fail-safe', () => {
    // @ts-expect-error Testing runtime robustness with wrong type
    const verdict = parseReviewVerdict(null);
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.confidence, null);
  });

  it('non-string input — number — returns fail-safe', () => {
    // @ts-expect-error Testing runtime robustness with wrong type
    const verdict = parseReviewVerdict(12345);
    assert.equal(verdict.verdict, 'revise');
    assert.equal(verdict.confidence, null);
  });
});

// ---------------------------------------------------------------------------
// buildReviewPrompt — basic structure checks
// ---------------------------------------------------------------------------

const EXPECTED_REVIEW_PROMPT_NO_CONTRACT = `\
You are a senior-manager / staff-engineer reviewer performing a critical quality gate.

You are reviewing the work of an individual-contributor (IC) engineer who was given the
following task. Your job is to identify any issues with correctness, quality, security,
or completeness in the IC's output before it reaches the user.

Original task:
task

IC output to review:
output

Review checklist (assess each dimension):
1. CORRECTNESS — Does the output actually solve the task? Are there logic errors, off-by-ones,
   or wrong assumptions?
2. QUALITY — Is the code/output clean, idiomatic, and maintainable? Are there obvious smells?
3. SECURITY — Are there any injection risks, secret leaks, missing input validation, or
   privilege-escalation paths?
4. COMPLETENESS — Does the output address all parts of the task, or does it miss edge cases?

For any finding, anchor it to a specific file path and line range when applicable.

After your review, append EXACTLY the following JSON object on its own line at the very end
of your response (no trailing text after it):
{"verdict": "approve|revise|escalate", "notes": "<specific, file-anchored feedback>", "confidence": <0.0-1.0>}

verdict choices:
  approve   — the IC output is correct, complete, and safe; ship it.
  revise    — the IC output has fixable issues; provide actionable notes so the IC can retry.
  escalate  — the task requires architectural judgement or has critical defects beyond IC scope.

confidence: your honest estimate that your review is complete and correct (1.0 = certain).`;

describe('buildReviewPrompt — structure', () => {
  it('without a contract matches the existing prompt byte-for-byte', () => {
    assert.equal(buildReviewPrompt('task', 'output'), EXPECTED_REVIEW_PROMPT_NO_CONTRACT);
  });

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

  it('with a contract adds verifier criteria before the verdict envelope instruction', () => {
    const prompt = buildReviewPrompt('task', 'output', {
      version: 1,
      objective: 'finish auth migration',
      vision: 'preserve login behavior',
    });

    assert.match(prompt, /VERIFY AGAINST CONTRACT:\nOBJECTIVE: finish auth migration\nVISION: preserve login behavior/);
    assert.ok(
      prompt.indexOf('VERIFY AGAINST CONTRACT') <
        prompt.indexOf('After your review, append EXACTLY'),
    );
    assert.ok(prompt.endsWith('confidence: your honest estimate that your review is complete and correct (1.0 = certain).'));
  });
});
