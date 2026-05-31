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

  it('shows a list-price routed cost estimate (consistent basis, not the provider-reported total)', () => {
    const total = lines.join('\n');
    // The Estimated-cost section uses list price × tokens for a consistent
    // apples-to-apples figure. Sonnet 500k in + 100k out = $1.50 + $1.50 = $3.0000.
    assert.ok(total.includes('Routed'), `expected a "Routed" estimate, got:\n${total}`);
    assert.ok(total.includes('3.0000'), `expected list-price routed ~$3.0000, got:\n${total}`);
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

  it('shows a routed list-price estimate that never exceeds always-flagship (consistent basis)', () => {
    assert.ok(output.includes('Routed'), `expected a "Routed" estimate:\n${output}`);
    // Both figures are list-price; extract and assert routed <= flagship.
    const routed = output.match(/Routed: ~\$([\d.]+)/);
    const flagship = output.match(/always-flagship: ~\$([\d.]+)/);
    assert.ok(routed !== null, 'routed estimate present');
    if (flagship !== null) {
      assert.ok(
        parseFloat(routed[1]) <= parseFloat(flagship[1]),
        `routed (${routed[1]}) must not exceed always-flagship (${flagship[1]})`,
      );
    }
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

  it('routing efficiency expresses savings as a billing-agnostic ratio', () => {
    // Flagship is getCheapestForTier('manager'); a haiku/sonnet mix is far cheaper,
    // so the routing-efficiency line reports a "~N× less" ratio than always-flagship.
    const ratioLine = lines.find((l) => l.includes('× less'));
    assert.ok(ratioLine !== undefined, 'routing-efficiency ratio line not found');
    assert.ok(
      ratioLine.includes('flagship'),
      `expected the ratio framed against the flagship: "${ratioLine}"`,
    );
  });

  it('routing-efficiency multiplier is a sensible positive number (>> 1)', () => {
    const ratioLine = lines.find((l) => l.includes('× less')) ?? '';
    // Extract the multiplier — appears as e.g. "~2522.7× less"
    const match = ratioLine.match(/([\d.]+)× less/);
    assert.ok(match !== null, `multiplier pattern not found in: "${ratioLine}"`);
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

  it('labels the dollar figure as an API-equivalent estimate, not the subscription bill', () => {
    const output = formatCostReport(entries, false).join('\n');
    assert.ok(
      /API-equivalent/i.test(output) && /not your subscription bill/i.test(output),
      `cost output must honestly caption dollars as an estimate, not the bill:\n${output}`,
    );
  });
});
