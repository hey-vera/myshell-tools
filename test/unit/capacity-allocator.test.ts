/**
 * Unit tests for src/core/capacity-allocator.ts
 * Run with: node --experimental-strip-types --test test/unit/capacity-allocator.test.ts
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  autoIntensityForTurn,
  classifyCapacity,
  deriveBaselineOrder,
  deriveLiveProviderOrder,
  legacyModeToIntensity,
  regimeForIntensity,
  concurrencyCeilingForRegime,
  crossGoalCap,
  type CapacityWeight,
} from '../../src/core/capacity-allocator.ts';
import type { ProviderId } from '../../src/providers/port.ts';

function weights(
  entries: ReadonlyArray<readonly [ProviderId, CapacityWeight['tier'], number]>,
): CapacityWeight[] {
  return entries.map(([provider, tier, weight]) => ({
    provider,
    tier,
    weight,
    confidence: tier === 'unknown' ? 'none' : 'observed',
  }));
}

describe('classifyCapacity', () => {
  it('classifies Claude Max 20x, 5x, generic Max, Pro, Free, and unknown honestly', () => {
    assert.deepEqual(classifyCapacity('claude', 'Claude Max 20x'), {
      provider: 'claude',
      tier: 'claude-max-20x',
      weight: 10,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('claude', 'Claude Max 5x'), {
      provider: 'claude',
      tier: 'claude-max-5x',
      weight: 4,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('claude', 'Claude Max'), {
      provider: 'claude',
      tier: 'claude-max-generic',
      weight: 4,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('claude', 'Claude Pro'), {
      provider: 'claude',
      tier: 'paid-standard',
      weight: 1,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('claude', 'Claude Free'), {
      provider: 'claude',
      tier: 'free',
      weight: 0.25,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('claude', null), {
      provider: 'claude',
      tier: 'unknown',
      weight: 1,
      confidence: 'none',
    });
    // Observed but unrecognized label → never promoted by reputation.
    assert.deepEqual(classifyCapacity('claude', 'Claude Ultra'), {
      provider: 'claude',
      tier: 'unknown',
      weight: 1,
      confidence: 'none',
    });
  });

  it('keeps Codex and OpenCode neutral unless an explicit recognized label is observed', () => {
    assert.deepEqual(classifyCapacity('codex', null), {
      provider: 'codex',
      tier: 'unknown',
      weight: 1,
      confidence: 'none',
    });
    assert.deepEqual(classifyCapacity('codex', 'Codex Pro'), {
      provider: 'codex',
      tier: 'paid-standard',
      weight: 1,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('codex', 'Codex High Capacity Pro'), {
      provider: 'codex',
      tier: 'paid-high',
      weight: 5,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('codex', 'Codex Ultra'), {
      provider: 'codex',
      tier: 'unknown',
      weight: 1,
      confidence: 'none',
    });

    assert.deepEqual(classifyCapacity('opencode', 'OpenCode Team'), {
      provider: 'opencode',
      tier: 'paid-standard',
      weight: 1,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('opencode', 'OpenCode Enterprise Business'), {
      provider: 'opencode',
      tier: 'paid-high',
      weight: 3,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('opencode', 'OpenCode Free'), {
      provider: 'opencode',
      tier: 'free',
      weight: 0.25,
      confidence: 'observed',
    });
    assert.deepEqual(classifyCapacity('opencode', 'OpenCode Starter'), {
      provider: 'opencode',
      tier: 'unknown',
      weight: 1,
      confidence: 'none',
    });
  });
});

describe('deriveBaselineOrder', () => {
  it('sorts descending by weight and uses canonical order for ties at every tier', () => {
    const order = deriveBaselineOrder(weights([
      ['codex', 'paid-standard', 1],
      ['opencode', 'paid-standard', 1],
      ['claude', 'claude-max-20x', 10],
    ]));

    assert.deepEqual(order, {
      worker: ['claude', 'codex', 'opencode'],
      ic: ['claude', 'codex', 'opencode'],
      manager: ['claude', 'codex', 'opencode'],
    });
  });

  it('keeps a single provider first and appends the absent canonical tail fail-soft', () => {
    const order = deriveBaselineOrder(weights([
      ['codex', 'paid-standard', 1],
    ]));

    assert.deepEqual(order.worker, ['codex', 'claude', 'opencode']);
    assert.deepEqual(order.ic, ['codex', 'claude', 'opencode']);
    assert.deepEqual(order.manager, ['codex', 'claude', 'opencode']);
  });

  it('returns canonical order for equal or unknown inventories', () => {
    const equal = deriveBaselineOrder(weights([
      ['opencode', 'unknown', 1],
      ['codex', 'unknown', 1],
      ['claude', 'unknown', 1],
    ]));

    assert.deepEqual(equal.worker, ['claude', 'codex', 'opencode']);
  });
});

describe('regimeForIntensity', () => {
  const cases = [
    [1, 'focused'],
    [2, 'pair'],
    [3, 'fleet'],
    [4, 'fleet-hedge'],
    [5, 'fleet-panel'],
  ] as const;
  for (const [level, regime] of cases) {
    it(`maps ${level} to ${regime}`, () => {
      assert.equal(regimeForIntensity(level), regime);
    });
  }
});

describe('concurrencyCeilingForRegime — tuning is a CEILING (never above BASE_ACTIVE_LIMIT=2)', () => {
  const cases = [
    ['focused', 1],
    ['pair', 1],
    ['fleet', 2],
    ['fleet-hedge', 2],
    ['fleet-panel', 2],
  ] as const;
  for (const [regime, ceiling] of cases) {
    it(`${regime} → ${ceiling}`, () => {
      assert.equal(concurrencyCeilingForRegime(regime), ceiling);
    });
  }
});

/**
 * R8.1 production proof: Intensity is the concurrency dial. Changing intensity
 * must change the tuning ceiling that feeds crossGoalCap (the same composition
 * path menu.ts uses for multi-goal scheduling). Pure helpers are the production
 * composition surface for capacity-allocator — no orchestration-profile layer.
 */
