/**
 * test/unit/insights.test.ts — unit tests for src/infra/insights.ts
 *
 * All tests are pure — no I/O, no file system access.
 *
 * Honesty Contract: no hardcoded percentages, no fabricated data, no mock
 * AI-response phrases, no digit-% literals in source.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { summarizeSpend, providerHealth, formatUsd, formatTokens } from '../../src/infra/insights.ts';
import type { LedgerEntry } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[\d;]*[A-Za-z]/;

/** Patterns that must never appear in any rendered output (Honesty Contract). */
const FORBIDDEN_SUBSTRINGS = [
  'JWT',
  'Authentication bug',
  'sess-abc',
  '8m 23s',
  '12 exchanges',
  '87%',
];

function assertNoForbidden(output: string, label: string): void {
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    assert.ok(
      !output.includes(sub),
      `${label}: must not contain forbidden substring "${sub}"`,
    );
  }
}

function assertNoDigitPercent(output: string, label: string): void {
  assert.ok(
    !/\d+%/.test(output),
    `${label}: must not contain a digit-followed-by-% literal`,
  );
}

/** Build a minimal valid LedgerEntry for testing. */
function makeEntry(overrides?: Partial<LedgerEntry>): LedgerEntry {
  return {
    timestamp: '2026-05-29T12:00:00.000Z',
    sessionId: randomUUID(),
    taskId: randomUUID(),
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    tier: 'ic',
    inputTokens: 1000,
    outputTokens: 200,
    cachedInputTokens: 0,
    usd: 0.006,
    durationMs: 1500,
    success: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// summarizeSpend
// ---------------------------------------------------------------------------

describe('summarizeSpend', () => {
  const NOW_ISO = '2026-05-29T18:00:00.000Z'; // "today" is 2026-05-29
  const YESTERDAY_ISO = '2026-05-28T23:59:59.000Z'; // "yesterday"

  it('returns zeros for an empty array', () => {
    const spend = summarizeSpend([], NOW_ISO);
    assert.strictEqual(spend.todayUsd, 0);
    assert.strictEqual(spend.totalUsd, 0);
    assert.strictEqual(spend.calls, 0);
    assert.strictEqual(spend.todayTokens, 0);
    assert.strictEqual(spend.totalTokens, 0);
    assert.deepStrictEqual(spend.byProvider, {});
  });

  it('sums real tokens (input + output) for today and all-time', () => {
    const today = makeEntry({ timestamp: NOW_ISO, inputTokens: 1000, outputTokens: 200 });
    const yesterday = makeEntry({ timestamp: YESTERDAY_ISO, inputTokens: 500, outputTokens: 100 });
    const spend = summarizeSpend([today, yesterday], NOW_ISO);
    assert.strictEqual(spend.todayTokens, 1200, 'today = 1000 + 200');
    assert.strictEqual(spend.totalTokens, 1800, 'all-time = 1200 + 600');
  });

  it('counts a single entry today correctly', () => {
    const entry = makeEntry({ timestamp: '2026-05-29T10:00:00.000Z', usd: 0.0050 });
    const spend = summarizeSpend([entry], NOW_ISO);
    assert.ok(Math.abs(spend.todayUsd - 0.0050) < 1e-9, 'todayUsd should be 0.005');
    assert.ok(Math.abs(spend.totalUsd - 0.0050) < 1e-9, 'totalUsd should be 0.005');
    assert.strictEqual(spend.calls, 1);
  });

  it('does not count yesterday entries in todayUsd', () => {
    const today = makeEntry({ timestamp: '2026-05-29T08:00:00.000Z', usd: 0.0030 });
    const yesterday = makeEntry({ timestamp: YESTERDAY_ISO, usd: 0.0100 });
    const spend = summarizeSpend([today, yesterday], NOW_ISO);
    assert.ok(Math.abs(spend.todayUsd - 0.0030) < 1e-9, 'todayUsd should exclude yesterday');
    assert.ok(Math.abs(spend.totalUsd - 0.0130) < 1e-9, 'totalUsd includes all entries');
    assert.strictEqual(spend.calls, 2);
  });

  it('sums multiple today entries', () => {
    const entries = [
      makeEntry({ timestamp: '2026-05-29T01:00:00.000Z', usd: 0.0010 }),
      makeEntry({ timestamp: '2026-05-29T05:00:00.000Z', usd: 0.0020 }),
      makeEntry({ timestamp: '2026-05-29T14:00:00.000Z', usd: 0.0040 }),
    ];
    const spend = summarizeSpend(entries, NOW_ISO);
    assert.ok(Math.abs(spend.todayUsd - 0.0070) < 1e-9, 'todayUsd is sum of all three');
    assert.ok(Math.abs(spend.totalUsd - 0.0070) < 1e-9, 'totalUsd is same when all are today');
    assert.strictEqual(spend.calls, 3);
  });

  it('splits calls and usd by provider', () => {
    const entries = [
      makeEntry({ provider: 'claude', usd: 0.0050 }),
      makeEntry({ provider: 'codex', usd: 0.0020 }),
      makeEntry({ provider: 'claude', usd: 0.0030 }),
    ];
    const spend = summarizeSpend(entries, NOW_ISO);
    const claudeData = spend.byProvider['claude'];
    const codexData = spend.byProvider['codex'];
    assert.ok(claudeData !== undefined, 'claude key exists');
    assert.strictEqual(claudeData.calls, 2);
    assert.ok(Math.abs(claudeData.usd - 0.0080) < 1e-9, 'claude usd = 0.008');
    assert.ok(codexData !== undefined, 'codex key exists');
    assert.strictEqual(codexData.calls, 1);
    assert.ok(Math.abs(codexData.usd - 0.0020) < 1e-9, 'codex usd = 0.002');
  });

  it('handles entries from different months correctly (date prefix match)', () => {
    const thisMonth = makeEntry({ timestamp: '2026-05-29T10:00:00.000Z', usd: 0.0100 });
    const lastMonth = makeEntry({ timestamp: '2026-04-29T10:00:00.000Z', usd: 0.0500 });
    const spend = summarizeSpend([thisMonth, lastMonth], NOW_ISO);
    assert.ok(Math.abs(spend.todayUsd - 0.0100) < 1e-9, 'only today entry counted in todayUsd');
    assert.ok(Math.abs(spend.totalUsd - 0.0600) < 1e-9, 'totalUsd includes both');
  });

  it('all entries older → todayUsd is 0', () => {
    const entries = [
      makeEntry({ timestamp: YESTERDAY_ISO, usd: 0.0100 }),
      makeEntry({ timestamp: '2026-05-27T09:00:00.000Z', usd: 0.0200 }),
    ];
    const spend = summarizeSpend(entries, NOW_ISO);
    assert.strictEqual(spend.todayUsd, 0, 'todayUsd must be 0 when no entries match today');
    assert.ok(Math.abs(spend.totalUsd - 0.0300) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// providerHealth
// ---------------------------------------------------------------------------

describe('providerHealth', () => {
  it('returns empty array for no entries', () => {
    const health = providerHealth([]);
    assert.deepStrictEqual(health, []);
  });

  it('computes successRate correctly for all-success entries', () => {
    const entries = [
      makeEntry({ provider: 'claude', success: true }),
      makeEntry({ provider: 'claude', success: true }),
      makeEntry({ provider: 'claude', success: true }),
    ];
    const health = providerHealth(entries);
    assert.strictEqual(health.length, 1);
    const claudeHealth = health[0];
    assert.ok(claudeHealth !== undefined);
    assert.strictEqual(claudeHealth.provider, 'claude');
    assert.strictEqual(claudeHealth.calls, 3);
    assert.ok(Math.abs(claudeHealth.successRate - 1.0) < 1e-9, 'successRate = 1.0');
    assert.strictEqual(claudeHealth.status, 'healthy');
  });

  it('computes successRate correctly for mixed results', () => {
    // 2 success out of 4 = 0.5, below 0.7 threshold → degraded
    const entries = [
      makeEntry({ provider: 'claude', success: true }),
      makeEntry({ provider: 'claude', success: true }),
      makeEntry({ provider: 'claude', success: false }),
      makeEntry({ provider: 'claude', success: false }),
    ];
    const health = providerHealth(entries);
    const claudeHealth = health[0];
    assert.ok(claudeHealth !== undefined);
    assert.ok(Math.abs(claudeHealth.successRate - 0.5) < 1e-9, 'successRate = 0.5');
    assert.strictEqual(claudeHealth.status, 'degraded');
  });

  it('status is degraded when successRate < 0.7', () => {
    // 2 success out of 3 ≈ 0.667, below 0.7 → degraded
    const entries = [
      makeEntry({ provider: 'codex', success: true }),
      makeEntry({ provider: 'codex', success: true }),
      makeEntry({ provider: 'codex', success: false }),
    ];
    const health = providerHealth(entries);
    const h = health[0];
    assert.ok(h !== undefined);
    const rate = h.successRate;
    assert.ok(rate < 0.7, 'rate below 0.7');
    assert.strictEqual(h.status, 'degraded');
  });

  it('status is healthy when successRate >= 0.7', () => {
    // 7 success out of 10 = 0.7 → healthy (boundary)
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ provider: 'claude', success: i < 7 }),
    );
    const health = providerHealth(entries);
    const h = health[0];
    assert.ok(h !== undefined);
    assert.ok(Math.abs(h.successRate - 0.7) < 1e-9, 'successRate = 0.7 exactly');
    assert.strictEqual(h.status, 'healthy');
  });

  it('computes avgDurationMs as arithmetic mean', () => {
    const entries = [
      makeEntry({ provider: 'claude', durationMs: 1000 }),
      makeEntry({ provider: 'claude', durationMs: 2000 }),
      makeEntry({ provider: 'claude', durationMs: 3000 }),
    ];
    const health = providerHealth(entries);
    const h = health[0];
    assert.ok(h !== undefined);
    assert.ok(Math.abs(h.avgDurationMs - 2000) < 1e-9, 'avgDurationMs = 2000');
  });

  it('separates health stats by provider', () => {
    const entries = [
      makeEntry({ provider: 'claude', success: true, durationMs: 1000 }),
      makeEntry({ provider: 'codex', success: false, durationMs: 5000 }),
    ];
    const health = providerHealth(entries);
    assert.strictEqual(health.length, 2);
    const claudeH = health.find((h) => h.provider === 'claude');
    const codexH = health.find((h) => h.provider === 'codex');
    assert.ok(claudeH !== undefined);
    assert.ok(codexH !== undefined);
    assert.strictEqual(claudeH.calls, 1);
    assert.ok(Math.abs(claudeH.successRate - 1.0) < 1e-9);
    assert.strictEqual(claudeH.status, 'healthy');
    assert.strictEqual(codexH.calls, 1);
    assert.ok(Math.abs(codexH.successRate - 0.0) < 1e-9);
    assert.strictEqual(codexH.status, 'degraded');
  });

  it('all-failure entries → degraded status', () => {
    const entries = [
      makeEntry({ provider: 'claude', success: false }),
      makeEntry({ provider: 'claude', success: false }),
    ];
    const health = providerHealth(entries);
    const h = health[0];
    assert.ok(h !== undefined);
    assert.strictEqual(h.successRate, 0);
    assert.strictEqual(h.status, 'degraded');
  });
});

// ---------------------------------------------------------------------------
// formatUsd
// ---------------------------------------------------------------------------

describe('formatUsd', () => {
  it('formats zero as $0.0000', () => {
    assert.strictEqual(formatUsd(0), '$0.0000');
  });

  it('formats a small value with 4 decimals', () => {
    assert.strictEqual(formatUsd(0.0124), '$0.0124');
  });

  it('starts with $', () => {
    assert.ok(formatUsd(1.5).startsWith('$'), 'result starts with $');
  });

  it('has exactly 4 decimal places', () => {
    const result = formatUsd(0.0890);
    const dotIdx = result.indexOf('.');
    assert.ok(dotIdx >= 0, 'result contains a decimal point');
    assert.strictEqual(result.length - dotIdx - 1, 4, 'exactly 4 decimal places');
  });

  it('formats larger amounts correctly', () => {
    assert.strictEqual(formatUsd(1.23456789), '$1.2346');
  });

  it('does not contain a digit-% literal', () => {
    const results = [
      formatUsd(0),
      formatUsd(0.0001),
      formatUsd(0.9999),
      formatUsd(1.0),
      formatUsd(100.0),
    ];
    for (const r of results) {
      assertNoDigitPercent(r, 'formatUsd');
    }
  });

  it('does not contain ANSI codes', () => {
    const result = formatUsd(0.0042);
    assert.ok(!ANSI_RE.test(result), 'formatUsd must not contain ANSI codes');
  });

  it('does not contain forbidden substrings', () => {
    const results = [formatUsd(0), formatUsd(0.0042), formatUsd(1.0)];
    for (const r of results) {
      assertNoForbidden(r, 'formatUsd');
    }
  });
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe('formatTokens', () => {
  it('shows raw count below 1000', () => {
    assert.strictEqual(formatTokens(0), '0');
    assert.strictEqual(formatTokens(942), '942');
  });

  it('shows k with one decimal, dropping a trailing .0', () => {
    assert.strictEqual(formatTokens(12_400), '12.4k');
    assert.strictEqual(formatTokens(12_000), '12k');
    assert.strictEqual(formatTokens(1500), '1.5k');
  });

  it('shows M for millions', () => {
    assert.strictEqual(formatTokens(3_000_000), '3M');
    assert.strictEqual(formatTokens(2_500_000), '2.5M');
  });

  it('clamps invalid / negative inputs to "0"', () => {
    assert.strictEqual(formatTokens(-5), '0');
    assert.strictEqual(formatTokens(Number.NaN), '0');
  });

  it('never contains a dollar sign or digit-% literal', () => {
    for (const n of [0, 942, 12_400, 3_000_000]) {
      const s = formatTokens(n);
      assert.ok(!s.includes('$'), `formatTokens must not contain "$": "${s}"`);
      assertNoDigitPercent(s, 'formatTokens');
    }
  });
});
