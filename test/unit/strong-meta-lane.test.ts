/**
 * test/unit/strong-meta-lane.test.ts — R1.2 live strong-meta lane selection.
 *
 * Covers:
 *  - no dated hard-coded model ids in the selector path
 *  - meta pick uses a model from fixture availableModels inventory
 *  - auth-failed managed account is not ambient-fallthrough when alternatives exist
 *  - managed-only ineligible → no_eligible_lane (no ambient)
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { selectStrongMetaLane } from '../../src/core/strong-meta-lane.ts';
import { POLICY_PRESETS } from '../../src/core/policy.ts';
import type {
  ClaudeSubscriptionAccount,
  CodexSubscriptionAccount,
  OpencodeSubscriptionAccount,
  SubscriptionAccount,
} from '../../src/infra/subscriptions.js';

const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();
const createdAt = '2026-06-01T00:00:00.000Z';

function makeClaude(
  overrides: Partial<ClaudeSubscriptionAccount> & { id: string },
): ClaudeSubscriptionAccount {
  return {
    id: overrides.id,
    provider: 'claude',
    kind: 'oauth-sub',
    label: overrides.id,
    homeDir: `/tmp/provider-homes/claude/${overrides.id}`,
    priority: 'medium',
    priorityWeight: 100,
    enabled: true,
    createdAt,
    status: 'active',
    ...overrides,
  };
}

function makeCodex(
  overrides: Partial<CodexSubscriptionAccount> & { id: string },
): CodexSubscriptionAccount {
  return {
    id: overrides.id,
    provider: 'codex',
    kind: 'oauth-sub',
    label: overrides.id,
    homeDir: `/tmp/provider-homes/codex/${overrides.id}`,
    priority: 'medium',
    priorityWeight: 100,
    enabled: true,
    createdAt,
    status: 'active',
    ...overrides,
  };
}

function makeOpencode(
  overrides: Partial<OpencodeSubscriptionAccount> & { id: string },
): OpencodeSubscriptionAccount {
  return {
    provider: 'opencode',
    label: overrides.id,
    pool: 'go',
    homeDir: `/tmp/opencode-accounts/${overrides.id}`,
    priority: 'medium',
    priorityWeight: 100,
    enabled: true,
    createdAt,
    status: 'active',
    ...overrides,
    id: overrides.id,
  };
}

const emptyCooldown = new Map<string, number>();

describe('selectStrongMetaLane', () => {
  it('picks a model from fixture availableModels (opencode inventory is authoritative)', () => {
    // opencode's route path uses selectOpencodeModel → first availableModels entry.
    const inventory = [
      'opencode-go/fixture-live-manager-abc',
      'opencode-go/fixture-live-secondary',
    ] as const;
    const result = selectStrongMetaLane({
      available: ['opencode'],
      availableModels: { opencode: inventory },
      authenticatedProviders: ['opencode'],
      policy: POLICY_PRESETS['quality-first'],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'opencode');
    assert.ok(
      (inventory as readonly string[]).includes(result.lane.model),
      `expected model from inventory, got ${result.lane.model}`,
    );
    assert.equal(result.lane.model, inventory[0]);
    assert.equal(result.lane.account, null);
  });

  it('constrains codex to advertised pricing-known manager when inventory is set', () => {
    // getCheapestForTier filters to advertised models that match the pricing table.
    // Advertise only the manager codex id → must not invent another id.
    const inventory = ['gpt-5.5'] as const;
    const result = selectStrongMetaLane({
      available: ['codex'],
      availableModels: { codex: inventory },
      authenticatedProviders: ['codex'],
      policy: POLICY_PRESETS['quality-first'],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'codex');
    assert.ok(
      (inventory as readonly string[]).includes(result.lane.model),
      `expected model from inventory, got ${result.lane.model}`,
    );
  });

  it('uses live inventory model for preferred provider (claude manager alias)', () => {
    // Advertise manager-tier id present in pricing; route must stay in inventory.
    const claudeInventory = ['claude-opus-4-7'] as const;
    const result = selectStrongMetaLane({
      available: ['claude', 'codex'],
      availableModels: {
        claude: claudeInventory,
        codex: ['gpt-5.5'],
      },
      authenticatedProviders: ['claude', 'codex'],
      policy: POLICY_PRESETS['quality-first'],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'claude');
    assert.ok((claudeInventory as readonly string[]).includes(result.lane.model));
  });

  it('auth-failed managed account is not used; skips to alternate provider', () => {
    const bad = makeClaude({ id: 'claude-bad', status: 'auth-failed' });
    const good = makeCodex({ id: 'codex-good', status: 'active' });
    const result = selectStrongMetaLane({
      available: ['claude', 'codex'],
      availableModels: {
        claude: ['claude-opus-4-7'],
        codex: ['gpt-5.5'],
      },
      authenticatedProviders: ['claude', 'codex'],
      accounts: [bad, good],
      policy: POLICY_PRESETS['quality-first'],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // claude has managed inventory but only auth-failed → blocked; codex wins.
    assert.equal(result.lane.provider, 'codex');
    assert.equal(result.lane.model, 'gpt-5.5');
    assert.ok(result.lane.account !== null);
    assert.equal(result.lane.account!.id, 'codex-good');
    assert.notEqual(result.lane.account!.id, 'claude-bad');
  });

  it('refuses ambient fallthrough when only managed account is auth-failed', () => {
    const bad = makeClaude({ id: 'only-bad', status: 'auth-failed' });
    const result = selectStrongMetaLane({
      available: ['claude'],
      availableModels: { claude: ['claude-opus-4-7'] },
      authenticatedProviders: ['claude'],
      accounts: [bad] as readonly SubscriptionAccount[],
      policy: POLICY_PRESETS['quality-first'],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'no_eligible_lane');
    assert.ok(result.failure.blockedProviders.includes('claude'));
    assert.match(result.failure.message, /refusing ambient/i);
  });

  it('pairs eligible managed account with selected model', () => {
    const acct = makeClaude({ id: 'claude-primary', priority: 'high', priorityWeight: 200 });
    const result = selectStrongMetaLane({
      available: ['claude'],
      availableModels: { claude: ['claude-opus-4-7'] },
      authenticatedProviders: ['claude'],
      accounts: [acct],
      policy: POLICY_PRESETS['quality-first'],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'claude');
    assert.equal(result.lane.model, 'claude-opus-4-7');
    assert.equal(result.lane.account!.id, 'claude-primary');
  });

  it('pairs opencode managed account for inventory-selected model', () => {
    const acct = makeOpencode({ id: 'oc-go', pool: 'go', status: 'active' });
    const inventory = ['opencode-go/fixture-mgr-from-inventory'] as const;
    const result = selectStrongMetaLane({
      available: ['opencode'],
      availableModels: { opencode: inventory },
      authenticatedProviders: ['opencode'],
      accounts: [acct],
      policy: POLICY_PRESETS['quality-first'],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'opencode');
    assert.equal(result.lane.model, inventory[0]);
    assert.equal(result.lane.account!.id, 'oc-go');
  });

  it('returns no_eligible_lane when available is empty', () => {
    const result = selectStrongMetaLane({
      available: [],
      nowMs,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'no_eligible_lane');
  });

  it('plumbs inventoryGeneration onto the strong-meta lane (R1.3b)', () => {
    const result = selectStrongMetaLane({
      available: ['codex'],
      availableModels: { codex: ['gpt-5.5'] },
      authenticatedProviders: ['codex'],
      inventoryGeneration: 99,
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.inventoryGeneration, 99);
  });
});

describe('strong-meta source hygiene (no dated bypass table)', () => {
  it('strong-meta-lane.ts has no dated model id string literals from the old table', () => {
    const srcPath = join(process.cwd(), 'src/core/strong-meta-lane.ts');
    const src = readFileSync(srcPath, 'utf8');
    for (const banned of [
      'claude-opus-4-8',
      'gpt-5.5',
      'opencode-go/kimi-k2.7-code',
    ] as const) {
      assert.equal(
        src.includes(`'${banned}'`) || src.includes(`"${banned}"`),
        false,
        `strong-meta-lane must not hard-code dated model id ${banned}`,
      );
    }
  });

  it('menu.ts strong-meta path has no dated model id return literals', () => {
    const srcPath = join(process.cwd(), 'src/interface/menu.ts');
    const src = readFileSync(srcPath, 'utf8');
    const start = src.indexOf('selectStrongMetaLane');
    assert.ok(start >= 0, 'menu must call selectStrongMetaLane');
    assert.equal(
      src.includes("model: 'claude-opus-4-8'"),
      false,
      'menu must not hard-code claude-opus-4-8 for strong meta',
    );
    assert.equal(
      src.includes("model: 'gpt-5.5'"),
      false,
      'menu must not hard-code gpt-5.5 for strong meta',
    );
    assert.equal(
      src.includes("model: 'opencode-go/kimi-k2.7-code'"),
      false,
      'menu must not hard-code kimi-k2.7-code for strong meta',
    );
  });
});
