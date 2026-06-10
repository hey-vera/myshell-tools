/**
 * test/unit/understanding.test.ts — the PURE core for the WHOLE-PICTURE
 * UNDERSTANDING PASS (core/understanding.ts, Elite-partner Part 2). Locks in the
 * prompt-builder shape and the fail-soft tagged parse (well-formed → SystemModel,
 * partial → best-effort, garbage → null, caps enforced, never throws). Twin of the
 * goal-plan parse tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUnderstandingPrompt,
  parseSystemModel,
  UNDERSTANDING_MAX_MODULES,
  UNDERSTANDING_MAX_CONVENTIONS,
  UNDERSTANDING_MAX_CONSTRAINTS,
  UNDERSTANDING_MAX_OPEN_QUESTIONS,
  UNDERSTANDING_MAX_CITATIONS,
} from '../../src/core/understanding.ts';

describe('buildUnderstandingPrompt', () => {
  it('returns empty string for empty input (the generator then does nothing)', () => {
    assert.equal(buildUnderstandingPrompt('   '), '');
    assert.equal(buildUnderstandingPrompt(''), '');
  });

  it('leads with the elite voice + names a READ-ONLY investigation + carries the task', () => {
    const p = buildUnderstandingPrompt('migrate the auth token refresh path');
    assert.ok(p.length > 0);
    assert.ok(/READ-ONLY/i.test(p), 'names a read-only investigation');
    assert.ok(/MODULE:/.test(p) && /CONSTRAINT:/.test(p) && /OPENQ:/.test(p), 'documents the tagged shape');
    assert.ok(p.includes('migrate the auth token refresh path'), 'carries the work to understand');
  });

  it('includes the repo orientation block only when given one', () => {
    const without = buildUnderstandingPrompt('do the thing');
    assert.ok(!/REPOSITORY ORIENTATION/.test(without));
    const withCtx = buildUnderstandingPrompt('do the thing', 'src/a.ts\nsrc/b.ts');
    assert.ok(/REPOSITORY ORIENTATION/.test(withCtx));
    assert.ok(withCtx.includes('src/a.ts'));
  });
});

describe('parseSystemModel — fail-soft tagged parse', () => {
  it('parses a well-formed reply into a SystemModel', () => {
    const raw = [
      'SUMMARY: The auth path lives in core/oauth and is refreshed in infra/token-store.',
      'MODULE: core/oauth — owns the refresh flow, calls infra/token-store',
      'MODULE: infra/token-store — atomic on-disk token persistence',
      'CONVENTION: pure core, impure infra (no fs in core/)',
      'CONSTRAINT: subscription-OAuth only, no metered API, no embeddings',
      'OPENQ: should refresh happen eagerly or lazily?',
      'CITE: https://example.com/oauth-best-practice',
    ].join('\n');
    const m = parseSystemModel(raw);
    assert.ok(m !== null);
    assert.ok(m.summary.startsWith('The auth path lives'));
    assert.equal(m.modules.length, 2);
    assert.deepEqual(m.conventions, ['pure core, impure infra (no fs in core/)']);
    assert.equal(m.constraints.length, 1);
    assert.deepEqual(m.openQuestions, ['should refresh happen eagerly or lazily?']);
    assert.deepEqual(m.researchCitations, ['https://example.com/oauth-best-practice']);
  });

  it('best-effort parses a partial reply (only a summary)', () => {
    const m = parseSystemModel('SUMMARY: a small CLI tool that routes model calls');
    assert.ok(m !== null);
    assert.ok(m.summary.startsWith('a small CLI tool'));
    assert.deepEqual(m.modules, []);
    assert.deepEqual(m.constraints, []);
    assert.deepEqual(m.researchCitations, []);
  });

  it('best-effort parses a reply with only modules (no summary)', () => {
    const m = parseSystemModel('MODULE: core/route — the tier router');
    assert.ok(m !== null);
    assert.equal(m.summary, '');
    assert.deepEqual(m.modules, ['core/route — the tier router']);
  });

  it('returns null for garbage / no grounding (caller plans ungrounded)', () => {
    assert.equal(parseSystemModel('hello there, here is my plan!'), null);
    assert.equal(parseSystemModel(''), null);
    assert.equal(parseSystemModel(undefined), null);
    assert.equal(parseSystemModel(null), null);
    assert.equal(parseSystemModel(123 as unknown as string), null);
  });

  it('open questions / citations ALONE are not enough grounding → null', () => {
    const raw = 'OPENQ: what scale?\nCITE: https://example.com/x';
    assert.equal(parseSystemModel(raw), null);
  });

  it('caps every list to its bound', () => {
    const modules = Array.from({ length: 30 }, (_, i) => `MODULE: m${String(i)}`).join('\n');
    const conventions = Array.from({ length: 30 }, (_, i) => `CONVENTION: c${String(i)}`).join('\n');
    const constraints = Array.from({ length: 30 }, (_, i) => `CONSTRAINT: k${String(i)}`).join('\n');
    const openqs = Array.from({ length: 30 }, (_, i) => `OPENQ: q${String(i)}`).join('\n');
    const cites = Array.from({ length: 30 }, (_, i) => `CITE: u${String(i)}`).join('\n');
    const m = parseSystemModel(['SUMMARY: x', modules, conventions, constraints, openqs, cites].join('\n'));
    assert.ok(m !== null);
    assert.equal(m.modules.length, UNDERSTANDING_MAX_MODULES);
    assert.equal(m.conventions.length, UNDERSTANDING_MAX_CONVENTIONS);
    assert.equal(m.constraints.length, UNDERSTANDING_MAX_CONSTRAINTS);
    assert.equal(m.openQuestions.length, UNDERSTANDING_MAX_OPEN_QUESTIONS);
    assert.equal(m.researchCitations.length, UNDERSTANDING_MAX_CITATIONS);
  });

  it('caps a runaway line length (never bloats the planner prompt)', () => {
    const long = 'MODULE: ' + 'x'.repeat(5000);
    const m = parseSystemModel('SUMMARY: ok\n' + long);
    assert.ok(m !== null);
    assert.ok((m.modules[0]?.length ?? 0) <= 200);
  });

  it('never throws on hostile input', () => {
    assert.doesNotThrow(() => parseSystemModel('SUMMARY:\nMODULE:\n:::\n— — —'));
  });
});
