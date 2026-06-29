/**
 * test/unit/opencode-account-routing.test.ts — unit tests for OpenCode account
 * routing, env injection, per-account cooldown, and flag-off behaviour
 * (Slice 1 Half B).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  opencodePoolForModel,
  selectOpencodeAccount,
  selectSubscriptionAccount,
} from '../../src/core/opencode-account-routing.ts';
import { buildOpencodeEnv } from '../../src/providers/opencode.ts';
import { buildOpencodeArgs } from '../../src/providers/opencode.ts';
import { isLedgerEntry } from '../../src/infra/jsonl-guards.ts';
import type { OpencodeSubscriptionAccount } from '../../src/infra/subscriptions.ts';
import type { ProviderRequest } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(
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

function makeReq(
  overrides?: Partial<ProviderRequest>,
): ProviderRequest {
  return {
    model: 'opencode',
    prompt: 'hello',
    cwd: '/tmp',
    sandbox: 'workspace-write',
    timeoutMs: 120000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pool detection
// ---------------------------------------------------------------------------

describe('opencodePoolForModel', () => {
  it('returns go for opencode-go/ prefixed models', () => {
    assert.equal(opencodePoolForModel('opencode-go/kimi-k2.6'), 'go');
    assert.equal(opencodePoolForModel('opencode-go/glm-5.1'), 'go');
  });

  it('returns zen for opencode/ prefixed models', () => {
    assert.equal(opencodePoolForModel('opencode/deepseek-v4-flash-free'), 'zen');
    assert.equal(opencodePoolForModel('opencode/claude-opus-4-8'), 'zen');
  });

  it('returns null for non-opencode models', () => {
    assert.equal(opencodePoolForModel('claude-sonnet-4-6'), null);
    assert.equal(opencodePoolForModel('codex-sonnet'), null);
    assert.equal(opencodePoolForModel('grok-3'), null);
  });

  it('returns null for the bare opencode placeholder (no slash)', () => {
    assert.equal(opencodePoolForModel('opencode'), null);
  });
});

// ---------------------------------------------------------------------------
// account selection
// ---------------------------------------------------------------------------

describe('selectOpencodeAccount', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  const zenA = makeAccount({ id: 'zen-a', pool: 'zen' });
  const zenB = makeAccount({
    id: 'zen-b',
    pool: 'zen',
    priority: 'low',
    priorityWeight: 25,
    createdAt: '2026-05-01T00:00:00.000Z', // older
  });
  const goA = makeAccount({ id: 'go-a', pool: 'go' });
  const goHigh = makeAccount({
    id: 'go-high',
    pool: 'go',
    priority: 'high',
    priorityWeight: 200,
  });

  const all = [zenA, zenB, goA, goHigh];

  it('selects the only matching-pool account', () => {
    const result = selectOpencodeAccount({
      accounts: [goA],
      pool: 'go',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'go-a');
  });

  it('separates zen from go pools', () => {
    const result = selectOpencodeAccount({
      accounts: all,
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.pool, 'zen');
  });

  it('picks the lowest normalized-load (higher weight absorbs more)', () => {
    // zenA: weight=100, tokens=0 → load=0
    // zenB: weight=25,  tokens=0 → load=0
    // Tie → zenB is older (createdAt 2026-05 vs 2026-06 for zenA) → zenB wins
    const result = selectOpencodeAccount({
      accounts: [zenA, zenB],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'zen-b'); // older wins tie
  });

  it('has higher weight absorb more load', () => {
    // goHigh: weight=200, tokens=106 → load=0.53
    // goA:    weight=100, tokens=50  → load=0.50
    // goA has LOWER load → goA is picked
    const result = selectOpencodeAccount({
      accounts: [goA, goHigh],
      pool: 'go',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { 'go-a': 50, 'go-high': 106 },
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'go-a');
  });

  it('excludes expired accounts', () => {
    const expired = makeAccount({
      id: 'expired',
      pool: 'zen',
      expiresAt: '2026-01-01T00:00:00.000Z', // well in the past
    });
    const result = selectOpencodeAccount({
      accounts: [expired, zenA],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'zen-a');
  });

  it('keeps accounts with no expiresAt', () => {
    const result = selectOpencodeAccount({
      accounts: [zenA],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
  });

  it('excludes disabled accounts', () => {
    const disabled = makeAccount({ id: 'disabled', pool: 'zen', enabled: false });
    const result = selectOpencodeAccount({
      accounts: [disabled],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('excludes accounts with disabled priority (weight=0)', () => {
    const d = makeAccount({
      id: 'disabled-prio',
      pool: 'zen',
      priority: 'disabled',
      priorityWeight: 0,
    });
    const result = selectOpencodeAccount({
      accounts: [d, zenA],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'zen-a'); // skips disabled, picks zenA
  });

  it('excludes cooling account when sibling is available', () => {
    const cd = new Map<string, number>([['zen-a', nowMs + 60_000]]);
    const result = selectOpencodeAccount({
      accounts: [zenA, zenB],
      pool: 'zen',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'zen-b'); // zenA is cooling, zenB wins
  });

  it('ignores expired cooldown (cooling elapsed)', () => {
    const cd = new Map<string, number>([['zen-a', nowMs - 1000]]); // expired
    const result = selectOpencodeAccount({
      accounts: [zenA, zenB],
      pool: 'zen',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'zen-b'); // zenA cooldown expired, but zenB wins on tie (older)
  });

  it('never-strands: returns one of all-cooling candidates', () => {
    const cd = new Map<string, number>([
      ['zen-a', nowMs + 60_000],
      ['zen-b', nowMs + 120_000],
    ]);
    const result = selectOpencodeAccount({
      accounts: [zenA, zenB],
      pool: 'zen',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null); // still returns one
    assert.ok(result!.id === 'zen-a' || result!.id === 'zen-b');
  });

  it('returns null when no accounts match the pool', () => {
    const result = selectOpencodeAccount({
      accounts: [goA],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('returns null for empty accounts', () => {
    const result = selectOpencodeAccount({
      accounts: [],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result, null);
  });

  it('stable tiebreaker: same load, younger/lexical id', () => {
    const a = makeAccount({
      id: 'aaa',
      pool: 'zen',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const b = makeAccount({
      id: 'aab',
      pool: 'zen',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const result = selectOpencodeAccount({
      accounts: [b, a],
      pool: 'zen',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'aaa'); // lexical tiebreak
  });

  // --- sticky strategy (Slice 4) ---

  it('sticky selects the highest-weight opencode account', () => {
    const high = makeAccount({ id: 'go-high', pool: 'go', priority: 'high', priorityWeight: 200 });
    const low = makeAccount({ id: 'go-low', pool: 'go', priority: 'low', priorityWeight: 25 });
    const result = selectSubscriptionAccount({
      accounts: [low, high],
      provider: 'opencode',
      pool: 'go',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
      strategy: 'sticky',
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'go-high');
  });

  it('selectOpencodeAccount defaults to spread (unchanged)', () => {
    // high has lower load ratio → wins under spread
    const high = makeAccount({ id: 'go-a', pool: 'go', priority: 'high', priorityWeight: 200 });
    const low = makeAccount({ id: 'go-b', pool: 'go', priority: 'low', priorityWeight: 25 });
    // go-a: 50/200=0.25, go-b: 5/25=0.20 → go-b wins (spread picks lowest load)
    const result = selectOpencodeAccount({
      accounts: [high, low],
      pool: 'go',
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: { 'go-a': 50, 'go-b': 5 },
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'go-b');
  });
});

// ---------------------------------------------------------------------------
// env injection (opencode adapter)
// ---------------------------------------------------------------------------

describe('opencode adapter env injection', () => {
  it('passes XDG_DATA_HOME from accountEnv through to child env', () => {
    const req = makeReq({
      accountEnv: { XDG_DATA_HOME: '/custom/opencode-home' },
    });
    const env = buildOpencodeEnv(req, { HOME: '/home/user' });
    assert.equal(env['XDG_DATA_HOME'], '/custom/opencode-home');
  });

  it('does not alter env when accountEnv is absent (flag-off path)', () => {
    const req = makeReq();
    const env = buildOpencodeEnv(req, {
      HOME: '/home/user',
      PATH: '/usr/bin',
    });
    assert.equal(env['HOME'], '/home/user');
    assert.equal(env['PATH'], '/usr/bin');
    assert.equal(env['XDG_DATA_HOME'] ?? '__absent__', '__absent__');
  });

  it('preserves non-XDG parent env vars', () => {
    const req = makeReq({
      accountEnv: { XDG_DATA_HOME: '/custom' },
    });
    const env = buildOpencodeEnv(req, {
      HOME: '/home/user',
      PATH: '/usr/bin',
      FOO: 'bar',
    });
    assert.equal(env['HOME'], '/home/user');
    assert.equal(env['PATH'], '/usr/bin');
    assert.equal(env['FOO'], 'bar');
    assert.equal(env['XDG_DATA_HOME'], '/custom');
  });

  it('buildOpencodeArgs does NOT include env fields (requests are args-only)', () => {
    const req = makeReq({
      model: 'opencode-go/kimi-k2.6',
      accountEnv: { XDG_DATA_HOME: '/custom' },
    });
    const args = buildOpencodeArgs(req);
    assert.ok(!args.includes('XDG_DATA_HOME'));
    assert.ok(!args.includes('/custom'));
    assert.deepEqual(args, ['run', '--format', 'json', '-m', 'opencode-go/kimi-k2.6']);
  });
});

// ---------------------------------------------------------------------------
// ledger — accountId guard
// ---------------------------------------------------------------------------

describe('JSONL ledger guard — accountId', () => {
  const base = {
    timestamp: '2026-06-01T00:00:00.000Z',
    sessionId: 's1',
    taskId: 't1',
    provider: 'opencode' as const,
    model: 'opencode/deepseek-v4-flash-free',
    tier: 'ic' as const,
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    usd: 0.001,
    durationMs: 1000,
    success: true,
  };

  it('accepts an entry with a valid accountId', () => {
    const entry = { ...base, accountId: 'acct_abc123' };
    assert.equal(isLedgerEntry(entry), true);
  });

  it('accepts an entry without accountId (backward-compatible)', () => {
    assert.equal(isLedgerEntry(base), true);
  });

  it('rejects accountId that is not a string', () => {
    assert.equal(isLedgerEntry({ ...base, accountId: 123 }), false);
  });

  it('rejects accountId that is an empty string', () => {
    assert.equal(isLedgerEntry({ ...base, accountId: '' }), false);
    assert.equal(isLedgerEntry({ ...base, accountId: '  ' }), false);
  });
});

// ---------------------------------------------------------------------------
// account cooldown (per-account; siblings stay available)
// ---------------------------------------------------------------------------

describe('per-account cooldown', () => {
  const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

  const goA = makeAccount({ id: 'go-a', pool: 'go' });
  const goB = makeAccount({ id: 'go-b', pool: 'go' });

  it('cooling account A leaves sibling B available', () => {
    const cd = new Map<string, number>([['go-a', nowMs + 300_000]]);
    const result = selectOpencodeAccount({
      accounts: [goA, goB],
      pool: 'go',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null);
    assert.equal(result!.id, 'go-b');
  });

  it('cooling both still returns one (never-strand)', () => {
    const cd = new Map<string, number>([
      ['go-a', nowMs + 300_000],
      ['go-b', nowMs + 300_000],
    ]);
    const result = selectOpencodeAccount({
      accounts: [goA, goB],
      pool: 'go',
      nowMs,
      cooldownUntil: cd,
      sessionTokensByAccount: {},
    });
    assert.ok(result !== null); // never stranded
  });
});
