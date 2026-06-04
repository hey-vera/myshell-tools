/**
 * test/unit/auto-mode.test.ts — unit tests for autoModeForPlans (multi-provider
 * auto-mode resolver) and a smoke test that defaultModeForPlan is still exported.
 *
 * Honesty Contract: no hardcoded percentages, no fabricated data, no mock
 * AI-response phrases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { autoModeForPlans, defaultModeForPlan } from '../../src/core/policy.ts';

// ---------------------------------------------------------------------------
// autoModeForPlans — all spec rules
// ---------------------------------------------------------------------------

describe('autoModeForPlans — max wins (quality-first)', () => {
  it("['max'] → 'quality-first'", () => {
    assert.equal(autoModeForPlans(['max']), 'quality-first');
  });

  it("['Max'] → 'quality-first' (case-insensitive)", () => {
    assert.equal(autoModeForPlans(['Max']), 'quality-first');
  });

  it("['claude max'] → 'quality-first' (substring match)", () => {
    assert.equal(autoModeForPlans(['claude max']), 'quality-first');
  });

  it("['CLAUDE MAX'] → 'quality-first' (case-insensitive substring)", () => {
    assert.equal(autoModeForPlans(['CLAUDE MAX']), 'quality-first');
  });

  it("['free', 'max'] → 'quality-first' (max beats free)", () => {
    assert.equal(autoModeForPlans(['free', 'max']), 'quality-first');
  });

  it("['max', null] → 'quality-first' (null alongside max)", () => {
    assert.equal(autoModeForPlans(['max', null]), 'quality-first');
  });
});

describe('autoModeForPlans — free only (cost-saver)', () => {
  it("['free'] → 'cost-saver'", () => {
    assert.equal(autoModeForPlans(['free']), 'cost-saver');
  });

  it("['Free'] → 'cost-saver' (case-insensitive)", () => {
    assert.equal(autoModeForPlans(['Free']), 'cost-saver');
  });

  it("['claude free'] → 'cost-saver' (substring match)", () => {
    assert.equal(autoModeForPlans(['claude free']), 'cost-saver');
  });

  it("['free', null] → 'cost-saver' (every non-null plan is free)", () => {
    assert.equal(autoModeForPlans(['free', null]), 'cost-saver');
  });
});

describe('autoModeForPlans — balanced (no signal or mixed)', () => {
  it("[] → 'balanced' (no plans)", () => {
    assert.equal(autoModeForPlans([]), 'balanced');
  });

  it("[null, null] → 'balanced' (no non-null plans)", () => {
    assert.equal(autoModeForPlans([null, null]), 'balanced');
  });

  it("[null] → 'balanced' (single null)", () => {
    assert.equal(autoModeForPlans([null]), 'balanced');
  });

  it("['pro'] → 'balanced' (paid but not max or free)", () => {
    assert.equal(autoModeForPlans(['pro']), 'balanced');
  });

  it("['free', 'pro'] → 'balanced' (not every non-null plan is free)", () => {
    assert.equal(autoModeForPlans(['free', 'pro']), 'balanced');
  });

  it("['pro', 'free'] → 'balanced' (order independent)", () => {
    assert.equal(autoModeForPlans(['pro', 'free']), 'balanced');
  });
});

describe('autoModeForPlans — pure (same inputs → same output)', () => {
  it('returns same result for identical inputs called twice', () => {
    const a = autoModeForPlans(['max', null]);
    const b = autoModeForPlans(['max', null]);
    assert.equal(a, b);
  });

  it('does not mutate the input array', () => {
    const input: Array<string | null> = ['max', null, 'free'];
    const copy = [...input];
    autoModeForPlans(input);
    assert.deepEqual(input, copy, 'autoModeForPlans must not mutate its input');
  });
});

// ---------------------------------------------------------------------------
// defaultModeForPlan — still exported and behaves as before (keep it alive)
// ---------------------------------------------------------------------------

describe('defaultModeForPlan — still exported and correct', () => {
  it('null → balanced', () => {
    assert.equal(defaultModeForPlan(null), 'balanced');
  });

  it('undefined → balanced', () => {
    assert.equal(defaultModeForPlan(undefined), 'balanced');
  });

  it('max → quality-first', () => {
    assert.equal(defaultModeForPlan('max'), 'quality-first');
  });

  it('free → cost-saver', () => {
    assert.equal(defaultModeForPlan('free'), 'cost-saver');
  });

  it('pro → balanced', () => {
    assert.equal(defaultModeForPlan('pro'), 'balanced');
  });
});
