/**
 * Unit tests for src/infra/jsonl-guards.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isConversationMessage, isLedgerEntry, isSessionEntry } from '../../src/infra/jsonl-guards.ts';

describe('jsonl guards', () => {
  it('accept valid session entries and reject wrong-shape records', () => {
    assert.equal(
      isSessionEntry({
        timestamp: '2024-01-01T00:00:00.000Z',
        role: 'user',
        content: 'hello',
      }),
      true,
    );
    assert.equal(isSessionEntry(null), false);
    assert.equal(isSessionEntry({}), false);
    assert.equal(isSessionEntry({ timestamp: 123, role: 'user', content: 'bad' }), false);
    assert.equal(isSessionEntry({ timestamp: 'x', role: 'tool', content: 'bad' }), false);
  });

  it('uses the session-entry shape for conversation messages', () => {
    assert.equal(
      isConversationMessage({
        timestamp: '2024-01-01T00:00:00.000Z',
        role: 'assistant',
        content: 'hello',
      }),
      true,
    );
    assert.equal(isConversationMessage({ timestamp: 'x', role: 'assistant' }), false);
  });

  it('accepts valid ledger entries and rejects wrong-shape records', () => {
    assert.equal(
      isLedgerEntry({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'session-1',
        taskId: 'task-1',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        tier: 'ic',
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        usd: 0.01,
        durationMs: 1000,
        success: true,
      }),
      true,
    );
    assert.equal(isLedgerEntry(null), false);
    assert.equal(isLedgerEntry({}), false);
    assert.equal(isLedgerEntry({ usd: 'x' }), false);
    assert.equal(
      isLedgerEntry({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'session-1',
        taskId: 'task-1',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        tier: 'ic',
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        usd: 0.01,
        durationMs: 1000,
        success: 'yes',
      }),
      false,
    );
  });
});
