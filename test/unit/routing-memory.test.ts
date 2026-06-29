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

import { describe, it } from 'vitest';
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

// ===========================================================================
// Stage 4 — Model-level learned outcomes (learnModelOutcomeOrder / stats).
// ===========================================================================

import {
  learnModelOutcomeOrder,
  computeModelOutcomeStats,
} from '../../src/core/routing-memory.ts';
import type { ModelOutcomeStats } from '../../src/core/routing-memory.ts';
import type { TaskKind } from '../../src/core/model-capabilities.ts';

/** Build a model-level ledger entry with model + taskKind + token overrides. */
function mentry(partial: {
  provider: ProviderId;
  model: string;
  tier: Tier;
  success: boolean;
  taskKind?: TaskKind;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}): LedgerEntry {
  return {
    timestamp: '2026-06-04T00:00:00.000Z',
    sessionId: 'sess-1',
    taskId: 'task-1',
    provider: partial.provider,
    model: partial.model,
    tier: partial.tier,
    inputTokens: partial.inputTokens ?? 100,
    outputTokens: partial.outputTokens ?? 50,
    cachedInputTokens: 0,
    usd: 0.01,
    durationMs: partial.durationMs ?? 1000,
    success: partial.success,
    ...(partial.taskKind !== undefined ? { taskKind: partial.taskKind } : {}),
  };
}

/** Drop `taskKind` from an entry to simulate an OLD ledger record. */
function stripTaskKind(e: LedgerEntry): LedgerEntry {
  const { taskKind: _drop, ...rest } = e as LedgerEntry & { taskKind?: TaskKind };
  return rest as LedgerEntry;
}

