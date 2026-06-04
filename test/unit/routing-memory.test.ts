/**
 * Unit tests for src/core/routing-memory.ts — the Local Outcome Learner.
 * Run with: node --experimental-strip-types --test test/unit/routing-memory.test.ts
 *
 * PURE module: every test builds a ledger entry array by hand and asserts the
 * learned order (or null). Covers: insufficient data → null, below-threshold
 * exclusion, <2 qualifying → null, ranking by successRate then avgDurationMs then
 * id, determinism/stability, garbage tolerance, tier filtering, and that
 * usd/tokens are ignored in ranking.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { learnProviderOrder, computeTierStats } from '../../src/core/routing-memory.ts';
import type { ProviderTierStats } from '../../src/core/routing-memory.ts';
import type { LedgerEntry, Tier } from '../../src/core/types.ts';
import type { ProviderId } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Helper: build a LedgerEntry with sane defaults; override the fields that matter.
// ---------------------------------------------------------------------------

function entry(
  partial: {
    provider: ProviderId;
    tier: Tier;
    success: boolean;
    durationMs?: number;
    usd?: number;
    inputTokens?: number;
    outputTokens?: number;
  },
): LedgerEntry {
  return {
    timestamp: '2026-06-04T00:00:00.000Z',
    sessionId: 'sess-1',
    taskId: 'task-1',
    model: 'some-model',
    cachedInputTokens: 0,
    inputTokens: partial.inputTokens ?? 100,
    outputTokens: partial.outputTokens ?? 50,
    usd: partial.usd ?? 0.01,
    durationMs: partial.durationMs ?? 1000,
    provider: partial.provider,
    tier: partial.tier,
    success: partial.success,
  };
}

/** N entries for a provider at a tier with a fixed success flag + duration. */
function runs(
  provider: ProviderId,
  tier: Tier,
  count: number,
  success: boolean,
  durationMs = 1000,
): LedgerEntry[] {
  return Array.from({ length: count }, () => entry({ provider, tier, success, durationMs }));
}

// ---------------------------------------------------------------------------
// learnProviderOrder — insufficient signal → null
// ---------------------------------------------------------------------------

describe('learnProviderOrder — insufficient signal', () => {
  it('empty input → null', () => {
    assert.equal(learnProviderOrder([], 'ic'), null);
  });

  it('a single provider above threshold but only one qualifying → null', () => {
    // claude has 5 ic runs (qualifies) but it is the ONLY one — nothing to reorder.
    const entries = runs('claude', 'ic', 5, true);
    assert.equal(learnProviderOrder(entries, 'ic'), null);
  });

  it('two providers both BELOW the run threshold → null', () => {
    const entries = [...runs('claude', 'ic', 2, true), ...runs('codex', 'ic', 2, true)];
    assert.equal(learnProviderOrder(entries, 'ic'), null); // default minRuns=3
  });

  it('one provider qualifies, the other is below threshold → null (need ≥2 ranked)', () => {
    const entries = [...runs('claude', 'ic', 5, true), ...runs('codex', 'ic', 2, true)];
    assert.equal(learnProviderOrder(entries, 'ic'), null);
  });
});

// ---------------------------------------------------------------------------
// learnProviderOrder — ranking
// ---------------------------------------------------------------------------

describe('learnProviderOrder — ranking by successRate', () => {
  it('higher success rate ranks first', () => {
    // claude: 3/3 success; codex: 1/3 success → claude first.
    const entries = [
      ...runs('claude', 'ic', 3, true),
      ...runs('codex', 'ic', 1, true),
      ...runs('codex', 'ic', 2, false),
    ];
    assert.deepEqual(learnProviderOrder(entries, 'ic'), ['claude', 'codex']);
  });

  it('lower success rate provider can be promoted by the user data (codex wins)', () => {
    const entries = [
      ...runs('claude', 'ic', 1, true),
      ...runs('claude', 'ic', 2, false), // 1/3
      ...runs('codex', 'ic', 3, true), // 3/3
    ];
    assert.deepEqual(learnProviderOrder(entries, 'ic'), ['codex', 'claude']);
  });
});

describe('learnProviderOrder — tie-break by avgDurationMs then id', () => {
  it('equal success rate → faster average wins', () => {
    // both 3/3 success; claude avg 2000ms, codex avg 500ms → codex first.
    const entries = [...runs('claude', 'ic', 3, true, 2000), ...runs('codex', 'ic', 3, true, 500)];
    assert.deepEqual(learnProviderOrder(entries, 'ic'), ['codex', 'claude']);
  });

  it('equal success rate AND equal avg duration → alphabetical by id', () => {
    // claude, codex, opencode all 3/3 at 1000ms → fully deterministic id order.
    const entries = [
      ...runs('opencode', 'ic', 3, true, 1000),
      ...runs('codex', 'ic', 3, true, 1000),
      ...runs('claude', 'ic', 3, true, 1000),
    ];
    assert.deepEqual(learnProviderOrder(entries, 'ic'), ['claude', 'codex', 'opencode']);
  });
});

describe('learnProviderOrder — determinism / stability', () => {
  it('input order does not change the output', () => {
    const base = [...runs('claude', 'ic', 3, true, 1000), ...runs('codex', 'ic', 3, true, 500)];
    const reversed = [...base].reverse();
    const a = learnProviderOrder(base, 'ic');
    const b = learnProviderOrder(reversed, 'ic');
    assert.deepEqual(a, ['codex', 'claude']);
    assert.deepEqual(b, ['codex', 'claude']);
  });
});

