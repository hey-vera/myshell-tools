/**
 * Unit tests for the pure turn routing receipt formatter (PR-B visible dispatch).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  formatTurnRoutingReceipt,
  routingReceiptFromRun,
} from '../../src/core/turn-routing-receipt.ts';

describe('formatTurnRoutingReceipt', () => {
  it('formats full provider · model · effort · account — why', () => {
    const line = formatTurnRoutingReceipt({
      provider: 'claude',
      model: 'claude-opus-4',
      reasoningEffort: 'high',
      accountLabel: 'work',
      reason: 'multi-file refactor',
    });
    assert.equal(
      line,
      'claude \u00b7 claude-opus-4 \u00b7 high \u00b7 work \u2014 multi-file refactor',
    );
  });

  it('omits missing optional fields without placeholders', () => {
    const line = formatTurnRoutingReceipt({
      provider: 'codex',
      model: 'gpt-5.1',
    });
    assert.equal(line, 'codex \u00b7 gpt-5.1');
    assert.ok(!line.includes('undefined'));
    assert.ok(!line.includes('null'));
    assert.ok(!line.includes(' \u2014 '));
  });

  it('prefers accountLabel over accountId', () => {
    const line = formatTurnRoutingReceipt({
      provider: 'opencode',
      model: 'kimi-k2.6',
      accountLabel: 'free-1',
      accountId: 'acc-uuid-should-not-appear',
    });
    assert.ok(line.includes('free-1'));
    assert.ok(!line.includes('acc-uuid-should-not-appear'));
  });

  it('falls back to accountId when label is absent', () => {
    const line = formatTurnRoutingReceipt({
      provider: 'opencode',
      model: 'kimi-k2.6',
      accountId: 'acct-1',
    });
    assert.equal(line, 'opencode \u00b7 kimi-k2.6 \u00b7 acct-1');
  });

  it('returns empty string when no provider/model (nothing truthful to show)', () => {
    assert.equal(formatTurnRoutingReceipt({ reason: 'only why' }), '');
    assert.equal(formatTurnRoutingReceipt({}), '');
    assert.equal(formatTurnRoutingReceipt({ reasoningEffort: 'high' }), '');
  });

  it('never throws on bad input', () => {
    // @ts-expect-error deliberate bad input
    assert.doesNotThrow(() => formatTurnRoutingReceipt(null));
    // @ts-expect-error deliberate bad input
    assert.doesNotThrow(() => formatTurnRoutingReceipt(undefined));
    // @ts-expect-error deliberate bad input
    assert.equal(formatTurnRoutingReceipt(null), '');
  });

  it('truncates long reasons', () => {
    const long = 'x'.repeat(200);
    const line = formatTurnRoutingReceipt({
      provider: 'claude',
      model: 'opus',
      reason: long,
    });
    assert.ok(line.includes('\u2026'));
    assert.ok(line.length < 120);
  });

  it('strips secret-shaped segments instead of leaking them', () => {
    const line = formatTurnRoutingReceipt({
      provider: 'claude',
      model: 'opus',
      accountLabel: 'sk-ant-api03-definitely-a-key',
      reason: 'ok reason',
    });
    assert.ok(!line.includes('sk-ant'));
    assert.equal(line, 'claude \u00b7 opus \u2014 ok reason');
  });

  it('collapses whitespace in segments', () => {
    const line = formatTurnRoutingReceipt({
      provider: '  claude  ',
      model: 'opus\n4',
      reason: '  multi   file  ',
    });
    assert.equal(line, 'claude \u00b7 opus 4 \u2014 multi file');
  });
});

describe('routingReceiptFromRun', () => {
  it('returns undefined (not empty string) when nothing to show', () => {
    assert.equal(routingReceiptFromRun({}), undefined);
    assert.equal(routingReceiptFromRun({ routeReason: 'only why' }), undefined);
  });

  it('maps routeReason onto the receipt why segment', () => {
    const line = routingReceiptFromRun({
      provider: 'claude',
      model: 'opus',
      reasoningEffort: 'medium',
      accountLabel: 'work',
      routeReason: 'context window 200k',
    });
    assert.equal(
      line,
      'claude \u00b7 opus \u00b7 medium \u00b7 work \u2014 context window 200k',
    );
  });

  it('accepts reason alias', () => {
    const line = routingReceiptFromRun({
      provider: 'codex',
      model: 'gpt-5',
      reason: 'tier worker',
    });
    assert.equal(line, 'codex \u00b7 gpt-5 \u2014 tier worker');
  });

  it('never throws on bad input', () => {
    // @ts-expect-error deliberate bad input
    assert.equal(routingReceiptFromRun(null), undefined);
  });
});