describe('R8.1 dial honesty — intensity affects concurrency ceiling / crossGoalCap', () => {
  it('low intensity (1–2) ceilings crossGoalCap at 1 even with headroom elsewhere', () => {
    for (const intensity of [1, 2] as const) {
      const tuningCeiling = concurrencyCeilingForRegime(regimeForIntensity(intensity));
      assert.equal(tuningCeiling, 1, `intensity ${intensity} → ceiling 1`);
      assert.equal(
        crossGoalCap({
          activeLimit: 2,
          tuningCeiling,
          callBudgetCeiling: 2,
          genuineParallelGoalCount: 3,
        }),
        1,
        `intensity ${intensity} must cap concurrent goals at 1`,
      );
    }
  });

  it('fleet intensity (3–5) allows crossGoalCap of 2 when other ceilings allow', () => {
    for (const intensity of [3, 4, 5] as const) {
      const tuningCeiling = concurrencyCeilingForRegime(regimeForIntensity(intensity));
      assert.equal(tuningCeiling, 2, `intensity ${intensity} → ceiling 2`);
      assert.equal(
        crossGoalCap({
          activeLimit: 2,
          tuningCeiling,
          callBudgetCeiling: 2,
          genuineParallelGoalCount: 3,
        }),
        2,
        `intensity ${intensity} must allow concurrent goals up to 2`,
      );
    }
  });

  it('raising intensity from 1 to 3 raises the crossGoalCap when only tuning differs', () => {
    // Same active/budget/demand — only intensity-derived tuningCeiling changes.
    // Mirrors menu.ts: tuningCeiling = concurrencyCeilingForRegime(regimeForIntensity(...))
    // then maxActive = min(tuningCeiling, callBudgetCeiling, genuineParallelGoalCount).
    const lowCeiling = concurrencyCeilingForRegime(regimeForIntensity(1));
    const highCeiling = concurrencyCeilingForRegime(regimeForIntensity(3));
    assert.equal(lowCeiling, 1);
    assert.equal(highCeiling, 2);
    assert.equal(
      crossGoalCap({
        activeLimit: 2,
        tuningCeiling: lowCeiling,
        callBudgetCeiling: 2,
        genuineParallelGoalCount: 2,
      }),
      1,
    );
    assert.equal(
      crossGoalCap({
        activeLimit: 2,
        tuningCeiling: highCeiling,
        callBudgetCeiling: 2,
        genuineParallelGoalCount: 2,
      }),
      2,
    );
  });

  it('legacy Mode still projects onto Intensity (Mode→Intensity bridge, not Speed dial)', () => {
    assert.equal(legacyModeToIntensity('cost-saver'), 1);
    assert.equal(
      concurrencyCeilingForRegime(regimeForIntensity(legacyModeToIntensity('cost-saver'))),
      1,
    );
    assert.equal(legacyModeToIntensity('balanced'), 3);
    assert.equal(
      concurrencyCeilingForRegime(regimeForIntensity(legacyModeToIntensity('balanced'))),
      2,
    );
    assert.equal(legacyModeToIntensity('quality-first'), 5);
    assert.equal(
      concurrencyCeilingForRegime(regimeForIntensity(legacyModeToIntensity('quality-first'))),
      2,
    );
  });
});

