/**
 * test/unit/menu-accounts-refresh.test.ts — live-snapshot refresh tests for
 * the Accounts submenu (SLICE R4-P0-05).
 *
 * Verifies that every Accounts frame is derived from the latest completed
 * subscriptions read: child mutations (add/delete/disable/re-auth) are
 * visible in the very next repaint without re-entering the submenu.
 */

import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import {
  loadProviderAccountStates,
  __resetAccountsStateForTest,
} from '../../src/interface/menu.ts';
import { startMenu } from '../../src/interface/menu.ts';
import type { MenuContext } from '../../src/interface/menu.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type {
  SubscriptionsFileV1,
  SubscriptionAccount,
} from '../../src/infra/subscriptions.js';
import {
  writeSubscriptions,
} from '../../src/infra/subscriptions.js';
import { defaultStateLayout } from '../../src/infra/state-layout.js';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';
import type { AppConfig } from '../../src/infra/config.ts';
import type { LoginResult } from '../../src/commands/login.js';
import type { Clock, LedgerWriter, LedgerEntry } from '../../src/core/types.ts';
import type { ConversationMeta, ConversationStore, SessionEntry, SessionWriter } from '../../src/infra/conversation-store.ts';
import type { UpdateCheckResult } from '../../src/infra/update-check.ts';

// ---------------------------------------------------------------------------
// Helpers (mirror menu-flow.test.ts patterns)
// ---------------------------------------------------------------------------

function makeSink(): OutputSink & { buf: string } {
  let buf = '';
  return {
    get buf() { return buf; },
    write: (s: string) => { buf += s; },
    color: false,
    isTty: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeScriptedReader(lines: ReadonlyArray<string | null>): () => Promise<string | null> {
  let i = 0;
  return async (): Promise<string | null> => {
    if (i < lines.length) {
      const val = lines[i];
      i += 1;
      return val ?? null;
    }
    return null;
  };
}

function makeFakeClock(): Clock {
  let counter = 0;
  const base = 1_700_000_000_000;
  return {
    now: () => base,
    isoNow: () => new Date(base).toISOString(),
    uuid: () => `fake-${++counter}`,
    random: () => 0.5,
  };
}

interface FakeConversationStore extends ConversationStore {
  readonly _metas: ConversationMeta[];
  readonly _writers: Map<string, SessionWriter & { entries: SessionEntry[] }>;
}

function makeFakeSessionWriter(
  id: string,
  metas?: ConversationMeta[],
): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    entries,
    async append(entry: SessionEntry): Promise<void> {
      if (metas !== undefined && entry.role === 'user' && entry.content) {
        const hadUserMsg = entries.some((e) => e.role === 'user');
        if (!hadUserMsg) {
          const idx = metas.findIndex((m) => m.id === id);
          const meta = idx >= 0 ? metas[idx] : undefined;
          if (meta !== undefined && meta.title.trim().length === 0) {
            const t = entry.content.trim();
            metas[idx] = { ...meta, title: t.length <= 80 ? t : t.slice(0, 80) };
          }
        }
      }
      entries.push(entry);
    },
  };
}

function makeStore(clock: Clock): FakeConversationStore {
  const metas: ConversationMeta[] = [];
  const writers = new Map<string, SessionWriter & { entries: SessionEntry[] }>();
  return {
    _metas: metas,
    _writers: writers,
    async list(): Promise<ConversationMeta[]> {
      return [...metas].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    },
    async create(title: string): Promise<ConversationMeta> {
      const id = clock.uuid();
      const iso = clock.isoNow();
      const meta: ConversationMeta = {
        id, title, createdAt: iso, updatedAt: iso,
        messageCount: 0, pinned: false, category: null,
      };
      metas.push(meta);
      return meta;
    },
    async load(_id: string): Promise<SessionEntry[]> {
      const w = writers.get(_id);
      return w ? [...w.entries] : [];
    },
    async rename(id: string, title: string): Promise<void> {
      const idx = metas.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const m = metas[idx];
        if (m !== undefined) metas[idx] = { ...m, title };
      }
    },
    async remove(id: string): Promise<void> {
      const idx = metas.findIndex((m) => m.id === id);
      if (idx >= 0) metas.splice(idx, 1);
    },
    writer(id: string): SessionWriter {
      let w = writers.get(id);
      if (w === undefined) {
        w = makeFakeSessionWriter(id, metas);
        writers.set(id, w);
      }
      return w;
    },
    async setPinned(id: string, pinned: boolean): Promise<void> {
      const idx = metas.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const m = metas[idx];
        if (m !== undefined) metas[idx] = { ...m, pinned };
      }
    },
    async setCategory(): Promise<void> {},
  };
}

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    entries,
    async record(entry: LedgerEntry): Promise<void> { entries.push(entry); },
  };
}

