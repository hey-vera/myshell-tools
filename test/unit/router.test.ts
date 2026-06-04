/**
 * test/unit/router.test.ts — the model-brained front door (core/router.ts).
 *
 * Covers: the hasTierEvidence seam, the router prompt, the tolerant-but-strict
 * JSON parser, and decideRoute's fast-path / model-path / graceful-fallback
 * behaviour. All pure — the model is a fake injected ModelClassifier, so there
 * is no live-model dependency here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classify, hasTierEvidence } from '../../src/core/classify.ts';
import {
  buildRouterPrompt,
  parseModelRoute,
  decideRoute,
  type ModelClassifier,
} from '../../src/core/router.ts';

const NEVER_ABORT = new AbortController().signal;

// ---------------------------------------------------------------------------
// hasTierEvidence
// ---------------------------------------------------------------------------

describe('hasTierEvidence', () => {
  it('true when a tier keyword matches (worker/ic/manager)', () => {
    assert.equal(hasTierEvidence('please find the config file'), true);   // worker
    assert.equal(hasTierEvidence('implement a retry helper'), true);      // ic
    assert.equal(hasTierEvidence('audit the auth flow'), true);           // manager
  });

  it('false for empty / whitespace input', () => {
    assert.equal(hasTierEvidence(''), false);
    assert.equal(hasTierEvidence('   '), false);
  });

  it('false when no tier keyword matches (the ambiguous case)', () => {
    assert.equal(hasTierEvidence('the thing is being weird again'), false);
    assert.equal(hasTierEvidence('it broke after lunch, halp'), false);
  });

  it('false for a lone soft manager keyword with no ic/worker signal', () => {
    assert.equal(hasTierEvidence('design a multi-tenant billing system'), false);
    assert.equal(hasTierEvidence('plan the new onboarding flow'), false);
    assert.equal(hasTierEvidence('review this when you can'), false);
  });

  it('true when manager evidence qualifies by strong or two soft signals', () => {
    assert.equal(hasTierEvidence('audit the billing flow'), true);
    assert.equal(hasTierEvidence('review and design the billing flow'), true);
  });

  it('true for ic and worker signals', () => {
    assert.equal(hasTierEvidence('fix the billing form'), true);
    assert.equal(hasTierEvidence('find the billing form'), true);
  });

  it('matches classify manager qualification for lone soft, strong, and two-soft cases', () => {
    assert.equal(classify('design a multi-tenant billing system').tier, 'ic');
    assert.equal(hasTierEvidence('design a multi-tenant billing system'), false);

    assert.equal(classify('audit the billing system').tier, 'manager');
    assert.equal(hasTierEvidence('audit the billing system'), true);

    assert.equal(classify('review and design the billing system').tier, 'manager');
    assert.equal(hasTierEvidence('review and design the billing system'), true);
  });
});

// ---------------------------------------------------------------------------
// buildRouterPrompt
// ---------------------------------------------------------------------------

describe('buildRouterPrompt', () => {
  it('embeds the task and instructs JSON-only output', () => {
    const p = buildRouterPrompt('make the dashboard faster');
    assert.ok(p.includes('make the dashboard faster'), 'includes the task');
    assert.ok(p.includes('"tier"') && p.includes('"plan"'), 'shows the JSON shape');
    assert.ok(/ONLY a JSON object/i.test(p), 'demands JSON-only');
  });
});

// ---------------------------------------------------------------------------
// parseModelRoute
// ---------------------------------------------------------------------------

describe('parseModelRoute', () => {
  it('parses a clean JSON-only reply', () => {
    const s = parseModelRoute('{"tier":"manager","plan":true,"reason":"cross-system redesign"}');
    assert.deepEqual(s, { tier: 'manager', plan: true, reason: 'cross-system redesign' });
  });

  it('extracts JSON even with prose around it', () => {
    const s = parseModelRoute('Sure! Here is my call:\n{"tier":"ic","plan":false,"reason":"single edit"}\nHope that helps.');
    assert.deepEqual(s, { tier: 'ic', plan: false, reason: 'single edit' });
  });

  it('handles a brace inside the reason string', () => {
    const s = parseModelRoute('{"tier":"worker","plan":false,"reason":"lookup {x} value"}');
    assert.deepEqual(s, { tier: 'worker', plan: false, reason: 'lookup {x} value' });
  });

  it('returns null for an invalid tier', () => {
    assert.equal(parseModelRoute('{"tier":"boss","plan":false,"reason":"x"}'), null);
  });

  it('returns null when plan is not a boolean', () => {
    assert.equal(parseModelRoute('{"tier":"ic","plan":"yes","reason":"x"}'), null);
  });

  it('returns null for an empty / missing reason', () => {
    assert.equal(parseModelRoute('{"tier":"ic","plan":false,"reason":"   "}'), null);
    assert.equal(parseModelRoute('{"tier":"ic","plan":false}'), null);
  });

  it('returns null for non-JSON / undefined / no object', () => {
    assert.equal(parseModelRoute('not json at all'), null);
    assert.equal(parseModelRoute(undefined), null);
    assert.equal(parseModelRoute('{"tier":"ic", "plan": false,'), null); // truncated
  });
});

// ---------------------------------------------------------------------------
// decideRoute
// ---------------------------------------------------------------------------

describe('decideRoute', () => {
  it('fast path: no classifier wired → deterministic rules, source "rules"', async () => {
    const d = await decideRoute('implement a retry helper', { signal: NEVER_ABORT });
    assert.equal(d.source, 'rules');
    assert.equal(d.tier, 'ic');
    assert.equal(d.plan, false);
  });

  it('fast path: classifier wired but task HAS evidence → rules, model NOT consulted', async () => {
    let called = false;
    const classifier: ModelClassifier = async () => {
      called = true;
      return { tier: 'manager', plan: true, reason: 'should not be used' };
    };
    const d = await decideRoute('audit the auth flow', { classifier, signal: NEVER_ABORT });
    assert.equal(called, false, 'classifier must NOT be called when rules had evidence');
    assert.equal(d.source, 'rules');
    assert.equal(d.tier, 'manager'); // from the deterministic "audit" strong signal
  });

  it('model path: ambiguous task → uses the model suggestion, source "model"', async () => {
    const classifier: ModelClassifier = async () => ({
      tier: 'manager',
      plan: true,
      reason: 'big multi-system change',
    });
    const d = await decideRoute('the whole thing needs rethinking honestly', { classifier, signal: NEVER_ABORT });
    assert.equal(d.source, 'model');
    assert.equal(d.tier, 'manager');
    assert.equal(d.plan, true);
    assert.ok(d.rationale.includes('model router'), 'rationale names the model router');
  });

  it('model path NEVER downgrades the deterministic risk', async () => {
    // "the password thing is weird" → no tier keyword (ambiguous) but 'password'
    // is a CRITICAL risk signal. A model picking a tier must not erase that.
    const classifier: ModelClassifier = async () => ({ tier: 'worker', plan: false, reason: 'just a question' });
    const d = await decideRoute('the password thing is weird', { classifier, signal: NEVER_ABORT });
    assert.equal(d.source, 'model');
    assert.equal(d.tier, 'worker');
    assert.equal(d.risk, 'critical', 'deterministic critical risk is preserved');
  });

  it('graceful fallback: classifier returns null → rules', async () => {
    const classifier: ModelClassifier = async () => null;
    const d = await decideRoute('the thing is being weird again', { classifier, signal: NEVER_ABORT });
    assert.equal(d.source, 'rules');
    assert.equal(d.tier, 'ic'); // ambiguous default
  });

  it('graceful fallback: classifier throws → rules (never propagates)', async () => {
    const classifier: ModelClassifier = async () => {
      throw new Error('router model exploded');
    };
    const d = await decideRoute('it broke after lunch, halp', { classifier, signal: NEVER_ABORT });
    assert.equal(d.source, 'rules');
    assert.equal(d.tier, 'ic');
  });
});
