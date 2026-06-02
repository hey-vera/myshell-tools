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

  it('reports tokens as the unit and shows NO dollar figure (subscription, not API-billed)', () => {
    const total = lines.join('\n');
    assert.ok(total.includes('Tokens used'), `expected a token total, got:\n${total}`);
    assert.ok(!/\$\d/.test(total), `must not show any dollar amount (subscription tool):\n${total}`);
  });

  it('mentions the model in the per-model breakdown', () => {
    const total = lines.join('\n');
    assert.ok(
      total.includes('claude-sonnet-4-6'),
      `expected model name in output`,
    );
  });

  it('frames routing efficiency against the flagship (a ratio, not a dollar figure)', () => {
    const total = lines.join('\n');
    assert.ok(/flagship/i.test(total), `expected a flagship-referenced efficiency line:\n${total}`);
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

  it('shows NO dollar figures — tokens only (subscription, not API-billed)', () => {
    assert.ok(!/\$\d/.test(output), `cost view must not display any dollar amount:\n${output}`);
    assert.ok(output.includes('Tokens used'), 'shows a measured token total');
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

  it('routing-efficiency line references the flagship', () => {
    assert.ok(
      /flagship/i.test(output),
      `expected a flagship-referenced efficiency line:\n${output}`,
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

  it('shows tokens and never a dollar figure (honest for subscription auth)', () => {
    const output = formatCostReport(entries, false).join('\n');
    assert.ok(!/\$\d/.test(output), `must not show any dollar amount:\n${output}`);
  });
});
