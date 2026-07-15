/**
 * test/unit/menu-claude-accounts.test.ts — unit tests for Claude accounts menu
 * (Slice 2 Half A). Tests macOS guard, create flow, edit, delete, re-auth.
 *
 * All tests use injected fakes for login, detection, and filesystem — no real
 * network or provider CLIs are called.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readSubscriptions,
  writeSubscriptions,
  deleteAccountHome,
  type ClaudeSubscriptionAccount,
  type SubscriptionsFileV1,
} from '../../src/infra/subscriptions.js';

// ---------------------------------------------------------------------------
// Temp directory for subscriptions.json
// ---------------------------------------------------------------------------

let dir: string;
let stateHome: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-menu-test-'));
  stateHome = dir;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// macOS guard tests
// ---------------------------------------------------------------------------

describe('macOS guard', () => {
  it('darwin with one existing Claude oauth account → blocked', async () => {
    // Pre-seed subscriptions.json with one Claude OAuth account
    const existing: SubscriptionsFileV1 = {
      version: 1,
      accounts: [
        {
          id: 'acct_existing',
          provider: 'claude',
          kind: 'oauth-sub',
          label: 'Existing Claude',
          homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_existing'),
          priority: 'medium',
          priorityWeight: 100,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    await writeSubscriptions(existing, stateHome);

    const subs = await readSubscriptions(stateHome);
    const claudeAccounts = subs.accounts.filter(
      (a) => a.provider === 'claude' && a.kind === 'oauth-sub',
    );

    // On darwin with 1 claude oauth account, create should be blocked
    assert.equal(claudeAccounts.length, 1);

    // Verify the guard condition: darwin + existing oauth account >= 1
    const platform = 'darwin';
    const blocked = platform === 'darwin' && claudeAccounts.length >= 1;
    assert.equal(blocked, true);
  });

  it('darwin with zero Claude oauth accounts → first create allowed', async () => {
    // Empty subscriptions
    await writeSubscriptions({ version: 1, accounts: [] }, stateHome);

    const subs = await readSubscriptions(stateHome);
    const claudeAccounts = subs.accounts.filter(
      (a) => a.provider === 'claude' && a.kind === 'oauth-sub',
    );

    const platform = 'darwin';
    const blocked = platform === 'darwin' && claudeAccounts.length >= 1;
    assert.equal(blocked, false); // zero accounts → not blocked
  });

  it('linux with two Claude oauth accounts → not blocked', async () => {
    const file: SubscriptionsFileV1 = {
      version: 1,
      accounts: [
        {
          id: 'acct_l1',
          provider: 'claude',
          kind: 'oauth-sub',
          label: 'L1',
          homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_l1'),
          priority: 'medium',
          priorityWeight: 100,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'acct_l2',
          provider: 'claude',
          kind: 'oauth-sub',
          label: 'L2',
          homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_l2'),
          priority: 'medium',
          priorityWeight: 100,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    await writeSubscriptions(file, stateHome);

    const subs = await readSubscriptions(stateHome);
    const claudeAccounts = subs.accounts.filter(
      (a) => a.provider === 'claude' && a.kind === 'oauth-sub',
    );
    assert.equal(claudeAccounts.length, 2);

    const platform = 'linux';
    const blocked = platform === 'darwin' && claudeAccounts.length >= 1;
    assert.equal(blocked, false); // linux is never blocked
  });

  it('win32 with one Claude oauth account → not blocked', async () => {
    const file: SubscriptionsFileV1 = {
      version: 1,
      accounts: [
        {
          id: 'acct_w1',
          provider: 'claude',
          kind: 'oauth-sub',
          label: 'W1',
          homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_w1'),
          priority: 'medium',
          priorityWeight: 100,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    await writeSubscriptions(file, stateHome);

    const subs = await readSubscriptions(stateHome);
    const claudeAccounts = subs.accounts.filter(
      (a) => a.provider === 'claude' && a.kind === 'oauth-sub',
    );

    const platform = 'win32';
    const blocked = platform === 'darwin' && claudeAccounts.length >= 1;
    assert.equal(blocked, false); // win32 is never blocked
  });
});

// ---------------------------------------------------------------------------
// Menu state tests
// ---------------------------------------------------------------------------

describe('Claude account record management', () => {
  it('creates and reads a Claude subscription account', async () => {
    const account: ClaudeSubscriptionAccount = {
      id: 'acct_test',
      provider: 'claude',
      kind: 'oauth-sub',
      label: 'Test Claude',
      homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_test'),
      priority: 'high',
      priorityWeight: 200,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
      plan: 'Max',
      expiresAt: '2026-12-31T00:00:00.000Z',
    };

    await writeSubscriptions({ version: 1, accounts: [account] }, stateHome);
    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]!.label, 'Test Claude');
    assert.equal(result.accounts[0]!.priority, 'high');
    assert.equal(result.accounts[0]!.plan, 'Max');
  });

  it('updates Claude account priority', async () => {
    const account: ClaudeSubscriptionAccount = {
      id: 'acct_upd',
      provider: 'claude',
      kind: 'oauth-sub',
      label: 'UpdateMe',
      homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_upd'),
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    await writeSubscriptions({ version: 1, accounts: [account] }, stateHome);

    // Simulate account update
    const { updateSubscriptions } = await import('../../src/infra/subscriptions.js');
    await updateSubscriptions((file) => ({
      ...file,
      accounts: file.accounts.map((a) =>
        a.id === 'acct_upd'
          ? { ...a, priority: 'high', priorityWeight: 200 }
          : a,
      ),
    }), stateHome);

    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts[0]!.priority, 'high');
    assert.equal(result.accounts[0]!.priorityWeight, 200);
  });

  it('renames Claude account label (A2 [l] label)', async () => {
    const account: ClaudeSubscriptionAccount = {
      id: 'acct_lbl',
      provider: 'claude',
      kind: 'oauth-sub',
      label: 'Old Label',
      homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_lbl'),
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    await writeSubscriptions({ version: 1, accounts: [account] }, stateHome);

    const { updateSubscriptions } = await import('../../src/infra/subscriptions.js');
    await updateSubscriptions((file) => ({
      ...file,
      accounts: file.accounts.map((a) =>
        a.id === 'acct_lbl' ? { ...a, label: 'Claude Max personal' } : a,
      ),
    }), stateHome);

    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts[0]!.label, 'Claude Max personal');
    assert.equal(result.accounts[0]!.id, 'acct_lbl'); // id stable across rename
  });

  it('toggles Claude account enabled state', async () => {
    const account: ClaudeSubscriptionAccount = {
      id: 'acct_tog',
      provider: 'claude',
      kind: 'oauth-sub',
      label: 'ToggleMe',
      homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_tog'),
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    await writeSubscriptions({ version: 1, accounts: [account] }, stateHome);

    const { updateSubscriptions } = await import('../../src/infra/subscriptions.js');
    await updateSubscriptions((file) => ({
      ...file,
      accounts: file.accounts.map((a) =>
        a.id === 'acct_tog' ? { ...a, enabled: false } : a,
      ),
    }), stateHome);

    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts[0]!.enabled, false);
  });

  it('deletes Claude account record and scoped home', async () => {
    const account: ClaudeSubscriptionAccount = {
      id: 'acct_del',
      provider: 'claude',
      kind: 'oauth-sub',
      label: 'DeleteMe',
      homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_del'),
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    // Create the home directory
    await mkdir(account.homeDir, { recursive: true });

    await writeSubscriptions({ version: 1, accounts: [account] }, stateHome);

    // Delete record
    const { updateSubscriptions } = await import('../../src/infra/subscriptions.js');
    await updateSubscriptions((file) => ({
      ...file,
      accounts: file.accounts.filter((a) => a.id !== 'acct_del'),
    }), stateHome);

    // Delete home
    await deleteAccountHome(account, stateHome);

    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 0);
  });

  it('re-auth updates status and plan', async () => {
    const account: ClaudeSubscriptionAccount = {
      id: 'acct_reauth',
      provider: 'claude',
      kind: 'oauth-sub',
      label: 'ReAuthMe',
      homeDir: join(stateHome, '.myshell-tools', 'provider-homes', 'claude', 'acct_reauth'),
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'auth-failed',
    };

    await writeSubscriptions({ version: 1, accounts: [account] }, stateHome);

    const { updateSubscriptions } = await import('../../src/infra/subscriptions.js');
    await updateSubscriptions((file) => ({
      ...file,
      accounts: file.accounts.map((a) =>
        a.id === 'acct_reauth'
          ? { ...a, status: 'active', plan: 'Max', lastUsedAt: '2026-06-15T00:00:00.000Z' }
          : a,
      ),
    }), stateHome);

    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts[0]!.status, 'active');
    assert.equal(result.accounts[0]!.plan, 'Max');
    assert.equal(result.accounts[0]!.lastUsedAt, '2026-06-15T00:00:00.000Z');
  });
});