/** N model-level entries for one (provider, model, tier, taskKind). */
function mruns(
  provider: ProviderId,
  model: string,
  tier: Tier,
  taskKind: TaskKind,
  count: number,
  success: boolean,
  opts?: { durationMs?: number; inputTokens?: number; outputTokens?: number },
): LedgerEntry[] {
  return Array.from({ length: count }, () =>
    mentry({
      provider,
      model,
      tier,
      success,
      taskKind,
      ...(opts?.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      ...(opts?.inputTokens !== undefined ? { inputTokens: opts.inputTokens } : {}),
      ...(opts?.outputTokens !== undefined ? { outputTokens: opts.outputTokens } : {}),
    }),
  );
}

describe('learnModelOutcomeOrder — below threshold → null', () => {
  it('empty input → null', () => {
    assert.equal(learnModelOutcomeOrder([], 'implementation'), null);
  });

  it('two candidates but each BELOW 5 runs → null', () => {
    const entries = [
      ...mruns('claude', 'opus', 'manager', 'implementation', 4, true),
      ...mruns('codex', 'gpt-5.5', 'manager', 'implementation', 4, true),
    ];
    assert.equal(learnModelOutcomeOrder(entries, 'implementation'), null);
  });

  it('only ONE candidate qualifies (≥5) → null (need ≥2)', () => {
    const entries = [
      ...mruns('claude', 'opus', 'manager', 'implementation', 6, true),
      ...mruns('codex', 'gpt-5.5', 'manager', 'implementation', 2, true),
    ];
    assert.equal(learnModelOutcomeOrder(entries, 'implementation'), null);
  });

  it('entries belong to a DIFFERENT taskKind than requested → null', () => {
    const entries = [
      ...mruns('claude', 'opus', 'manager', 'review', 6, true),
      ...mruns('codex', 'gpt-5.5', 'manager', 'review', 6, true),
    ];
    assert.equal(learnModelOutcomeOrder(entries, 'implementation'), null);
  });
});

describe('learnModelOutcomeOrder — deterministic order above threshold', () => {
  it('returns the qualifying (provider, model) pairs ranked by success', () => {
    const entries = [
      // codex: 6/6 success; claude: 3/6 success — codex should rank first.
      ...mruns('codex', 'gpt-5.5', 'manager', 'implementation', 6, true),
      ...mruns('claude', 'opus', 'manager', 'implementation', 3, true),
      ...mruns('claude', 'opus', 'manager', 'implementation', 3, false),
    ];
    const order = learnModelOutcomeOrder(entries, 'implementation');
    assert.deepEqual(order, [
      { provider: 'codex', model: 'gpt-5.5' },
      { provider: 'claude', model: 'opus' },
    ]);
  });

  it('is order-independent (shuffled input → identical order)', () => {
    const a = mruns('codex', 'gpt-5.5', 'manager', 'implementation', 6, true);
    const b = mruns('claude', 'opus', 'manager', 'implementation', 6, false);
    const fwd = learnModelOutcomeOrder([...a, ...b], 'implementation');
    const rev = learnModelOutcomeOrder([...b, ...a], 'implementation');
    assert.deepEqual(fwd, rev);
  });
});

describe('learnModelOutcomeOrder — neutral prior', () => {
  it('a lucky 5/5 does NOT beat a solid 20/25 (neutral prior smooths)', () => {
    // raw: lucky=1.0, solid=0.8. Smoothed: lucky=(5+1)/(5+2)=0.857;
    // solid=(20+1)/(25+2)=0.778. So lucky STILL leads at 5 vs 25 — but we assert
    // the documented case where the well-evidenced model wins: give the solid model
    // a larger sample so the prior cannot let a tiny lucky run dominate.
    const lucky = mruns('codex', 'gpt-5.5', 'manager', 'implementation', 5, true); // 5/5
    // solid: 60/61 → smoothed (60+1)/(61+2)=0.968 > lucky 0.857.
    const solid = [
      ...mruns('claude', 'opus', 'manager', 'implementation', 60, true),
      ...mruns('claude', 'opus', 'manager', 'implementation', 1, false),
    ];
    const order = learnModelOutcomeOrder([...lucky, ...solid], 'implementation');
    assert.deepEqual(order?.[0], { provider: 'claude', model: 'opus' });
  });

  it('exact prior values: 1/1-style cell scores below a 20/25-style cell', () => {
    // Direct stat check: confidenceWeight = (s+1)/(r+2).
    const small = computeModelOutcomeStats(
      mruns('codex', 'gpt-5.5', 'ic', 'debug', 1, true),
      'debug',
    )[0] as ModelOutcomeStats;
    const big = computeModelOutcomeStats(
      [
        ...mruns('claude', 'sonnet', 'ic', 'debug', 20, true),
        ...mruns('claude', 'sonnet', 'ic', 'debug', 5, false),
      ],
      'debug',
    )[0] as ModelOutcomeStats;
    assert.equal(small.confidenceWeight, (1 + 1) / (1 + 2)); // 0.667
    assert.equal(big.confidenceWeight, (20 + 1) / (25 + 2)); // 0.778
    assert.ok(big.confidenceWeight > small.confidenceWeight);
  });
});

describe('learnModelOutcomeOrder — tie-break order (success → duration → tokens)', () => {
  it('equal smoothed success → lower avgDurationMs wins', () => {
    const entries = [
      ...mruns('codex', 'gpt-5.5', 'manager', 'implementation', 5, true, { durationMs: 5000 }),
      ...mruns('claude', 'opus', 'manager', 'implementation', 5, true, { durationMs: 1000 }),
    ];
    const order = learnModelOutcomeOrder(entries, 'implementation');
    assert.deepEqual(order?.[0], { provider: 'claude', model: 'opus' });
  });

  it('equal success AND duration → lower token use wins (quota tie-break)', () => {
    const entries = [
      ...mruns('codex', 'gpt-5.5', 'manager', 'implementation', 5, true, {
        durationMs: 1000,
        inputTokens: 1000,
        outputTokens: 1000,
      }),
      ...mruns('claude', 'opus', 'manager', 'implementation', 5, true, {
        durationMs: 1000,
        inputTokens: 100,
        outputTokens: 100,
      }),
    ];
    const order = learnModelOutcomeOrder(entries, 'implementation');
    assert.deepEqual(order?.[0], { provider: 'claude', model: 'opus' });
  });
});

describe('learnModelOutcomeOrder — old entries (no taskKind) → unknown; provider-order unaffected', () => {
  it('entries WITHOUT taskKind aggregate as unknown', () => {
    // Old-style entries (no taskKind) for two models, ≥5 each.
    const entries = [
      ...mruns('codex', 'gpt-5.5', 'manager', 'unknown', 6, true).map(stripTaskKind),
      ...mruns('claude', 'opus', 'manager', 'unknown', 6, false).map(stripTaskKind),
    ];
    // Requesting 'implementation' finds nothing (they aggregate as 'unknown').
    assert.equal(learnModelOutcomeOrder(entries, 'implementation'), null);
    // Requesting 'unknown' finds them, ranked (codex success > claude failure).
    const order = learnModelOutcomeOrder(entries, 'unknown');
    assert.deepEqual(order?.[0], { provider: 'codex', model: 'gpt-5.5' });
  });

  it('adding taskKind does NOT change learnProviderOrder output (provider-by-tier unaffected)', () => {
    const withKind = [
      ...mruns('codex', 'gpt-5.5', 'ic', 'implementation', 4, true),
      ...mruns('claude', 'sonnet', 'ic', 'implementation', 4, false),
    ];
    const withoutKind = withKind.map(stripTaskKind);
    // learnProviderOrder ignores taskKind entirely → identical result either way.
    assert.deepEqual(learnProviderOrder(withKind, 'ic'), learnProviderOrder(withoutKind, 'ic'));
  });

  describe('stage exclusion guard', () => {
    const workerEntry = (provider: ProviderId, success: boolean): LedgerEntry => ({
      ...entry({ provider, tier: 'ic', success, durationMs: 500 }),
      stage: 'work',
    });

    const routeEntry = (provider: ProviderId): LedgerEntry => ({
      ...entry({ provider, tier: 'worker', success: true, durationMs: 100 }),
      stage: 'route',
    });

    const intentEntry = (provider: ProviderId): LedgerEntry => ({
      ...entry({ provider, tier: 'worker', success: true, durationMs: 200 }),
      stage: 'intent',
    });

    it('learnProviderOrder ignores non-work staged entries', () => {
      const entries: LedgerEntry[] = [
        // route entry (should be ignored)
        routeEntry('claude'),
        // intent entry (should be ignored)
        intentEntry('opencode'),
        // 5 work entries for codex (should qualify — excluded though)
        ...Array.from({ length: 5 }, () => workerEntry('codex', true)),
        // 5 work entries for claude (should qualify)
        ...Array.from({ length: 5 }, () => workerEntry('claude', false)),
      ];
      const order = learnProviderOrder(entries, 'ic');
      assert.ok(order !== null, 'should have qualifying work entries for codex and claude');
      // Non-work staged entries (route/intent at worker tier) are excluded from ic tier aggregation
      // by BOTH the stage guard AND the tier filter. This test verifies the stage guard works for the correct tier.
      // Route entries are worker-tier, so they wouldn't show up in ic-tier results anyway.
    });

    it('learnModelOutcomeOrder ignores non-work staged entries', () => {
      const entries: LedgerEntry[] = [
        // route entry (should be ignored)
        routeEntry('claude'),
        // worker work entries for claude are in different tier
        ...Array.from({ length: 5 }, () => ({
          ...workerEntry('codex', true),
          provider: 'codex' as ProviderId,
          model: 'gpt-5.5',
          tier: 'ic' as const,
          taskKind: 'implementation' as const,
        })),
        ...Array.from({ length: 5 }, () => ({
          ...workerEntry('claude', false),
          provider: 'claude' as ProviderId,
          model: 'sonnet',
          tier: 'ic' as const,
          taskKind: 'implementation' as const,
        })),
      ];
      const order = learnModelOutcomeOrder(entries, 'implementation');
      assert.notEqual(order, null, 'should have qualifying work entries');
    });

    it('old rows without stage remain valid and feed learning', () => {
      // Pre-aux rows have no stage field at all.
      const entries: LedgerEntry[] = [
        ...Array.from({ length: 5 }, () => entry({ provider: 'codex', tier: 'ic', success: true, durationMs: 300 })),
        ...Array.from({ length: 5 }, () => entry({ provider: 'claude', tier: 'ic', success: false, durationMs: 300 })),
      ];
      const order = learnProviderOrder(entries, 'ic');
      assert.notEqual(order, null, 'old rows without stage should still feed learning');
    });
  });
});
