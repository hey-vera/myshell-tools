import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  resolveMenuLoginDestination,
  type MenuLoginOrigin,
} from '../../src/interface/menu-login-navigation.js';
import type {
  LoginResult,
  LoginProviderOutcome,
  LoginMethod,
} from '../../src/commands/login.js';
import type { ProviderId } from '../../src/providers/port.js';

function makeAuthOutcome(provider: ProviderId, method: LoginMethod = 'browser'): LoginProviderOutcome {
  return {
    provider,
    status: 'authenticated',
    method,
    attempts: [{ method, status: 'authenticated', childExitCode: 0, verification: 'authenticated' }],
    fallbackUsed: false,
  };
}

function makeFailedOutcome(provider: ProviderId): LoginProviderOutcome {
  return {
    provider,
    status: 'failed',
    method: null,
    attempts: [{ method: 'browser', status: 'failed', childExitCode: 1, verification: 'not-authenticated' }],
    fallbackUsed: false,
  };
}

function makeResult(
  status: LoginResult['status'],
  outcomes: readonly LoginProviderOutcome[],
): LoginResult {
  return { status, outcomes };
}

const NON_CHAT_ORIGINS: readonly MenuLoginOrigin[] = [
  { kind: 'root' },
  { kind: 'accounts' },
  { kind: 'provider-accounts', provider: 'claude' },
  { kind: 'provider-account-edit', provider: 'claude', accountId: 'acc-1' },
];

const STATUSES: LoginResult['status'][] = ['success', 'partial', 'cancelled', 'failed'];

describe('resolveMenuLoginDestination', () => {
  it('every non-chat origin returns its origin for all statuses', () => {
    for (const origin of NON_CHAT_ORIGINS) {
      for (const status of STATUSES) {
        const result = makeResult(status, [makeAuthOutcome('claude')]);
        const dest = resolveMenuLoginDestination(origin, result, true);
        assert.equal(dest.kind, 'return', `${origin.kind} × ${status} → return`);
        assert.strictEqual(
          (dest as { kind: 'return'; origin: MenuLoginOrigin }).origin,
          origin,
          `${origin.kind} × ${status} must return same origin by identity`,
        );
      }
    }
  });

  it('provider account edit preserves provider and accountId by object identity', () => {
    const origin: MenuLoginOrigin = {
      kind: 'provider-account-edit',
      provider: 'codex',
      accountId: 'acc-cx',
    };
    const result = makeResult('success', [makeAuthOutcome('codex')]);
    const dest = resolveMenuLoginDestination(origin, result, false);

    assert.equal(dest.kind, 'return');
    assert.strictEqual(
      (dest as { kind: 'return'; origin: MenuLoginOrigin }).origin,
      origin,
      'origin must be the same object by identity',
    );
    const returned = (dest as { kind: 'return'; origin: MenuLoginOrigin }).origin;
    assert.equal(returned.kind, 'provider-account-edit');
    if (returned.kind === 'provider-account-edit') {
      assert.equal(returned.provider, 'codex');
      assert.equal(returned.accountId, 'acc-cx');
    }
  });

  it('chat aggregate success with stale refresh returns', () => {
    const origin: MenuLoginOrigin = {
      kind: 'chat-entry',
      conversationId: 'conv-1',
      provider: 'claude',
    };
    const result = makeResult('success', [makeAuthOutcome('claude')]);
    const dest = resolveMenuLoginDestination(origin, result, false);

    assert.equal(dest.kind, 'return');
    assert.strictEqual((dest as { kind: 'return'; origin: MenuLoginOrigin }).origin, origin);
  });

  it('fresh refresh with failed outcome returns', () => {
    const origin: MenuLoginOrigin = {
      kind: 'chat-entry',
      conversationId: 'conv-1',
      provider: 'claude',
    };
    const result = makeResult('success', [makeFailedOutcome('claude')]);
    const dest = resolveMenuLoginDestination(origin, result, true);

    assert.equal(dest.kind, 'return');
    assert.strictEqual((dest as { kind: 'return'; origin: MenuLoginOrigin }).origin, origin);
  });

  it('matching authenticated outcome plus fresh refresh enters chat', () => {
    const origin: MenuLoginOrigin = {
      kind: 'chat-entry',
      conversationId: 'conv-1',
      provider: 'claude',
    };
    const result = makeResult('success', [makeAuthOutcome('claude')]);
    const dest = resolveMenuLoginDestination(origin, result, true);

    assert.equal(dest.kind, 'enter-chat');
    assert.equal((dest as { kind: 'enter-chat'; conversationId: string }).conversationId, 'conv-1');
  });

  it('partial aggregate enters only when the requested provider authenticated', () => {
    const origin: MenuLoginOrigin = {
      kind: 'chat-entry',
      conversationId: 'conv-new',
      provider: 'claude',
    };

    // claude authenticated, codex failed — partial result
    const result = makeResult('partial', [
      makeAuthOutcome('claude'),
      makeFailedOutcome('codex'),
    ]);
    const dest = resolveMenuLoginDestination(origin, result, true);

    assert.equal(dest.kind, 'enter-chat');
    assert.equal(
      (dest as { kind: 'enter-chat'; conversationId: string }).conversationId,
      'conv-new',
    );

    // different provider authenticated, requested provider failed → return
    const origin2: MenuLoginOrigin = {
      kind: 'chat-entry',
      conversationId: 'conv-2',
      provider: 'codex',
    };
    const result2 = makeResult('partial', [
      makeAuthOutcome('claude'),
      makeFailedOutcome('codex'),
    ]);
    const dest2 = resolveMenuLoginDestination(origin2, result2, true);

    assert.equal(dest2.kind, 'return');
    assert.strictEqual((dest2 as { kind: 'return'; origin: MenuLoginOrigin }).origin, origin2);
  });

  it('chat retry preserves conversation and provider', () => {
    const origin: MenuLoginOrigin = {
      kind: 'chat-retry',
      conversationId: 'conv-retry',
      provider: 'codex',
    };
    const result = makeResult('success', [makeAuthOutcome('codex')]);
    const dest = resolveMenuLoginDestination(origin, result, true);

    assert.equal(dest.kind, 'retry-chat');
    const rc = dest as { kind: 'retry-chat'; conversationId: string; provider: ProviderId };
    assert.equal(rc.conversationId, 'conv-retry');
    assert.equal(rc.provider, 'codex');
  });
});
