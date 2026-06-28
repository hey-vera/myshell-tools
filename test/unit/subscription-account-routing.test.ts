/**
 * test/unit/subscription-account-routing.test.ts — unit tests for the
 * generalized subscription account selector (Slice 2 Half A).
 *
 * Covers selectSubscriptionAccount across providers while preserving
 * the existing opencode-account-routing.test.ts imports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectOpencodeAccount,
  selectSubscriptionAccount,
} from '../../src/core/opencode-account-routing.ts';
import type {
  OpencodeSubscriptionAccount,
  ClaudeSubscriptionAccount,
  SubscriptionAccount,
} from '../../src/infra/subscriptions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// selectSubscriptionAccount — generic provider tests
// ---------------------------------------------------------------------------

describe('selectSubscriptionAccount', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  it('selects matching claude account', () => {
    const c1 = makeClaude({ id: 'c1', priority: 'high', priorityWeight: 200 });
    const result = selectSubscriptionAccount({
      accounts: [c1],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c1');
    assert.equal(result!.provider, 'claude');
  });

  it('filters wrong provider', () => {
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

  it('openCode accounts respect pool filter', () => {
    const zen = makeOpencode({ id: 'zen-a', pool: 'zen' });
    const go = makeOpencode({ id: 'go-a', pool: 'go' });

    const result = selectSubscriptionAccount({
      accounts: [zen, go],
      provider: 'opencode',
      pool: 'go',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'go-a');
  });

  it('claude accounts ignore pool (pool undefined for non-opencode)', () => {
    const c1 = makeClaude({ id: 'c1', priority: 'low', priorityWeight: 25 });
    const c2 = makeClaude({ id: 'c2', priority: 'high', priorityWeight: 200 });
    // Both 0 tokens → load = 0 for both. Same createdAt → lexical: c1 < c2
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c1'); // lexical tiebreak
  });

  it('filters disabled accounts', () => {
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

  it('filters disabled priority (weight=0)', () => {
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

  it('filters expired accounts', () => {
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

  it('cooling account excluded when sibling available', () => {
    const cd = new Map<string, number>([['c1', nowMs + 60_000]]);
    const c1 = makeClaude({ id: 'c1' });
    const c2 = makeClaude({ id: 'c2', priority: 'low', priorityWeight: 25 });
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'claude',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c2'); // c1 cooling, c2 available
  });

  it('never-strands: returns one of all-cooling candidates', () => {
    const cd = new Map<string, number>([
      ['c1', nowMs + 60_000],
      ['c2', nowMs + 120_000],
    ]);
    const c1 = makeClaude({ id: 'c1' });
    const c2 = makeClaude({ id: 'c2' });
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'claude',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.ok(result!.id === 'c1' || result!.id === 'c2');
  });

  it('picks minimum normalized load', () => {
    const c1 = makeClaude({ id: 'c1', priority: 'low', priorityWeight: 25 });
    const c2 = makeClaude({ id: 'c2', priority: 'high', priorityWeight: 200 });
    // c1: 10/25 = 0.4, c2: 100/200 = 0.5 → c1 wins
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { 'c1': 10, 'c2': 100 },
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c1');
  });

  it('stable tiebreaker: same load, createdAt then id lexical', () => {
    const a = makeClaude({
      id: 'aaa',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const b = makeClaude({
      id: 'aab',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const result = selectSubscriptionAccount({
      accounts: [b, a],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'aaa');
  });

  it('returns null for empty accounts', () => {
    const result = selectSubscriptionAccount({
      accounts: [] as SubscriptionAccount[],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// selectOpencodeAccount wrapper still works
// ---------------------------------------------------------------------------

describe('selectOpencodeAccount (compatibility wrapper)', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  it('returns the matching-pool opencode account', () => {
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
  });
});
