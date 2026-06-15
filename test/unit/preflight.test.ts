/**
 * test/unit/preflight.test.ts — the PURE unified-preflight helpers (rank-7),
 * which live in core/router.ts (its natural home + an already-imported module, so
 * they satisfy the no-orphan arch guard + knip without an orphan file).
 *
 * Covers: combineRoute (the monotonic combine — tier may raise, risk is NEVER
 * model-driven, plan defaults false, source flips on a tier hint, absent hints →
 * the deterministic decideRoute-fallback decision) and unifiedPreflightApplies
 * (the §A.1 predicate). All pure — no model, no I/O. Default-off: nothing in src
 * calls these yet, so they change ZERO live behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { combineRoute, unifiedPreflightApplies } from '../../src/core/router.ts';
import type { Classification } from '../../src/core/types.ts';

const DET = (
  tier: Classification['tier'],
  risk: Classification['risk'] = 'low',
): Classification => ({ tier, risk, rationale: `tier: ${tier}; risk: ${risk}` });

// ---------------------------------------------------------------------------
// combineRoute — the monotonic combine (§B)
// ---------------------------------------------------------------------------

describe('combineRoute', () => {
  it('no hints → deterministic decision, source "rules" (== decideRoute fallback)', () => {
    const det = DET('ic', 'medium');
    const out = combineRoute(det, {});
    assert.deepEqual(out, {
      tier: 'ic',
      risk: 'medium',
      plan: false,
      rationale: 'tier: ic; risk: medium',
      source: 'rules',
    });
  });

  it('model tier hint sets the tier and flips source to "model"', () => {
    const det = DET('worker', 'low');
    const out = combineRoute(det, { routeTier: 'manager' });
    assert.equal(out.tier, 'manager');
    assert.equal(out.source, 'model');
    assert.match(out.rationale, /tier: manager \(intent preflight\)/);
    assert.match(out.rationale, /risk: low/);
  });

  it('a model tier hint may RAISE the tier above the deterministic choice', () => {
    const det = DET('worker', 'low');
    assert.equal(combineRoute(det, { routeTier: 'ic' }).tier, 'ic');
    assert.equal(combineRoute(det, { routeTier: 'manager' }).tier, 'manager');
  });

  it('risk is ALWAYS det.risk — a hint can never lower (or touch) it', () => {
    // critical-risk task stays critical regardless of the tier the model suggests.
    const det = DET('manager', 'critical');
    assert.equal(combineRoute(det, { routeTier: 'worker' }).risk, 'critical');
    assert.equal(combineRoute(det, { routeTier: 'ic', routePlan: true }).risk, 'critical');
    assert.equal(combineRoute(det, {}).risk, 'critical');
  });

  it('plan = the routePlan hint, defaulting false when absent', () => {
    const det = DET('ic');
    assert.equal(combineRoute(det, {}).plan, false);
    assert.equal(combineRoute(det, { routePlan: false }).plan, false);
    assert.equal(combineRoute(det, { routeTier: 'ic', routePlan: true }).plan, true);
  });

  it('routePlan alone (no tier) does NOT flip source to "model"', () => {
    const out = combineRoute(DET('worker'), { routePlan: true });
    assert.equal(out.source, 'rules');
    assert.equal(out.tier, 'worker');
    assert.equal(out.plan, true);
  });
});

// ---------------------------------------------------------------------------
// unifiedPreflightApplies — the §A.1 predicate
// ---------------------------------------------------------------------------

describe('unifiedPreflightApplies', () => {
  it('true ONLY when gate on AND intent scheduled AND extractor wired', () => {
    assert.equal(
      unifiedPreflightApplies({ gateOn: true, runIntentScheduled: true, hasExtractor: true }),
      true,
    );
  });

  it('false if the gate is off (default-off neutrality)', () => {
    assert.equal(
      unifiedPreflightApplies({ gateOn: false, runIntentScheduled: true, hasExtractor: true }),
      false,
    );
  });

  it('false if the intent pass is not already scheduled (never ADDS a call)', () => {
    assert.equal(
      unifiedPreflightApplies({ gateOn: true, runIntentScheduled: false, hasExtractor: true }),
      false,
    );
  });

  it('false if no extractor is wired', () => {
    assert.equal(
      unifiedPreflightApplies({ gateOn: true, runIntentScheduled: true, hasExtractor: false }),
      false,
    );
  });
});
