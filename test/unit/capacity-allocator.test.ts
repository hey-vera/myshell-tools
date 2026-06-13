/**
 * Unit tests for src/core/capacity-allocator.ts
 * Run with: node --experimental-strip-types --test test/unit/capacity-allocator.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoIntensityForTurn,
  classifyCapacity,
  deriveBaselineOrder,
  deriveLiveProviderOrder,
  legacyModeToIntensity,
  regimeForIntensity,
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
    [2, 'focused'],
    [3, 'pair'],
    [4, 'pair'],
    [5, 'fleet'],
    [6, 'fleet'],
    [7, 'fleet-hedge'],
    [8, 'fleet-hedge'],
    [9, 'fleet-panel'],
    [10, 'fleet-panel'],
  ] as const;
  for (const [level, regime] of cases) {
    it(`maps ${level} to ${regime}`, () => {
      assert.equal(regimeForIntensity(level), regime);
    });
  }
});

describe('legacyModeToIntensity', () => {
  it('maps all legacy modes and applies panel and hedge floors', () => {
    assert.equal(legacyModeToIntensity('cost-saver'), 2);
    assert.equal(legacyModeToIntensity('balanced'), 6);
    assert.equal(legacyModeToIntensity('quality-first'), 10);
    assert.equal(legacyModeToIntensity('cost-saver', { hedge: true }), 4);
    assert.equal(legacyModeToIntensity('cost-saver', { panel: true }), 5);
    assert.equal(legacyModeToIntensity('cost-saver', { panel: true, hedge: true }), 5);
    assert.equal(legacyModeToIntensity('balanced', { panel: true, hedge: true }), 6);
  });
});

describe('autoIntensityForTurn', () => {
  it('is efficiency-first, escalates on difficulty, and never returns 10', () => {
    // Genuinely-trivial fast path earns the cheapest regime (Focused/2).
    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'low',
      depth: 0,
      escalate: false,
    }), 2);

    // A worker/low turn with ANY depth is no longer trivial → ordinary (4).
    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'low',
      depth: 1,
      escalate: false,
    }), 4);

    assert.equal(autoIntensityForTurn({
      tier: 'ic',
      risk: 'medium',
      depth: 1,
      escalate: false,
    }), 4);

    assert.equal(autoIntensityForTurn({
      tier: 'manager',
      risk: 'medium',
      depth: 1,
      escalate: false,
    }), 6);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'low',
      depth: 2,
      escalate: false,
    }), 6);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'high',
      depth: 0,
      escalate: false,
    }), 8);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'medium',
      depth: 0,
      escalate: true,
    }), 8);

    assert.equal(autoIntensityForTurn({
      tier: 'manager',
      risk: 'critical',
      depth: 1,
      escalate: false,
    }), 9);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'critical',
      depth: 2,
      escalate: false,
    }), 9);

    assert.equal(autoIntensityForTurn({
      tier: 'worker',
      risk: 'high',
      depth: 0,
      escalate: false,
      needsReview: true,
    }), 9);

    // Never selects full-width 10 (that is an explicit user choice).
    assert.ok(autoIntensityForTurn({
      tier: 'worker',
      risk: 'critical',
      depth: 2,
      escalate: true,
      needsReview: true,
    }) < 10);
  });
});

describe('deriveLiveProviderOrder', () => {
  const baseline = {
    worker: ['claude', 'codex', 'opencode'],
    ic: ['claude', 'codex', 'opencode'],
    manager: ['claude', 'codex', 'opencode'],
  } as const;

  it('returns the step-a order unchanged on cold start and with absent consumption', () => {
    const order = deriveLiveProviderOrder({
      baselineOrderByTier: baseline,
      capacityWeightByProvider: { claude: 10, codex: 1, opencode: 1 },
      sessionTokensByProvider: {},
      learnedOutcomeOrderByTier: {
        worker: ['codex', 'claude'],
      },
      coolingProviders: new Set(),
    });

    assert.deepEqual(order.worker, ['codex', 'claude', 'opencode']);
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
      learnedOutcomeOrderByTier: {
        worker: ['codex', 'claude', 'opencode'],
      },
      coolingProviders: new Set(),
    });

    assert.deepEqual(order.worker, ['codex', 'claude', 'opencode']);
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
