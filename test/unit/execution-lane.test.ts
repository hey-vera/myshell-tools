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

import { selectExecutionLane } from '../../src/core/execution-lane.ts';
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
