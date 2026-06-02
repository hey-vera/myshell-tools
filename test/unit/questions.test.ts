/**
 * Unit tests for src/core/questions.ts
 * Run with: node --experimental-strip-types --test test/unit/questions.test.ts
 *
 * Covers parseQuestions (valid single/multi, bounds rejection, malformed → null,
 * never throws, non-ask_user text → null) and formatAnswers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestions, formatAnswers } from '../../src/core/questions.ts';
import type { QuestionSet } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// parseQuestions — valid
// ---------------------------------------------------------------------------

describe('parseQuestions — valid blocks', () => {
  it('parses a single single-select question', () => {
    const text =
      'I need a decision first.\n' +
      '{"ask_user":{"questions":[{"id":"framework","prompt":"Which test framework?","options":[{"label":"vitest","description":"fast"},{"label":"jest"}],"multiSelect":false,"allowFreeText":true}]}}';
    const qs = parseQuestions(text);
    assert.ok(qs !== null);
    assert.equal(qs.questions.length, 1);
    const q = qs.questions[0]!;
    assert.equal(q.id, 'framework');
    assert.equal(q.prompt, 'Which test framework?');
    assert.equal(q.options.length, 2);
    assert.equal(q.options[0]!.label, 'vitest');
    assert.equal(q.options[0]!.description, 'fast');
    assert.equal(q.options[1]!.description, undefined);
    assert.equal(q.multiSelect, false);
    assert.equal(q.allowFreeText, true);
  });

  it('parses an envelope wrapped in a ```json code fence (models add one despite instructions)', () => {
    const text =
      "Let me ask first.\n```json\n" +
      '{"ask_user":{"questions":[{"id":"db","prompt":"Which DB?","options":[{"label":"Postgres"},{"label":"SQLite"}],"multiSelect":false,"allowFreeText":true}]}}\n' +
      '```';
    const qs = parseQuestions(text);
    assert.ok(qs !== null, 'a fenced trailing envelope must still parse (not leak as raw JSON)');
    assert.equal(qs.questions[0]!.options.length, 2);
  });

  it('clamps an over-long option list to the cap instead of rejecting the whole selector', () => {
    const text =
      '{"ask_user":{"questions":[{"id":"lang","prompt":"Which?","options":[' +
      '{"label":"Python"},{"label":"JS"},{"label":"Go"},{"label":"Rust"},{"label":"Other"}' +
      '],"multiSelect":false,"allowFreeText":true}]}}';
    const qs = parseQuestions(text);
    assert.ok(qs !== null, '5 options should clamp, not discard the selector');
    assert.equal(qs.questions[0]!.options.length, 4, 'clamped to MAX_OPTIONS');
    assert.equal(qs.questions[0]!.options[0]!.label, 'Python');
  });

  it('parses a multi-select question and defaults flags to false when absent', () => {
    const text =
      '{"ask_user":{"questions":[{"id":"langs","prompt":"Pick languages","options":[{"label":"ts"},{"label":"go"},{"label":"rust"}],"multiSelect":true}]}}';
    const qs = parseQuestions(text);
    assert.ok(qs !== null);
    const q = qs.questions[0]!;
    assert.equal(q.multiSelect, true);
    assert.equal(q.allowFreeText, false); // absent → false
  });

  it('parses up to 4 questions', () => {
    const q = (id: string) =>
      `{"id":"${id}","prompt":"p ${id}","options":[{"label":"a"},{"label":"b"}],"multiSelect":false,"allowFreeText":false}`;
    const text = `{"ask_user":{"questions":[${q('q1')},${q('q2')},${q('q3')},${q('q4')}]}}`;
    const qs = parseQuestions(text);
    assert.ok(qs !== null);
    assert.equal(qs.questions.length, 4);
  });

  it('uses the LAST ask_user block when text has an earlier non-trailing object', () => {
    const text =
      'Example: {"ask_user":{"questions":[]}} is invalid; here is the real one:\n' +
      '{"ask_user":{"questions":[{"id":"x","prompt":"p","options":[{"label":"a"},{"label":"b"}],"multiSelect":false,"allowFreeText":false}]}}';
    const qs = parseQuestions(text);
    assert.ok(qs !== null);
    assert.equal(qs.questions[0]!.id, 'x');
  });
});

// ---------------------------------------------------------------------------
// parseQuestions — bounds rejection
// ---------------------------------------------------------------------------

describe('parseQuestions — bounds', () => {
  it('rejects zero questions', () => {
    assert.equal(parseQuestions('{"ask_user":{"questions":[]}}'), null);
  });

  it('rejects more than 4 questions', () => {
    const q = (id: string) =>
      `{"id":"${id}","prompt":"p","options":[{"label":"a"},{"label":"b"}],"multiSelect":false,"allowFreeText":false}`;
    const text = `{"ask_user":{"questions":[${q('1')},${q('2')},${q('3')},${q('4')},${q('5')}]}}`;
    assert.equal(parseQuestions(text), null);
  });

  it('rejects fewer than 2 options', () => {
    const text =
      '{"ask_user":{"questions":[{"id":"x","prompt":"p","options":[{"label":"only"}],"multiSelect":false,"allowFreeText":false}]}}';
    assert.equal(parseQuestions(text), null);
  });

  it('clamps more than 4 options to the cap (keeps the selector, drops the extras)', () => {
    const opts = ['a', 'b', 'c', 'd', 'e'].map((l) => `{"label":"${l}"}`).join(',');
    const text = `{"ask_user":{"questions":[{"id":"x","prompt":"p","options":[${opts}],"multiSelect":false,"allowFreeText":false}]}}`;
    const qs = parseQuestions(text);
    assert.ok(qs !== null, 'an over-long option list clamps rather than discarding the selector');
    assert.equal(qs.questions[0]!.options.length, 4);
    assert.equal(qs.questions[0]!.options[3]!.label, 'd');
  });
});

// ---------------------------------------------------------------------------
// parseQuestions — malformed / non-ask_user → null, never throws
// ---------------------------------------------------------------------------

describe('parseQuestions — malformed → null', () => {
  it('returns null for plain prose with no block', () => {
    assert.equal(parseQuestions('Just a normal answer, nothing structured.'), null);
  });

  it('returns null for a confidence envelope (not ask_user)', () => {
    assert.equal(
      parseQuestions('{"confidence": 0.9, "escalate": false, "reason": "ok", "needs_review": false}'),
      null,
    );
  });

  it('returns null when a question is missing an id', () => {
    const text =
      '{"ask_user":{"questions":[{"prompt":"p","options":[{"label":"a"},{"label":"b"}],"multiSelect":false,"allowFreeText":false}]}}';
    assert.equal(parseQuestions(text), null);
  });

  it('returns null when an option lacks a label', () => {
    const text =
      '{"ask_user":{"questions":[{"id":"x","prompt":"p","options":[{"description":"no label"},{"label":"b"}],"multiSelect":false,"allowFreeText":false}]}}';
    assert.equal(parseQuestions(text), null);
  });

  it('returns null when a flag is a non-boolean', () => {
    const text =
      '{"ask_user":{"questions":[{"id":"x","prompt":"p","options":[{"label":"a"},{"label":"b"}],"multiSelect":"yes","allowFreeText":false}]}}';
    assert.equal(parseQuestions(text), null);
  });

  it('returns null for invalid JSON in the block', () => {
    assert.equal(parseQuestions('{"ask_user":{"questions":[}}'), null);
  });

  it('never throws on adversarial input', () => {
    const inputs: unknown[] = [
      '',
      '{',
      '{"ask_user":null}',
      '{"ask_user":{"questions":"nope"}}',
      '{"ask_user":{}}',
      '{"ask_user":[]}',
      'ask_user',
    ];
    for (const i of inputs) {
      assert.doesNotThrow(() => parseQuestions(i as string));
      assert.equal(parseQuestions(i as string), null);
    }
  });
});

// ---------------------------------------------------------------------------
// formatAnswers
// ---------------------------------------------------------------------------

describe('formatAnswers', () => {
  const qs: QuestionSet = {
    questions: [
      { id: 'framework', prompt: 'p', options: [{ label: 'vitest' }, { label: 'jest' }], multiSelect: false, allowFreeText: false },
      { id: 'coverage', prompt: 'p', options: [{ label: 'yes' }, { label: 'no' }], multiSelect: false, allowFreeText: false },
    ],
  };

  it('builds a deterministic answer line', () => {
    const out = formatAnswers(qs, { framework: 'vitest', coverage: 'yes' });
    assert.equal(out, 'Answers: framework = vitest; coverage = yes');
  });

  it('omits unanswered questions', () => {
    const out = formatAnswers(qs, { framework: 'vitest' });
    assert.equal(out, 'Answers: framework = vitest');
  });

  it('returns empty string when nothing was answered', () => {
    assert.equal(formatAnswers(qs, {}), '');
  });
});

describe('parseQuestions — trailing-only (Major 3 regression)', () => {
  const VALID =
    '{"ask_user":{"questions":[{"id":"fw","prompt":"Which?","options":[{"label":"a"},{"label":"b"}],"multiSelect":false,"allowFreeText":true}]}}';

  it('parses a TRAILING ask_user block', () => {
    const r = parseQuestions('Here you go.\n' + VALID);
    assert.ok(r !== null && r.questions.length === 1);
  });

  it('returns null when the ask_user block is NOT trailing (prose follows)', () => {
    // e.g. the user asked "how does ask_user work?" and the model showed a sample
    // block mid-answer — it must NOT be misread as a real question and pop a selector.
    const r = parseQuestions(VALID + '\n\nThat is an example of the format.');
    assert.equal(r, null);
  });
});
