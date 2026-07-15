/**
 * U1 — enrichOrchestrateDepsWithAccounts (shared menu/detached account enrich).
 * Injectable read/probe; no live network.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { OrchestrateDeps } from '../../src/core/types.ts';
import type { AvailableModelsByAccount } from '../../src/core/execution-lane.ts';
import { enrichOrchestrateDepsWithAccounts } from '../../src/interface/enrich-orchestrate-accounts.ts';
import type {
  SubscriptionAccount,
  SubscriptionsFileV1,
} from '../../src/infra/subscriptions.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { systemClock } from '../../src/infra/clock.ts';

function baseDeps(overrides: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    clock: systemClock,
    policy: DEFAULT_POLICY,
    providers: { claude: {} as never },
    cwd: '/tmp/proj',
    timeoutMs: 1_000,
    availableModels: { claude: ['claude-sonnet-4'], opencode: ['kimi-k2'] },
    ...overrides,
  };
}

function claudeAccount(id: string): SubscriptionAccount {
  return {
    id,
    provider: 'claude',
    kind: 'oauth-sub',
    label: id,
    homeDir: `/homes/${id}`,
    priority: 'medium',
    priorityWeight: 100,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function opencodeAccount(id: string): SubscriptionAccount {
  return {
    id,
    provider: 'opencode',
    label: id,
    pool: 'zen',
    homeDir: `/homes/${id}`,
    priority: 'medium',
    priorityWeight: 100,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function subsFile(accounts: readonly SubscriptionAccount[]): SubscriptionsFileV1 {
  return { version: 1, accounts };
}

describe('enrichOrchestrateDepsWithAccounts (U1)', () => {
  it('sets subscriptionAccounts + availableModelsByAccount from probe rows', async () => {
    const accounts = [claudeAccount('c1'), opencodeAccount('oc1')];
    const probed: AvailableModelsByAccount = {
      claude: { c1: ['claude-opus-4'] },
      opencode: { oc1: ['big-pickle'] },
    };
    const enriched = await enrichOrchestrateDepsWithAccounts(baseDeps(), {
      cwd: '/tmp/proj',
      readSubscriptions: async () => subsFile(accounts),
      probeAvailableModelsByAccount: async () => probed,
    });
    assert.equal(enriched.subscriptionAccounts, accounts);
    assert.deepEqual(enriched.availableModelsByAccount, probed);
    assert.ok(enriched.opencodeAccounts);
    assert.equal(enriched.opencodeAccounts?.length, 1);
    assert.equal(enriched.opencodeAccounts?.[0]?.id, 'oc1');
    assert.ok(enriched.accountCooldownUntil instanceof Map);
    assert.equal(enriched.accountCooldownUntil?.size, 0);
  });

  it('uses provisional fallback when probe returns empty/undefined', async () => {
    const accounts = [claudeAccount('c1'), opencodeAccount('oc1')];
    const enriched = await enrichOrchestrateDepsWithAccounts(baseDeps(), {
      cwd: '/tmp/proj',
      readSubscriptions: async () => subsFile(accounts),
      probeAvailableModelsByAccount: async () => undefined,
    });
    assert.equal(enriched.subscriptionAccounts?.length, 2);
    assert.deepEqual(enriched.availableModelsByAccount, {
      claude: { c1: ['claude-sonnet-4'] },
      opencode: { oc1: ['kimi-k2'] },
    });
  });

  it('leaves base unchanged when no managed accounts', async () => {
    const base = baseDeps();
    const enriched = await enrichOrchestrateDepsWithAccounts(base, {
      cwd: '/tmp/proj',
      readSubscriptions: async () => subsFile([]),
      probeAvailableModelsByAccount: async () => {
        throw new Error('probe must not run with zero accounts');
      },
    });
    assert.equal(enriched, base);
    assert.equal(enriched.subscriptionAccounts, undefined);
    assert.equal(enriched.availableModelsByAccount, undefined);
    assert.equal(enriched.accountCooldownUntil, undefined);
  });

  it('fail-soft: subscription read failure returns base', async () => {
    const base = baseDeps();
    const enriched = await enrichOrchestrateDepsWithAccounts(base, {
      cwd: '/tmp/proj',
      readSubscriptions: async () => {
        throw new Error('disk full');
      },
    });
    assert.equal(enriched, base);
  });

  it('fail-soft: probe throw falls back to provisional, still attaches accounts', async () => {
    const accounts = [claudeAccount('c1')];
    const enriched = await enrichOrchestrateDepsWithAccounts(baseDeps(), {
      cwd: '/tmp/proj',
      readSubscriptions: async () => subsFile(accounts),
      probeAvailableModelsByAccount: async () => {
        throw new Error('probe crash');
      },
    });
    assert.equal(enriched.subscriptionAccounts?.length, 1);
    assert.deepEqual(enriched.availableModelsByAccount, {
      claude: { c1: ['claude-sonnet-4'] },
    });
  });

  it('keeps pre-set availableModelsByAccount (does not re-probe)', async () => {
    let probeCalls = 0;
    const preset: AvailableModelsByAccount = {
      claude: { c1: ['already-set'] },
    };
    const enriched = await enrichOrchestrateDepsWithAccounts(
      baseDeps({ availableModelsByAccount: preset }),
      {
        cwd: '/tmp/proj',
        readSubscriptions: async () => subsFile([claudeAccount('c1')]),
        probeAvailableModelsByAccount: async () => {
          probeCalls += 1;
          return { claude: { c1: ['should-not-win'] } };
        },
      },
    );
    assert.equal(probeCalls, 0);
    assert.deepEqual(enriched.availableModelsByAccount, preset);
  });

  it('passes through provided accountCooldownUntil map', async () => {
    const cool = new Map<string, number>([['c1', 9_999_999_999]]);
    const enriched = await enrichOrchestrateDepsWithAccounts(baseDeps(), {
      cwd: '/tmp/proj',
      accountCooldownUntil: cool,
      readSubscriptions: async () => subsFile([claudeAccount('c1')]),
      probeAvailableModelsByAccount: async () => undefined,
    });
    assert.equal(enriched.accountCooldownUntil, cool);
    assert.equal(enriched.accountCooldownUntil?.get('c1'), 9_999_999_999);
  });

  it('omits availableModelsByAccount row when probe empty and no global models', async () => {
    const enriched = await enrichOrchestrateDepsWithAccounts(
      baseDeps({ availableModels: undefined }),
      {
        cwd: '/tmp/proj',
        readSubscriptions: async () => subsFile([claudeAccount('c1')]),
        probeAvailableModelsByAccount: async () => undefined,
      },
    );
    assert.equal(enriched.subscriptionAccounts?.length, 1);
    // Never invent models — key omitted → global fallback per existing rules.
    assert.equal(enriched.availableModelsByAccount, undefined);
  });
});
