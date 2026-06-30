/**
 * test/unit/auto-mode.test.ts — unit tests for autoModeForPlans (multi-provider
 * auto-mode resolver) and a smoke test that defaultModeForPlan is still exported.
 *
 * Honesty Contract: no hardcoded percentages, no fabricated data, no mock
 * AI-response phrases.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  autoModeForPlans,
  autoModeForPlanInfos,
  classifyPlan,
  classifyMaxSubTier,
  describePlanSet,
  planTierLabel,
  planDisplayLabel,
  tunePolicyForMaxSubTier,
  defaultModeForPlan,
  POLICY_PRESETS,
} from '../../src/core/policy.ts';

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

// ---------------------------------------------------------------------------
// classifyPlan — the honest taxonomy
// ---------------------------------------------------------------------------

describe('classifyPlan — observed vs none, kind by substring', () => {
  it('null → unknown / none (never a guess)', () => {
    assert.deepEqual(classifyPlan(null), { raw: null, tier: 'unknown', confidence: 'none' });
  });

  it("'max' → max / observed", () => {
    assert.deepEqual(classifyPlan('max'), { raw: 'max', tier: 'max', confidence: 'observed' });
  });

  it("'claude_max_20x' → max, raw preserved", () => {
    const info = classifyPlan('claude_max_20x');
    assert.equal(info.tier, 'max');
    assert.equal(info.raw, 'claude_max_20x');
    assert.equal(info.confidence, 'observed');
  });

  it("'Pro' → pro (case-insensitive)", () => {
    assert.equal(classifyPlan('Pro').tier, 'pro');
  });

  it("'free' → free", () => {
    assert.equal(classifyPlan('free').tier, 'free');
  });

  it('max is checked before pro (a "max" label never falls to pro)', () => {
    // a hypothetical label containing both should resolve to the stronger kind
    assert.equal(classifyPlan('max-pro-bundle').tier, 'max');
  });

  it('unrecognised but present label → unknown / observed (we saw a plan)', () => {
    const info = classifyPlan('enterprise-x');
    assert.equal(info.tier, 'unknown');
    assert.equal(info.confidence, 'observed');
  });
});

// ---------------------------------------------------------------------------
// autoModeForPlanInfos — strongest KIND wins across the full set
// ---------------------------------------------------------------------------

describe('autoModeForPlanInfos — full-set rules', () => {
  it('any max → quality-first (even mixed with pro/free)', () => {
    const infos = ['max', 'pro', 'free'].map(classifyPlan);
    assert.equal(autoModeForPlanInfos(infos), 'quality-first');
  });

  it('pro present, no max → balanced', () => {
    assert.equal(autoModeForPlanInfos(['pro', 'free'].map(classifyPlan)), 'balanced');
  });

  it('all free → cost-saver', () => {
    assert.equal(autoModeForPlanInfos(['free', 'free'].map(classifyPlan)), 'cost-saver');
  });

  it('no observed plans → balanced (no signal)', () => {
    assert.equal(autoModeForPlanInfos([null, null].map(classifyPlan)), 'balanced');
  });

  it('matches autoModeForPlans for the same raw inputs', () => {
    const plans = ['max', null, 'free'];
    assert.equal(autoModeForPlans(plans), autoModeForPlanInfos(plans.map(classifyPlan)));
  });
});

// ---------------------------------------------------------------------------
// describePlanSet — honest multiset summary (accounts for duplicates)
// ---------------------------------------------------------------------------

describe('describePlanSet — counts and kinds, never overclaims', () => {
  it('no providers → "no plan reported"', () => {
    assert.equal(describePlanSet([]), 'no plan reported');
  });

  it('all null → "no plan reported"', () => {
    assert.equal(describePlanSet([null, null].map(classifyPlan)), 'no plan reported');
  });

  it('multiple Max plans are counted (duplicates accounted for)', () => {
    assert.equal(describePlanSet(['max', 'max'].map(classifyPlan)), '2 Max');
  });

  it('mixed kinds listed strongest-first', () => {
    assert.equal(describePlanSet(['pro', 'max', 'free'].map(classifyPlan)), '1 Max, 1 Pro, 1 Free');
  });

  it('separates providers that reported no plan', () => {
    assert.equal(describePlanSet(['max', null].map(classifyPlan)), '1 Max · 1 reported no plan');
  });
});

describe('planTierLabel', () => {
  it('maps each tier to a title-case label', () => {
    assert.equal(planTierLabel('max'), 'Max');
    assert.equal(planTierLabel('pro'), 'Pro');
    assert.equal(planTierLabel('free'), 'Free');
    assert.equal(planTierLabel('unknown'), 'Unknown');
  });
});

// ---------------------------------------------------------------------------
// Max sub-tier: classification, display, quota-aware auto tuning
// ---------------------------------------------------------------------------

describe('classifyMaxSubTier', () => {
  it('classifies the 5x / 20x markers (substring, case-insensitive)', () => {
    assert.equal(classifyMaxSubTier('max_5x'), 'max_5x');
    assert.equal(classifyMaxSubTier('MAX_20X'), 'max_20x');
    assert.equal(classifyMaxSubTier('default_claude_max_5x'), 'max_5x');
  });

  it('20x is checked before 5x', () => {
    assert.equal(classifyMaxSubTier('max_20x'), 'max_20x');
  });

  it('generic max / non-max / missing → unknown', () => {
    assert.equal(classifyMaxSubTier('max'), 'unknown');
    assert.equal(classifyMaxSubTier('pro'), 'unknown');
    assert.equal(classifyMaxSubTier(null), 'unknown');
    assert.equal(classifyMaxSubTier(undefined), 'unknown');
  });
});

describe('planDisplayLabel — honest about the Max sub-tier', () => {
  it('shows "Max 5x" / "Max 20x" when known', () => {
    assert.equal(planDisplayLabel(classifyPlan('max_5x')), 'Max 5x');
    assert.equal(planDisplayLabel(classifyPlan('max_20x')), 'Max 20x');
  });

  it('plain "Max" when the sub-tier is unknown', () => {
    assert.equal(planDisplayLabel(classifyPlan('max')), 'Max');
  });

  it('non-Max tiers use the plain tier label', () => {
    assert.equal(planDisplayLabel(classifyPlan('pro')), 'Pro');
    assert.equal(planDisplayLabel(classifyPlan('free')), 'Free');
  });
});

describe('describePlanSet — breaks out Max sub-tiers', () => {
  it('shows "1 Max 5x" / "1 Max 20x" when detected', () => {
    assert.equal(describePlanSet(['max_5x'].map(classifyPlan)), '1 Max 5x');
    assert.equal(describePlanSet(['max_20x'].map(classifyPlan)), '1 Max 20x');
  });

  it('orders 20x before 5x before generic Max', () => {
    assert.equal(
      describePlanSet(['max_5x', 'max_20x', 'max'].map(classifyPlan)),
      '1 Max 20x, 1 Max 5x, 1 Max',
    );
  });

  it('plain generic max still summarises as "Max" (back-compat)', () => {
    assert.equal(describePlanSet(['max', 'max'].map(classifyPlan)), '2 Max');
  });
});

describe('tunePolicyForMaxSubTier — quota-aware auto panel width', () => {
  const qf = POLICY_PRESETS['quality-first'];

  it('max_5x narrows the auto panel to 2 providers', () => {
    assert.equal(tunePolicyForMaxSubTier(qf, ['max_5x']).maxPanelProviders, 2);
  });

  it('max_20x keeps the 3-way panel', () => {
    assert.equal(tunePolicyForMaxSubTier(qf, ['max_20x']).maxPanelProviders, 3);
  });

  it('generic max keeps the 3-way panel (fail-soft)', () => {
    assert.equal(tunePolicyForMaxSubTier(qf, ['max']).maxPanelProviders, 3);
  });

  it('a 20x alongside a 5x keeps the wider panel (more headroom wins)', () => {
    assert.equal(tunePolicyForMaxSubTier(qf, ['max_5x', 'max_20x']).maxPanelProviders, 3);
  });

  it('a generic max alongside a 5x keeps the wider panel', () => {
    assert.equal(tunePolicyForMaxSubTier(qf, ['max_5x', 'max']).maxPanelProviders, 3);
  });

  it('no Max signal (pro/free/null) leaves the policy unchanged', () => {
    assert.equal(tunePolicyForMaxSubTier(qf, ['pro']).maxPanelProviders, 3);
    assert.equal(tunePolicyForMaxSubTier(qf, [null]).maxPanelProviders, 3);
  });

  it('does not mutate the shared preset', () => {
    tunePolicyForMaxSubTier(qf, ['max_5x']);
    assert.equal(POLICY_PRESETS['quality-first'].maxPanelProviders, 3);
  });

  it('cost-saver (no panel) max_5x stays as-is — nothing to narrow', () => {
    const cs = POLICY_PRESETS['cost-saver'];
    assert.equal(tunePolicyForMaxSubTier(cs, ['max_5x']).maxPanelProviders, cs.maxPanelProviders);
  });
});
