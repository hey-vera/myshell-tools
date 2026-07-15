/**
 * Unit tests: per-account model probe (detectSubscriptionAccount +
 * probeAvailableModelsByAccount) with injectable fake detect that returns
 * different models based on account-scoped env.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { ProviderStatus } from '../../src/providers/detect.ts';
import type { SubscriptionAccount } from '../../src/infra/subscriptions.ts';
import {
  detectSubscriptionAccount,
  probeAvailableModelsByAccount,
  type DetectProviderFn,
} from '../../src/infra/subscription-detect.ts';
import { accountEnvFor } from '../../src/infra/subscriptions.ts';

function baseAccount(
  partial: Pick<SubscriptionAccount, 'id' | 'provider' | 'homeDir'> &
    Partial<SubscriptionAccount>,
): SubscriptionAccount {
  const common = {
    id: partial.id,
    label: partial.id,
    homeDir: partial.homeDir,
    priority: 'medium' as const,
    priorityWeight: 100,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  if (partial.provider === 'opencode') {
    return {
      ...common,
      provider: 'opencode',
      pool: 'zen',
    };
  }
  if (partial.provider === 'claude') {
    return {
      ...common,
      provider: 'claude',
      kind: 'oauth-sub',
    };
  }
  if (partial.provider === 'codex') {
    return {
      ...common,
      provider: 'codex',
      kind: 'oauth-sub',
    };
  }
  return {
    ...common,
    provider: 'grok',
    kind: 'oauth-sub',
  };
}

function okStatus(
  id: ProviderStatus['id'],
  models: readonly string[],
  authenticated = true,
): ProviderStatus {
  return {
    id,
    installed: true,
    version: '1.0.0',
    authenticated,
    plan: 'pro',
    binaryPath: `/bin/${id}`,
    availableModels: models,
  };
}

/** Fake detect: models keyed by the account env home value. */
function makeFakeDetect(
  byHome: Readonly<Record<string, { models: readonly string[]; auth?: boolean }>>,
): DetectProviderFn {
  return async (id, opts) => {
    const env = opts?.env ?? {};
    // Match accountEnvFor keys per provider.
    const home =
      (env.CLAUDE_CONFIG_DIR as string | undefined) ??
      (env.CODEX_HOME as string | undefined) ??
      (env.GROK_HOME as string | undefined) ??
      (env.XDG_DATA_HOME as string | undefined) ??
      '';
    const row = byHome[home];
    if (row === undefined) {
      return okStatus(id, [], false);
    }
    return okStatus(id, row.models, row.auth ?? true);
  };
}

describe('detectSubscriptionAccount availableModels', () => {
  it('returns models from env-scoped detect when active', async () => {
    const account = baseAccount({
      id: 'c1',
      provider: 'claude',
      homeDir: '/homes/claude-a',
    });
    const detect = makeFakeDetect({
      '/homes/claude-a': { models: ['opus', 'sonnet'] },
    });
    const result = await detectSubscriptionAccount({
      account,
      cwd: '/tmp',
      nowMs: Date.now(),
      detect,
    });
    assert.equal(result.status, 'active');
    assert.deepEqual(result.availableModels, ['opus', 'sonnet']);
  });

  it('omits availableModels on auth-fail', async () => {
    const account = baseAccount({
      id: 'c-fail',
      provider: 'codex',
      homeDir: '/homes/codex-x',
    });
    const detect = makeFakeDetect({
      '/homes/codex-x': { models: ['gpt-5'], auth: false },
    });
    const result = await detectSubscriptionAccount({
      account,
      cwd: '/tmp',
      nowMs: Date.now(),
      detect,
    });
    assert.equal(result.status, 'auth-failed');
    assert.equal(result.availableModels, undefined);
  });

  it('opencode branch uses accountEnv (XDG_DATA_HOME)', async () => {
    const account = baseAccount({
      id: 'oc1',
      provider: 'opencode',
      homeDir: '/homes/oc-zen',
    });
    const env = accountEnvFor(account);
    assert.equal(env.XDG_DATA_HOME, '/homes/oc-zen');

    let seenEnv: NodeJS.ProcessEnv | undefined;
    const detect: DetectProviderFn = async (id, opts) => {
      seenEnv = opts?.env;
      assert.equal(id, 'opencode');
      return okStatus('opencode', ['big-pickle', 'glm']);
    };
    const result = await detectSubscriptionAccount({
      account,
      cwd: '/tmp',
      nowMs: Date.now(),
      detect,
    });
    assert.equal(result.status, 'active');
    assert.deepEqual(result.availableModels, ['big-pickle', 'glm']);
    assert.equal(seenEnv?.XDG_DATA_HOME, '/homes/oc-zen');
  });

  it('omits availableModels when detect returns empty list', async () => {
    const account = baseAccount({
      id: 'g1',
      provider: 'grok',
      homeDir: '/homes/grok-empty',
    });
    const detect = makeFakeDetect({
      '/homes/grok-empty': { models: [] },
    });
    const result = await detectSubscriptionAccount({
      account,
      cwd: '/tmp',
      nowMs: Date.now(),
      detect,
    });
    assert.equal(result.status, 'active');
    assert.equal(result.availableModels, undefined);
  });
});

