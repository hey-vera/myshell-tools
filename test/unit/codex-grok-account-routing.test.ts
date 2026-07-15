/**
 * test/unit/codex-grok-account-routing.test.ts — unit tests for Codex & Grok
 * account selection via selectSubscriptionAccount (Slice 3).
 *
 * Mirrors subscription-account-routing.test.ts patterns.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { selectSubscriptionAccount } from '../../src/core/opencode-account-routing.ts';
import type {
  CodexSubscriptionAccount,
  GrokSubscriptionAccount,
  OpencodeSubscriptionAccount,
  ClaudeSubscriptionAccount,
  SubscriptionAccount,
} from '../../src/infra/subscriptions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCodex(
  overrides: Partial<CodexSubscriptionAccount> & { id: string },
): CodexSubscriptionAccount {
  const now = '2026-06-01T00:00:00.000Z';
  return {
    id: overrides.id,
    provider: 'codex',
    kind: 'oauth-sub',
    label: overrides.id,
    homeDir: `/tmp/provider-homes/codex/${overrides.id}`,
    priority: 'medium',
    priorityWeight: 100,
    enabled: true,
    createdAt: now,
    ...overrides,
  };
}

function makeGrok(
  overrides: Partial<GrokSubscriptionAccount> & { id: string },
): GrokSubscriptionAccount {
  const now = '2026-06-01T00:00:00.000Z';
  return {
    id: overrides.id,
    provider: 'grok',
    kind: 'oauth-sub',
    label: overrides.id,
    homeDir: `/tmp/provider-homes/grok/${overrides.id}`,
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
// Codex account selection via selectSubscriptionAccount
// ---------------------------------------------------------------------------

describe('codex account selection', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  it('selects a codex account by minimum normalized load', () => {
    const cLow = makeCodex({ id: 'codex-low', priority: 'low', priorityWeight: 25 });
    const cHigh = makeCodex({ id: 'codex-high', priority: 'high', priorityWeight: 200 });
    // cLow: 5/25=0.2, cHigh: 100/200=0.5 → cLow wins
    const result = selectSubscriptionAccount({
      accounts: [cLow, cHigh],
      provider: 'codex',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { 'codex-low': 5, 'codex-high': 100 },
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'codex-low');
    assert.equal(result!.provider, 'codex');
  });

  it('returns null when no codex accounts present', () => {
    const zen = makeOpencode({ id: 'zen-a' });
    const result = selectSubscriptionAccount({
      accounts: [zen],
      provider: 'codex',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('excludes disabled codex accounts', () => {
    const disabled = makeCodex({ id: 'd1', enabled: false });
    const active = makeCodex({ id: 'a1' });
    const result = selectSubscriptionAccount({
      accounts: [disabled, active],
      provider: 'codex',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'a1');
  });

  it('excludes expired codex accounts', () => {
    const expired = makeCodex({
      id: 'exp',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const active = makeCodex({ id: 'a1' });
    const result = selectSubscriptionAccount({
      accounts: [expired, active],
      provider: 'codex',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'a1');
  });

  it('excludes disabled-priority codex accounts (weight=0)', () => {
    const d = makeCodex({ id: 'd1', priority: 'disabled', priorityWeight: 0 });
    const result = selectSubscriptionAccount({
      accounts: [d],
      provider: 'codex',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Grok account selection via selectSubscriptionAccount
// ---------------------------------------------------------------------------

describe('grok account selection', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  it('selects a grok account by minimum normalized load', () => {
    const gLow = makeGrok({ id: 'grok-low', priority: 'low', priorityWeight: 25 });
    const gHigh = makeGrok({ id: 'grok-high', priority: 'high', priorityWeight: 200 });
    // gLow: 5/25=0.2, gHigh: 100/200=0.5 → gLow wins
    const result = selectSubscriptionAccount({
      accounts: [gLow, gHigh],
      provider: 'grok',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { 'grok-low': 5, 'grok-high': 100 },
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'grok-low');
    assert.equal(result!.provider, 'grok');
  });

  it('returns null when no grok accounts present', () => {
    const zen = makeOpencode({ id: 'zen-a' });
    const result = selectSubscriptionAccount({
      accounts: [zen],
      provider: 'grok',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('excludes disabled grok accounts', () => {
    const disabled = makeGrok({ id: 'd1', enabled: false });
    const active = makeGrok({ id: 'a1' });
    const result = selectSubscriptionAccount({
      accounts: [disabled, active],
      provider: 'grok',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'a1');
  });

  it('excludes expired grok accounts', () => {
    const expired = makeGrok({
      id: 'exp',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const active = makeGrok({ id: 'a1' });
    const result = selectSubscriptionAccount({
      accounts: [expired, active],
      provider: 'grok',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'a1');
  });

  it('excludes disabled-priority grok accounts (weight=0)', () => {
    const d = makeGrok({ id: 'd1', priority: 'disabled', priorityWeight: 0 });
    const result = selectSubscriptionAccount({
      accounts: [d],
      provider: 'grok',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Per-account cooldown (codex)
// ---------------------------------------------------------------------------

describe('per-account cooldown — codex', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  const c1 = makeCodex({ id: 'c1', priority: 'low', priorityWeight: 25 });
  const c2 = makeCodex({ id: 'c2', priority: 'high', priorityWeight: 200 });

  it('cooling account c1 leaves sibling c2 available', () => {
    const cd = new Map<string, number>([['c1', nowMs + 300_000]]);
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'codex',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c2');
  });

  it('cooling both codex accounts → null (R3.1: no silent cooling pick)', () => {
    const cd = new Map<string, number>([
      ['c1', nowMs + 300_000],
      ['c2', nowMs + 300_000],
    ]);
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'codex',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('ignores expired cooldown on a codex account', () => {
    const cd = new Map<string, number>([['c1', nowMs - 1000]]); // expired
    const result = selectSubscriptionAccount({
      accounts: [c1, c2],
      provider: 'codex',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'c1'); // c1 is available again (lower weight → lower load)
  });
});

// ---------------------------------------------------------------------------
// Per-account cooldown (grok)
// ---------------------------------------------------------------------------

describe('per-account cooldown — grok', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  const g1 = makeGrok({ id: 'g1', priority: 'low', priorityWeight: 25 });
  const g2 = makeGrok({ id: 'g2', priority: 'high', priorityWeight: 200 });

  it('cooling account g1 leaves sibling g2 available', () => {
    const cd = new Map<string, number>([['g1', nowMs + 300_000]]);
    const result = selectSubscriptionAccount({
      accounts: [g1, g2],
      provider: 'grok',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'g2');
  });

  it('cooling both grok accounts → null (R3.1: no silent cooling pick)', () => {
    const cd = new Map<string, number>([
      ['g1', nowMs + 300_000],
      ['g2', nowMs + 300_000],
    ]);
    const result = selectSubscriptionAccount({
      accounts: [g1, g2],
      provider: 'grok',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('ignores expired cooldown on a grok account', () => {
    const cd = new Map<string, number>([['g1', nowMs - 1000]]); // expired
    const result = selectSubscriptionAccount({
      accounts: [g1, g2],
      provider: 'grok',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'g1'); // g1 is available again (lower weight → lower load)
  });
});

// ---------------------------------------------------------------------------
// Cross-provider isolation
// ---------------------------------------------------------------------------

describe('cross-provider isolation', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  it('codex selection ignores grok/claude/opencode accounts', () => {
    const codex = makeCodex({ id: 'cx1' });
    const grok = makeGrok({ id: 'gr1' });
    const claude = makeClaude({ id: 'cl1' });
    const opencode = makeOpencode({ id: 'o1' });
    const result = selectSubscriptionAccount({
      accounts: [codex, grok, claude, opencode] as SubscriptionAccount[],
      provider: 'codex',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'cx1');
    assert.equal(result!.provider, 'codex');
  });

  it('grok selection ignores codex/claude/opencode accounts', () => {
    const grok = makeGrok({ id: 'gr1' });
    const codex = makeCodex({ id: 'cx1' });
    const claude = makeClaude({ id: 'cl1' });
    const opencode = makeOpencode({ id: 'o1' });
    const result = selectSubscriptionAccount({
      accounts: [grok, codex, claude, opencode] as SubscriptionAccount[],
      provider: 'grok',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'gr1');
    assert.equal(result!.provider, 'grok');
  });

  it('returns null when only non-codex accounts exist for codex query', () => {
    const grok = makeGrok({ id: 'gr1' });
    const claude = makeClaude({ id: 'cl1' });
    const opencode = makeOpencode({ id: 'o1' });
    const result = selectSubscriptionAccount({
      accounts: [grok, claude, opencode] as SubscriptionAccount[],
      provider: 'codex',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('returns null when only non-grok accounts exist for grok query', () => {
    const codex = makeCodex({ id: 'cx1' });
    const claude = makeClaude({ id: 'cl1' });
    const opencode = makeOpencode({ id: 'o1' });
    const result = selectSubscriptionAccount({
      accounts: [codex, claude, opencode] as SubscriptionAccount[],
      provider: 'grok',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });
});
