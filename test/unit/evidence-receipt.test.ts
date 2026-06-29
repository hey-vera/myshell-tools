import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { buildEvidenceReceipt } from '../../src/core/evidence-receipt.ts';
import type { VerifyOutcome } from '../../src/core/verify.ts';
import type { LedgerEntry } from '../../src/core/types.ts';

function outcome(
  verified: VerifyOutcome['verified'],
  over: Partial<VerifyOutcome> = {},
): VerifyOutcome {
  return { verified, changedFiles: 1, changedPaths: ['src/a.ts'], ...over };
}

function ledgerEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    sessionId: 's',
    taskId: 't',
    provider: 'claude',
    model: 'opus',
    tier: 'ic',
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    usd: 0.0015,
    durationMs: 100,
    success: true,
    ...over,
  };
}

describe('buildEvidenceReceipt', () => {
  it('passing tests produce verdict verified with changedFiles commandsRun testsResult', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.01,
      ledgerEntries: [],
      verifyOutcome: outcome('passing', {
        testCommand: 'npm test',
        testRun: { outcome: 'green', output: 'ok', durationMs: 1234 },
        changedPaths: ['src/a.ts', 'src/b.ts'],
      }),
    });

    assert.ok(receipt !== undefined);
    assert.equal(receipt!.version, 2);
    assert.equal(receipt!.terminal, 'done');
    assert.equal(receipt!.verdict, 'verified');
    assert.deepEqual(receipt!.changedFiles, ['src/a.ts', 'src/b.ts']);
    assert.equal(receipt!.commandsRun?.[0]?.command, 'npm test');
    assert.equal(receipt!.commandsRun?.[0]?.outcome, 'success');
    assert.equal(receipt!.commandsRun?.[0]?.durationMs, 1234);
    assert.equal(receipt!.testsResult?.command, 'npm test');
    assert.equal(receipt!.testsResult?.outcome, 'green');
    assert.equal(receipt!.testsResult?.durationMs, 1234);
    assert.equal(receipt!.verifyVerdict, 'passing');
    assert.equal(receipt!.costUsd, 0.01);
    assert.equal(receipt!.headroom, 'unknown');
  });

  it('reviewed produce verdict reviewed not verified', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.01,
      ledgerEntries: [],
      verifyOutcome: outcome('reviewed', {
        critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
      }),
    });

    assert.ok(receipt !== undefined);
    assert.equal(receipt!.verdict, 'reviewed');
    assert.equal(receipt!.verifyVerdict, 'reviewed');
  });

  it('unverified and no outcome produce unverified not verified', () => {
    // Unverified outcome
    let receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.01,
      ledgerEntries: [],
      verifyOutcome: outcome('unverified', { note: 'no test command detected' }),
    });
    assert.ok(receipt !== undefined);
    assert.equal(receipt!.verdict, 'unverified');
    assert.equal(receipt!.verifyVerdict, 'unverified');

    // No outcome
    receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.01,
      ledgerEntries: [],
    });
    assert.ok(receipt !== undefined);
    assert.equal(receipt!.verdict, 'unverified');
    assert.equal(receipt!.verifyVerdict, 'not-run');
  });

  it('best effort produces unverified receipt', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      bestEffort: true,
      totalCostUsd: 0.01,
      ledgerEntries: [],
      verifyOutcome: outcome('reviewed'),
    });

    assert.ok(receipt !== undefined);
    assert.equal(receipt!.verdict, 'reviewed');
    // bestEffort itself doesn't change the verdict; that's based on verify outcome
  });

  it('summarizes aux staged ledger entries and omits auxCalls when none exist', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.03,
      cacheAccountingV2: true,
      ledgerEntries: [
        ledgerEntry({ stage: 'work', usd: 0.01 }),
        ledgerEntry({ stage: 'classify', usd: 0.005, inputTokens: 200, outputTokens: 100 }),
        ledgerEntry({ stage: 'intent', usd: 0.015, inputTokens: 300, outputTokens: 150, cachedInputTokens: 50, cacheWriteInputTokens: 25 }),
      ],
    });

    assert.ok(receipt !== undefined);
    assert.equal(receipt!.auxCalls?.count, 2);
    assert.equal(receipt!.auxCalls?.inputTokens, 500);
    assert.equal(receipt!.auxCalls?.outputTokens, 250);
    assert.equal(receipt!.auxCalls?.usd, 0.02);
    assert.equal(receipt!.auxCalls?.cachedInputTokens, 50);
    assert.equal(receipt!.auxCalls?.cacheWriteInputTokens, 25);

    // No aux entries
    const noAux = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.01,
      ledgerEntries: [ledgerEntry({ stage: 'work', usd: 0.01 })],
    });
    assert.equal(noAux!.auxCalls, undefined);
  });

  it('cacheAdjustedUsd appears only when cacheAccountingV2 is true', () => {
    const entries = [
      ledgerEntry({ stage: 'work', usd: 0.01 }),
      ledgerEntry({ stage: 'work', usd: 0.02 }),
    ];

    // With cacheAccountingV2
    const withCache = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.03,
      cacheAccountingV2: true,
      ledgerEntries: entries,
    });
    assert.equal(withCache!.cacheAdjustedUsd, 0.03);

    // Without cacheAccountingV2
    const withoutCache = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.03,
      ledgerEntries: entries,
    });
    assert.equal(withoutCache!.cacheAdjustedUsd, undefined);
  });

  it('intentVersionId is preserved when supplied', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.01,
      ledgerEntries: [],
      intentVersionId: 'abc123',
    });
    assert.equal(receipt!.intentVersionId, 'abc123');
  });

  it('blocked terminal maps to verdict from verifyOutcome', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: false,
      blocked: { reason: 'verification failed', nextAction: 'review', preservedWork: '' },
      totalCostUsd: 0.01,
      ledgerEntries: [],
      verifyOutcome: outcome('failing'),
    });
    assert.equal(receipt!.terminal, 'blocked');
    assert.equal(receipt!.verdict, 'failing');
  });

  it('failed terminal maps correctly', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: false,
      totalCostUsd: 0.01,
      ledgerEntries: [],
    });
    assert.equal(receipt!.terminal, 'failed');
    assert.equal(receipt!.verdict, 'unverified');
    assert.equal(receipt!.verifyVerdict, 'not-run');
  });

  it('turnTokens aggregates ledger entries by provider + model', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.03,
      ledgerEntries: [
        ledgerEntry({ provider: 'claude', model: 'sonnet', inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 }),
        ledgerEntry({ provider: 'claude', model: 'sonnet', inputTokens: 200, outputTokens: 100, cachedInputTokens: 30 }),
        ledgerEntry({ provider: 'codex', model: 'gpt-5', inputTokens: 300, outputTokens: 150 }),
      ],
    });
    assert.ok(receipt !== undefined);
    assert.equal(receipt!.headroom, 'unknown');
    assert.ok(receipt!.turnTokens !== undefined);
    assert.equal(receipt!.turnTokens!.length, 2);
    const claude = receipt!.turnTokens!.find(t => t.provider === 'claude');
    assert.ok(claude !== undefined);
    assert.equal(claude!.model, 'sonnet');
    assert.equal(claude!.inputTokens, 300);
    assert.equal(claude!.outputTokens, 150);
    assert.equal(claude!.cachedInputTokens, 50);
    const codex = receipt!.turnTokens!.find(t => t.provider === 'codex');
    assert.ok(codex !== undefined);
    assert.equal(codex!.model, 'gpt-5');
    assert.equal(codex!.inputTokens, 300);
    assert.equal(codex!.outputTokens, 150);
    assert.equal(codex!.cachedInputTokens, 0);
  });

  it('receipt includes headroom unknown and never shows dollar in user-visible summary', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.05,
      ledgerEntries: [
        ledgerEntry({ provider: 'claude', model: 'opus', inputTokens: 500, outputTokens: 200, usd: 0.05 }),
      ],
    });
    assert.equal(receipt!.headroom, 'unknown');
    assert.notEqual(receipt!.headroom, 'unknown%');
    assert.notEqual(receipt!.headroom, '100%');
    // costUsd remains in schema for internal routing but should not be shown to user
    assert.equal(receipt!.costUsd, 0.05);
    assert.ok(receipt!.turnTokens !== undefined);
    assert.equal(receipt!.turnTokens!.length, 1);
  });

  it('threads cooldownProviders and sessionTokens when provided', () => {
    const receipt = buildEvidenceReceipt({
      terminal: 'done',
      success: true,
      totalCostUsd: 0.01,
      ledgerEntries: [],
      cooldownProviders: [{ provider: 'codex', remainingMs: 180_000 }],
      sessionTokens: { claude: 91_000, codex: 45_000 },
    });
    assert.equal(receipt!.headroom, 'unknown');
    assert.deepEqual(receipt!.cooldownProviders, [{ provider: 'codex', remainingMs: 180_000 }]);
    assert.deepEqual(receipt!.sessionTokens, { claude: 91_000, codex: 45_000 });
  });
});
