/**
 * Unit tests for src/commands/cost.ts
 *
 * Exercises the pure formatCostReport() function with hand-built LedgerEntry
 * arrays. No real filesystem I/O — the pure builder is the primary coverage
 * surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { LedgerEntry } from '../../src/core/types.ts';
import { formatCostReport } from '../../src/commands/cost.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LedgerEntry> & { usd: number }): LedgerEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: randomUUID(),
    taskId: randomUUID(),
    provider: 'claude',
    model: 'claude-haiku-4-5',
    tier: 'worker',
    inputTokens: 1_000,
    outputTokens: 200,
    cachedInputTokens: 0,
    durationMs: 500,
    success: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty ledger
// ---------------------------------------------------------------------------

describe('formatCostReport — empty ledger', () => {
  it('does not throw for empty input', () => {
    assert.doesNotThrow(() => formatCostReport([]));
  });

  it('returns a single "No usage" line for empty input', () => {
    const lines = formatCostReport([]);
    assert.equal(lines.length, 1);
    assert.ok(
      lines[0]?.includes('No usage recorded yet'),
      `expected "No usage recorded yet" in "${lines[0]}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// Single entry
// ---------------------------------------------------------------------------

describe('formatCostReport — single entry', () => {
  const entry = makeEntry({
    model: 'claude-sonnet-4-6',
    tier: 'ic',
    provider: 'claude',
    inputTokens: 500_000,
    outputTokens: 100_000,
    usd: 0.003,
  });

  const lines = formatCostReport([entry]);

  it('contains the actual total spend', () => {
    const total = lines.join('\n');
    assert.ok(total.includes('0.0030'), `expected 0.0030 in output, got:\n${total}`);
  });

  it('mentions the model in the per-model breakdown', () => {
    const total = lines.join('\n');
    assert.ok(
      total.includes('claude-sonnet-4-6'),
      `expected model name in output`,
    );
  });

  it('contains a counterfactual line', () => {
    const total = lines.join('\n');
    assert.ok(
      total.includes('always-flagship'),
      `expected counterfactual line in output`,
    );
  });
});

// ---------------------------------------------------------------------------
// Multiple entries across haiku / sonnet
// ---------------------------------------------------------------------------

describe('formatCostReport — multi-entry across haiku and sonnet', () => {
  // haiku: 2 calls, usd 0.001 + 0.002 = 0.003
  // sonnet: 1 call, usd 0.008
  // total: 0.011
  const entries: LedgerEntry[] = [
    makeEntry({
      model: 'claude-haiku-4-5',
      tier: 'worker',
      provider: 'claude',
      inputTokens: 500_000,
      outputTokens: 200_000,
      usd: 0.001,
    }),
    makeEntry({
      model: 'claude-sonnet-4-6',
      tier: 'ic',
      provider: 'claude',
      inputTokens: 1_000_000,
      outputTokens: 300_000,
      usd: 0.008,
    }),
    makeEntry({
      model: 'claude-haiku-4-5',
      tier: 'worker',
      provider: 'claude',
      inputTokens: 800_000,
      outputTokens: 150_000,
      usd: 0.002,
    }),
  ];

  const lines = formatCostReport(entries);
  const output = lines.join('\n');

  it('reports the correct total spend (0.0110)', () => {
    assert.ok(
      output.includes('0.0110'),
      `expected total 0.0110 in output:\n${output}`,
    );
  });

  it('reports total call count', () => {
    assert.ok(
      output.includes('3'),
      `expected call count 3 in output`,
    );
  });

  it('includes per-model line for haiku', () => {
    assert.ok(
      output.includes('claude-haiku-4-5'),
      `expected haiku model in per-model breakdown`,
    );
  });

  it('includes per-model line for sonnet', () => {
    assert.ok(
      output.includes('claude-sonnet-4-6'),
      `expected sonnet model in per-model breakdown`,
    );
  });

  it('haiku shows 2 calls', () => {
    const haikuLine = lines.find((l) => l.includes('claude-haiku-4-5'));
    assert.ok(haikuLine !== undefined, 'haiku line not found');
    assert.ok(haikuLine.includes('2'), 'haiku line should show 2 calls');
  });

  it('counterfactual line is present', () => {
    assert.ok(
      output.includes('always-flagship'),
      `expected counterfactual in output`,
    );
  });

  it('flagship cost > actual cost (manager-tier is pricier than haiku/sonnet mix)', () => {
    // Flagship is getCheapestForTier('manager') = claude-opus-4-7:
    //   $5/M input + $25/M output
    // Entry 1 (haiku): 500k in + 200k out  → $2.50 + $5.00  = $7.50
    // Entry 2 (sonnet): 1M in + 300k out   → $5.00 + $7.50  = $12.50
    // Entry 3 (haiku): 800k in + 150k out  → $4.00 + $3.75  = $7.75
    // Flagship total: $27.75 >> $0.011 actual
    const flagshipLine = lines.find((l) => l.includes('always-flagship'));
    assert.ok(flagshipLine !== undefined, 'counterfactual line not found');
    // The multiplier text should be present and mention "x more"
    assert.ok(
      flagshipLine.includes('x more'),
      `expected multiplier in counterfactual line: "${flagshipLine}"`,
    );
  });

  it('multiplier is a sensible positive number (>> 1)', () => {
    const flagshipLine = lines.find((l) => l.includes('x more')) ?? '';
    // Extract the multiplier — it appears as e.g. "2522.7x more" in this test
    const match = flagshipLine.match(/([\d.]+)x more/);
    assert.ok(match !== null, `multiplier pattern not found in: "${flagshipLine}"`);
    const multiplier = parseFloat(match[1]);
    assert.ok(
      multiplier > 1,
      `expected multiplier > 1, got ${multiplier}`,
    );
  });
});

// ---------------------------------------------------------------------------
// formatCostReport with color=false (plain text — no ANSI codes)
// ---------------------------------------------------------------------------

describe('formatCostReport — plain text mode', () => {
  const entries: LedgerEntry[] = [
    makeEntry({ model: 'claude-haiku-4-5', usd: 0.002, inputTokens: 100_000, outputTokens: 50_000 }),
  ];

  it('plain output contains no ANSI escape codes', () => {
    const lines = formatCostReport(entries, false);
    const output = lines.join('\n');
    assert.ok(
      !output.includes('\x1b['),
      'Expected no ANSI codes in plain-text output',
    );
  });
});

// ---------------------------------------------------------------------------
// formatCostReport — honest cost label (does not claim "as billed" for estimates)
// ---------------------------------------------------------------------------

describe('formatCostReport — honest total label', () => {
  const entries: LedgerEntry[] = [
    makeEntry({ model: 'claude-haiku-4-5', usd: 0.001, inputTokens: 100_000, outputTokens: 50_000 }),
  ];

  it('does not claim "as billed" when estimates may be included', () => {
    const output = formatCostReport(entries, false).join('\n');
    assert.ok(
      !output.includes('as billed'),
      `must not claim "as billed" — Codex costs are estimated:\n${output}`,
    );
  });

  it('uses "Total cost" or "provider-reported" language to describe the total', () => {
    const output = formatCostReport(entries, false).join('\n');
    assert.ok(
      output.includes('Total cost') || output.includes('provider-reported'),
      `expected honest label in cost output:\n${output}`,
    );
  });
});
