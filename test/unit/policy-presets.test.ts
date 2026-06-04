/**
 * test/unit/policy-presets.test.ts — unit tests for POLICY_PRESETS.
 *
 * Verifies that all three named presets exist, are valid Policies, and that
 * cost-saver escalates less aggressively than quality-first.
 *
 * Honesty Contract: no hardcoded percentages, no fabricated data, no mock
 * AI-response phrases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { POLICY_PRESETS, DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Policy } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

function assertValidPolicy(policy: Policy, label: string): void {
  assert.ok(
    policy.maxAttempts >= 1,
    `${label}: maxAttempts must be >= 1, got ${policy.maxAttempts}`,
  );

  for (const risk of RISK_LEVELS) {
    const threshold = policy.escalateBelowConfidence[risk];
    assert.ok(
      typeof threshold === 'number',
      `${label}: escalateBelowConfidence.${risk} must be a number`,
    );
    assert.ok(
      threshold >= 0 && threshold <= 1,
      `${label}: escalateBelowConfidence.${risk} must be in [0, 1], got ${threshold}`,
    );
  }

  const tiers = ['worker', 'ic', 'manager'] as const;
  for (const tier of tiers) {
    const order = policy.providerOrderByTier[tier];
    assert.ok(
      Array.isArray(order) && order.length > 0,
      `${label}: providerOrderByTier.${tier} must be a non-empty array`,
    );
  }
}

// ---------------------------------------------------------------------------
// POLICY_PRESETS — presence
// ---------------------------------------------------------------------------

describe('POLICY_PRESETS — all three modes exist', () => {
  it('has cost-saver preset', () => {
    assert.ok(POLICY_PRESETS['cost-saver'] !== undefined);
  });

  it('has balanced preset', () => {
    assert.ok(POLICY_PRESETS['balanced'] !== undefined);
  });

  it('has quality-first preset', () => {
    assert.ok(POLICY_PRESETS['quality-first'] !== undefined);
  });
});

// ---------------------------------------------------------------------------
// POLICY_PRESETS — validity
// ---------------------------------------------------------------------------

describe('POLICY_PRESETS — each preset is a valid Policy', () => {
  it('cost-saver is a valid Policy', () => {
    assertValidPolicy(POLICY_PRESETS['cost-saver'], 'cost-saver');
  });

  it('balanced is a valid Policy', () => {
    assertValidPolicy(POLICY_PRESETS['balanced'], 'balanced');
  });

  it('quality-first is a valid Policy', () => {
    assertValidPolicy(POLICY_PRESETS['quality-first'], 'quality-first');
  });
});

// ---------------------------------------------------------------------------
// POLICY_PRESETS — semantic ordering
// ---------------------------------------------------------------------------

describe('POLICY_PRESETS — cost-saver escalates less than quality-first', () => {
  for (const risk of RISK_LEVELS) {
    it(`cost-saver threshold for "${risk}" risk is strictly lower than quality-first`, () => {
      const costSaver = POLICY_PRESETS['cost-saver'].escalateBelowConfidence[risk];
      const qualityFirst = POLICY_PRESETS['quality-first'].escalateBelowConfidence[risk];
      assert.ok(
        costSaver < qualityFirst,
        `cost-saver.${risk} (${costSaver}) must be < quality-first.${risk} (${qualityFirst})`,
      );
    });
  }
});

describe('POLICY_PRESETS — balanced equals DEFAULT_POLICY', () => {
  it('balanced and DEFAULT_POLICY are the same object reference (or deep-equal)', () => {
    // Either they share the same reference (our current impl) or they are structurally equal.
    const balanced = POLICY_PRESETS['balanced'];
    const isRef = balanced === DEFAULT_POLICY;
    if (!isRef) {
      assert.deepEqual(balanced, DEFAULT_POLICY);
    } else {
      assert.ok(isRef);
    }
  });
});

// ---------------------------------------------------------------------------
// POLICY_PRESETS — no fabricated / forbidden values
// ---------------------------------------------------------------------------

describe('POLICY_PRESETS — honesty contract', () => {
  it('no preset contains a digit-% literal in any serialized threshold', () => {
    for (const [name, preset] of Object.entries(POLICY_PRESETS)) {
      const serialized = JSON.stringify(preset);
      assert.ok(
        !/\d+%/.test(serialized),
        `${name}: serialized preset must not contain a digit-% literal`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// POLICY_PRESETS — reviewPolicy field
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POLICY_PRESETS — maxTier ceiling (cost guard against auto-running manager)
// ---------------------------------------------------------------------------

describe('POLICY_PRESETS — maxTier ceiling', () => {
  it("cost-saver has maxTier:'ic' (never runs the manager model)", () => {
    assert.equal(POLICY_PRESETS['cost-saver'].maxTier, 'ic');
  });

  it("balanced / DEFAULT_POLICY has maxTier:'ic' (manager is an explicit opt-in, not a default)", () => {
    assert.equal(POLICY_PRESETS['balanced'].maxTier, 'ic');
    assert.equal(DEFAULT_POLICY.maxTier, 'ic');
  });

  it("quality-first has maxTier:'manager' (opens the manager tier)", () => {
    assert.equal(POLICY_PRESETS['quality-first'].maxTier, 'manager');
  });
});

// ---------------------------------------------------------------------------
// POLICY_PRESETS — flagship admission (replaces the retired maxCostUsd guard)
// ---------------------------------------------------------------------------

describe('POLICY_PRESETS — flagshipAdmission', () => {
  it("cost-saver is 'never-auto' (and never spends a flagship attempt)", () => {
    assert.equal(POLICY_PRESETS['cost-saver'].flagshipAdmission, 'never-auto');
    assert.equal(POLICY_PRESETS['cost-saver'].maxFlagshipAttemptsPerTurn, 0);
  });

  it("balanced / DEFAULT_POLICY is 'adaptive' with one flagship pass per turn", () => {
    assert.equal(POLICY_PRESETS['balanced'].flagshipAdmission, 'adaptive');
    assert.equal(DEFAULT_POLICY.flagshipAdmission, 'adaptive');
    assert.equal(DEFAULT_POLICY.maxFlagshipAttemptsPerTurn, 1);
  });

  it("quality-first is 'always-eligible'", () => {
    assert.equal(POLICY_PRESETS['quality-first'].flagshipAdmission, 'always-eligible');
  });

  it('the dollar budget guard is retired — no preset carries maxCostUsd', () => {
    for (const mode of ['cost-saver', 'balanced', 'quality-first'] as const) {
      assert.equal(
        'maxCostUsd' in POLICY_PRESETS[mode],
        false,
        `${mode} must not carry the retired maxCostUsd field`,
      );
    }
  });
});

describe('POLICY_PRESETS — reviewPolicy field', () => {
  it("cost-saver has reviewPolicy:'critical-only'", () => {
    assert.equal(
      POLICY_PRESETS['cost-saver'].reviewPolicy,
      'critical-only',
      "cost-saver preset must have reviewPolicy:'critical-only' to reduce spend",
    );
  });

  it("balanced has reviewPolicy:'auto' (via DEFAULT_POLICY)", () => {
    assert.equal(
      POLICY_PRESETS['balanced'].reviewPolicy,
      'auto',
      "balanced preset must have reviewPolicy:'auto'",
    );
  });

  it("quality-first has reviewPolicy:'auto'", () => {
    assert.equal(
      POLICY_PRESETS['quality-first'].reviewPolicy,
      'auto',
      "quality-first preset must have reviewPolicy:'auto'",
    );
  });

  it('DEFAULT_POLICY has reviewPolicy explicitly set to auto', () => {
    assert.equal(
      DEFAULT_POLICY.reviewPolicy,
      'auto',
      "DEFAULT_POLICY must have reviewPolicy:'auto'",
    );
  });
});
