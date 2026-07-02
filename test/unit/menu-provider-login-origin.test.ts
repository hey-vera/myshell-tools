/**
 * test/unit/menu-provider-login-origin.test.ts — P0-03e provider-login origin tests.
 *
 * Verifies that MenuLoginOrigin → MenuLoginDestination resolution for provider
 * account create/re-auth never produces enter-chat, and that each provider
 * returns to its list/edit screen.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { LoginResult } from '../../src/commands/login.js';
import {
  resolveMenuLoginDestination,
  type MenuLoginOrigin,
} from '../../src/interface/menu-login-navigation.js';

function successResult(): LoginResult {
  return {
    status: 'success',
    outcomes: [
      { provider: 'claude', status: 'authenticated', method: 'code', attempts: [], fallbackUsed: false },
      { provider: 'codex', status: 'authenticated', method: 'code', attempts: [], fallbackUsed: false },
      { provider: 'grok', status: 'authenticated', method: 'code', attempts: [], fallbackUsed: false },
    ],
  };
}

function cancelledResult(): LoginResult {
  return { status: 'cancelled', outcomes: [] };
}

function failedResult(): LoginResult {
  return { status: 'failed', outcomes: [] };
}

describe('resolveMenuLoginDestination — provider accounts', () => {
  for (const provider of ['claude', 'codex', 'grok'] as const) {
    describe(`${provider} create`, () => {
      it('success returns to provider list (kind: provider-accounts)', () => {
        const origin: MenuLoginOrigin = { kind: 'provider-accounts', provider };
        const dest = resolveMenuLoginDestination(origin, successResult(), true);
        assert.deepStrictEqual(dest, { kind: 'return', origin });
      });

      it('cancelled returns to provider list', () => {
        const origin: MenuLoginOrigin = { kind: 'provider-accounts', provider };
        const dest = resolveMenuLoginDestination(origin, cancelledResult(), false);
        assert.deepStrictEqual(dest, { kind: 'return', origin });
      });

      it('failed returns to provider list', () => {
        const origin: MenuLoginOrigin = { kind: 'provider-accounts', provider };
        const dest = resolveMenuLoginDestination(origin, failedResult(), false);
        assert.deepStrictEqual(dest, { kind: 'return', origin });
      });

      it('does not produce enter-chat as destination', () => {
        const origin: MenuLoginOrigin = { kind: 'provider-accounts', provider };
        const dest = resolveMenuLoginDestination(origin, successResult(), true);
        assert.notStrictEqual(dest.kind, 'enter-chat');
      });
    });

    describe(`${provider} re-auth`, () => {
      const accountId = `acct_${provider}_1`;

      it('success returns to edit screen with same accountId', () => {
        const origin: MenuLoginOrigin = { kind: 'provider-account-edit', provider, accountId };
        const dest = resolveMenuLoginDestination(origin, successResult(), true);
        assert.deepStrictEqual(dest, { kind: 'return', origin });
        assert.strictEqual((dest as { kind: 'return'; origin: typeof origin }).origin.accountId, accountId);
      });

      it('cancelled returns to same edit screen', () => {
        const origin: MenuLoginOrigin = { kind: 'provider-account-edit', provider, accountId };
        const dest = resolveMenuLoginDestination(origin, cancelledResult(), false);
        assert.deepStrictEqual(dest, { kind: 'return', origin });
        assert.strictEqual((dest as { kind: 'return'; origin: typeof origin }).origin.accountId, accountId);
      });

      it('failed returns to same edit screen', () => {
        const origin: MenuLoginOrigin = { kind: 'provider-account-edit', provider, accountId };
        const dest = resolveMenuLoginDestination(origin, failedResult(), false);
        assert.deepStrictEqual(dest, { kind: 'return', origin });
      });

      it('does not produce enter-chat as destination', () => {
        const origin: MenuLoginOrigin = { kind: 'provider-account-edit', provider, accountId };
        const dest = resolveMenuLoginDestination(origin, successResult(), true);
        assert.notStrictEqual(dest.kind, 'enter-chat');
      });
    });
  }

  it('no provider account case can produce enter-chat', () => {
    const result = successResult();
    const origins: MenuLoginOrigin[] = [
      { kind: 'provider-accounts', provider: 'claude' },
      { kind: 'provider-accounts', provider: 'codex' },
      { kind: 'provider-accounts', provider: 'grok' },
      { kind: 'provider-account-edit', provider: 'claude', accountId: 'acct_1' },
      { kind: 'provider-account-edit', provider: 'codex', accountId: 'acct_2' },
      { kind: 'provider-account-edit', provider: 'grok', accountId: 'acct_3' },
    ];
    for (const origin of origins) {
      const dest = resolveMenuLoginDestination(origin, result, true);
      assert.notStrictEqual(
        dest.kind,
        'enter-chat',
        `${origin.kind} ${(origin as { provider: string }).provider} must not produce enter-chat`,
      );
    }
  });

  it('accounts origin returns to accounts on all outcomes', () => {
    const origin: MenuLoginOrigin = { kind: 'accounts' };
    assert.strictEqual(resolveMenuLoginDestination(origin, successResult(), true).kind, 'return');
    assert.strictEqual(resolveMenuLoginDestination(origin, cancelledResult(), false).kind, 'return');
    assert.strictEqual(resolveMenuLoginDestination(origin, failedResult(), false).kind, 'return');
  });

  it('root origin returns root on all outcomes', () => {
    const origin: MenuLoginOrigin = { kind: 'root' };
    assert.strictEqual(resolveMenuLoginDestination(origin, successResult(), true).kind, 'return');
    assert.strictEqual(resolveMenuLoginDestination(origin, cancelledResult(), false).kind, 'return');
    assert.strictEqual(resolveMenuLoginDestination(origin, failedResult(), false).kind, 'return');
  });
});
