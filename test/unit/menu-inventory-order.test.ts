import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { deriveBaselineOrder } from '../../src/core/capacity-allocator.ts';
import { subscriptionInventoryFromEnvironment } from '../../src/interface/menu-auto-mode.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';

type ProviderStatusWithPlan = EnvironmentStatus['claude'] & { readonly plan?: string | null };

function makeProvider(
  id: 'claude' | 'codex' | 'opencode' | 'grok',
  opts: {
    installed?: boolean;
    authenticated?: boolean;
    plan?: string | null;
  } = {},
): ProviderStatusWithPlan {
  const installed = opts.installed ?? true;
  return {
    id,
    installed,
    version: installed ? '1.0.0' : null,
    authenticated: opts.authenticated ?? false,
    plan: opts.plan ?? null,
    binaryPath: installed ? id : null,
    availableModels: installed ? ['model-a'] : [],
  } as ProviderStatusWithPlan;
}

function makeEnv(overrides: Partial<EnvironmentStatus> = {}): EnvironmentStatus {
  return {
    claude: makeProvider('claude'),
    codex: makeProvider('codex'),
    opencode: makeProvider('opencode', { installed: false }),
    grok: makeProvider('grok', { installed: false }),
    hasAnyProvider: true,
    platform: 'linux',
    ...overrides,
  };
}

describe('subscriptionInventoryFromEnvironment', () => {
  it('includes only authenticated providers and classifies their plans', () => {
    const inventory = subscriptionInventoryFromEnvironment(makeEnv({
      claude: makeProvider('claude', { authenticated: true, plan: 'free' }),
      codex: makeProvider('codex', { authenticated: true, plan: 'high capacity pro' }),
      opencode: makeProvider('opencode', { authenticated: false, plan: 'business' }),
    }));

    assert.deepEqual(inventory, [
      { provider: 'claude', tier: 'free', weight: 0.25, confidence: 'observed' },
      { provider: 'codex', tier: 'paid-high', weight: 5, confidence: 'observed' },
    ]);
  });
});

describe('inventory-derived baseline order', () => {
  it('puts Codex first when it has strictly higher observed capacity than free Claude', () => {
    const inventory = subscriptionInventoryFromEnvironment(makeEnv({
      claude: makeProvider('claude', { authenticated: true, plan: 'free' }),
      codex: makeProvider('codex', { authenticated: true, plan: 'high capacity pro' }),
    }));
    const order = deriveBaselineOrder(inventory);

    assert.deepEqual(order.ic, ['codex', 'claude', 'opencode']);
    assert.deepEqual(order.manager, ['codex', 'claude', 'opencode']);
  });

  it('stays canonical for a single authenticated Claude provider', () => {
    const inventory = subscriptionInventoryFromEnvironment(makeEnv({
      claude: makeProvider('claude', { authenticated: true, plan: 'pro' }),
      codex: makeProvider('codex', { authenticated: false }),
      opencode: makeProvider('opencode', { installed: false, authenticated: false }),
    }));
    const order = deriveBaselineOrder(inventory);

    assert.deepEqual(order.worker, ['claude', 'codex', 'opencode']);
  });

  it('stays canonical for equal or unknown inventories', () => {
    const equalInventory = subscriptionInventoryFromEnvironment(makeEnv({
      claude: makeProvider('claude', { authenticated: true, plan: 'pro' }),
      codex: makeProvider('codex', { authenticated: true, plan: 'plus' }),
      opencode: makeProvider('opencode', { authenticated: true, plan: 'team' }),
    }));
    const unknownInventory = subscriptionInventoryFromEnvironment(makeEnv({
      claude: makeProvider('claude', { authenticated: true, plan: null }),
      codex: makeProvider('codex', { authenticated: true, plan: 'starter' }),
      opencode: makeProvider('opencode', { authenticated: true, plan: null }),
    }));

    assert.deepEqual(deriveBaselineOrder(equalInventory).worker, ['claude', 'codex', 'opencode']);
    assert.deepEqual(deriveBaselineOrder(unknownInventory).worker, ['claude', 'codex', 'opencode']);
  });
});
