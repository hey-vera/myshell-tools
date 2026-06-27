/**
 * Unit tests for src/infra/jsonl-guards.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isConversationMessage, isLedgerEntry, isSessionEntry, isWorkTrace } from '../../src/infra/jsonl-guards.ts';

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

  it('accepts session entries without workTrace and rejects malformed present workTrace', () => {
    const base = {
      timestamp: '2024-01-01T00:00:00.000Z',
      role: 'assistant',
      content: 'done',
    };

    assert.equal(isSessionEntry(base), true);
    assert.equal(
      isSessionEntry({
        ...base,
        workTrace: {
          version: 1,
          objective: 'ship the feature',
          roadmap: [{ id: 'R1', text: 'implement', status: 'done' }],
          checkpoints: [{ id: 'C1', summary: 'tests pass', evidence: 'npm test' }],
          verification: { verdict: 'approve', failedCheckpointIds: [] },
        },
      }),
      true,
    );
    assert.equal(isSessionEntry({ ...base, workTrace: { version: 2, objective: 'ship' } }), false);
    assert.equal(isSessionEntry({ ...base, workTrace: { version: 1, objective: 42 } }), false);
    assert.equal(
      isSessionEntry({ ...base, workTrace: { version: 1, objective: 'ship', roadmap: {} } }),
      false,
    );
  });

  it('validates workTrace shape directly', () => {
    assert.equal(
      isWorkTrace({
        version: 1,
        objective: 'ship',
        vision: 'keep behavior stable',
        roadmap: [{ id: 'R1', text: 'patch', status: 'active' }],
        checkpoints: [{ id: 'C1', summary: 'patched', roadmapId: 'R1' }],
        verification: { verdict: 'revise', notes: 'missing test', failedCheckpointIds: ['C1'] },
      }),
      true,
    );
    assert.equal(isWorkTrace(undefined), false);
    assert.equal(isWorkTrace({ version: 1 }), false);
    assert.equal(isWorkTrace({ version: 1, objective: 'ship', roadmap: 'R1' }), false);
    assert.equal(
      isWorkTrace({ version: 1, objective: 'ship', checkpoints: [{ id: 'C1', summary: 9 }] }),
      false,
    );
    assert.equal(
      isWorkTrace({ version: 1, objective: 'ship', verification: { verdict: 'retry' } }),
      false,
    );
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

  it('valid ledger with cacheWriteInputTokens passes', () => {
    assert.equal(
      isLedgerEntry({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 's1',
        taskId: 't1',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        tier: 'ic',
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 2201,
        usd: 0.01,
        durationMs: 1000,
        success: true,
      }),
      true,
    );
  });

  it('ledger with non-number cacheWriteInputTokens fails', () => {
    assert.equal(
      isLedgerEntry({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 's1',
        taskId: 't1',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        tier: 'ic',
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 'not-a-number',
        usd: 0.01,
        durationMs: 1000,
        success: true,
      }),
      false,
    );
  });

  it('ledger without cacheWriteInputTokens still passes', () => {
    assert.equal(
      isLedgerEntry({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 's1',
        taskId: 't1',
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
  });
});