describe('crossGoalCap — load-bearing min of every ceiling + demand', () => {
  it('returns the minimum of the four inputs', () => {
    assert.equal(
      crossGoalCap({
        activeLimit: 2,
        tuningCeiling: 2,
        callBudgetCeiling: 2,
        genuineParallelGoalCount: 2,
      }),
      2,
    );
  });

  it('a low provider ceiling caps it to 1 regardless of high tuning/budget/demand', () => {
    assert.equal(
      crossGoalCap({
        activeLimit: 1,
        tuningCeiling: 2,
        callBudgetCeiling: 2,
        genuineParallelGoalCount: 3,
      }),
      1,
    );
  });

  it('a budget of 1 caps it to 1', () => {
    assert.equal(
      crossGoalCap({
        activeLimit: 2,
        tuningCeiling: 2,
        callBudgetCeiling: 1,
        genuineParallelGoalCount: 2,
      }),
      1,
    );
  });

  it('the birdhouse-at-max-tuning case: max regime + high budget + 3 providers but ONE genuine goal ⇒ 1', () => {
    assert.equal(
      crossGoalCap({
        activeLimit: 2, // planSchedule already capped at BASE_ACTIVE_LIMIT
        tuningCeiling: concurrencyCeilingForRegime('fleet-panel'), // 2
        callBudgetCeiling: 2,
        genuineParallelGoalCount: 1, // only one independent runnable goal
      }),
      1,
    );
  });

  it('no single high signal can cancel a lower quota (zero demand ⇒ 0)', () => {
    assert.equal(
      crossGoalCap({
        activeLimit: 2,
        tuningCeiling: 2,
        callBudgetCeiling: 2,
        genuineParallelGoalCount: 0,
      }),
      0,
    );
  });

  it('garbage inputs degrade to 0 (safe floor, never unbounded)', () => {
    assert.equal(
      crossGoalCap({
        activeLimit: NaN,
        tuningCeiling: 2,
        callBudgetCeiling: 2,
        genuineParallelGoalCount: 2,
      }),
      0,
    );
    assert.equal(
      crossGoalCap({
        activeLimit: 2,
        tuningCeiling: -5,
        callBudgetCeiling: 2,
        genuineParallelGoalCount: 2,
      }),
      0,
    );
  });
});

describe('legacyModeToIntensity', () => {
  it('maps all legacy modes and applies panel and hedge floors', () => {
    assert.equal(legacyModeToIntensity('cost-saver'), 1);
    assert.equal(legacyModeToIntensity('balanced'), 3);
    assert.equal(legacyModeToIntensity('quality-first'), 5);
    assert.equal(legacyModeToIntensity('cost-saver', { hedge: true }), 4);
    assert.equal(legacyModeToIntensity('cost-saver', { panel: true }), 5);
    assert.equal(legacyModeToIntensity('cost-saver', { panel: true, hedge: true }), 5);
    assert.equal(legacyModeToIntensity('balanced', { hedge: true }), 4);
  });
});

describe('autoIntensityForTurn', () => {
  it('is efficiency-first, escalates on difficulty, and never returns 5', () => {
    // Genuinely-trivial fast path earns the cheapest regime.
    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'low',
      depth: 0,
      escalate: false,
    }), 1);

    // A worker/low turn with depth 1 is no longer trivial.
    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'low',
      depth: 1,
      escalate: false,
    }), 2);

    assert.equal(autoIntensityForTurn({
      tier: 'ic',
      risk: 'medium',
      depth: 1,
      escalate: false,
    }), 2);

    assert.equal(autoIntensityForTurn({
      tier: 'manager',
      risk: 'medium',
      depth: 1,
      escalate: false,
    }), 3);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'low',
      depth: 2,
      escalate: false,
    }), 3);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'high',
      depth: 0,
      escalate: false,
    }), 4);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'medium',
      depth: 0,
      escalate: true,
    }), 4);

    assert.equal(autoIntensityForTurn({
      tier: 'manager',
      risk: 'critical',
      depth: 1,
      escalate: false,
    }), 4);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'high',
      depth: 0,
      escalate: false,
      needsReview: true,
    }), 4);

    assert.notEqual(autoIntensityForTurn({
      tier: 'worker',
      risk: 'critical',
      depth: 2,
      escalate: true,
      needsReview: true,
    }), 5);
  });
});