describe('probeAvailableModelsByAccount', () => {
  it('returns different models per account env in parallel (fail-soft)', async () => {
    const accounts: SubscriptionAccount[] = [
      baseAccount({
        id: 'claude-a',
        provider: 'claude',
        homeDir: '/homes/claude-a',
      }),
      baseAccount({
        id: 'claude-b',
        provider: 'claude',
        homeDir: '/homes/claude-b',
      }),
      baseAccount({
        id: 'codex-1',
        provider: 'codex',
        homeDir: '/homes/codex-1',
      }),
      baseAccount({
        id: 'codex-fail',
        provider: 'codex',
        homeDir: '/homes/codex-fail',
      }),
      baseAccount({
        id: 'oc-1',
        provider: 'opencode',
        homeDir: '/homes/oc-1',
      }),
    ];

    const detect = makeFakeDetect({
      '/homes/claude-a': { models: ['opus-a-only'] },
      '/homes/claude-b': { models: ['sonnet-b-only', 'haiku'] },
      '/homes/codex-1': { models: ['gpt-account-1'] },
      '/homes/codex-fail': { models: ['should-omit'], auth: false },
      '/homes/oc-1': { models: ['zen-model'] },
    });

    const map = await probeAvailableModelsByAccount(accounts, '/tmp', {
      detect,
      nowMs: Date.now(),
    });

    assert.ok(map);
    assert.deepEqual(map.claude?.['claude-a'], ['opus-a-only']);
    assert.deepEqual(map.claude?.['claude-b'], ['sonnet-b-only', 'haiku']);
    assert.deepEqual(map.codex?.['codex-1'], ['gpt-account-1']);
    assert.equal(map.codex?.['codex-fail'], undefined);
    assert.deepEqual(map.opencode?.['oc-1'], ['zen-model']);
  });

  it('returns undefined when all accounts auth-fail or empty', async () => {
    const accounts: SubscriptionAccount[] = [
      baseAccount({
        id: 'x',
        provider: 'grok',
        homeDir: '/homes/x',
      }),
    ];
    const detect = makeFakeDetect({
      '/homes/x': { models: ['m'], auth: false },
    });
    const map = await probeAvailableModelsByAccount(accounts, '/tmp', {
      detect,
    });
    assert.equal(map, undefined);
  });

  it('returns undefined for empty account list', async () => {
    const map = await probeAvailableModelsByAccount([], '/tmp');
    assert.equal(map, undefined);
  });

  it('swallows per-account detect throws (fail-soft)', async () => {
    const accounts: SubscriptionAccount[] = [
      baseAccount({
        id: 'ok',
        provider: 'codex',
        homeDir: '/homes/ok',
      }),
      baseAccount({
        id: 'boom',
        provider: 'codex',
        homeDir: '/homes/boom',
      }),
    ];
    const detect: DetectProviderFn = async (id, opts) => {
      const home = opts?.env?.CODEX_HOME;
      if (home === '/homes/boom') {
        throw new Error('spawn failed');
      }
      return okStatus(id, ['safe-model']);
    };
    const map = await probeAvailableModelsByAccount(accounts, '/tmp', {
      detect,
    });
    assert.deepEqual(map?.codex?.['ok'], ['safe-model']);
    assert.equal(map?.codex?.['boom'], undefined);
  });
});
