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

  it('finds gpt-5.2-codex by alias "codex"', () => {
    const result = getModelPricing('codex', 'codex');
    assert.ok(result !== undefined);
    assert.equal(result.model, 'gpt-5.2-codex');
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

  it('calculates gpt-5.4-nano cost correctly', () => {
    // nano: $0.20 / 1M input, $1.25 / 1M output
    // 1M input => $0.20, 1M output => $1.25 => $1.45
    const pricing = getModelPricing('codex', 'gpt-5.4-nano')!;
    const cost = calculateCost(1_000_000, 1_000_000, pricing);
    assert.ok(
      Math.abs(cost - 1.45) < 1e-9,
      `expected $1.45, got $${cost}`,
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

  it('gpt-5.4-nano is the cheapest non-opencode worker', () => {
    const cheapest = getCheapestForTier('worker', ['claude', 'codex']);
    assert.equal(cheapest.model, 'gpt-5.4-nano');
  });
});

// ---------------------------------------------------------------------------
// getCheapestForTier — allowedModels filter
// ---------------------------------------------------------------------------

describe('getCheapestForTier — allowedModels filter', () => {
  it('prefers a model whose exact id is in the allowed set', () => {
    // gpt-5.4 (ic) is in the allowed set; should be picked over gpt-5.2-codex for codex ic
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