describe('deriveLiveProviderOrder', () => {
  const baseline = {
    worker: ['claude', 'codex', 'opencode'],
    ic: ['claude', 'codex', 'opencode'],
    manager: ['claude', 'codex', 'opencode'],
  } as const;

  it('returns the baseline order unchanged on cold start and with absent consumption', () => {
    const order = deriveLiveProviderOrder({
      baselineOrderByTier: baseline,
      capacityWeightByProvider: { claude: 10, codex: 1, opencode: 1 },
      sessionTokensByProvider: {},
      coolingProviders: new Set(),
    });

    assert.deepEqual(order.worker, ['claude', 'codex', 'opencode']);
    assert.deepEqual(order.ic, ['claude', 'codex', 'opencode']);
    assert.deepEqual(order.manager, ['claude', 'codex', 'opencode']);
  });

  it('shifts by weighted fair normalized load', () => {
    const equalTokens = deriveLiveProviderOrder({
      baselineOrderByTier: baseline,
      capacityWeightByProvider: { claude: 10, codex: 1, opencode: 1 },
      sessionTokensByProvider: { claude: 10, codex: 10, opencode: 100 },
      coolingProviders: new Set(),
    });
    assert.ok(
      equalTokens.worker.indexOf('claude') < equalTokens.worker.indexOf('codex'),
    );

    const claudeOver10x = deriveLiveProviderOrder({
      baselineOrderByTier: baseline,
      capacityWeightByProvider: { claude: 10, codex: 1, opencode: 1 },
      sessionTokensByProvider: { claude: 11, codex: 1, opencode: 100 },
      coolingProviders: new Set(),
    });
    assert.ok(
      claudeOver10x.worker.indexOf('codex') < claudeOver10x.worker.indexOf('claude'),
    );
  });

  it('preserves the composed order on exact normalized-load ties', () => {
    const order = deriveLiveProviderOrder({
      baselineOrderByTier: baseline,
      capacityWeightByProvider: { claude: 10, codex: 1, opencode: 1 },
      sessionTokensByProvider: { claude: 10, codex: 1, opencode: 100 },
      coolingProviders: new Set(),
    });

    // claude and codex both have normalized load 1 → index tie-break keeps
    // claude (index 0) before codex (index 1); opencode (load 100) last.
    assert.deepEqual(order.worker, ['claude', 'codex', 'opencode']);
  });

  it('moves cooling providers to the tail, preserves relative order, and keeps all-cooled deterministic', () => {
    const cooled = deriveLiveProviderOrder({
      baselineOrderByTier: baseline,
      capacityWeightByProvider: { claude: 10, codex: 1, opencode: 1 },
      sessionTokensByProvider: { claude: 100, codex: 1, opencode: 0 },
      coolingProviders: new Set(['opencode', 'claude']),
    });
    assert.deepEqual(cooled.worker, ['codex', 'opencode', 'claude']);

    const allCooled = deriveLiveProviderOrder({
      baselineOrderByTier: baseline,
      capacityWeightByProvider: { claude: 10, codex: 1, opencode: 1 },
      sessionTokensByProvider: { claude: 100, codex: 1, opencode: 0 },
      coolingProviders: new Set(['claude', 'codex', 'opencode']),
    });
    assert.deepEqual(allCooled.worker, ['opencode', 'codex', 'claude']);
  });

  it('leaves a single provider unchanged', () => {
    const order = deriveLiveProviderOrder({
      baselineOrderByTier: {
        worker: ['codex'],
        ic: ['codex'],
        manager: ['codex'],
      },
      capacityWeightByProvider: { codex: 1 },
      sessionTokensByProvider: { codex: 999 },
      coolingProviders: new Set(['codex']),
    });

    assert.deepEqual(order, {
      worker: ['codex'],
      ic: ['codex'],
      manager: ['codex'],
    });
  });
});
