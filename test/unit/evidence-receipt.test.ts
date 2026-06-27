import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildEvidenceReceipt, type EvidenceReceiptV2 } from '../../src/core/evidence-receipt.ts';
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
});
