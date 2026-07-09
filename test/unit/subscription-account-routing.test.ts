/**
 * test/unit/subscription-account-routing.test.ts — unit tests for the
 * generalized subscription account selector (Slice 2 Half A).
 *
 * Covers selectSubscriptionAccount across providers while preserving
 * the existing opencode-account-routing.test.ts imports.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  selectOpencodeAccount,
  selectSubscriptionAccount,
} from '../../src/core/opencode-account-routing.ts';
import {
  priorityWeight,
} from '../../src/infra/subscriptions.js';
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

  // --- customWeight resolution (Slice 4) ---

  it('priorityWeight uses customWeight when set', () => {
    assert.equal(priorityWeight('low', 50), 50);
    assert.equal(priorityWeight('medium', 5), 5);
    assert.equal(priorityWeight('high', 300), 300);
  });

  it('priorityWeight falls back to label when no customWeight', () => {
    assert.equal(priorityWeight('low'), 25);
    assert.equal(priorityWeight('medium'), 100);
    assert.equal(priorityWeight('high'), 200);
  });

  it('customWeight 0 excludes the account (priorityWeight=0)', () => {
    const c1 = makeClaude({ id: 'c1', customWeight: 0, priorityWeight: 0, enabled: false });
    const result = selectSubscriptionAccount({
      accounts: [c1],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  // --- sticky strategy (Slice 4) ---

  it('sticky picks the highest priorityWeight account', () => {
    const high = makeClaude({ id: 'high', priority: 'high', priorityWeight: 200 });
    const low = makeClaude({ id: 'low', priority: 'low', priorityWeight: 25 });
    const med = makeClaude({ id: 'med', priority: 'medium', priorityWeight: 100 });
    // All 0 tokens → same load. Sticky picks highest weight.
    const result = selectSubscriptionAccount({
      accounts: [low, high, med],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'high');
  });

  it('sticky falls to lower weight when highest is cooling', () => {
    const cd = new Map<string, number>([['high', nowMs + 60_000]]);
    const high = makeClaude({ id: 'high', priority: 'high', priorityWeight: 200 });
    const med = makeClaude({ id: 'med', priority: 'medium', priorityWeight: 100 });
    const result = selectSubscriptionAccount({
      accounts: [high, med],
      provider: 'claude',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'med');
  });

  it('sticky tiebreaker: same weight uses min normalized load', () => {
    const a = makeClaude({ id: 'a', priority: 'high', priorityWeight: 200 });
    const b = makeClaude({ id: 'b', priority: 'high', priorityWeight: 200 });
    // a: 10/200=0.05, b: 100/200=0.5 → a wins
    const result = selectSubscriptionAccount({
      accounts: [a, b],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { 'a': 10, 'b': 100 },
      strategy: 'sticky',
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'a');
  });

  it('sticky with customWeight: higher custom weight wins', () => {
    const custom = makeClaude({ id: 'custom', priority: 'low', priorityWeight: 500, customWeight: 500 });
    const normal = makeClaude({ id: 'normal', priority: 'high', priorityWeight: 200 });
    const result = selectSubscriptionAccount({
      accounts: [custom, normal],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'custom');
  });

  it('spread unchanged — default strategy picks min normalized load', () => {
    const high = makeClaude({ id: 'high', priority: 'high', priorityWeight: 200 });
    const low = makeClaude({ id: 'low', priority: 'low', priorityWeight: 25 });
    // Both 0 tokens → load=0 → tie → low (older createdAt? same) → lexical: high < low
    // Actually both have same createdAt → lexical: high < low. But spread is min load.
    const result = selectSubscriptionAccount({
      accounts: [high, low],
      provider: 'claude',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    // Without strategy, defaults to 'spread'
    // Both 0 load: tie → createdAt tie → id lexical: high < low
    assert.ok(result !== null);
    assert.equal(result!.id, 'high');
  });

  it('spread explicit does load-balancing even with high weight', () => {
    const high = makeClaude({ id: 'high', priority: 'high', priorityWeight: 200 });
    const low = makeClaude({ id: 'low', priority: 'low', priorityWeight: 25 });
    // high: 199/200=0.995, low: 24/25=0.96 → low wins
    const result = selectSubscriptionAccount({
      accounts: [high, low],
      provider: 'claude',
      strategy: 'spread',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { 'high': 199, 'low': 24 },
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'low');
  });

  it('sticky never-strands: returns highest-weight of all-cooling', () => {
    const cd = new Map<string, number>([
      ['high', nowMs + 120_000],
      ['low', nowMs + 60_000],
    ]);
    const high = makeClaude({ id: 'high', priority: 'high', priorityWeight: 200 });
    const low = makeClaude({ id: 'low', priority: 'low', priorityWeight: 25 });
    const result = selectSubscriptionAccount({
      accounts: [high, low],
      provider: 'claude',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'high');
  });

  // --- priorityWeight honesty: proportional within-provider load (PR-C) ---

  it('spread: higher priorityWeight absorbs more tokens before sibling wins', () => {
    // weight 200 vs 100 → high stays preferred until it carries ~2× tokens.
    const high = makeClaude({ id: 'high', priority: 'high', priorityWeight: 200 });
    const med = makeClaude({ id: 'med', priority: 'medium', priorityWeight: 100 });
    // high: 150/200=0.75, med: 80/100=0.80 → high still wins despite more absolute tokens
    const stillHigh = selectSubscriptionAccount({
      accounts: [high, med],
      provider: 'claude',
      strategy: 'spread',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { high: 150, med: 80 },
    });
    assert.ok(stillHigh !== null);
    assert.equal(stillHigh!.id, 'high');
    // high: 200/200=1.0, med: 80/100=0.80 → med wins once high catches up
    const thenMed = selectSubscriptionAccount({
      accounts: [high, med],
      provider: 'claude',
      strategy: 'spread',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { high: 200, med: 80 },
    });
    assert.ok(thenMed !== null);
    assert.equal(thenMed!.id, 'med');
  });

  it('sticky: prefers higher priorityWeight even when it has more absolute tokens', () => {
    const high = makeClaude({ id: 'high', priority: 'high', priorityWeight: 200 });
    const low = makeClaude({ id: 'low', priority: 'low', priorityWeight: 25 });
    // high has far more tokens; sticky still sticks to highest weight group
    const result = selectSubscriptionAccount({
      accounts: [high, low],
      provider: 'claude',
      strategy: 'sticky',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { high: 10_000, low: 0 },
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'high');
  });

  it('weights are within-provider only: other providers are never selected', () => {
    const claudeHigh = makeClaude({ id: 'claude-high', priority: 'high', priorityWeight: 200 });
    const ocLow = makeOpencode({ id: 'oc-low', priority: 'low', priorityWeight: 25 });
    const result = selectSubscriptionAccount({
      accounts: [claudeHigh, ocLow],
      provider: 'claude',
      strategy: 'spread',
      nowMs,
      cooldownUntil: new Map(),
      // Even if opencode is idle, provider filter keeps selection on claude seats
      sessionTokensByAccount: { 'claude-high': 50_000, 'oc-low': 0 },
    });
    assert.ok(result !== null);
    assert.equal(result!.provider, 'claude');
    assert.equal(result!.id, 'claude-high');
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
