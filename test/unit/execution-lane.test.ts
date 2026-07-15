/**
 * test/unit/execution-lane.test.ts — R1.1 atomic execution-lane selection.
 *
 * Covers:
 *  - atomic pairing (never model without matching account when accounts exist)
 *  - auth-failed / unknown excluded
 *  - managed accounts → no ambient fallthrough for that provider
 *  - zero accounts neutrality vs current route() for fixed fixtures
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  accountEntitledToModel,
  deriveInventoryGeneration,
  resolveModelsForAccount,
  routingModelsFromInventories,
  selectExecutionLane,
} from '../../src/core/execution-lane.ts';
import { route } from '../../src/core/route.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import {
  isSubscriptionAccountStructurallyEligible,
  selectSubscriptionAccount,
} from '../../src/core/opencode-account-routing.ts';
import type {
  ClaudeSubscriptionAccount,
  CodexSubscriptionAccount,
  OpencodeSubscriptionAccount,
  SubscriptionAccount,
} from '../../src/infra/subscriptions.js';
import type { ProviderId } from '../../src/providers/port.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    pool: 'zen',
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

// ---------------------------------------------------------------------------
// Structural eligibility (shared with account routing)
// ---------------------------------------------------------------------------

describe('isSubscriptionAccountStructurallyEligible', () => {
  it('accepts active enabled accounts', () => {
    assert.equal(
      isSubscriptionAccountStructurallyEligible(makeClaude({ id: 'c1' }), nowMs),
      true,
    );
  });

  it('rejects auth-failed', () => {
    assert.equal(
      isSubscriptionAccountStructurallyEligible(
        makeClaude({ id: 'c1', status: 'auth-failed' }),
        nowMs,
      ),
      false,
    );
  });

  it('rejects unknown', () => {
    assert.equal(
      isSubscriptionAccountStructurallyEligible(
        makeClaude({ id: 'c1', status: 'unknown' }),
        nowMs,
      ),
      false,
    );
  });

  it('rejects disabled/expired status', () => {
    assert.equal(
      isSubscriptionAccountStructurallyEligible(
        makeClaude({ id: 'c1', status: 'disabled' }),
        nowMs,
      ),
      false,
    );
    assert.equal(
      isSubscriptionAccountStructurallyEligible(
        makeClaude({ id: 'c1', status: 'expired' }),
        nowMs,
      ),
      false,
    );
  });

  it('allows absent status for backward-compat fixtures', () => {
    const a = makeClaude({ id: 'c1' });
    const { status: _s, ...rest } = a;
    assert.equal(
      isSubscriptionAccountStructurallyEligible(
        rest as ClaudeSubscriptionAccount,
        nowMs,
      ),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// selectExecutionLane
// ---------------------------------------------------------------------------

describe('selectExecutionLane', () => {
  const available: ProviderId[] = ['claude', 'codex', 'opencode', 'grok'];

  it('zero managed accounts: matches route() provider+model with account null', () => {
    const expected = route('ic', available, DEFAULT_POLICY);
    const result = selectExecutionLane({
      tier: 'ic',
      available,
      policy: DEFAULT_POLICY,
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, expected.provider);
    assert.equal(result.lane.model, expected.model);
    assert.equal(result.lane.tier, expected.tier);
    assert.equal(result.lane.account, null);
  });

  it('atomic pairing: returns provider+model+account together when accounts exist', () => {
    const c1 = makeClaude({ id: 'claude-primary', priority: 'high', priorityWeight: 200 });
    const result = selectExecutionLane({
      tier: 'ic',
      available,
      policy: DEFAULT_POLICY,
      accounts: [c1],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'claude');
    assert.ok(result.lane.model.length > 0);
    assert.ok(result.lane.account !== null);
    assert.equal(result.lane.account!.id, 'claude-primary');
    assert.equal(result.lane.account!.provider, result.lane.provider);
  });

  it('never pairs a model to a different provider account', () => {
    const codex = makeCodex({ id: 'codex-only' });
    // claude is first in policy order but has no managed account → ambient OK
    // codex has managed → must pair if chosen
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude', 'codex'],
      policy: DEFAULT_POLICY,
      accounts: [codex],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    if (result.lane.provider === 'codex') {
      assert.ok(result.lane.account !== null);
      assert.equal(result.lane.account!.id, 'codex-only');
    } else {
      // ambient claude: no account
      assert.equal(result.lane.account, null);
      assert.equal(result.lane.provider, 'claude');
    }
  });

  it('excludes auth-failed accounts from selection', () => {
    const bad = makeClaude({ id: 'bad', status: 'auth-failed' });
    const good = makeCodex({ id: 'good', status: 'active' });
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude', 'codex'],
      policy: DEFAULT_POLICY,
      accounts: [bad, good],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // claude has managed inventory but none eligible → blocked, codex wins
    assert.equal(result.lane.provider, 'codex');
    assert.equal(result.lane.account!.id, 'good');
  });

  it('excludes unknown-status accounts', () => {
    const unk = makeClaude({ id: 'unk', status: 'unknown' });
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      accounts: [unk],
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

  it('managed accounts: no ambient fallthrough when none eligible', () => {
    const failed = makeClaude({ id: 'f1', status: 'auth-failed' });
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      accounts: [failed],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'no_eligible_lane');
    assert.deepEqual(result.failure.blockedProviders, ['claude']);
  });

  it('managed accounts on preferred provider skip to next eligible lane', () => {
    const failedClaude = makeClaude({ id: 'c-bad', status: 'auth-failed' });
    const goodCodex = makeCodex({ id: 'cx-good', status: 'active' });
    const baseline = route('ic', ['claude', 'codex'], DEFAULT_POLICY);
    // Policy prefers claude — without R1.1 we'd get claude + ambient (null account).
    assert.equal(baseline.provider, 'claude');

    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude', 'codex'],
      policy: DEFAULT_POLICY,
      accounts: [failedClaude, goodCodex],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'codex');
    assert.equal(result.lane.account!.id, 'cx-good');
  });

  it('selectSubscriptionAccount also excludes auth-failed', () => {
    const bad = makeClaude({ id: 'bad', status: 'auth-failed' });
    const good = makeClaude({ id: 'good', status: 'active', priorityWeight: 50 });
    const picked = selectSubscriptionAccount({
      accounts: [bad, good],
      provider: 'claude',
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.ok(picked !== null);
    assert.equal(picked!.id, 'good');
  });

  it('legacy opencodeAccounts still pair without ambient when ineligible', () => {
    const bad = makeOpencode({ id: 'oc-bad', status: 'auth-failed' });
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['opencode'],
      policy: DEFAULT_POLICY,
      opencodeAccounts: [bad],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.failure.blockedProviders.includes('opencode'));
  });

  it('empty accounts array is neutral (ambient)', () => {
    const expected = route('worker', ['claude'], DEFAULT_POLICY);
    const result = selectExecutionLane({
      tier: 'worker',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      accounts: [] as readonly SubscriptionAccount[],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, expected.provider);
    assert.equal(result.lane.model, expected.model);
    assert.equal(result.lane.account, null);
  });
});

// ---------------------------------------------------------------------------
// R1.3b — inventory generation on lane snapshot
// ---------------------------------------------------------------------------

describe('inventoryGeneration (R1.3b)', () => {
  const available: ProviderId[] = ['claude', 'codex'];

  it('same inventory → same generation (order-independent)', () => {
    const modelsA = {
      claude: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      codex: ['gpt-5.3-codex'],
    };
    const modelsB = {
      codex: ['gpt-5.3-codex'],
      claude: ['claude-opus-4-8', 'claude-sonnet-4-6'],
    };
    const a = deriveInventoryGeneration({ availableModels: modelsA });
    const b = deriveInventoryGeneration({ availableModels: modelsB });
    assert.equal(a, b);
    assert.match(String(a), /^ig-[0-9a-f]{8}$/);
  });

  it('different models → different generation', () => {
    const a = deriveInventoryGeneration({
      availableModels: { claude: ['model-a'] },
    });
    const b = deriveInventoryGeneration({
      availableModels: { claude: ['model-b'] },
    });
    assert.notEqual(a, b);
  });

  it('different accounts → different generation', () => {
    const a = deriveInventoryGeneration({
      availableModels: { claude: ['m1'] },
      accounts: [{ id: 'acc-1', provider: 'claude' }],
    });
    const b = deriveInventoryGeneration({
      availableModels: { claude: ['m1'] },
      accounts: [{ id: 'acc-2', provider: 'claude' }],
    });
    assert.notEqual(a, b);
  });

  it('ok lane carries content-derived inventoryGeneration', () => {
    const availableModels = {
      claude: ['claude-sonnet-4-6'],
      codex: ['gpt-5.3-codex'],
    };
    const expected = deriveInventoryGeneration({ availableModels });
    const result = selectExecutionLane({
      tier: 'ic',
      available,
      policy: DEFAULT_POLICY,
      availableModels,
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.inventoryGeneration, expected);
  });

  it('explicit inventoryGeneration is frozen on the lane', () => {
    const result = selectExecutionLane({
      tier: 'ic',
      available,
      policy: DEFAULT_POLICY,
      availableModels: { claude: ['claude-sonnet-4-6'] },
      inventoryGeneration: 42,
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.inventoryGeneration, 42);
  });

  it('string inventoryGeneration token is preserved', () => {
    const result = selectExecutionLane({
      tier: 'ic',
      available,
      policy: DEFAULT_POLICY,
      inventoryGeneration: 'probe-gen-7',
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.inventoryGeneration, 'probe-gen-7');
  });

  it('accounts participate in derived generation on lane', () => {
    const c1 = makeClaude({ id: 'claude-primary' });
    const availableModels = { claude: ['claude-sonnet-4-6'] };
    const expected = deriveInventoryGeneration({
      availableModels,
      accounts: [c1],
    });
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels,
      accounts: [c1],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.inventoryGeneration, expected);
    assert.equal(result.lane.account!.id, 'claude-primary');
  });

  it('per-account model rows participate in derived generation', () => {
    const a = deriveInventoryGeneration({
      availableModelsByAccount: {
        claude: { 'acc-a': ['model-a'], 'acc-b': ['model-b'] },
      },
    });
    const b = deriveInventoryGeneration({
      availableModelsByAccount: {
        claude: { 'acc-a': ['model-a'], 'acc-b': ['model-c'] },
      },
    });
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// R1.5 — per-account model inventory (no silent cross-entitlement pairing)
// ---------------------------------------------------------------------------

describe('per-account model inventory (R1.5)', () => {
  it('resolveModelsForAccount prefers account row over global', () => {
    const list = resolveModelsForAccount(
      'claude',
      'acc-a',
      { claude: { 'acc-a': ['only-a'], 'acc-b': ['only-b'] } },
      { claude: ['global-model'] },
    );
    assert.deepEqual(list, ['only-a']);
  });

  it('resolveModelsForAccount falls back to global when map/provider absent', () => {
    const list = resolveModelsForAccount(
      'claude',
      'acc-a',
      undefined,
      { claude: ['global-model'] },
    );
    assert.deepEqual(list, ['global-model']);
  });

  it('accountEntitledToModel refuses cross-account models', () => {
    const byAccount = {
      claude: { 'acc-a': ['only-a'], 'acc-b': ['only-b'] },
    };
    assert.equal(
      accountEntitledToModel('claude', 'acc-a', 'only-a', byAccount, undefined),
      true,
    );
    assert.equal(
      accountEntitledToModel('claude', 'acc-a', 'only-b', byAccount, undefined),
      false,
    );
    assert.equal(
      accountEntitledToModel('claude', 'acc-b', 'only-b', byAccount, undefined),
      true,
    );
  });

  it('routingModelsFromInventories unions per-account lists', () => {
    const merged = routingModelsFromInventories({
      availableModelsByAccount: {
        claude: { 'acc-a': ['only-a'], 'acc-b': ['only-b'] },
      },
      accounts: [
        makeClaude({ id: 'acc-a' }),
        makeClaude({ id: 'acc-b' }),
      ],
    });
    assert.ok(merged !== undefined);
    assert.deepEqual([...(merged!.claude ?? [])].sort(), ['only-a', 'only-b']);
  });

  it('never pairs account A with a model only listed under account B', () => {
    // Global + sticky would attach high-priority acc-a to the IC pricing model.
    // Per-account rows must force the account that actually lists that model.
    const sonnet = 'claude-sonnet-4-6';
    const accA = makeClaude({
      id: 'acc-a',
      priority: 'high',
      priorityWeight: 500,
    });
    const accB = makeClaude({
      id: 'acc-b',
      priority: 'low',
      priorityWeight: 10,
    });
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: { claude: [sonnet] },
      availableModelsByAccount: {
        claude: {
          'acc-a': ['model-only-a'],
          'acc-b': [sonnet],
        },
      },
      accounts: [accA, accB],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'claude');
    assert.equal(result.lane.model, sonnet);
    assert.ok(result.lane.account !== null);
    assert.equal(result.lane.account!.id, 'acc-b');
    assert.notEqual(result.lane.account!.id, 'acc-a');
  });

  it('selected model is never entitled only on the other account', () => {
    const sonnet = 'claude-sonnet-4-6';
    const accA = makeClaude({ id: 'acc-a', priorityWeight: 100 });
    const accB = makeClaude({ id: 'acc-b', priorityWeight: 100 });
    const byAccount = {
      claude: {
        'acc-a': ['model-only-a'],
        'acc-b': [sonnet],
      },
    } as const;

    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: { claude: [sonnet, 'model-only-a'] },
      availableModelsByAccount: byAccount,
      accounts: [accA, accB],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'spread',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'claude');
    assert.ok(result.lane.account !== null);
    const owner = result.lane.account!.id;
    const model = result.lane.model;
    assert.equal(
      accountEntitledToModel('claude', owner, model, byAccount, undefined),
      true,
    );
    const other = owner === 'acc-a' ? 'acc-b' : 'acc-a';
    assert.equal(
      accountEntitledToModel('claude', other, model, byAccount, undefined),
      false,
    );
  });

  it('falls back to provider-global availableModels when per-account map absent', () => {
    const accA = makeClaude({
      id: 'acc-a',
      priority: 'high',
      priorityWeight: 500,
    });
    const accB = makeClaude({
      id: 'acc-b',
      priority: 'low',
      priorityWeight: 10,
    });
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: { claude: ['claude-sonnet-4-6'] },
      accounts: [accA, accB],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // No per-account map → sticky high-priority account may run global model.
    assert.equal(result.lane.account!.id, 'acc-a');
    assert.equal(result.lane.model, 'claude-sonnet-4-6');
  });

  it('fails closed when no account is entitled to the routable model', () => {
    const accA = makeClaude({ id: 'acc-a' });
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: { claude: ['claude-sonnet-4-6'] },
      availableModelsByAccount: {
        claude: {
          'acc-a': ['model-only-a'],
        },
      },
      accounts: [accA],
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'no_eligible_lane');
    assert.ok(result.failure.blockedProviders.includes('claude'));
    assert.match(result.failure.message, /per-account inventory|entitled/i);
  });
});
