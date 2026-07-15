/**
 * test/unit/claude-account-routing.test.ts — unit tests for Claude account
 * routing, env injection, per-account cooldown, and flag-off behaviour
 * (Slice 2 Half B).
 *
 * Tests:
 *  - Claude account selection routes to the chosen account
 *  - buildClaudeEnv carries CLAUDE_CONFIG_DIR and it is NOT shadowed
 *  - Per-account cooldown cools one claude account while sibling stays available
 *  - Expired/disabled claude excluded
 *  - FLAG OFF claude path identical to today (no accountEnv → byte-identical)
 *  - OpenCode account routing still works (regression)
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  selectSubscriptionAccount,
  selectOpencodeAccount,
} from '../../src/core/opencode-account-routing.ts';
import {
  buildAccountScopedBase,
  applyAccountEnvOverride,
} from '../../src/providers/claude.ts';
import type {
  ClaudeSubscriptionAccount,
  OpencodeSubscriptionAccount,
  SubscriptionAccount,
} from '../../src/infra/subscriptions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaude(
  overrides: Partial<ClaudeSubscriptionAccount> & { id: string },
): ClaudeSubscriptionAccount {
  const now = '2026-06-01T00:00:00.000Z';
  return {
    id: overrides.id,
    provider: 'claude',
    kind: 'oauth-sub',
    label: overrides.id,
    homeDir: `/tmp/provider-homes/claude/${overrides.id}`,
    priority: 'medium',
    priorityWeight: 100,
    enabled: true,
    createdAt: now,
    ...overrides,
  };
}

function makeOpencode(
  overrides: Partial<OpencodeSubscriptionAccount> & { id: string },
): OpencodeSubscriptionAccount {
  const now = '2026-06-01T00:00:00.000Z';
  return {
    provider: 'opencode',
    label: overrides.id,
    pool: 'zen',
    homeDir: `/tmp/opencode-accounts/${overrides.id}`,
    priority: 'medium',
    priorityWeight: 100,
    enabled: true,
    createdAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Claude account selection via selectSubscriptionAccount
// ---------------------------------------------------------------------------

describe('claude account selection', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  it('selects a claude account by minimum normalized load', () => {
    const cLow = makeClaude({ id: 'claude-low', priority: 'low', priorityWeight: 25 });
    const cHigh = makeClaude({ id: 'claude-high', priority: 'high', priorityWeight: 200 });
    // cLow: 5/25=0.2, cHigh: 100/200=0.5 → cLow wins
    const result = selectSubscriptionAccount({
      accounts: [cLow, cHigh],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { 'claude-low': 5, 'claude-high': 100 },
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'claude-low');
    assert.equal(result!.provider, 'claude');
  });

  it('returns null when no claude accounts present', () => {
    const zen = makeOpencode({ id: 'zen-a' });
    const result = selectSubscriptionAccount({
      accounts: [zen],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('excludes disabled claude accounts', () => {
    const disabled = makeClaude({ id: 'd1', enabled: false });
    const active = makeClaude({ id: 'a1' });
    const result = selectSubscriptionAccount({
      accounts: [disabled, active],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'a1');
  });

  it('excludes expired claude accounts', () => {
    const expired = makeClaude({
      id: 'exp',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const active = makeClaude({ id: 'a1' });
    const result = selectSubscriptionAccount({
      accounts: [expired, active],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'a1');
  });

  it('excludes disabled-priority claude accounts (weight=0)', () => {
    const d = makeClaude({ id: 'd1', priority: 'disabled', priorityWeight: 0 });
    const result = selectSubscriptionAccount({
      accounts: [d],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Per-account cooldown (claude)
// ---------------------------------------------------------------------------

describe('per-account cooldown — claude', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  const c1 = makeClaude({ id: 'c1', priority: 'low', priorityWeight: 25 });
  const c2 = makeClaude({ id: 'c2', priority: 'high', priorityWeight: 200 });

  it('cooling account c1 leaves sibling c2 available', () => {
    const cd = new Map<string, number>([['c1', nowMs + 300_000]]);
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'claude',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c2');
  });

  it('cooling both claude accounts → null (R3.1: no silent cooling pick)', () => {
    const cd = new Map<string, number>([
      ['c1', nowMs + 300_000],
      ['c2', nowMs + 300_000],
    ]);
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'claude',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('ignores expired cooldown on a claude account', () => {
    const cd = new Map<string, number>([['c1', nowMs - 1000]]); // expired
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'claude',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c1'); // c1 is available again (lower weight → lower load)
  });
});

// ---------------------------------------------------------------------------
// buildAccountScopedBase — pure env composition
// ---------------------------------------------------------------------------

describe('buildAccountScopedBase', () => {
  it('merges accountEnv into parentEnv', () => {
    const result = buildAccountScopedBase(
      { HOME: '/home/user', PATH: '/usr/bin' },
      { CLAUDE_CONFIG_DIR: '/custom/claude-home' },
    );
    assert.equal(result['HOME'], '/home/user');
    assert.equal(result['PATH'], '/usr/bin');
    assert.equal(result['CLAUDE_CONFIG_DIR'], '/custom/claude-home');
  });

  it('accountEnv wins over parentEnv conflicts', () => {
    const result = buildAccountScopedBase(
      { CLAUDE_CONFIG_DIR: '/default' },
      { CLAUDE_CONFIG_DIR: '/account-specific' },
    );
    assert.equal(result['CLAUDE_CONFIG_DIR'], '/account-specific');
  });

  it('returns parentEnv unchanged when accountEnv is undefined', () => {
    const parent = { HOME: '/home/user', PATH: '/usr/bin' };
    const result = buildAccountScopedBase(parent, undefined);
    assert.equal(result, parent); // same reference
  });
});

// ---------------------------------------------------------------------------
// applyAccountEnvOverride — final merge (shadow-proof)
// ---------------------------------------------------------------------------

describe('applyAccountEnvOverride', () => {
  it('CLAUDE_CONFIG_DIR from accountEnv wins over fallback', () => {
    const fallback = {
      HOME: '/home/user',
      CLAUDE_CONFIG_DIR: '/conflict-dir-wrong',
      PATH: '/usr/bin',
    };
    const result = applyAccountEnvOverride(fallback, { CLAUDE_CONFIG_DIR: '/winning-dir' });
    // Account CLAUDE_CONFIG_DIR wins
    assert.equal(result['CLAUDE_CONFIG_DIR'], '/winning-dir');
    // Other fallback vars preserved
    assert.equal(result['HOME'], '/home/user');
    assert.equal(result['PATH'], '/usr/bin');
  });

  it('accountEnv override trumps fallback on conflict', () => {
    const fallback = {
      CLAUDE_CONFIG_DIR: '/default',
    };
    const result = applyAccountEnvOverride(fallback, { CLAUDE_CONFIG_DIR: '/account-home' });
    assert.equal(result['CLAUDE_CONFIG_DIR'], '/account-home');
  });

  it('returns fallbackEnv unchanged when accountEnv is undefined (flag-off)', () => {
    const fallback = { HOME: '/home/user' };
    const result = applyAccountEnvOverride(fallback, undefined);
    assert.equal(result, fallback); // same reference
  });

  it('preserves non-overlapping accountEnv vars', () => {
    const fallback = { HOME: '/home/user' };
    const result = applyAccountEnvOverride(fallback, {
      CLAUDE_CONFIG_DIR: '/custom',
      CUSTOM_VAR: 'custom-value',
    });
    assert.equal(result['CLAUDE_CONFIG_DIR'], '/custom');
    assert.equal(result['CUSTOM_VAR'], 'custom-value');
  });
});

// ---------------------------------------------------------------------------
// OpenCode regression — selectOpencodeAccount still works
// ---------------------------------------------------------------------------

describe('openCode regression — selectOpencodeAccount', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  it('still selects matching-pool opencode account', () => {
    const zen = makeOpencode({ id: 'zen-a', pool: 'zen' });
    const go = makeOpencode({ id: 'go-a', pool: 'go' });
    const result = selectOpencodeAccount({
      accounts: [zen, go],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'zen-a');
    assert.equal(result!.pool, 'zen');
  });

  it('excludes opencode accounts with wrong pool', () => {
    const go = makeOpencode({ id: 'go-a', pool: 'go' });
    const result = selectOpencodeAccount({
      accounts: [go],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('preserves load-based selection with cooldown', () => {
    const a = makeOpencode({ id: 'a', priorityWeight: 100 });
    const b = makeOpencode({ id: 'b', priorityWeight: 25, priority: 'low' });
    const cd = new Map<string, number>([['a', nowMs + 60_000]]);
    const result = selectOpencodeAccount({
      accounts: [a, b],
      pool: 'zen',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'b'); // a cooling, b wins
  });
});

// ---------------------------------------------------------------------------
// Mixed accounts — only matching provider accounts are selected
// ---------------------------------------------------------------------------

describe('mixed provider accounts', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  it('claude selection ignores opencode accounts', () => {
    const claude = makeClaude({ id: 'c1' });
    const opencode = makeOpencode({ id: 'o1' });
    const result = selectSubscriptionAccount({
      accounts: [claude, opencode] as SubscriptionAccount[],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c1');
    assert.equal(result!.provider, 'claude');
  });

  it('opencode selection ignores claude accounts', () => {
    const claude = makeClaude({ id: 'c1' });
    const opencode = makeOpencode({ id: 'o1', pool: 'zen' });
    const result = selectSubscriptionAccount({
      accounts: [claude, opencode] as SubscriptionAccount[],
      provider: 'opencode',
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'o1');
    assert.equal(result!.provider, 'opencode');
  });
});
