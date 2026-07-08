import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { summarizeSubscriptionPressure } from '../../src/core/subscription-pressure.ts';

describe('summarizeSubscriptionPressure', () => {
  it('keeps transcript and telemetry consumption separate from exact remaining quota', () => {
    const summary = summarizeSubscriptionPressure([
      { kind: 'tokens-used', source: 'transcript', trust: 'local-transcript-consumption', provider: 'claude', inputTokens: 40_000, outputTokens: 5_000 },
      { kind: 'cache-usage', source: 'otel', trust: 'official-telemetry-consumption', provider: 'claude', cacheReadTokens: 10_000, cacheWriteTokens: 2_000 },
    ]);

    assert.equal(summary.remainingQuotaKnown, false);
    assert.equal(summary.totalTokens, 57_000);
    assert.equal(summary.level, 'medium');
    assert.ok(summary.receiptLines.some((line) => line.includes('Remaining subscription headroom: unknown')));
  });

  it('treats third-party monitor data as estimate only', () => {
    const summary = summarizeSubscriptionPressure([
      { kind: 'external-monitor-estimate', source: 'third-party-monitor', trust: 'third-party-estimate', provider: 'claude', estimateLevel: 'high', note: 'cmonitor estimate' },
    ]);

    assert.equal(summary.level, 'high');
    assert.equal(summary.remainingQuotaKnown, false);
    assert.ok(summary.receiptLines.some((line) => line.includes('Third-party monitor data is treated as an estimate')));
    assert.ok(summary.receiptLines.some((line) => line.includes('headroom: unknown')));
  });

  it('cooldown or rate-limit pressure wins over token-only levels', () => {
    const summary = summarizeSubscriptionPressure([
      { kind: 'tokens-used', source: 'myshell-ledger', trust: 'official-runtime-field', provider: 'codex', inputTokens: 100 },
      { kind: 'cooldown-active', source: 'myshell-runtime', trust: 'runtime-observed-failure', provider: 'claude', cooldownMs: 300_000 },
    ]);

    assert.equal(summary.level, 'cooling');
    assert.deepEqual(summary.coolingProviders, ['claude']);
  });

  it('unknown input remains honest unknown headroom', () => {
    const summary = summarizeSubscriptionPressure([{ kind: 'headroom-unknown', source: 'provider-usage', trust: 'unknown', provider: 'grok' }]);
    assert.equal(summary.level, 'unknown');
    assert.equal(summary.remainingQuotaKnown, false);
    assert.deepEqual(summary.coolingProviders, []);
  });
});
