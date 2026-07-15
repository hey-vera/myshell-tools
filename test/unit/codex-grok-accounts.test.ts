/**
 * test/unit/codex-grok-accounts.test.ts — unit tests for Codex & Grok account
 * creation, account env injection, kind detection, home dir helpers, and mixed
 * round-trip read/write (Slice 3).
 *
 * Mirrors subscriptions.test.ts patterns.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  newCodexAccount,
  newGrokAccount,
  accountEnvFor,
  subscriptionAccountKind,
  getCodexAccountHome,
  getGrokAccountHome,
  readSubscriptions,
  writeSubscriptions,
  newClaudeAccount,
  newOpencodeAccount,
  type SubscriptionAccount,
  type SubscriptionsFileV1,
} from '../../src/infra/subscriptions.ts';

// ---------------------------------------------------------------------------
// Temp directory
// ---------------------------------------------------------------------------

let dir: string;
let stateHome: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-grok-accounts-'));
  stateHome = dir;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// newCodexAccount
// ---------------------------------------------------------------------------

describe('newCodexAccount', () => {
  it('creates a codex account with correct provider and kind', () => {
    const acc = newCodexAccount({
      id: 'acct_cx1',
      label: 'Codex Test',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.provider, 'codex');
    assert.equal(acc.kind, 'oauth-sub');
    assert.equal(acc.priority, 'medium');
    assert.equal(acc.priorityWeight, 100);
    assert.equal(acc.enabled, true);
    assert.equal(acc.status, 'unknown');
  });

  it('disabled priority → enabled false', () => {
    const acc = newCodexAccount({
      id: 'acct_cx2',
      label: 'Codex Disabled',
      priority: 'disabled',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.priority, 'disabled');
    assert.equal(acc.priorityWeight, 0);
    assert.equal(acc.enabled, false);
  });

  it('homeDir uses provider-homes/codex path', () => {
    const acc = newCodexAccount({
      id: 'acct_cx3',
      label: 'CX3',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.ok(acc.homeDir.includes('provider-homes'));
    assert.ok(acc.homeDir.includes('codex'));
    assert.ok(acc.homeDir.includes('acct_cx3'));
  });

  it('expiresAt is preserved when set', () => {
    const acc = newCodexAccount({
      id: 'acct_cx4',
      label: 'CX4',
      expiresAt: '2026-12-31T00:00:00.000Z',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.expiresAt, '2026-12-31T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// newGrokAccount
// ---------------------------------------------------------------------------

describe('newGrokAccount', () => {
  it('creates a grok account with correct provider and kind', () => {
    const acc = newGrokAccount({
      id: 'acct_gr1',
      label: 'Grok Test',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.provider, 'grok');
    assert.equal(acc.kind, 'oauth-sub');
    assert.equal(acc.priority, 'medium');
    assert.equal(acc.priorityWeight, 100);
    assert.equal(acc.enabled, true);
    assert.equal(acc.status, 'unknown');
  });

  it('disabled priority → enabled false', () => {
    const acc = newGrokAccount({
      id: 'acct_gr2',
      label: 'Grok Disabled',
      priority: 'disabled',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.priority, 'disabled');
    assert.equal(acc.priorityWeight, 0);
    assert.equal(acc.enabled, false);
  });

  it('homeDir uses provider-homes/grok path', () => {
    const acc = newGrokAccount({
      id: 'acct_gr3',
      label: 'GR3',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.ok(acc.homeDir.includes('provider-homes'));
    assert.ok(acc.homeDir.includes('grok'));
    assert.ok(acc.homeDir.includes('acct_gr3'));
  });

  it('expiresAt is preserved when set', () => {
    const acc = newGrokAccount({
      id: 'acct_gr4',
      label: 'GR4',
      expiresAt: '2026-12-31T00:00:00.000Z',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.expiresAt, '2026-12-31T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// accountEnvFor
// ---------------------------------------------------------------------------

describe('accountEnvFor', () => {
  it('codex account → CODEX_HOME', () => {
    const acc = newCodexAccount({
      id: 'acct_env_cx',
      label: 'Env CX',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    const env = accountEnvFor(acc);
    assert.equal(env['CODEX_HOME'], acc.homeDir);
    assert.equal(env['GROK_HOME'], undefined);
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined);
    assert.equal(env['XDG_DATA_HOME'], undefined);
  });

  it('grok account → GROK_HOME', () => {
    const acc = newGrokAccount({
      id: 'acct_env_gr',
      label: 'Env GR',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    const env = accountEnvFor(acc);
    assert.equal(env['GROK_HOME'], acc.homeDir);
    assert.equal(env['CODEX_HOME'], undefined);
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined);
    assert.equal(env['XDG_DATA_HOME'], undefined);
  });

  it('codex account via SubscriptionAccount union type', () => {
    const acc: SubscriptionAccount = {
      id: 'acct_union_cx',
      provider: 'codex',
      kind: 'oauth-sub',
      label: 'Union CX',
      homeDir: '/tmp/codex-union',
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const env = accountEnvFor(acc);
    assert.equal(env['CODEX_HOME'], '/tmp/codex-union');
  });

  it('grok account via SubscriptionAccount union type', () => {
    const acc: SubscriptionAccount = {
      id: 'acct_union_gr',
      provider: 'grok',
      kind: 'oauth-sub',
      label: 'Union GR',
      homeDir: '/tmp/grok-union',
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const env = accountEnvFor(acc);
    assert.equal(env['GROK_HOME'], '/tmp/grok-union');
  });
});

// ---------------------------------------------------------------------------
// subscriptionAccountKind
// ---------------------------------------------------------------------------

describe('subscriptionAccountKind', () => {
  it('codex → oauth-sub', () => {
    const acc = newCodexAccount({
      id: 'acct_kind_cx',
      label: 'Kind CX',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(subscriptionAccountKind(acc), 'oauth-sub');
  });

  it('grok → oauth-sub', () => {
    const acc = newGrokAccount({
      id: 'acct_kind_gr',
      label: 'Kind GR',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(subscriptionAccountKind(acc), 'oauth-sub');
  });
});

// ---------------------------------------------------------------------------
// getCodexAccountHome / getGrokAccountHome
// ---------------------------------------------------------------------------

describe('getCodexAccountHome', () => {
  it('returns scoped path under provider-homes/codex', () => {
    const p = getCodexAccountHome('acct_home_cx', stateHome);
    assert.ok(p.includes('provider-homes'));
    assert.ok(p.includes('codex'));
    assert.ok(p.endsWith('acct_home_cx'));
  });
});

describe('getGrokAccountHome', () => {
  it('returns scoped path under provider-homes/grok', () => {
    const p = getGrokAccountHome('acct_home_gr', stateHome);
    assert.ok(p.includes('provider-homes'));
    assert.ok(p.includes('grok'));
    assert.ok(p.endsWith('acct_home_gr'));
  });
});

// ---------------------------------------------------------------------------
// Mixed accounts round-trip (opencode + claude + codex + grok)
// ---------------------------------------------------------------------------

describe('mixed accounts read/write with codex + grok', () => {
  it('four-provider file round-trips all accounts', async () => {
    const opencodeAcc = newOpencodeAccount({
      id: 'acct_op_r1',
      label: 'OpenCode Zen',
      pool: 'zen',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    const claudeAcc = newClaudeAccount({
      id: 'acct_cl_r1',
      label: 'Claude Max',
      priority: 'high',
      expiresAt: '2026-12-31T00:00:00.000Z',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    const codexAcc = newCodexAccount({
      id: 'acct_cx_r1',
      label: 'Codex One',
      priority: 'high',
      expiresAt: '2026-12-31T00:00:00.000Z',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    const grokAcc = newGrokAccount({
      id: 'acct_gr_r1',
      label: 'Grok One',
      priority: 'medium',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });

    const file: SubscriptionsFileV1 = {
      version: 1,
      accounts: [opencodeAcc, claudeAcc, codexAcc, grokAcc],
    };
    await writeSubscriptions(file, stateHome);
    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 4);

    const opencode = result.accounts.find((a) => a.provider === 'opencode');
    assert.ok(opencode !== undefined);
    assert.equal(opencode.label, 'OpenCode Zen');

    const claude = result.accounts.find((a) => a.provider === 'claude');
    assert.ok(claude !== undefined);
    assert.equal(claude.label, 'Claude Max');
    assert.equal(claude.priority, 'high');

    const codex = result.accounts.find((a) => a.provider === 'codex');
    assert.ok(codex !== undefined);
    assert.equal(codex.label, 'Codex One');
    assert.equal(codex.priority, 'high');
    assert.equal(codex.kind, 'oauth-sub');

    const grok = result.accounts.find((a) => a.provider === 'grok');
    assert.ok(grok !== undefined);
    assert.equal(grok.label, 'Grok One');
    assert.equal(grok.priority, 'medium');
    assert.equal(grok.kind, 'oauth-sub');
  });

  it('overwrites file with codex+grok accounts', async () => {
    const codexAcc = newCodexAccount({
      id: 'acct_cx_w1',
      label: 'Codex Write',
      nowIso: '2026-02-01T00:00:00.000Z',
      stateHome,
    });
    const grokAcc = newGrokAccount({
      id: 'acct_gr_w1',
      label: 'Grok Write',
      nowIso: '2026-02-01T00:00:00.000Z',
      stateHome,
    });

    // First write empty, then write with codex+grok
    await writeSubscriptions({ version: 1, accounts: [] }, stateHome);
    const file: SubscriptionsFileV1 = {
      version: 1,
      accounts: [codexAcc, grokAcc],
    };
    await writeSubscriptions(file, stateHome);
    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 2);
    assert.equal(result.accounts[0]!.provider, 'codex');
    assert.equal(result.accounts[0]!.id, 'acct_cx_w1');
    assert.equal(result.accounts[1]!.provider, 'grok');
    assert.equal(result.accounts[1]!.id, 'acct_gr_w1');
  });

  it('codex and grok fields survive raw JSON round-trip', async () => {
    const codexAcc = newCodexAccount({
      id: 'acct_cx_raw',
      label: 'CX Raw',
      priority: 'low',
      nowIso: '2026-03-01T00:00:00.000Z',
      stateHome,
    });
    const grokAcc = newGrokAccount({
      id: 'acct_gr_raw',
      label: 'GR Raw',
      priority: 'high',
      expiresAt: '2026-12-31T00:00:00.000Z',
      nowIso: '2026-03-01T00:00:00.000Z',
      stateHome,
    });

    await writeSubscriptions({ version: 1, accounts: [codexAcc, grokAcc] }, stateHome);

    // Read raw JSON to verify no transformation
    const raw = JSON.parse(
      await readFile(
        join(stateHome, '.myshell-tools', 'subscriptions.json'),
        'utf8',
      ),
    ) as { accounts: Array<Record<string, unknown>> };

    const rawCodex = raw.accounts.find((a) => a.provider === 'codex');
    assert.ok(rawCodex !== undefined);
    assert.equal(rawCodex!.kind, 'oauth-sub');
    assert.equal(rawCodex!.priority, 'low');
    assert.equal(rawCodex!.priorityWeight, 25);

    const rawGrok = raw.accounts.find((a) => a.provider === 'grok');
    assert.ok(rawGrok !== undefined);
    assert.equal(rawGrok!.kind, 'oauth-sub');
    assert.equal(rawGrok!.priority, 'high');
    assert.equal(rawGrok!.priorityWeight, 200);
    assert.equal(rawGrok!.expiresAt, '2026-12-31T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// NOTE: env seam availability
// ---------------------------------------------------------------------------
//
// The codex and grok adapters (src/providers/codex.ts, src/providers/grok.ts)
// do NOT export a testable env composition function like claude.ts's
// `buildAccountScopedBase` / `applyAccountEnvOverride`. The child env is built
// inline at the spawn site:
//
//   codex.ts buildCodexEnv — allowlist parent + replitPersistentEnv + accountEnv LAST
//   grok.ts  buildGrokEnv  — allowlist parent + replitPersistentEnv + accountEnv LAST
//
// Because req.accountEnv is simply spread into the child env, a test verifying
// the env injection behaviour would need to inspect the ProviderRequest that
// flows into the adapter — which is the caller's responsibility. No isolated
// env seam is available to unit test outside of the spawn path.
//
// If such a seam is desired, follow claude.ts's pattern: extract
// `buildAccountScopedBase` and `applyAccountEnvOverride` from the inline
// spread in both providers.
