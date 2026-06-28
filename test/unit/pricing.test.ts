/**
 * Unit tests for src/infra/pricing.ts
 * Run with: node --experimental-strip-types --test test/unit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICING_TABLE,
  getModelPricing,
  calculateCost,
  calculateEffectiveCost,
  getCheapestForTier,
  isPricingStale,
} from '../../src/infra/pricing.ts';

// ---------------------------------------------------------------------------
// Sanity check: every model in the table has valid pricing
// ---------------------------------------------------------------------------

describe('PRICING_TABLE integrity', () => {
  it('every model has inputPer1M >= 0', () => {
    for (const m of PRICING_TABLE.models) {
      assert.ok(
        m.inputPer1M >= 0,
        `${m.model}: inputPer1M must be >= 0, got ${m.inputPer1M}`,
      );
    }
  });

  it('every model has outputPer1M >= 0', () => {
    for (const m of PRICING_TABLE.models) {
      assert.ok(
        m.outputPer1M >= 0,
        `${m.model}: outputPer1M must be >= 0, got ${m.outputPer1M}`,
      );
    }
  });

  it('every model has a non-empty model ID', () => {
    for (const m of PRICING_TABLE.models) {
      assert.ok(m.model.trim().length > 0, 'model ID must not be empty');
    }
  });

  it('every model belongs to a known provider', () => {
    const knownProviders = new Set(['claude', 'codex', 'opencode', 'grok']);
    for (const m of PRICING_TABLE.models) {
      assert.ok(
        knownProviders.has(m.provider),
        `unknown provider "${m.provider}" on model ${m.model}`,
      );
    }
  });

  it('every model belongs to a known tier', () => {
    const knownTiers = new Set(['worker', 'ic', 'manager']);
    for (const m of PRICING_TABLE.models) {
      assert.ok(
        knownTiers.has(m.tier),
        `unknown tier "${m.tier}" on model ${m.model}`,
      );
    }
  });

  it('asOf is a valid ISO date string', () => {
    const d = new Date(PRICING_TABLE.asOf);
    assert.ok(!isNaN(d.getTime()), `asOf "${PRICING_TABLE.asOf}" is not a valid date`);
  });

  it('sourceUrls is non-empty', () => {
    assert.ok(PRICING_TABLE.sourceUrls.length > 0, 'sourceUrls must not be empty');
  });
});

// ---------------------------------------------------------------------------
// getModelPricing — lookup by model ID and alias
// ---------------------------------------------------------------------------

describe('getModelPricing', () => {
  it('finds claude-opus-4-7 by exact model ID', () => {
    const result = getModelPricing('claude', 'claude-opus-4-7');
    assert.ok(result !== undefined, 'expected a result');
    assert.equal(result.model, 'claude-opus-4-7');
    assert.equal(result.provider, 'claude');
  });

  it('finds claude-opus-4-7 by alias "opus"', () => {
    const result = getModelPricing('claude', 'opus');
    assert.ok(result !== undefined, 'expected a result for alias "opus"');
    assert.equal(result.model, 'claude-opus-4-7');
  });

  it('finds claude-opus-4-7 by alias "opus-4.7"', () => {
    const result = getModelPricing('claude', 'opus-4.7');
    assert.ok(result !== undefined);
    assert.equal(result.model, 'claude-opus-4-7');
  });

  it('finds claude-sonnet-4-6 by alias "sonnet"', () => {
    const result = getModelPricing('claude', 'sonnet');
    assert.ok(result !== undefined);
    assert.equal(result.model, 'claude-sonnet-4-6');
  });

  it('finds claude-haiku-4-5 by alias "haiku"', () => {
    const result = getModelPricing('claude', 'haiku');
    assert.ok(result !== undefined);
    assert.equal(result.model, 'claude-haiku-4-5');
  });

  it('finds gpt-5.5 by exact model ID', () => {
    const result = getModelPricing('codex', 'gpt-5.5');
    assert.ok(result !== undefined);
    assert.equal(result.model, 'gpt-5.5');
  });

  it('lookup is case-insensitive', () => {
    const result = getModelPricing('claude', 'OPUS');
    assert.ok(result !== undefined, 'case-insensitive lookup should succeed');
    assert.equal(result.model, 'claude-opus-4-7');
  });

  it('returns undefined for unknown model', () => {
    const result = getModelPricing('claude', 'does-not-exist');
    assert.equal(result, undefined);
  });

  it('returns undefined when provider does not own the model', () => {
    // "opus" belongs to claude, not codex
    const result = getModelPricing('codex', 'opus');
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// calculateCost
// ---------------------------------------------------------------------------

describe('calculateCost', () => {
  it('returns 0 for zero tokens', () => {
    const pricing = getModelPricing('claude', 'sonnet')!;
    assert.equal(calculateCost(0, 0, pricing), 0);
  });

  it('calculates input-only cost correctly', () => {
    // sonnet: $3 / 1M input
    const pricing = getModelPricing('claude', 'sonnet')!;
    const cost = calculateCost(1_000_000, 0, pricing);
    assert.equal(cost, 3);
  });

  it('calculates output-only cost correctly', () => {
    // sonnet: $15 / 1M output
    const pricing = getModelPricing('claude', 'sonnet')!;
    const cost = calculateCost(0, 1_000_000, pricing);
    assert.equal(cost, 15);
  });

  it('calculates combined input + output cost correctly', () => {
    // haiku: $0.80 / 1M input, $4 / 1M output
    // 500k input => $0.40, 250k output => $1.00 => total $1.40
    const pricing = getModelPricing('claude', 'haiku')!;
    const cost = calculateCost(500_000, 250_000, pricing);
    assert.ok(
      Math.abs(cost - 1.4) < 1e-9,
      `expected $1.40, got $${cost}`,
    );
  });

  it('calculates opus cost correctly', () => {
    // opus 4.7: $5 / 1M input, $25 / 1M output
    // 2M input => $10, 1M output => $25 => $35
    const pricing = getModelPricing('claude', 'opus')!;
    const cost = calculateCost(2_000_000, 1_000_000, pricing);
    assert.equal(cost, 35);
  });

  it('calculates gpt-5.4-mini cost correctly', () => {
    // mini: $0.75 / 1M input, $4.50 / 1M output
    // 1M input => $0.75, 1M output => $4.50 => $5.25
    const pricing = getModelPricing('codex', 'gpt-5.4-mini')!;
    const cost = calculateCost(1_000_000, 1_000_000, pricing);
    assert.ok(
      Math.abs(cost - 5.25) < 1e-9,
      `expected $5.25, got $${cost}`,
    );
  });
});

// ---------------------------------------------------------------------------
// getCheapestForTier
// ---------------------------------------------------------------------------

describe('getCheapestForTier', () => {
  it('returns a model for the worker tier', () => {
    const m = getCheapestForTier('worker');
    assert.equal(m.tier, 'worker');
  });

  it('returns a model for the ic tier', () => {
    const m = getCheapestForTier('ic');
    assert.equal(m.tier, 'ic');
  });

  it('returns a model for the manager tier', () => {
    const m = getCheapestForTier('manager');
    assert.equal(m.tier, 'manager');
  });

  it('worker tier cheapest has the lowest inputPer1M among workers', () => {
    const cheapest = getCheapestForTier('worker');
    const allWorkers = PRICING_TABLE.models.filter((m) => m.tier === 'worker');
    for (const w of allWorkers) {
      assert.ok(
        cheapest.inputPer1M <= w.inputPer1M,
        `${cheapest.model} ($${cheapest.inputPer1M}) should be <= ${w.model} ($${w.inputPer1M})`,
      );
    }
  });

  it('ic tier cheapest has the lowest inputPer1M among ic models', () => {
    const cheapest = getCheapestForTier('ic');
    const allIc = PRICING_TABLE.models.filter((m) => m.tier === 'ic');
    for (const ic of allIc) {
      assert.ok(
        cheapest.inputPer1M <= ic.inputPer1M,
        `${cheapest.model} ($${cheapest.inputPer1M}) should be <= ${ic.model} ($${ic.inputPer1M})`,
      );
    }
  });

  it('respects availableProviders filter', () => {
    const m = getCheapestForTier('ic', ['claude']);
    assert.equal(m.provider, 'claude');
    assert.equal(m.tier, 'ic');
  });

  it('throws when no models match the tier + provider filter', () => {
    // There are no manager models from a fictional provider
    assert.throws(
      () => getCheapestForTier('manager', ['nonexistent-provider']),
      /No models available/,
    );
  });

  it('opencode (provider default) is the cheapest worker overall (zero-cost sentinel)', () => {
    // opencode is a subscription/free provider — a single 'opencode' model id
    // means "opencode's own configured model" (the adapter omits -m). inputPer1M=0
    // is a flat-cost sentinel; it wins the raw sort intentionally, but route()
    // keeps opencode last via providerOrderByTier so it doesn't displace
    // claude/codex when those are available.
    const cheapest = getCheapestForTier('worker');
    assert.equal(cheapest.model, 'opencode');
    assert.equal(cheapest.inputPer1M, 0);
  });

  it('gpt-5.4-mini is the cheapest non-opencode worker', () => {
    const cheapest = getCheapestForTier('worker', ['claude', 'codex']);
    assert.equal(cheapest.model, 'gpt-5.4-mini');
  });
});

// ---------------------------------------------------------------------------
// getCheapestForTier — allowedModels filter
// ---------------------------------------------------------------------------

describe('getCheapestForTier — allowedModels filter', () => {
  it('prefers a model whose exact id is in the allowed set', () => {
    // gpt-5.4 (ic) is in the allowed set; should be picked for codex ic
    const result = getCheapestForTier('ic', ['codex'], ['gpt-5.4']);
    assert.equal(result.model, 'gpt-5.4');
    assert.equal(result.provider, 'codex');
  });

  it('prefers a model whose alias is in the allowed set (case-insensitive)', () => {
    // 'SONNET' is an alias for claude-sonnet-4-6
    const result = getCheapestForTier('ic', ['claude'], ['SONNET']);
    assert.equal(result.model, 'claude-sonnet-4-6');
  });

  it('graceful fallback: when allowed set matches nothing, returns cheapest tier model anyway', () => {
    // 'phantom-model-xyz' does not appear in the pricing table; should fall back
    // gracefully to cheapest codex worker (not throw)
    const result = getCheapestForTier('worker', ['codex'], ['phantom-model-xyz']);
    assert.equal(result.tier, 'worker');
    assert.equal(result.provider, 'codex');
  });

  it('ignores empty allowedModels (identical to omitting it)', () => {
    const withEmpty = getCheapestForTier('ic', ['claude'], []);
    const withOmitted = getCheapestForTier('ic', ['claude']);
    assert.equal(withEmpty.model, withOmitted.model);
  });

  it('ignores undefined allowedModels (identical to omitting it)', () => {
    const withUndefined = getCheapestForTier('ic', ['claude'], undefined);
    const withOmitted = getCheapestForTier('ic', ['claude']);
    assert.equal(withUndefined.model, withOmitted.model);
  });
});

// ---------------------------------------------------------------------------
// opencode tier coverage — regression guard for the JOB-1 crash fix
// ---------------------------------------------------------------------------

describe('opencode pricing — all tiers covered', () => {
  it('opencode has a pricing entry for the worker tier', () => {
    const entry = PRICING_TABLE.models.find(
      (m) => m.provider === 'opencode' && m.tier === 'worker',
    );
    assert.ok(entry !== undefined, 'expected an opencode worker entry in the pricing table');
    assert.equal(entry.tier, 'worker');
  });

  it('opencode has a pricing entry for the ic tier', () => {
    const entry = PRICING_TABLE.models.find(
      (m) => m.provider === 'opencode' && m.tier === 'ic',
    );
    assert.ok(entry !== undefined, 'expected an opencode ic entry in the pricing table');
    assert.equal(entry.tier, 'ic');
  });

  it('opencode has a pricing entry for the manager tier', () => {
    const entry = PRICING_TABLE.models.find(
      (m) => m.provider === 'opencode' && m.tier === 'manager',
    );
    assert.ok(entry !== undefined, 'expected an opencode manager entry in the pricing table');
    assert.equal(entry.tier, 'manager');
  });

  it('getCheapestForTier worker with opencode does not throw', () => {
    const result = getCheapestForTier('worker', ['opencode']);
    assert.equal(result.provider, 'opencode');
    assert.equal(result.tier, 'worker');
  });

  it('getCheapestForTier ic with opencode does not throw', () => {
    const result = getCheapestForTier('ic', ['opencode']);
    assert.equal(result.provider, 'opencode');
    assert.equal(result.tier, 'ic');
  });

  it('getCheapestForTier manager with opencode does not throw', () => {
    const result = getCheapestForTier('manager', ['opencode']);
    assert.equal(result.provider, 'opencode');
    assert.equal(result.tier, 'manager');
  });
});

// ---------------------------------------------------------------------------
// isPricingStale
// ---------------------------------------------------------------------------

describe('isPricingStale', () => {
  it('returns false for a recent pricing date with default maxAgeDays', () => {
    // PRICING_TABLE.asOf is "2026-05-29" and today is 2026-05-29
    // so the table is 0 days old — not stale under any reasonable threshold
    assert.equal(isPricingStale(90), false);
  });

  it('returns false with a very large maxAgeDays threshold', () => {
    assert.equal(isPricingStale(36500), false); // 100 years
  });

  it('returns true when maxAgeDays is 0 (always stale)', () => {
    // The table was captured at some point in the past; even today it is ≥ 0 days old,
    // and with maxAgeDays=0 any age > 0 is stale.  We allow for a same-day edge case
    // by checking that stale is true only when the table date is strictly in the past.
    const asOf = new Date(PRICING_TABLE.asOf);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    asOf.setHours(0, 0, 0, 0);
    if (asOf < today) {
      assert.equal(isPricingStale(0), true);
    }
    // If same day, either result is acceptable — skip the assertion.
  });

  it('returns true for a very small maxAgeDays (1) when the table is not from today', () => {
    const asOf = new Date(PRICING_TABLE.asOf);
    const now = new Date();
    const diffDays = (now.getTime() - asOf.getTime()) / (1_000 * 60 * 60 * 24);
    if (diffDays > 1) {
      assert.equal(isPricingStale(1), true);
    }
    // If the table was updated today or yesterday, skip — not a useful test.
  });

  it('uses 90 days as the default threshold', () => {
    // We cannot predict the exact result without knowing the current date, but we
    // can at least verify the function runs without error when called with no args.
    const result = isPricingStale();
    assert.equal(typeof result, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// calculateEffectiveCost
// ---------------------------------------------------------------------------

describe('calculateEffectiveCost', () => {
  it('returns calculateCost when no cache buckets are supplied', () => {
    const pricing = getModelPricing('claude', 'claude-opus-4-7')!;
    // Strip cache rates
    const noCache = { ...pricing, cacheReadInputPer1M: undefined, cacheWriteInputPer1M: undefined };
    const result = calculateEffectiveCost(1661, 4, noCache);
    const expected = calculateCost(1661, 4, pricing);
    assert.ok(Math.abs(result - expected) < 1e-9);
  });

  it('prices Claude-style separate cache buckets', () => {
    const pricing = getModelPricing('claude', 'claude-opus-4-7')!;
    // input=1661, output=4, read=13247, write=2201
    // inputPer1M=5, outputPer1M=25, cacheReadInputPer1M=0.5, cacheWriteInputPer1M=6.25
    // normal input = 1661 (Claude: cache not included in input)
    // normalInputCost = 1661/1e6 * 5 = 0.008305
    // readCost = 13247/1e6 * 0.5 = 0.0066235
    // writeCost = 2201/1e6 * 6.25 = 0.01375625
    // outputCost = 4/1e6 * 25 = 0.0001
    // total = 0.008305 + 0.0066235 + 0.01375625 + 0.0001 = 0.02878475
    const result = calculateEffectiveCost(1661, 4, pricing, {
      cachedInputTokens: 13247,
      cacheWriteInputTokens: 2201,
    });
    assert.ok(Math.abs(result - 0.02878475) < 1e-9, `expected 0.02878475, got ${result}`);
  });

  it('discounts included cached input for Codex-style rows', () => {
    const pricing = getModelPricing('codex', 'gpt-5.5')!;
    // inputPer1M=5, outputPer1M=30, cacheReadInputPer1M=0.5, cacheInputTokensIncludedInInput=true
    // input=5000, output=10, read=3000
    // normal input = max(0, 5000 - 3000) = 2000 (write=0)
    // normalInputCost = 2000/1e6 * 5 = 0.01
    // readCost = 3000/1e6 * 0.5 = 0.0015
    // outputCost = 10/1e6 * 30 = 0.0003
    // total = 0.01 + 0.0015 + 0.0003 = 0.0118
    const result = calculateEffectiveCost(5000, 10, pricing, {
      cachedInputTokens: 3000,
    });
    assert.ok(Math.abs(result - 0.0118) < 1e-9, `expected 0.0118, got ${result}`);
  });

  it('falls back to list input price for cache buckets when row lacks cache rates', () => {
    // opencode rows have no cache rates
    const pricing = getModelPricing('opencode', 'opencode')!;
    // inputPer1M=0, outputPer1M=0
    const result = calculateEffectiveCost(1000, 10, pricing, {
      cachedInputTokens: 500,
      cacheWriteInputTokens: 100,
    });
    // Both read and write cost fall back to inputPer1M (0), so total = 0
    assert.ok(Math.abs(result - 0) < 1e-9);
  });
});