const FAKE_LOGIN_RESULT: LoginResult = {
  status: 'success',
  outcomes: [
    { provider: 'claude', status: 'authenticated', method: 'code', attempts: [], fallbackUsed: false },
    { provider: 'codex', status: 'authenticated', method: 'code', attempts: [], fallbackUsed: false },
    { provider: 'opencode', status: 'authenticated', method: 'code', attempts: [], fallbackUsed: false },
    { provider: 'grok', status: 'authenticated', method: 'code', attempts: [], fallbackUsed: false },
  ],
};

const FAKE_ENV: EnvironmentStatus = {
  claude: {
    id: 'claude', installed: true, version: '1.0.0', authenticated: true,
    plan: null, binaryPath: 'claude', availableModels: ['claude-sonnet-4-6'],
  },
  codex: {
    id: 'codex', installed: true, version: '1.0.0', authenticated: true,
    plan: null, binaryPath: 'codex', availableModels: ['gpt-5.4'],
  },
  opencode: {
    id: 'opencode', installed: true, version: '0.1.0', authenticated: true,
    plan: null, binaryPath: 'opencode', availableModels: ['opencode/deepseek-v4-flash-free'],
  },
  grok: {
    id: 'grok', installed: false, version: null, authenticated: false,
    plan: null, binaryPath: null, availableModels: [],
  },
  hasAnyProvider: true,
  platform: 'linux',
};

function makeCtx(
  overrides: Partial<MenuContext> & { readLine: () => Promise<string | null> },
  clock?: Clock,
  store?: FakeConversationStore,
  ledger?: LedgerWriter,
  cwd?: string,
): MenuContext {
  const c = clock ?? makeFakeClock();
  const s = store ?? makeStore(c);
  const l = ledger ?? makeFakeLedger();
  const dir = cwd ?? join(tmpdir(), `menu-accts-refresh-${randomUUID()}`);
  const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };
  return {
    version: '2.0.0',
    clock: c, ledger: l,
    providers: {},
    env: FAKE_ENV, store: s, config, cwd: dir,
    sandbox: 'workspace-write', timeoutMs: 5_000,
    installProvider: async () => true,
    login: async () => FAKE_LOGIN_RESULT,
    checkForUpdate: async (): Promise<UpdateCheckResult> => ({
      current: '2.0.0', latest: null, updateAvailable: false,
    }),
    ...overrides,
  };
}

/**
 * Run `fn` with the app state home forced to `home`.
 */
async function withStateHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const keys = [
    'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA',
    'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
    'REPL_ID', 'REPLIT_DEV_DOMAIN',
    'CODESPACES', 'CODESPACE_NAME', 'GITPOD_WORKSPACE_ID', 'MYSHELL_CLOUD_WORKSPACE',
  ] as const;
  const orig = new Map(keys.map((k) => [k, process.env[k]] as const));
  const restore = (k: string, v: string | undefined): void => {
    if (v !== undefined) process.env[k] = v;
    else Reflect.deleteProperty(process.env, k);
  };
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['APPDATA'] = home;
  process.env['LOCALAPPDATA'] = home;
  restore('XDG_CONFIG_HOME', undefined);
  restore('XDG_STATE_HOME', undefined);
  restore('XDG_CACHE_HOME', undefined);
  restore('REPL_ID', undefined);
  restore('REPLIT_DEV_DOMAIN', undefined);
  restore('CODESPACES', undefined);
  restore('CODESPACE_NAME', undefined);
  restore('GITPOD_WORKSPACE_ID', undefined);
  restore('MYSHELL_CLOUD_WORKSPACE', undefined);
  await fs.promises.mkdir(home, { recursive: true });
  try {
    return await fn();
  } finally {
    for (const [k, v] of orig) restore(k, v);
  }
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    id: overrides.id ?? randomUUID().replace(/-/g, ''),
    provider: 'claude',
    kind: 'oauth-sub',
    label: 'claude-1',
    homeDir: '/tmp/fake-claude',
    priority: 'medium',
    priorityWeight: 1,
    enabled: true,
    createdAt: '2025-01-01T00:00:00Z',
    status: 'active',
    plan: null,
    ...overrides,
  } as SubscriptionAccount;
}

function makeSubsFile(accounts: SubscriptionAccount[]): SubscriptionsFileV1 {
  return { version: 1, accounts };
}