// ---------------------------------------------------------------------------
// learnProviderOrder — honesty: ignores usd/tokens; filters by tier
// ---------------------------------------------------------------------------

describe('learnProviderOrder — ignores usd/tokens', () => {
  it('a hugely expensive/large-token provider is NOT penalised; only outcomes count', () => {
    // codex: cheap, few tokens, but 1/3 success. claude: expensive, many tokens, 3/3.
    const entries = [
      ...Array.from({ length: 3 }, () =>
        entry({ provider: 'claude', tier: 'ic', success: true, usd: 100, inputTokens: 1e6, outputTokens: 1e6 }),
      ),
      entry({ provider: 'codex', tier: 'ic', success: true, usd: 0.0001, inputTokens: 1, outputTokens: 1 }),
      entry({ provider: 'codex', tier: 'ic', success: false, usd: 0.0001 }),
      entry({ provider: 'codex', tier: 'ic', success: false, usd: 0.0001 }),
    ];
    // claude wins on success rate despite being far more expensive — proves usd/tokens are ignored.
    assert.deepEqual(learnProviderOrder(entries, 'ic'), ['claude', 'codex']);
  });
});

describe('learnProviderOrder — tier filtering', () => {
  it('only entries for the requested tier are considered', () => {
    // At 'ic': claude 3/3, codex 3/3 same duration → alphabetical. The 'worker'
    // entries (which would flip the order if leaked) must be ignored.
    const entries = [
      ...runs('claude', 'ic', 3, true, 1000),
      ...runs('codex', 'ic', 3, true, 1000),
      ...runs('codex', 'worker', 9, true, 1), // noise at another tier
    ];
    assert.deepEqual(learnProviderOrder(entries, 'ic'), ['claude', 'codex']);
  });

  it('a tier with <2 qualifying providers → null even if other tiers are rich', () => {
    const entries = [...runs('claude', 'manager', 5, true), ...runs('codex', 'ic', 5, true)];
    assert.equal(learnProviderOrder(entries, 'manager'), null); // only claude qualifies at manager
  });
});

// ---------------------------------------------------------------------------
// learnProviderOrder — garbage tolerance / never throws
// ---------------------------------------------------------------------------

describe('learnProviderOrder — tolerates garbage, never throws', () => {
  it('non-array input → null', () => {
    // Simulate a corrupt caller passing a non-array (typed via unknown cast).
    assert.equal(learnProviderOrder(undefined as unknown as LedgerEntry[], 'ic'), null);
    assert.equal(learnProviderOrder(null as unknown as LedgerEntry[], 'ic'), null);
  });

  it('entries with missing/garbage fields are tolerated', () => {
    const garbage = [
      null,
      undefined,
      {},
      { provider: '', tier: 'ic', success: true },
      { provider: 'claude', tier: 'ic', success: true, durationMs: NaN },
      { provider: 'claude', tier: 'ic', success: true, durationMs: -5 },
      { provider: 'claude', tier: 'ic', success: true, durationMs: 100 },
      { provider: 'codex', tier: 'ic', success: true, durationMs: 100 },
      { provider: 'codex', tier: 'ic', success: false },
      { provider: 'codex', tier: 'ic', success: true, durationMs: 100 },
    ] as unknown as LedgerEntry[];
    // claude: 3 runs all success; codex: 3 runs 2/3 success → claude first. No throw.
    assert.deepEqual(learnProviderOrder(garbage, 'ic'), ['claude', 'codex']);
  });

  it('respects a custom minRunsPerProvider', () => {
    const entries = [...runs('claude', 'ic', 2, true), ...runs('codex', 'ic', 2, true)];
    // default minRuns=3 → null; with minRuns=2 → both qualify (equal → id order).
    assert.equal(learnProviderOrder(entries, 'ic'), null);
    assert.deepEqual(learnProviderOrder(entries, 'ic', { minRunsPerProvider: 2 }), ['claude', 'codex']);
  });
});

// ---------------------------------------------------------------------------
// computeTierStats — the internal helper, exported + tested
// ---------------------------------------------------------------------------

describe('computeTierStats', () => {
  it('aggregates runs/successes/successRate/avgDurationMs per provider for the tier', () => {
    const entries = [
      ...runs('claude', 'ic', 2, true, 1000),
      ...runs('claude', 'ic', 1, false, 3000),
      ...runs('codex', 'worker', 5, true, 10), // other tier — excluded
    ];
    const stats = computeTierStats(entries, 'ic');
    assert.equal(stats.length, 1);
    const c = stats.find((s) => s.provider === 'claude') as ProviderTierStats;
    assert.equal(c.runs, 3);
    assert.equal(c.successes, 2);
    assert.ok(Math.abs(c.successRate - 2 / 3) < 1e-9);
    // avg of (1000,1000,3000) = 5000/3
    assert.ok(Math.abs(c.avgDurationMs - 5000 / 3) < 1e-9);
  });

  it('empty input → empty array (no throw)', () => {
    assert.deepEqual(computeTierStats([], 'manager'), []);
  });

  it('negative/NaN durations are coerced to 0 in the average', () => {
    const entries = [
      entry({ provider: 'claude', tier: 'ic', success: true, durationMs: -10 }),
      entry({ provider: 'claude', tier: 'ic', success: true, durationMs: 200 }),
    ];
    const stats = computeTierStats(entries, 'ic');
    const c = stats[0] as ProviderTierStats;
    // (0 + 200) / 2 = 100
    assert.equal(c.avgDurationMs, 100);
  });
});
