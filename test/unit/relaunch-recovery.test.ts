import { afterAll, beforeAll, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;

vi.mock('../../src/infra/state-layout.ts', () => ({
  defaultStateLayout: () => ({
    paths: {
      relaunchRecoveryFile: join(dir, 'relaunch-recovery.json'),
    },
  }),
}));

import {
  readRelaunchRecoveryState,
  checkRelaunchGuard,
  recordRelaunchAttempt,
  clearRelaunchRecoveryState,
  buildRecoveryEnv,
  isRecoveryRelaunch,
  getRecoveryConversationId,
  getRecoveryReason,
} from '../../src/infra/relaunch-recovery.ts';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relaunch-recovery-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearRelaunchRecoveryState();
});

describe('readRelaunchRecoveryState', () => {
  it('returns empty state when no file exists', async () => {
    const state = await readRelaunchRecoveryState();
    assert.equal(state.version, 1);
    assert.deepEqual(state.attempts, []);
  });
});

describe('checkRelaunchGuard', () => {
  it('allows when no attempts exist', () => {
    const result = checkRelaunchGuard({ version: 1, attempts: [] }, 'conv-1');
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'allowed');
  });

  it('blocks after 2 per-conversation attempts in 10 minutes', () => {
    const now = Date.now();
    const state = {
      version: 1 as const,
      attempts: [
        { at: new Date(now - 5 * 60_000).toISOString(), pid: 1, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
        { at: new Date(now - 3 * 60_000).toISOString(), pid: 2, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
      ],
    };
    const result = checkRelaunchGuard(state, 'conv-1', now);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'per-conversation-limit');
    assert.equal(result.conversationAttemptsInWindow, 2);
  });

  it('allows attempts for a different conversation', () => {
    const now = Date.now();
    const state = {
      version: 1 as const,
      attempts: [
        { at: new Date(now - 5 * 60_000).toISOString(), pid: 1, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
        { at: new Date(now - 3 * 60_000).toISOString(), pid: 2, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
      ],
    };
    const result = checkRelaunchGuard(state, 'conv-2', now);
    assert.equal(result.allowed, true);
  });

  it('blocks after 3 global attempts in 30 minutes', () => {
    const now = Date.now();
    const state = {
      version: 1 as const,
      attempts: [
        { at: new Date(now - 25 * 60_000).toISOString(), pid: 1, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
        { at: new Date(now - 15 * 60_000).toISOString(), pid: 2, conversationId: 'conv-2', reason: 'watchdog-unresponsive' },
        { at: new Date(now - 5 * 60_000).toISOString(), pid: 3, conversationId: 'conv-3', reason: 'watchdog-unresponsive' },
      ],
    };
    const result = checkRelaunchGuard(state, 'conv-4', now);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'global-limit');
    assert.equal(result.attemptsInWindow, 3);
  });

  it('ignores attempts older than 30 minutes', () => {
    const now = Date.now();
    const state = {
      version: 1 as const,
      attempts: [
        { at: new Date(now - 35 * 60_000).toISOString(), pid: 1, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
        { at: new Date(now - 32 * 60_000).toISOString(), pid: 2, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
        { at: new Date(now - 31 * 60_000).toISOString(), pid: 3, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
      ],
    };
    const result = checkRelaunchGuard(state, 'conv-1', now);
    assert.equal(result.allowed, true);
    assert.equal(result.attemptsInWindow, 0);
  });

  it('per-conversation window is 10 minutes, not 30', () => {
    const now = Date.now();
    const state = {
      version: 1 as const,
      attempts: [
        { at: new Date(now - 12 * 60_000).toISOString(), pid: 1, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
        { at: new Date(now - 11 * 60_000).toISOString(), pid: 2, conversationId: 'conv-1', reason: 'watchdog-unresponsive' },
      ],
    };
    const result = checkRelaunchGuard(state, 'conv-1', now);
    assert.equal(result.allowed, true);
    assert.equal(result.conversationAttemptsInWindow, 0);
  });
});

describe('recordRelaunchAttempt', () => {
  it('records an attempt and persists it', async () => {
    await recordRelaunchAttempt('conv-1', 'watchdog-unresponsive');
    const state = await readRelaunchRecoveryState();
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0]!.conversationId, 'conv-1');
    assert.equal(state.attempts[0]!.reason, 'watchdog-unresponsive');
  });

  it('accumulates multiple attempts', async () => {
    await recordRelaunchAttempt('conv-1', 'watchdog-unresponsive');
    await recordRelaunchAttempt('conv-2', 'watchdog-unresponsive');
    const state = await readRelaunchRecoveryState();
    assert.equal(state.attempts.length, 2);
  });

  it('prunes old attempts when recording', async () => {
    const oldState = {
      version: 1 as const,
      attempts: [
        { at: new Date(Date.now() - 35 * 60_000).toISOString(), pid: 1, conversationId: 'old', reason: 'watchdog-unresponsive' },
      ],
    };
    const { atomicWrite } = await import('../../src/infra/atomic.ts');
    const { defaultStateLayout } = await import('../../src/infra/state-layout.ts');
    const filePath = defaultStateLayout().paths.relaunchRecoveryFile;
    await atomicWrite(filePath, JSON.stringify(oldState), 0o600);
    await recordRelaunchAttempt('conv-1', 'watchdog-unresponsive');
    const state = await readRelaunchRecoveryState();
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0]!.conversationId, 'conv-1');
  });
});

describe('buildRecoveryEnv', () => {
  it('builds correct env vars', () => {
    const env = buildRecoveryEnv('conv-123', 'watchdog-unresponsive');
    assert.equal(env['MYSHELL_RECOVERY_RELAUNCH'], '1');
    assert.equal(env['MYSHELL_RECOVERY_REASON'], 'watchdog-unresponsive');
    assert.equal(env['MYSHELL_RECOVERY_CONVERSATION_ID'], 'conv-123');
  });
});

describe('recovery env helpers', () => {
  it('isRecoveryRelaunch detects env var', () => {
    assert.equal(isRecoveryRelaunch({ MYSHELL_RECOVERY_RELAUNCH: '1' }), true);
    assert.equal(isRecoveryRelaunch({}), false);
    assert.equal(isRecoveryRelaunch({ MYSHELL_RECOVERY_RELAUNCH: '0' }), false);
  });

  it('getRecoveryConversationId reads env var', () => {
    assert.equal(getRecoveryConversationId({ MYSHELL_RECOVERY_CONVERSATION_ID: 'conv-1' }), 'conv-1');
    assert.equal(getRecoveryConversationId({}), null);
  });

  it('getRecoveryReason reads env var', () => {
    assert.equal(getRecoveryReason({ MYSHELL_RECOVERY_REASON: 'watchdog-unresponsive' }), 'watchdog-unresponsive');
    assert.equal(getRecoveryReason({}), null);
  });
});
