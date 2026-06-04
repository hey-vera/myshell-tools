/**
 * test/unit/flagship.test.ts — unit tests for authorizeTier (adaptive flagship
 * admission). Covers the matrix from the GPT-5.5 design review: Balanced earns
 * manager only when justified + within budget + not vetoed by an observed free
 * plan; Efficient never auto-opens; Max always eligible; the maxTier fallback for
 * policies that predate flagshipAdmission; and the Honesty Contract (no fabricated
 * plan signal opens or closes the gate).
 *
 * Pure-function tests: no I/O, explicit fixtures only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { authorizeTier } from '../../src/core/flagship.ts';
import type { FlagshipContext, FlagshipTrigger } from '../../src/core/flagship.ts';
import { POLICY_PRESETS } from '../../src/core/policy.ts';
import type { PlanInfo } from '../../src/core/policy.ts';
import type { Assessment, Classification, Policy, Risk, Tier } from '../../src/core/types.ts';

function classification(risk: Risk, tier: Tier = 'ic'): Classification {
  return { tier, risk, rationale: 'test' };
}

function assessment(over: Partial<Assessment> = {}): Assessment {
  return { confidence: 0.9, escalate: false, reason: 'test', needsReview: false, ...over };
}

function ctx(over: Partial<FlagshipContext> & { policy: Policy }): FlagshipContext {
  return {
    requestedTier: 'manager',
    currentTier: 'ic',
    classification: classification('low'),
    flagshipAttemptsThisTurn: 0,
    trigger: 'confidence' as FlagshipTrigger,
    ...over,
  };
}

const BALANCED = POLICY_PRESETS['balanced'];
const EFFICIENT = POLICY_PRESETS['cost-saver'];
const MAX = POLICY_PRESETS['quality-first'];

const planInfo = (tier: PlanInfo['tier'], confidence: PlanInfo['confidence'] = 'observed'): PlanInfo => ({
  raw: tier,
  tier,
  confidence,
});

describe('authorizeTier — non-manager requests always pass', () => {
  for (const t of ['worker', 'ic'] as const) {
    it(`${t} request is allowed regardless of policy`, () => {
      const d = authorizeTier(ctx({ policy: EFFICIENT, requestedTier: t }));
      assert.equal(d.allowed, true);
      assert.equal(d.tier, t);
    });
  }
});

describe('authorizeTier — Max (always-eligible)', () => {
  it('grants manager even on a low-risk turn', () => {
    const d = authorizeTier(ctx({ policy: MAX, classification: classification('low'), trigger: 'initial' }));
    assert.equal(d.allowed, true);
    assert.equal(d.tier, 'manager');
  });
});

describe('authorizeTier — Efficient (never-auto)', () => {
  it('denies manager even on a critical-risk turn', () => {
    const d = authorizeTier(ctx({ policy: EFFICIENT, classification: classification('critical') }));
    assert.equal(d.allowed, false);
    assert.equal(d.tier, 'ic');
  });
});

describe('authorizeTier — Balanced (adaptive)', () => {
  it('admits manager on a high-risk turn', () => {
    const d = authorizeTier(ctx({ policy: BALANCED, classification: classification('high'), trigger: 'initial' }));
    assert.equal(d.allowed, true);
    assert.equal(d.tier, 'manager');
  });

  it('admits manager on a critical-risk turn', () => {
    const d = authorizeTier(ctx({ policy: BALANCED, classification: classification('critical') }));
    assert.equal(d.allowed, true);
  });

  it('stays at IC on a low-risk initial route (no manager-first)', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('low', 'manager'), trigger: 'initial' }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.tier, 'ic');
  });

  it('admits manager when the model self-reports escalate', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('medium'), assessment: assessment({ escalate: true }), trigger: 'initial' }),
    );
    assert.equal(d.allowed, true);
  });

  it('admits manager when parsed confidence is below the risk threshold', () => {
    // medium threshold in balanced is 0.5; 0.3 is below it.
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('medium'), assessment: assessment({ confidence: 0.3 }), trigger: 'initial' }),
    );
    assert.equal(d.allowed, true);
  });

  it('admits manager on a reviewer escalation trigger', () => {
    const d = authorizeTier(ctx({ policy: BALANCED, classification: classification('low'), trigger: 'review' }));
    assert.equal(d.allowed, true);
  });

  it('admits manager on an execution-failure trigger (all vendors at tier failed)', () => {
    const d = authorizeTier(ctx({ policy: BALANCED, classification: classification('low'), trigger: 'failure' }));
    assert.equal(d.allowed, true);
  });

  it('denies a low-risk, high-confidence turn that is not otherwise justified', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('low'), assessment: assessment({ confidence: 0.95 }), trigger: 'initial' }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.tier, 'ic');
  });

  it('denies once the per-turn manager-attempt budget is spent', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('critical'), flagshipAttemptsThisTurn: 1 }),
    );
    assert.equal(d.allowed, false);
  });
});

describe('authorizeTier — Balanced plan veto (Honesty Contract)', () => {
  it('vetoes the flagship when the only observed plan is free', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('high'), planInfos: { claude: planInfo('free') } }),
    );
    assert.equal(d.allowed, false);
    assert.equal(d.tier, 'ic');
  });

  it('admits the flagship when an observed plan is max', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('high'), planInfos: { claude: planInfo('max') } }),
    );
    assert.equal(d.allowed, true);
  });

  it('does NOT veto on an unknown plan (no fabricated free signal)', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('high'), planInfos: { claude: planInfo('unknown') } }),
    );
    assert.equal(d.allowed, true);
  });

  it('ignores a non-observed (confidence none) plan for the veto', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('high'), planInfos: { codex: planInfo('free', 'none') } }),
    );
    // confidence 'none' is not an observed free plan → no veto
    assert.equal(d.allowed, true);
  });

  it('admits when free coexists with an observed max (not every observed plan is free)', () => {
    const d = authorizeTier(
      ctx({ policy: BALANCED, classification: classification('high'), planInfos: { claude: planInfo('max'), codex: planInfo('free') } }),
    );
    assert.equal(d.allowed, true);
  });
});

describe('authorizeTier — maxTier fallback (policies predating flagshipAdmission)', () => {
  // Explicit objects WITHOUT flagshipAdmission (exactOptionalPropertyTypes forbids
  // setting it to undefined) — these model a config that predates the new field.
  const legacyBase: Policy = {
    maxAttempts: 3,
    maxCostUsd: 2.0,
    escalateBelowConfidence: { low: 0.4, medium: 0.5, high: 0.7, critical: 0.8 },
    providerOrderByTier: { worker: ['claude'], ic: ['claude'], manager: ['claude'] },
    reviewPolicy: 'auto',
  };
  const legacyCapped: Policy = { ...legacyBase, maxTier: 'ic' };
  const legacyOpen: Policy = { ...legacyBase, maxTier: 'manager' };

  it("maxTier 'ic' with no flagshipAdmission behaves as never-auto", () => {
    const d = authorizeTier(ctx({ policy: legacyCapped, classification: classification('critical') }));
    assert.equal(d.allowed, false);
  });

  it("maxTier 'manager' with no flagshipAdmission behaves as always-eligible", () => {
    const d = authorizeTier(ctx({ policy: legacyOpen, classification: classification('low'), trigger: 'initial' }));
    assert.equal(d.allowed, true);
  });
});