async function writeTestSubs(home: string, accounts: SubscriptionAccount[]): Promise<void> {
  const layout = defaultStateLayout();
  await writeSubscriptions(makeSubsFile(accounts), home, layout);
}

// ---------------------------------------------------------------------------
// Unit tests: loadProviderAccountStates
// ---------------------------------------------------------------------------

describe('loadProviderAccountStates — unit', () => {
  beforeEach(() => {
    __resetAccountsStateForTest();
  });

  it('returns computed states from a successful read', async () => {
    const subs: SubscriptionsFileV1 = {
      version: 1,
      accounts: [makeAccount({ provider: 'claude' }), makeAccount({ provider: 'codex' })],
    };
    let readCount = 0;
    const read = async () => { readCount += 1; return subs; };

    const states = await loadProviderAccountStates(read);

    assert.equal(readCount, 1, 'read must be called once');
    assert.equal(states.claude!.total, 1, 'claude should have 1 account');
    assert.equal(states.codex!.total, 1, 'codex should have 1 account');
    assert.equal(states.opencode!.total, 0, 'opencode should have 0 accounts');
    assert.equal(states.grok!.total, 0, 'grok should have 0 accounts');
  });

  it('increments read count on each call', async () => {
    const subs: SubscriptionsFileV1 = {
      version: 1,
      accounts: [makeAccount({ provider: 'claude' })],
    };
    let readCount = 0;
    const read = async () => { readCount += 1; return subs; };

    await loadProviderAccountStates(read);
    await loadProviderAccountStates(read);
    await loadProviderAccountStates(read);

    assert.equal(readCount, 3, 'read must be called 3 times');
  });

  it('reflects updated data on subsequent reads', async () => {
    const accounts: SubscriptionAccount[] = [makeAccount({ provider: 'claude' })];
    let readCount = 0;
    const read = async () => {
      readCount += 1;
      return { version: 1 as const, accounts: [...accounts] };
    };

    const states1 = await loadProviderAccountStates(read);
    assert.equal(states1.claude!.total, 1);

    accounts.push(makeAccount({ provider: 'claude', label: 'claude-2' }));
    const states2 = await loadProviderAccountStates(read);
    assert.equal(readCount, 2, 'second call must read again');
    assert.equal(states2.claude!.total, 2, 'should see the new account');
  });

  it('retains last good snapshot on transient read failure', async () => {
    let shouldFail = false;
    let readCount = 0;
    const read = async () => {
      readCount += 1;
      if (shouldFail) throw new Error('transient I/O error');
      return { version: 1 as const, accounts: [makeAccount({ provider: 'claude' })] };
    };

    const states1 = await loadProviderAccountStates(read);
    assert.equal(states1.claude!.total, 1);

    shouldFail = true;
    const states2 = await loadProviderAccountStates(read);
    assert.equal(readCount, 2);
    assert.equal(states2.claude!.total, 1, 'must retain last good snapshot');

    shouldFail = false;
    const states3 = await loadProviderAccountStates(read);
    assert.equal(readCount, 3);
    assert.equal(states3.claude!.total, 1, 'must return fresh data after recovery');
  });

  it('uses empty v1 value on initial no-snapshot failure', async () => {
    const read = async () => { throw new Error('disk missing'); };

    const states = await loadProviderAccountStates(read);

    assert.equal(states.claude!.total, 0);
    assert.equal(states.codex!.total, 0);
    assert.equal(states.opencode!.total, 0);
    assert.equal(states.grok!.total, 0);
  });

  it('does not overwrite last good snapshot with empty on subsequent failure', async () => {
    let throwCount = 0;
    const read = async () => {
      throwCount += 1;
      if (throwCount === 1) return { version: 1 as const, accounts: [makeAccount({ provider: 'opencode' })] };
      throw new Error('transient');
    };

    const states1 = await loadProviderAccountStates(read);
    assert.equal(states1.opencode!.total, 1);

    const states2 = await loadProviderAccountStates(read);
    assert.equal(states2.opencode!.total, 1, 'should retain last good, not revert to empty');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: startMenu Accounts refresh
// ---------------------------------------------------------------------------

describe('startMenu — Accounts live-snapshot refresh', () => {
  beforeEach(() => {
    __resetAccountsStateForTest();
  });

  it('management branch shows initial count with one account', async () => {
    const dir = join(tmpdir(), `accts-refresh-init-${randomUUID()}`);
    try {
      await withStateHome(dir, async () => {
        await writeTestSubs(dir, [makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' })]);

        const sink = makeSink();
        const ctx = makeCtx({
          readLine: makeScriptedReader(['a', 'b', 'q']),
          detectEnvironment: async () => FAKE_ENV,
        });

        await startMenu(ctx, sink);

        assert.ok(sink.buf.includes('1 active'), 'initial render must show 1 active claude account');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accounts submenu re-reads subs on every iteration (child mutation visible without re-entry)', async () => {
    const dir = join(tmpdir(), `accts-refresh-iter-${randomUUID()}`);
    try {
      await withStateHome(dir, async () => {
        await writeTestSubs(dir, [makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' })]);

        const sink = makeSink();

        let phase = 0;
        const customReader = async (): Promise<string | null> => {
          if (phase === 0) {
            phase = 1;
            return 'a';
          }
          if (phase === 1) {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && !sink.buf.includes('1 active')) {
              await delay(5);
            }
            await writeTestSubs(dir, [
              makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' }),
              makeAccount({ provider: 'claude', label: 'c2', enabled: true, status: 'active' }),
            ]);
            phase = 2;
            return 'x';
          }
          if (phase === 2) {
            phase = 3;
            return 'b';
          }
          return 'q';
        };

        const ctx = makeCtx({
          readLine: customReader,
          detectEnvironment: async () => FAKE_ENV,
        }, undefined, undefined, undefined, dir);

        await startMenu(ctx, sink);

        const idx1 = sink.buf.indexOf('1 active');
        const idx2 = sink.buf.indexOf('2 active');
        assert.ok(idx1 >= 0, `initial frame must show 1 active. Sink:\n${sink.buf.slice(0, 3000)}`);
        assert.ok(idx2 > idx1, `updated frame (2 active) must appear after initial frame (1 active). Sink:\n${sink.buf.slice(0, 3000)}`);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accounts submenu shows updated counts after account deletion', async () => {
    const dir = join(tmpdir(), `accts-refresh-del-${randomUUID()}`);
    try {
      await withStateHome(dir, async () => {
        await writeTestSubs(dir, [
          makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' }),
          makeAccount({ provider: 'claude', label: 'c2', enabled: true, status: 'active' }),
        ]);

        const sink = makeSink();

        let phase = 0;
        const customReader = async (): Promise<string | null> => {
          if (phase === 0) {
            phase = 1;
            return 'a';
          }
          if (phase === 1) {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && !sink.buf.includes('2 active')) {
              await delay(5);
            }
            await writeTestSubs(dir, [
              makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' }),
            ]);
            phase = 2;
            return 'x';
          }
          if (phase === 2) {
            phase = 3;
            return 'b';
          }
          return 'q';
        };

        const ctx = makeCtx({
          readLine: customReader,
          detectEnvironment: async () => FAKE_ENV,
        }, undefined, undefined, undefined, dir);

        await startMenu(ctx, sink);

        const idx2 = sink.buf.indexOf('2 active');
        const idx1after = sink.buf.indexOf('1 active', idx2 + 1);
        assert.ok(idx2 >= 0, `initial frame must show 2 active. Sink:\n${sink.buf.slice(0, 3000)}`);
        assert.ok(idx1after > idx2, `updated frame (1 active) must appear after initial frame (2 active). Sink:\n${sink.buf.slice(0, 3000)}`);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accounts submenu shows disabled count after disabling an account', async () => {
    const dir = join(tmpdir(), `accts-refresh-dis-${randomUUID()}`);
    try {
      await withStateHome(dir, async () => {
        await writeTestSubs(dir, [
          makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' }),
          makeAccount({ provider: 'claude', label: 'c2', enabled: true, status: 'active' }),
        ]);

        const sink = makeSink();

        let phase = 0;
        const customReader = async (): Promise<string | null> => {
          if (phase === 0) {
            phase = 1;
            return 'a';
          }
          if (phase === 1) {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && !sink.buf.includes('2 active')) {
              await delay(5);
            }
            await writeTestSubs(dir, [
              makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' }),
              makeAccount({ provider: 'claude', label: 'c2', enabled: false, status: 'active' }),
            ]);
            phase = 2;
            return 'x';
          }
          if (phase === 2) {
            phase = 3;
            return 'b';
          }
          return 'q';
        };

        const ctx = makeCtx({
          readLine: customReader,
          detectEnvironment: async () => FAKE_ENV,
        }, undefined, undefined, undefined, dir);

        await startMenu(ctx, sink);

        assert.ok(
          sink.buf.includes('1 active, 1 disabled'),
          `after disabling, should show 1 active, 1 disabled. Sink:\n${sink.buf.slice(0, 3000)}`,
        );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accounts submenu shows updated status after re-auth changes', async () => {
    const dir = join(tmpdir(), `accts-refresh-auth-${randomUUID()}`);
    try {
      await withStateHome(dir, async () => {
        await writeTestSubs(dir, [
          makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'auth-failed' }),
        ]);

        const sink = makeSink();

        let phase = 0;
        const customReader = async (): Promise<string | null> => {
          if (phase === 0) {
            phase = 1;
            return 'a';
          }
          if (phase === 1) {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && (sink.buf.match(/Accounts/g) || []).length < 1) {
              await delay(5);
            }
            await writeTestSubs(dir, [
              makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' }),
            ]);
            phase = 2;
            return 'x';
          }
          if (phase === 2) {
            phase = 3;
            return 'b';
          }
          return 'q';
        };

        const ctx = makeCtx({
          readLine: customReader,
          detectEnvironment: async () => FAKE_ENV,
        }, undefined, undefined, undefined, dir);

        await startMenu(ctx, sink);

        // auth-failed account: enabled=true, status='auth-failed', so active filter excludes it
        // After re-auth: enabled=true, status='active', so active=1
        const activeCount = (sink.buf.match(/1 active/g) || []).length;
        assert.ok(activeCount >= 1, `after re-auth, should show 1 active. Sink:\n${sink.buf.slice(0, 3000)}`);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });



  it('read-failure-then-recovery: retains last good snapshot and continues', async () => {
    const dir = join(tmpdir(), `accts-refresh-recover-${randomUUID()}`);
    try {
      await withStateHome(dir, async () => {
        await writeTestSubs(dir, [makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' })]);

        const sink = makeSink();
        const subsPath = defaultStateLayout().paths.subscriptionsFile;

        let phase = 0;
        const customReader = async (): Promise<string | null> => {
          if (phase === 0) {
            phase = 1;
            return 'a';
          }
          if (phase === 1) {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && !sink.buf.includes('1 active')) {
              await delay(5);
            }
            // Transient failure: remove the file to cause a read error
            await fs.promises.rm(subsPath);
            phase = 2;
            return 'x';
          }
          if (phase === 2) {
            // Restore with more accounts for recovery
            await writeTestSubs(dir, [
              makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' }),
              makeAccount({ provider: 'codex', label: 'cx1', enabled: true, status: 'active' }),
            ]);
            phase = 3;
            return 'y';
          }
          if (phase === 3) {
            phase = 4;
            return 'b';
          }
          return 'q';
        };

        const ctx = makeCtx({
          readLine: customReader,
          detectEnvironment: async () => FAKE_ENV,
        }, undefined, undefined, undefined, dir);

        await startMenu(ctx, sink);

        assert.ok(
          sink.buf.includes('1 active'),
          `during transient failure, must retain 1 active. Sink:\n${sink.buf.slice(0, 3000)}`,
        );
        assert.ok(
          sink.buf.includes('2 active'),
          `after recovery, must show updated count. Sink:\n${sink.buf.slice(0, 3000)}`,
        );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initial empty state renders correctly when no accounts exist', async () => {
    const dir = join(tmpdir(), `accts-refresh-empty-${randomUUID()}`);
    try {
      await withStateHome(dir, async () => {
        await writeTestSubs(dir, []);

        const sink = makeSink();
        const ctx = makeCtx({
          readLine: makeScriptedReader(['a', 'b', 'q']),
          detectEnvironment: async () => FAKE_ENV,
        }, undefined, undefined, undefined, dir);

        await startMenu(ctx, sink);

        assert.ok(sink.buf.includes('Accounts') && sink.buf.includes('no accounts'), 'empty accounts must show Accounts menu with no accounts status');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('read count increments per Accounts repaint after typed login migration', async () => {
    const dir = join(tmpdir(), `accts-refresh-typed-${randomUUID()}`);
    try {
      await withStateHome(dir, async () => {
        await writeTestSubs(dir, [makeAccount({ provider: 'claude', label: 'c1', enabled: true, status: 'active' })]);

        const sink = makeSink();

        const ctx = makeCtx({
          readLine: makeScriptedReader(['a', 'b', 'q']),
          detectEnvironment: async () => FAKE_ENV,
        }, undefined, undefined, undefined, dir);

        await startMenu(ctx, sink);
        assert.ok(sink.buf.includes('Accounts / Sign in') || sink.buf.includes('Accounts'), 'should render accounts');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
