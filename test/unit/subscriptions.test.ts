import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat as fsStat, mkdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  priorityWeight,
  getSubscriptionsPath,
  getOpencodeAccountHome,
  getOpencodeAccountAuthPath,
  readSubscriptions,
  writeSubscriptions,
  updateSubscriptions,
  newOpencodeAccount,
  newClaudeAccount,
  writeOpencodeAuthJson,
  deleteOpencodeAccountHome,
  deleteAccountHome,
  accountEnvFor,
  subscriptionAccountKind,
  getClaudeAccountHome,
  type OpencodeSubscriptionAccount,
  type SubscriptionAccount,
  type SubscriptionsFileV1,
} from '../../src/infra/subscriptions.ts';

// ---------------------------------------------------------------------------
// Temp directory
// ---------------------------------------------------------------------------

let dir: string;
let stateHome: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subs-test-'));
  stateHome = dir;
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// priorityWeight
// ---------------------------------------------------------------------------

describe('priorityWeight', () => {
  it('low → 25', () => {
    assert.equal(priorityWeight('low'), 25);
  });

  it('medium → 100', () => {
    assert.equal(priorityWeight('medium'), 100);
  });

  it('high → 200', () => {
    assert.equal(priorityWeight('high'), 200);
  });

  it('disabled → 0', () => {
    assert.equal(priorityWeight('disabled'), 0);
  });

  // --- customWeight (Slice 4) ---

  it('customWeight overrides label mapping', () => {
    assert.equal(priorityWeight('low', 50), 50);
    assert.equal(priorityWeight('medium', 500), 500);
    assert.equal(priorityWeight('high', 999), 999);
  });

  it('customWeight 0 is allowed (returns 0)', () => {
    assert.equal(priorityWeight('high', 0), 0);
  });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('path helpers', () => {
  it('getSubscriptionsPath returns path under stateHome', () => {
    const p = getSubscriptionsPath(stateHome);
    assert.ok(p.endsWith('subscriptions.json'));
    assert.ok(p.includes('.myshell-tools'));
  });

  it('getOpencodeAccountHome returns scoped path', () => {
    const p = getOpencodeAccountHome('acct_test', stateHome);
    assert.ok(p.endsWith(join('opencode-accounts', 'acct_test')));
  });

  it('newOpencodeAccount creates absolute homeDir', () => {
    const acc = newOpencodeAccount({
      id: 'acct_test',
      label: 'Test',
      pool: 'zen',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.ok(acc.homeDir.startsWith(sep) || acc.homeDir.includes(':'));
    assert.ok(acc.homeDir.endsWith(join('opencode-accounts', 'acct_test')));
  });

  it('newOpencodeAccount defaults priority to medium', () => {
    const acc = newOpencodeAccount({
      id: 'acct_t2',
      label: 'T2',
      pool: 'go',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.priority, 'medium');
    assert.equal(acc.priorityWeight, 100);
    assert.equal(acc.enabled, true);
  });

  it('newOpencodeAccount sets disabled priority → enabled false', () => {
    const acc = newOpencodeAccount({
      id: 'acct_t3',
      label: 'T3',
      pool: 'zen',
      priority: 'disabled',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.priority, 'disabled');
    assert.equal(acc.priorityWeight, 0);
    assert.equal(acc.enabled, false);
  });

  it('newOpencodeAccount with customWeight overrides label weight', () => {
    const acc = newOpencodeAccount({
      id: 'acct_c1',
      label: 'Custom',
      pool: 'zen',
      customWeight: 150,
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.priority, 'medium');
    assert.equal(acc.priorityWeight, 150);
    assert.equal(acc.customWeight, 150);
    assert.equal(acc.enabled, true);
  });

  it('newOpencodeAccount with customWeight 0 disables account', () => {
    const acc = newOpencodeAccount({
      id: 'acct_c2',
      label: 'Zero',
      pool: 'zen',
      customWeight: 0,
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.priority, 'disabled');
    assert.equal(acc.priorityWeight, 0);
    assert.equal(acc.customWeight, 0);
    assert.equal(acc.enabled, false);
  });

  it('newClaudeAccount with customWeight applies correctly', () => {
    const acc = newClaudeAccount({
      id: 'claude_custom',
      label: 'Claude Custom',
      customWeight: 300,
      nowIso: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(acc.priority, 'medium');
    assert.equal(acc.priorityWeight, 300);
    assert.equal(acc.customWeight, 300);
  });
});

// ---------------------------------------------------------------------------
// readSubscriptions / writeSubscriptions / updateSubscriptions
// ---------------------------------------------------------------------------

describe('readSubscriptions', () => {
  it('missing file returns empty version 1', async () => {
    const result = await readSubscriptions(stateHome);
    assert.deepEqual(result, { version: 1, accounts: [] });
  });

  it('corrupt file returns empty and does not throw', async () => {
    const filePath = getSubscriptionsPath(stateHome);
    await mkdir(join(stateHome, '.myshell-tools'), { recursive: true });
    await writeFile(filePath, 'not json {{{');
    const result = await readSubscriptions(stateHome);
    assert.deepEqual(result, { version: 1, accounts: [] });
  });

  it('unrecognized version returns empty', async () => {
    const filePath = getSubscriptionsPath(stateHome);
    await writeFile(filePath, JSON.stringify({ version: 99, accounts: [{ id: 'x' }] }));
    const result = await readSubscriptions(stateHome);
    assert.deepEqual(result, { version: 1, accounts: [] });
  });

  it('missing accounts array returns empty', async () => {
    const filePath = getSubscriptionsPath(stateHome);
    await writeFile(filePath, JSON.stringify({ version: 1 }));
    const result = await readSubscriptions(stateHome);
    assert.deepEqual(result, { version: 1, accounts: [] });
  });
});

describe('writeSubscriptions', () => {
  it('round-trip writes and reads all fields', async () => {
    const file: SubscriptionsFileV1 = {
      version: 1,
      accounts: [
        {
          id: 'acct_1',
          provider: 'opencode',
          label: 'Zen Test',
          pool: 'zen',
          homeDir: '/home/test/.myshell-tools/opencode-accounts/acct_1',
          priority: 'high',
          priorityWeight: 200,
          customWeight: 150,
          expiresAt: '2026-12-31T00:00:00.000Z',
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    await writeSubscriptions(file, stateHome);
    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]!.id, 'acct_1');
    assert.equal(result.accounts[0]!.label, 'Zen Test');
    assert.equal(result.accounts[0]!.priority, 'high');
    assert.equal(result.accounts[0]!.priorityWeight, 200);
    assert.equal((result.accounts[0] as OpencodeSubscriptionAccount).customWeight, 150);
    assert.equal(result.accounts[0]!.expiresAt, '2026-12-31T00:00:00.000Z');
  });

  it('writing again overwrites previous', async () => {
    await writeSubscriptions({ version: 1, accounts: [] }, stateHome);
    const file: SubscriptionsFileV1 = {
      version: 1,
      accounts: [
        {
          id: 'acct_2',
          provider: 'opencode',
          label: 'Second',
          pool: 'go',
          homeDir: '/x',
          priority: 'low',
          priorityWeight: 25,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    await writeSubscriptions(file, stateHome);
    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]!.id, 'acct_2');
  });
});

describe('updateSubscriptions', () => {
  it('updates via callback and returns new file', async () => {
    await writeSubscriptions({ version: 1, accounts: [] }, stateHome);
    const result = await updateSubscriptions((file) => ({
      ...file,
      accounts: [
        ...file.accounts,
        {
          id: 'acct_u1',
          provider: 'opencode',
          label: 'Updated',
          pool: 'zen',
          homeDir: '/u1',
          priority: 'medium',
          priorityWeight: 100,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }), stateHome);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]!.id, 'acct_u1');

    // Verify persisted
    const reread = await readSubscriptions(stateHome);
    assert.equal(reread.accounts.length, 1);
    assert.equal(reread.accounts[0]!.id, 'acct_u1');
  });

  it('no file → starts from empty', async () => {
    // Ensure clean state with different home
    const subDir = join(dir, 'sub-update2');
    await mkdir(subDir, { recursive: true });
    const result = await updateSubscriptions((file) => ({
      ...file,
      accounts: [
        ...file.accounts,
        {
          id: 'acct_fresh',
          provider: 'opencode',
          label: 'Fresh',
          pool: 'go',
          homeDir: '/f',
          priority: 'high',
          priorityWeight: 200,
          enabled: true,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    }), subDir);
    assert.equal(result.accounts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// writeOpencodeAuthJson
// ---------------------------------------------------------------------------

describe('writeOpencodeAuthJson', () => {
  it('Zen writes exact schema', async () => {
    const account = newOpencodeAccount({
      id: 'acct_zen',
      label: 'Zen',
      pool: 'zen',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    await writeOpencodeAuthJson({ account, apiKey: 'sk-zen-test' });
    const authPath = getOpencodeAccountAuthPath(account);
    const content = await readFile(authPath, 'utf8');
    const parsed = JSON.parse(content);
    assert.deepEqual(parsed, { opencode: { type: 'api', key: 'sk-zen-test' } });
  });

  it('Go writes exact schema', async () => {
    const account = newOpencodeAccount({
      id: 'acct_go',
      label: 'Go',
      pool: 'go',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    await writeOpencodeAuthJson({ account, apiKey: 'sk-go-test' });
    const authPath = getOpencodeAccountAuthPath(account);
    const content = await readFile(authPath, 'utf8');
    const parsed = JSON.parse(content);
    assert.deepEqual(parsed, { 'opencode-go': { type: 'api', key: 'sk-go-test' } });
  });

  it('no secret appears in subscriptions.json', async () => {
    const account = newOpencodeAccount({
      id: 'acct_nosecret',
      label: 'NoSecret',
      pool: 'zen',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    await writeOpencodeAuthJson({ account, apiKey: 'sk-secret-123' });
    await writeSubscriptions({ version: 1, accounts: [account] }, stateHome);
    const subs = await readSubscriptions(stateHome);
    const raw = JSON.stringify(subs);
    assert.ok(!raw.includes('sk-secret-123'));
  });

  // Skip mode tests on win32
  if (process.platform !== 'win32') {
    it('auth file mode is 0600', async () => {
      const account = newOpencodeAccount({
        id: 'acct_mode',
        label: 'Mode',
        pool: 'zen',
        nowIso: '2026-01-01T00:00:00.000Z',
        stateHome,
      });
      await writeOpencodeAuthJson({ account, apiKey: 'sk-mode' });
      const authPath = getOpencodeAccountAuthPath(account);
      const st = await fsStat(authPath);
      const mode = st.mode & 0o777;
      assert.equal(
        mode,
        0o600,
        `expected mode 0o600, got 0o${mode.toString(8)}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// deleteOpencodeAccountHome
// ---------------------------------------------------------------------------

describe('deleteOpencodeAccountHome', () => {
  it('deletes scoped home dir', async () => {
    const account = newOpencodeAccount({
      id: 'acct_del',
      label: 'Del',
      pool: 'zen',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    // Create the dir via auth write
    await writeOpencodeAuthJson({ account, apiKey: 'sk-del' });
    // Verify it exists
    await assert.doesNotReject(fsStat(account.homeDir));

    await deleteOpencodeAccountHome(account, stateHome);
    await assert.rejects(fsStat(account.homeDir), { code: 'ENOENT' });
  });

  it('refuses path outside accounts root', async () => {
    const account: OpencodeSubscriptionAccount = {
      id: 'acct_bad',
      provider: 'opencode',
      label: 'Bad',
      pool: 'zen',
      homeDir: join(tmpdir(), 'outside-path'),
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await assert.rejects(
      deleteOpencodeAccountHome(account, stateHome),
      /outside accounts root/,
    );
  });
});

// ---------------------------------------------------------------------------
// Half A: generalized model tests
// ---------------------------------------------------------------------------

describe('accountEnvFor', () => {
  it('claude account → CLAUDE_CONFIG_DIR', () => {
    const account = newClaudeAccount({
      id: 'acct_c1',
      label: 'C1',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    const env = accountEnvFor(account);
    assert.equal(env['CLAUDE_CONFIG_DIR'], account.homeDir);
    assert.equal(env['CODEX_HOME'], undefined);
    assert.equal(env['GROK_HOME'], undefined);
    assert.equal(env['XDG_DATA_HOME'], undefined);
  });

  it('codex account → CODEX_HOME', () => {
    const account: SubscriptionAccount = {
      id: 'acct_cx1',
      provider: 'codex',
      kind: 'oauth-sub',
      label: 'CX1',
      homeDir: '/tmp/codex-home',
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const env = accountEnvFor(account);
    assert.equal(env['CODEX_HOME'], '/tmp/codex-home');
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined);
    assert.equal(env['XDG_DATA_HOME'], undefined);
  });

  it('grok account → GROK_HOME', () => {
    const account: SubscriptionAccount = {
      id: 'acct_g1',
      provider: 'grok',
      kind: 'oauth-sub',
      label: 'G1',
      homeDir: '/tmp/grok-home',
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const env = accountEnvFor(account);
    assert.equal(env['GROK_HOME'], '/tmp/grok-home');
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined);
    assert.equal(env['XDG_DATA_HOME'], undefined);
  });

  it('opencode account → XDG_DATA_HOME (unchanged Slice 1 behavior)', () => {
    const account = newOpencodeAccount({
      id: 'acct_o1',
      label: 'O1',
      pool: 'zen',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    const env = accountEnvFor(account);
    assert.equal(env['XDG_DATA_HOME'], account.homeDir);
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined);
  });
});

describe('newClaudeAccount', () => {
  it('creates a Claude account with correct provider and kind', () => {
    const acc = newClaudeAccount({
      id: 'acct_c2',
      label: 'Claude Test',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.provider, 'claude');
    assert.equal(acc.kind, 'oauth-sub');
    assert.equal(acc.priority, 'medium');
    assert.equal(acc.priorityWeight, 100);
    assert.equal(acc.enabled, true);
    assert.equal(acc.status, 'unknown');
  });

  it('disabled priority → enabled false', () => {
    const acc = newClaudeAccount({
      id: 'acct_c3',
      label: 'Claude Disabled',
      priority: 'disabled',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(acc.priority, 'disabled');
    assert.equal(acc.enabled, false);
  });

  it('homeDir uses provider-homes/claude path', () => {
    const acc = newClaudeAccount({
      id: 'acct_c4',
      label: 'C4',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.ok(acc.homeDir.includes('provider-homes'));
    assert.ok(acc.homeDir.includes('claude'));
    assert.ok(acc.homeDir.includes('acct_c4'));
  });
});

describe('subscriptionAccountKind', () => {
  it('opencode without kind → api-key', () => {
    const account: OpencodeSubscriptionAccount = {
      id: 'acct_ok',
      provider: 'opencode',
      label: 'NoKind',
      pool: 'zen',
      homeDir: '/tmp',
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(subscriptionAccountKind(account), 'api-key');
  });

  it('opencode with kind → returns kind', () => {
    const account: OpencodeSubscriptionAccount = {
      id: 'acct_ok2',
      provider: 'opencode',
      kind: 'api-key',
      label: 'WithKind',
      pool: 'zen',
      homeDir: '/tmp',
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(subscriptionAccountKind(account), 'api-key');
  });

  it('claude → oauth-sub', () => {
    const account = newClaudeAccount({
      id: 'acct_ck',
      label: 'CK',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    assert.equal(subscriptionAccountKind(account), 'oauth-sub');
  });
});

describe('mixed accounts read/write', () => {
  it('reads legacy opencode-only file without kind', async () => {
    const filePath = getSubscriptionsPath(stateHome);
    const legacy = {
      version: 1,
      accounts: [
        {
          id: 'acct_legacy',
          provider: 'opencode',
          label: 'Legacy',
          pool: 'zen',
          homeDir: '/tmp/legacy',
          priority: 'medium',
          priorityWeight: 100,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    await writeFile(filePath, JSON.stringify(legacy));
    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 1);
    const a = result.accounts[0];
    assert.ok(a !== undefined);
    assert.equal(a.provider, 'opencode');
    assert.equal(subscriptionAccountKind(a), 'api-key');
  });

  it('mixed claude + opencode in one file round-trips', async () => {
    const claudeAcc = newClaudeAccount({
      id: 'acct_cl1',
      label: 'Claude Max',
      priority: 'high',
      expiresAt: '2026-12-31T00:00:00.000Z',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    const opencodeAcc = newOpencodeAccount({
      id: 'acct_op1',
      label: 'OpenCode Zen',
      pool: 'zen',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });

    const file: SubscriptionsFileV1 = {
      version: 1,
      accounts: [claudeAcc, opencodeAcc],
    };
    await writeSubscriptions(file, stateHome);
    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 2);

    const claude = result.accounts.find((a) => a.provider === 'claude');
    assert.ok(claude !== undefined);
    assert.equal(claude.label, 'Claude Max');
    assert.equal(claude.priority, 'high');

    const opencode = result.accounts.find((a) => a.provider === 'opencode');
    assert.ok(opencode !== undefined);
    assert.equal(opencode.label, 'OpenCode Zen');
  });

  it('migration: old file with only opencode accounts loads unchanged', async () => {
    const oldFile = {
      version: 1,
      accounts: [
        {
          id: 'acct_old1',
          provider: 'opencode',
          label: 'Old Zen',
          pool: 'zen',
          homeDir: '/tmp/old-zen',
          priority: 'high',
          priorityWeight: 200,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-12-31T00:00:00.000Z',
        },
      ],
    };
    await writeSubscriptions(oldFile as SubscriptionsFileV1, stateHome);
    const result = await readSubscriptions(stateHome);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]!.label, 'Old Zen');
    assert.equal(subscriptionAccountKind(result.accounts[0]!), 'api-key');

    // Verify no kind was injected during read
    const raw = JSON.parse(
      await readFile(getSubscriptionsPath(stateHome), 'utf8'),
    ) as { accounts: Array<Record<string, unknown>> };
    assert.equal(raw.accounts[0]!['kind'], undefined);
  });
});

describe('deleteAccountHome', () => {
  it('deletes scoped provider-homes directory', async () => {
    const account = newClaudeAccount({
      id: 'acct_del2',
      label: 'DeleteMe',
      nowIso: '2026-01-01T00:00:00.000Z',
      stateHome,
    });
    // Create the home dir
    await mkdir(account.homeDir, { recursive: true });
    await assert.doesNotReject(fsStat(account.homeDir));

    await deleteAccountHome(account, stateHome);
    await assert.rejects(fsStat(account.homeDir), { code: 'ENOENT' });
  });

  it('refuses path outside accounts root', async () => {
    const account: SubscriptionAccount = {
      id: 'acct_bad2',
      provider: 'claude',
      kind: 'oauth-sub',
      label: 'Bad',
      homeDir: join(tmpdir(), 'outside-claude'),
      priority: 'medium',
      priorityWeight: 100,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await assert.rejects(
      deleteAccountHome(account, stateHome),
      /outside accounts root/,
    );
  });
});

describe('getClaudeAccountHome', () => {
  it('returns scoped path under provider-homes/claude', () => {
    const p = getClaudeAccountHome('acct_ch1', stateHome);
    assert.ok(p.includes('provider-homes'));
    assert.ok(p.includes('claude'));
    assert.ok(p.endsWith('acct_ch1'));
  });
});
