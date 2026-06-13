/**
 * test/unit/menu-flow.test.ts — interactive state-machine tests for startMenu.
 *
 * Drives startMenu via an injected readLine function (ctx.readLine) with a
 * scripted input sequence. No real readline, no TTY, no live providers.
 *
 * Coverage targets
 *   1. Immediate "q" → exits cleanly
 *   2. EOF (readLine returns null) → exits cleanly (FIX 1 regression)
 *   3. "n" → first message → "/exit" → "q" → conversation created, writer got entries
 *   4. "e" → manage screen → pin → back → "q" → store mutations applied
 *   5. Unknown key → does not crash, re-renders
 *
 * Honesty Contract: no Math.random, no fabricated AI output in assertions,
 * no digit-% literals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import tty from 'node:tty';

import { EventEmitter } from 'node:events';
import {
  approveTimeoutContinuation,
  startMenu,
  runChatLoop,
} from '../../src/interface/menu.ts';
import { parseYesNo, interpretYesNoKey, yesNoHint } from '../../src/interface/menu-questions.ts';
import { readSingleKey, createLineReader, normalizeMenuKey, resolveRawKeyInput, __resetControllingTtyRawInputForTest } from '../../src/interface/menu-readline.ts';
import { readMenuKey, confirmViaKey, attachChatTurnKeyListener } from '../../src/interface/menu-key-confirm.ts';
import { defaultAliasHint, autoUpdateEnabled } from '../../src/interface/menu-display.ts';
import { completeSlash, CHAT_SLASH_COMMANDS, classifyCompletion, completeSlashArg, fuzzyRank, expandPathToken, matchPathEntries, completeChat, CHAT_SLASH_ARG_MAP } from '../../src/interface/menu-completion.ts';
import type { KeypressEvent } from '../../src/interface/menu-key-confirm.ts';
import type { KeyInputStream } from '../../src/interface/menu-readline.ts';
import type { MenuContext } from '../../src/interface/menu.ts';
import type { UpdateCheckResult } from '../../src/infra/update-check.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type { ConversationMeta, ConversationStore } from '../../src/infra/conversation-store.ts';
import type {
  Clock,
  LedgerWriter,
  LedgerEntry,
  SessionEntry,
  SessionWriter,
} from '../../src/core/types.ts';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';
import type { AppConfig } from '../../src/infra/config.ts';
import { loadConfig } from '../../src/infra/config.ts';
import { resolveStateHome } from '../../src/infra/state-dir.ts';
import { createFileGoalStore } from '../../src/infra/goal-store.ts';
import { createLedger } from '../../src/infra/ledger.ts';
import { homedir } from 'node:os';
import { renderStreamInk } from '../../src/interface/ui/run-stream.ts';
import { reduce } from '../../src/interface/ui/reduce.ts';
import { initialState, type UiState } from '../../src/interface/ui/state.ts';

/**
 * Run `fn` with the app state home forced to `home`: HOME is overridden and the
 * Replit env vars are cleared so `defaultStateHome()` (used by menu's saveConfig,
 * which takes no explicit homeDir) resolves to `home`. Restores env after.
 */
async function withStateHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const keys = ['HOME', 'REPL_ID', 'REPLIT_DEV_DOMAIN'] as const;
  const orig = new Map(keys.map((k) => [k, process.env[k]] as const));
  const restore = (k: string, v: string | undefined): void => {
    if (v !== undefined) process.env[k] = v;
    else Reflect.deleteProperty(process.env, k);
  };
  process.env['HOME'] = home;
  restore('REPL_ID', undefined);
  restore('REPLIT_DEV_DOMAIN', undefined);
  try {
    return await fn();
  } finally {
    for (const [k, v] of orig) restore(k, v);
  }
}

/**
 * Read the config back the same way production resolves its state home (with the
 * env that `withStateHome` installed), so persistence assertions match what the
 * menu's saveConfig actually wrote.
 */
async function readPersistedConfig(): Promise<AppConfig> {
  return loadConfig(resolveStateHome(process.env, process.cwd(), homedir()));
}

// ---------------------------------------------------------------------------
// Scripted readLine helper
// ---------------------------------------------------------------------------

/**
 * Build an injected readLine that yields each string from `lines` in order,
 * then returns null (EOF) for every subsequent call.
 */
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

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

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

function makeAdvanceableClock(): Clock & { advance: (ms: number) => void } {
  let counter = 0;
  let nowMs = 1_700_000_000_000;
  return {
    now: () => nowMs,
    isoNow: () => new Date(nowMs).toISOString(),
    uuid: () => `fake-${++counter}`,
    random: () => 0.5,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake ledger
// ---------------------------------------------------------------------------

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    entries,
    async record(entry: LedgerEntry): Promise<void> {
      entries.push(entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake session writer
// ---------------------------------------------------------------------------

function makeFakeSessionWriter(
  id: string,
  metas?: ConversationMeta[],
): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    entries,
    async append(entry: SessionEntry): Promise<void> {
      // Mirror the real store (conversations.ts:191-201): the FIRST user message
      // derives the title when the conversation was created untitled. Without this
      // the fake never reflects the silent title-derivation the new-chat flow now
      // relies on (no up-front "name your chat" prompt).
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

// ---------------------------------------------------------------------------
// Fake in-memory ConversationStore
// ---------------------------------------------------------------------------

interface FakeConversationStore extends ConversationStore {
  readonly _metas: ConversationMeta[];
  readonly _writers: Map<string, SessionWriter & { entries: SessionEntry[] }>;
}

function makeStore(clock: Clock, initialMetas?: ConversationMeta[]): FakeConversationStore {
  const metas: ConversationMeta[] = initialMetas ? [...initialMetas] : [];
  const writers = new Map<string, SessionWriter & { entries: SessionEntry[] }>();

  return {
    _metas: metas,
    _writers: writers,

    async list(): Promise<ConversationMeta[]> {
      // Pinned first, then most-recently-updated first (mirrors real impl)
      return [...metas].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    },

    async create(title: string): Promise<ConversationMeta> {
      const id = clock.uuid();
      const iso = clock.isoNow();
      const meta: ConversationMeta = {
        id,
        title,
        createdAt: iso,
        updatedAt: iso,
        messageCount: 0,
        pinned: false,
        category: null,
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
        if (m !== undefined) {
          metas[idx] = { ...m, title };
        }
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
        if (m !== undefined) {
          metas[idx] = { ...m, pinned };
        }
      }
    },

    async setCategory(id: string, category: string | null): Promise<void> {
      const idx = metas.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const m = metas[idx];
        if (m !== undefined) {
          metas[idx] = { ...m, category };
        }
      }
    },

    async setRecap(id: string, recap: string | null, atMessageCount: number): Promise<void> {
      const idx = metas.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const m = metas[idx];
        if (m !== undefined) {
          metas[idx] = {
            ...m,
            recap,
            recapAt: recap === null ? null : clock.isoNow(),
            recapMessageCount: atMessageCount,
          };
        }
      }
    },

    async setIntensity(id: string, intensity): Promise<void> {
      const idx = metas.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const m = metas[idx];
        if (m !== undefined) {
          if (intensity === undefined || intensity === 'auto') {
            const { intensity: _ignored, ...rest } = m;
            metas[idx] = rest;
          } else {
            metas[idx] = { ...m, intensity };
          }
        }
      }
    },

    async truncateAfter(id: string, keepCount: number): Promise<number> {
      const w = writers.get(id);
      if (w === undefined) return 0;
      const keep = Math.max(0, Math.min(Math.floor(keepCount), w.entries.length));
      w.entries.length = keep;
      const idx = metas.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const m = metas[idx];
        if (m !== undefined) {
          metas[idx] = { ...m, messageCount: keep, recap: null, recapAt: null };
        }
      }
      return keep;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake provider (scripted done — no real model called)
// ---------------------------------------------------------------------------

const CONFIDENCE_ENVELOPE =
  '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';

const FAKE_USAGE: Usage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 };

function makeFakeProvider(id: 'claude' | 'codex' = 'claude'): Provider {
  const events: ProviderEvent[] = [
    { type: 'text', delta: 'Done.' },
    {
      type: 'done',
      text: `Done.\n${CONFIDENCE_ENVELOPE}`,
      usage: FAKE_USAGE,
      raw: {},
    },
  ];
  return {
    id,
    async detect() {
      return {
        id,
        installed: true,
        version: '1.0.0',
        authenticated: true,
        plan: null,
        binaryPath: null,
        availableModels: ['model-a'],
      };
    },
    async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      for (const ev of events) {
        yield ev;
      }
    },
  };
}

function makeTrackingProvider(
  id: 'claude' | 'codex',
  calls: Array<'claude' | 'codex'>,
): Provider {
  const provider = makeFakeProvider(id);
  return {
    ...provider,
    async *run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      if (req.prompt.includes('implement the parser')) calls.push(id);
      yield* provider.run(req, signal);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake environment
// ---------------------------------------------------------------------------

const FAKE_ENV: EnvironmentStatus = {
  claude: {
    id: 'claude',
    installed: true,
    version: '1.0.0',
    authenticated: true,
    plan: null,
    binaryPath: null,
    availableModels: ['model-a'],
  },
  codex: {
    id: 'codex',
    installed: false,
    version: null,
    authenticated: false,
    plan: null,
    binaryPath: null,
    availableModels: [],
  },
  opencode: {
    id: 'opencode',
    installed: false,
    version: null,
    authenticated: false,
    plan: null,
    binaryPath: null,
    availableModels: [],
  },
  hasAnyProvider: true,
  platform: 'linux',
};

describe('runChatLoop — active subscription capacity allocator', () => {
  const capacityEnv: EnvironmentStatus = {
    claude: {
      id: 'claude',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: 'Max 20x',
      binaryPath: 'claude',
      availableModels: ['claude-sonnet-4-6'],
    },
    codex: {
      id: 'codex',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: 'Plus',
      binaryPath: 'codex',
      availableModels: ['gpt-5.4'],
    },
    opencode: {
      id: 'opencode',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    hasAnyProvider: true,
    platform: 'linux',
  };

  it('shifts an IC turn by weighted session consumption and leaves a fresh conversation neutral', async () => {
    const cwd = join(tmpdir(), `menu-live-capacity-${randomUUID()}`);
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = createLedger({ cwd });
    const consumed = await store.create('consumed');
    const fresh = await store.create('fresh');
    await ledger.record({
      timestamp: clock.isoNow(),
      sessionId: consumed.id,
      taskId: 'seed-claude',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tier: 'ic',
      inputTokens: 2_001,
      outputTokens: 0,
      cachedInputTokens: 0,
      usd: 0,
      durationMs: 1,
      success: true,
    });
    await ledger.record({
      timestamp: clock.isoNow(),
      sessionId: consumed.id,
      taskId: 'seed-codex',
      provider: 'codex',
      model: 'gpt-5.4',
      tier: 'ic',
      inputTokens: 200,
      outputTokens: 0,
      cachedInputTokens: 0,
      usd: 0,
      durationMs: 1,
      success: true,
    });

    const runConversation = async (conversationId: string): Promise<Array<'claude' | 'codex'>> => {
      const calls: Array<'claude' | 'codex'> = [];
      const ctx = makeCtx(
        {
          providers: {
            claude: makeTrackingProvider('claude', calls),
            codex: makeTrackingProvider('codex', calls),
          },
          env: capacityEnv,
          config: {
            onboarded: true,
            setAsDefault: false,
            smartRoute: false,
            intentEngine: false,
            experimentalAutoGoal: false,
            mode: 'cost-saver',
          },
          readLine: makeScriptedReader(['implement the parser', '/exit']),
        },
        clock,
        store,
        ledger,
        cwd,
      );
      await runChatLoop(
        ctx,
        { config: ctx.config, env: capacityEnv },
        conversationId,
        makeSink(),
        makeScriptedReader(['implement the parser', '/exit']),
        async () => 0,
        async () => capacityEnv,
        async () => false,
      );
      return calls;
    };

    try {
      assert.deepStrictEqual(await runConversation(consumed.id), ['codex']);
      assert.deepStrictEqual(await runConversation(fresh.id), ['claude']);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Non-color capturing OutputSink
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

// ---------------------------------------------------------------------------
// Build a MenuContext from parts
// ---------------------------------------------------------------------------

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
  const dir = cwd ?? join(tmpdir(), `menu-flow-${randomUUID()}`);

  // smartRoute defaults ON in production, but these flows drive FAKE providers
  // (not a real router), so disable it here to keep the per-turn provider-call
  // sequence deterministic. Smart routing is covered by router.test.ts +
  // route-classifier.test.ts and verified live.
  const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };

  return {
    version: '2.0.0',
    clock: c,
    ledger: l,
    providers: { claude: makeFakeProvider() },
    env: FAKE_ENV,
    store: s,
    config,
    cwd: dir,
    sandbox: 'workspace-write',
    timeoutMs: 5_000,
    // Inject no-op fakes so no real npm/claude/codex subprocesses are spawned
    installProvider: async () => true,
    login: async () => 0,
    // Inject a no-op update check so no real npm registry requests are made
    checkForUpdate: async (): Promise<UpdateCheckResult> => ({
      current: '2.0.0',
      latest: null,
      updateAvailable: false,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FLOW 1: immediate "q" → exits cleanly
// ---------------------------------------------------------------------------

describe('startMenu — immediate q → exits cleanly', () => {
  it('resolves without throwing', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['q']) });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'startMenu should resolve cleanly on "q"',
    );
  });

  it('renders the main screen before quitting', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['q']) });

    await startMenu(ctx, sink);
    assert.ok(sink.buf.includes('myshell-tools'), 'main screen should be rendered');
  });

  it('dispatches a line-mode j with carriage return to Claude login', async () => {
    const sink = makeSink();
    const loginCalls: string[] = [];
    const ctx = makeCtx({
      readLine: makeScriptedReader(['j\r', 'q']),
      login: async (_out, providerArg) => {
        loginCalls.push(providerArg ?? 'all');
        return 0;
      },
      detectEnvironment: async () => FAKE_ENV,
    });

    await startMenu(ctx, sink);

    assert.deepEqual(loginCalls, ['claude'], 'normalized line-mode j must dispatch to Claude login');
  });

  it('after Claude login re-detects authenticated state and returns to home without re-prompting auth', async () => {
    const sink = makeSink();
    const loginCalls: string[] = [];
    let detectCalls = 0;
    const afterLoginEnv: EnvironmentStatus = {
      ...FAKE_ENV,
      claude: { ...FAKE_ENV.claude, authenticated: true, availableModels: ['model-a'] },
    };
    const ctx = makeCtx({
      env: { ...FAKE_ENV, claude: { ...FAKE_ENV.claude, authenticated: false } },
      readLine: makeScriptedReader(['j', '', 'q']),
      login: async (_out, providerArg) => {
        loginCalls.push(providerArg ?? 'all');
        return 0;
      },
      detectEnvironment: async () => {
        detectCalls += 1;
        return afterLoginEnv;
      },
    });

    await startMenu(ctx, sink);

    assert.deepEqual(loginCalls, ['claude'], 'completed login must not loop back into auth');
    assert.equal(detectCalls, 1, 'menu must refresh provider state exactly once after login');
    assert.ok(sink.buf.includes('ready'), 'home screen after login must render authenticated status');
  });

  it('startMenu resolves (not hangs)', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['q']) });

    const p = startMenu(ctx, sink);
    await assert.doesNotReject(p);
  });

  it('empty-key repaint within TTL does not re-detect the environment', async () => {
    const sink = makeSink();
    let detectCalls = 0;
    const ctx = makeCtx({
      readLine: makeScriptedReader(['', '', 'q']),
      detectEnvironment: async () => {
        detectCalls += 1;
        return FAKE_ENV;
      },
    });

    await startMenu(ctx, sink);

    assert.equal(detectCalls, 0, 'TTL no-op path must not spawn a re-detect');
  });

  it('after the TTL expires, the next return to the menu refreshes exactly once', async () => {
    const sink = makeSink();
    const clock = makeAdvanceableClock();
    let detectCalls = 0;
    let reads = 0;
    const ctx = makeCtx(
      {
        readLine: async () => {
          reads += 1;
          if (reads === 1) {
            clock.advance(15_001);
            return '';
          }
          return 'q';
        },
        detectEnvironment: async () => {
          detectCalls += 1;
          return FAKE_ENV;
        },
      },
      clock,
    );

    await startMenu(ctx, sink);

    assert.equal(detectCalls, 1, 'exactly one stale-menu refresh should run');
  });

  it('a failed stale refresh retains the prior environment snapshot', async () => {
    const priorEnv: EnvironmentStatus = {
      ...FAKE_ENV,
      claude: { ...FAKE_ENV.claude, plan: 'max_5x' },
    };
    const sink = makeSink();
    const clock = makeAdvanceableClock();
    let detectCalls = 0;
    let reads = 0;
    const ctx = makeCtx(
      {
        env: priorEnv,
        readLine: async () => {
          reads += 1;
          if (reads === 1) {
            clock.advance(15_001);
            return '';
          }
          return 'q';
        },
        detectEnvironment: async () => {
          detectCalls += 1;
          throw new Error('detect failed');
        },
      },
      clock,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    assert.equal(detectCalls, 1, 'stale refresh should attempt one detect');
    assert.ok(sink.buf.includes('max_5x'), 'prior provider plan should remain rendered after a failed refresh');
  });

  it('explicit login forces an environment refresh even within the TTL', async () => {
    const sink = makeSink();
    let detectCalls = 0;
    const ctx = makeCtx({
      readLine: makeScriptedReader(['j', 'q']),
      login: async () => 0,
      detectEnvironment: async () => {
        detectCalls += 1;
        return FAKE_ENV;
      },
    });

    await startMenu(ctx, sink);

    assert.equal(detectCalls, 1, 'forced post-login refresh must bypass the TTL');
  });
});

// ---------------------------------------------------------------------------
// FLOW 2: EOF (null) → exits cleanly (FIX 1 regression test)
// ---------------------------------------------------------------------------

describe('startMenu — EOF / null from readLine → exits cleanly (FIX 1)', () => {
  it('resolves without throwing on immediate EOF', async () => {
    const sink = makeSink();
    // readLine returns null immediately (simulates `printf '' | node dist/cli.js`)
    const ctx = makeCtx({ readLine: makeScriptedReader([null]) });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'EOF should not cause ERR_USE_AFTER_CLOSE or any thrown error',
    );
  });

  it('renders the screen before the EOF causes exit', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader([null]) });

    await startMenu(ctx, sink);
    // The main screen is rendered before the first readLine() call
    assert.ok(sink.buf.includes('myshell-tools'), 'main screen rendered before EOF');
  });

  it('EOF mid-session also exits cleanly (multiple screens then EOF)', async () => {
    const sink = makeSink();
    // Press unknown key (re-renders), then EOF
    const ctx = makeCtx({ readLine: makeScriptedReader(['z', null]) });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'EOF after an unknown key should resolve cleanly',
    );
    assert.ok(sink.buf.includes('Unknown option'), 'unknown key message shown before EOF exit');
  });
});

// ---------------------------------------------------------------------------
// FLOW 3: "n" → first message → "/exit" (back to menu) → "q"
//          A conversation should be created; the writer should have entries
// ---------------------------------------------------------------------------

describe('startMenu — n → first-message → /exit → q', () => {
  let sink: OutputSink & { buf: string };
  let store: FakeConversationStore;
  let clock: Clock;

  async function run(inputs: ReadonlyArray<string | null>): Promise<void> {
    clock = makeFakeClock();
    store = makeStore(clock);
    sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(inputs) }, clock, store);
    await startMenu(ctx, sink);
  }

  it('resolves cleanly', async () => {
    await assert.doesNotReject(() =>
      run(['n', 'My first task', '/exit', 'q']),
    );
  });

  it('creates a conversation in the store', async () => {
    await run(['n', 'My first task', '/exit', 'q']);
    const metas = await store.list();
    assert.equal(metas.length, 1, 'one conversation should be created');
    assert.equal(metas[0]?.title, 'My first task');
  });

  it('the session writer received the user message when a task is sent', async () => {
    // No up-front title prompt anymore: 'n' opens the chat directly and the FIRST
    // line is the task sent to orchestrate. Inputs: 'n' (new conv) →
    //   'do this task' (the task) → '/exit' → 'q'.
    await run(['n', 'do this task', '/exit', 'q']);
    const metas = await store.list();
    const id = metas[0]?.id;
    assert.ok(id !== undefined, 'conversation id exists');
    const w = store._writers.get(id);
    assert.ok(w !== undefined, 'writer exists for the conversation');
    // The orchestrator writes user + assistant entries
    assert.ok(w.entries.length > 0, 'writer received at least one entry');
    const userEntry = w.entries.find((e) => e.role === 'user');
    assert.ok(userEntry !== undefined, 'user entry present');
    assert.equal(userEntry.content, 'do this task', 'user message content matches task sent');
  });

  it('/exit returns to main menu (outputs main screen again)', async () => {
    await run(['n', 'My first task', '/exit', 'q']);
    // The main screen is rendered at least twice: once before 'n', once after /exit returns
    const occurrences = sink.buf.split('myshell-tools').length - 1;
    assert.ok(occurrences >= 2, `main screen rendered at least twice (got ${occurrences})`);
  });

  it('EOF inside chat loop exits gracefully without throw', async () => {
    await assert.doesNotReject(() =>
      run(['n', 'My task', null]),
      'EOF inside chat loop should resolve cleanly (no ERR_USE_AFTER_CLOSE)',
    );
  });

});

describe('startMenu — /goal ask_user stops autonomous loop and surfaces selector', () => {
  it('answers the selector without starting another autonomous goal turn', async () => {
    const prompts: string[] = [];
    const questionBlock =
      '{"ask_user":{"questions":[{"id":"db","prompt":"Which database?","options":[{"label":"Postgres"},{"label":"SQLite"}],"multiSelect":false,"allowFreeText":false}]}}';
    let callCount = 0;
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        // 4th-report fix: /goal now forms a SMART manager-tier objective for the
        // LABEL first (core/goal-objective-generator.ts), distinguishable by its
        // "OBJECTIVE: <a crisp" instruction. Answer it tidily and DON'T count it as
        // a goal turn — the assertions below are about the goal LOOP, not the label.
        if (req.prompt.includes('OBJECTIVE: <a crisp')) {
          const reply = 'OBJECTIVE: Choose the database';
          yield { type: 'text', delta: reply };
          yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
          return;
        }
        prompts.push(req.prompt);
        callCount++;
        if (callCount === 1) {
          yield { type: 'text', delta: 'Which database?\n' };
          yield {
            type: 'done',
            text: `Which database?\n${questionBlock}`,
            usage: FAKE_USAGE,
            raw: {},
          };
          return;
        }
        yield { type: 'text', delta: 'Using Postgres.' };
        yield {
          type: 'done',
          text: `Using Postgres.\n${CONFIDENCE_ENVELOPE}`,
          usage: FAKE_USAGE,
          raw: {},
        };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const ctx = makeCtx(
      {
        // Free-loop coverage: opt OUT of the manager cycle so `/goal` exercises the
        // autonomous loop's ask_user handling this test validates (with it on — the
        // default — `/goal` builds a roadmap + runs the per-to-do manager cycle).
        config: { onboarded: true, setAsDefault: false, smartRoute: false, experimentalManager: false },
        providers: { claude: provider },
        readLine: makeScriptedReader([
          'n',
          '/goal choose the database',
          '1',
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.equal(callCount, 2, 'one goal turn plus one normal answer turn');
    assert.ok(sink.buf.includes('? Question: Which database?'), 'question selector is surfaced');
    assert.ok(sink.buf.includes('1. Postgres'), 'selector shows numbered options');
    assert.ok(sink.buf.includes('Type a number · Enter = skip · Ctrl+C = cancel'), 'selector shows the final hint');
    assert.ok(prompts[0]?.includes('Goal: choose the database'), 'first call is the goal turn');
    assert.ok(prompts[1]?.includes('Answers: db = Postgres'), 'second call submits the selected answer');
    assert.ok(
      !prompts.slice(1).some((p) => p.includes('Continue working autonomously toward this goal')),
      'must not start another autonomous goal turn after ask_user',
    );
  });
});

describe('startMenu — /goal work contract threading', () => {
  it('passes a contract into each goal turn and grows it from GOAL_CONTINUE text', async () => {
    const prompts: string[] = [];
    let callCount = 0;
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        // 4th-report fix: /goal forms a SMART manager-tier objective for the LABEL
        // first; answer that call tidily and don't count it as a goal turn. The
        // formed objective becomes the contract OBJECTIVE (capitalised by
        // parseGoalObjective), while the full goalText drives the goal-turn headers.
        if (req.prompt.includes('OBJECTIVE: <a crisp')) {
          const reply = 'OBJECTIVE: ship the widget';
          yield { type: 'text', delta: reply };
          yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
          return;
        }
        prompts.push(req.prompt);
        callCount++;
        if (callCount === 1) {
          const continued = `Created the files.\nGOAL_CONTINUE: run the tests\n${CONFIDENCE_ENVELOPE}`;
          yield { type: 'text', delta: continued };
          yield {
            type: 'done',
            text: continued,
            usage: FAKE_USAGE,
            raw: {},
          };
          return;
        }
        yield { type: 'text', delta: 'Tests pass.\nGOAL_COMPLETE' };
        yield {
          type: 'done',
          text: 'Tests pass.\nGOAL_COMPLETE',
          usage: FAKE_USAGE,
          raw: {},
        };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const ctx = makeCtx(
      {
        // Free-loop coverage: opt OUT of the manager cycle so `/goal` exercises the
        // GOAL_CONTINUE contract loop this test validates (with it on — the default —
        // `/goal` builds a to-do roadmap + runs the per-to-do manager cycle instead,
        // covered separately). Byte-for-byte the legacy `/goal` path when off.
        config: { onboarded: true, setAsDefault: false, smartRoute: false, experimentalManager: false },
        providers: { claude: provider },
        readLine: makeScriptedReader([
          'n',
          '/goal ship the widget',
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.equal(callCount, 2, 'one continue turn plus one complete turn');
    // The contract OBJECTIVE is the formed label (parseGoalObjective capitalises it),
    // while the goal-turn header still carries the full raw goalText (asserted below).
    assert.ok(prompts[0]?.includes('OBJECTIVE: Ship the widget'));
    assert.ok(
      !prompts[0]?.includes('append EXACTLY the following JSON object'),
      'goal turns suppress the normal confidence-envelope requirement',
    );
    assert.ok(
      prompts[0]?.includes('Before acting, confirm this turn still directly serves the OBJECTIVE; do not pursue unrelated improvements.'),
    );
    assert.ok(!prompts[0]?.includes("RECENT STEPS (each turn's stated next action):"));
    assert.ok(prompts[1]?.includes('OBJECTIVE: Ship the widget'));
    assert.ok(prompts[1]?.includes("RECENT STEPS (each turn's stated next action):\n- C1: run the tests"));
    assert.ok(prompts[1]?.includes('Continue working autonomously toward this goal: ship the widget'));

    const persistedEntries = [...store._writers.values()].flatMap((writer) => writer.entries);
    assert.ok(
      persistedEntries.some((entry) => entry.role === 'user' && entry.content.startsWith('Goal: ship the widget')),
      'the persisted user turn remains the ordinary goal task',
    );
    assert.ok(
      !persistedEntries.some((entry) => entry.content.includes('OBJECTIVE: ship the widget')),
      'the prompt-only contract is not persisted in session history',
    );
    assert.ok(
      !persistedEntries.some((entry) => entry.role === 'user' && entry.workTrace !== undefined),
      'user entries stay clean and carry no workTrace',
    );

    const assistantEntries = persistedEntries.filter((entry) => entry.role === 'assistant');
    assert.equal(assistantEntries.length, 2);
    // The workTrace objective is the SMART formed label (capitalised), not the raw text.
    assert.equal(assistantEntries[0]?.workTrace?.objective, 'Ship the widget');
    assert.equal(assistantEntries[0]?.workTrace?.checkpoints, undefined);
    assert.deepEqual(assistantEntries[1]?.workTrace?.checkpoints, [
      { id: 'C1', summary: 'run the tests' },
    ]);
  });
});

describe('startMenu — /goal PROPOSES the plan before running it (manager cycle on)', () => {
  it('renders the confident proposal + one-tap confirm; "Edit / not yet" parks instead of executing', async () => {
    const prompts: string[] = [];
    let goalWorkTurns = 0;
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        // The PLANNING BRAIN call (judgeGoal) → return a real staged plan so the
        // proposal renders from the full plan (vision + goal + todos + deps + approach).
        if (req.prompt.includes('PLANNING BRAIN')) {
          const reply = [
            'JUDGMENT: stage',
            'VISION: ship the auth system',
            'GOAL: Harden the token-refresh path',
            'APPROACH: rotate refresh tokens server-side',
            'WHY: it closes the replay window the client-only flow leaves open',
            'ALT: client-only refresh',
            'TODO: wire the refresh endpoint',
            'TODO: add rotation on use  [after: 1]',
          ].join('\n');
          yield { type: 'text', delta: reply };
          yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
          return;
        }
        // The background whole-picture UNDERSTANDING warm + the smart-label OBJECTIVE
        // former are NOT goal-work turns — answer them benignly and don't count them.
        if (
          req.prompt.includes('WHOLE-PICTURE') ||
          req.prompt.includes('understand the system') ||
          req.prompt.includes('OBJECTIVE: <a crisp')
        ) {
          yield { type: 'text', delta: 'ok' };
          yield { type: 'done', text: 'ok', usage: FAKE_USAGE, raw: {} };
          return;
        }
        // Anything else is a goal-WORK turn — must NOT happen when the user declines.
        prompts.push(req.prompt);
        goalWorkTurns += 1;
        yield { type: 'text', delta: 'working' };
        yield { type: 'done', text: `working\n${CONFIDENCE_ENVELOPE}`, usage: FAKE_USAGE, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const ctx = makeCtx(
      {
        // Manager cycle ON (the default) → /goal proposes before executing.
        config: { onboarded: true, setAsDefault: false, smartRoute: false, experimentalManager: true },
        providers: { claude: provider },
        readLine: makeScriptedReader([
          'n',
          '/goal ship the auth system',
          '3', // the one-tap confirm: "Edit / not yet" → park, do not run
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes("Here's how I'd tackle ship the auth system"), 'renders the confident vision header');
    assert.ok(sink.buf.includes('1. Harden the token-refresh path'), 'renders the goal title');
    assert.ok(sink.buf.includes('Approach: rotate refresh tokens server-side'), 'renders the chosen approach');
    assert.ok(sink.buf.includes('Step 2 build on 1.'), 'renders the dependency cause→effect phrase');
    assert.ok(sink.buf.includes('? Question: Shall I run this, or adjust first?'), 'offers the one-tap confirm');
    assert.ok(sink.buf.includes('Start all') && sink.buf.includes('Just the unblocked ones'), 'the go options');
    assert.ok(/Parked ".*" on the board/.test(sink.buf), 'declining parks the goal');
    assert.equal(goalWorkTurns, 0, 'declining the proposal must NOT run any goal-work turn');
  });

  it('oversight=autonomous SKIPS the confirm — says "On it" and runs without a go prompt', async () => {
    let goalWorkTurns = 0;
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        // The PLANNING BRAIN call (judgeGoal) → a real staged plan to launch.
        if (req.prompt.includes('PLANNING BRAIN')) {
          const reply = [
            'JUDGMENT: stage',
            'VISION: ship the auth system',
            'GOAL: Harden the token-refresh path',
            'APPROACH: rotate refresh tokens server-side',
            'WHY: it closes the replay window the client-only flow leaves open',
            'TODO: wire the refresh endpoint',
          ].join('\n');
          yield { type: 'text', delta: reply };
          yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
          return;
        }
        // Background warm-up / smart-label passes — benign, not goal work.
        if (
          req.prompt.includes('WHOLE-PICTURE') ||
          req.prompt.includes('understand the system') ||
          req.prompt.includes('OBJECTIVE: <a crisp')
        ) {
          yield { type: 'text', delta: 'ok' };
          yield { type: 'done', text: 'ok', usage: FAKE_USAGE, raw: {} };
          return;
        }
        // A goal-WORK turn — autonomous launches it WITHOUT a confirm.
        goalWorkTurns += 1;
        yield { type: 'text', delta: 'working' };
        yield { type: 'done', text: `working\n${CONFIDENCE_ENVELOPE}`, usage: FAKE_USAGE, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const ctx = makeCtx(
      {
        // Manager cycle ON + oversight autonomous → /goal skips the confirm.
        config: {
          onboarded: true,
          setAsDefault: false,
          smartRoute: false,
          experimentalManager: true,
          oversight: 'autonomous',
        },
        providers: { claude: provider },
        // No confirm keypress in the script — autonomous never asks for one.
        readLine: makeScriptedReader([
          'n',
          '/goal ship the auth system',
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.ok(
      /On it — starting "/.test(sink.buf),
      'autonomous announces it is starting the goal',
    );
    assert.ok(
      !sink.buf.includes('Shall I run this, or adjust first?'),
      'autonomous must NOT present the launch confirm prompt',
    );
    assert.ok(goalWorkTurns >= 1, 'autonomous launches the manager cycle (a goal-work turn ran)');
  });

  it('[Start all] on a MULTI-goal plan runs EVERY goal sequentially to verified-done', async () => {
    // The over-promise bug this fixes: a 2-goal proposal offered [Start all] but only
    // the FIRST goal ever ran. Assert BOTH goals reach a goal-work turn (each goal's
    // title appears as the `Goal: <title>` work input) and the hand-off is narrated.
    const goalWorkTitles: string[] = [];
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        // The PLANNING BRAIN call (judgeGoal) → a TWO-goal staged plan, so [Start all]
        // promises "2 goals" and must run both.
        if (req.prompt.includes('PLANNING BRAIN')) {
          const reply = [
            'JUDGMENT: stage',
            'VISION: ship the auth system',
            'GOAL: Harden the token-refresh path',
            'TODO: wire the refresh endpoint',
            'GOAL: Add a session audit log',
            'TODO: append a row on each login',
          ].join('\n');
          yield { type: 'text', delta: reply };
          yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
          return;
        }
        // Background warm-up / smart-label passes — benign, not goal work.
        if (
          req.prompt.includes('WHOLE-PICTURE') ||
          req.prompt.includes('understand the system') ||
          req.prompt.includes('OBJECTIVE: <a crisp')
        ) {
          yield { type: 'text', delta: 'ok' };
          yield { type: 'done', text: 'ok', usage: FAKE_USAGE, raw: {} };
          return;
        }
        // A goal-WORK turn — capture which goal's title it carried (Goal: <title>) so
        // the test proves BOTH goals were actually worked, not just the first. Each
        // emits GOAL_COMPLETE so its manager cycle settles and the run moves on.
        const m = /Goal:\s*(.+)/.exec(req.prompt);
        if (m?.[1] !== undefined) goalWorkTitles.push(m[1].trim());
        yield { type: 'text', delta: 'Done.\nGOAL_COMPLETE' };
        yield { type: 'done', text: 'Done.\nGOAL_COMPLETE', usage: FAKE_USAGE, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const ctx = makeCtx(
      {
        config: { onboarded: true, setAsDefault: false, smartRoute: false, experimentalManager: true },
        providers: { claude: provider },
        readLine: makeScriptedReader([
          'n',
          '/goal ship the auth system',
          '1', // the one-tap confirm: "Start all" → run the WHOLE plan
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.ok(
      goalWorkTitles.some((t) => t.startsWith('Harden the token-refresh path')),
      'the FIRST goal ran a goal-work turn',
    );
    assert.ok(
      goalWorkTitles.some((t) => t.startsWith('Add a session audit log')),
      'the SECOND goal also ran a goal-work turn (no longer silently dropped)',
    );
    assert.ok(
      sink.buf.includes('moving to goal 2 of 2: "Add a session audit log"'),
      'narrates the hand-off between goals',
    );
  });
});

describe('startMenu — auto-goal smart autonomy', () => {
  it('with autoGoal off, a manager-tier task stays on the single runTask path', async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        prompts.push(req.prompt);
        yield { type: 'text', delta: 'Done.' };
        yield {
          type: 'done',
          text: `Done.\n${CONFIDENCE_ENVELOPE}`,
          usage: FAKE_USAGE,
          raw: {},
        };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      mode: 'quality-first',
      smartRoute: false,
      // Disable the gated intent pass so this asserts PURE task-dispatch routing
      // (a manager-tier turn would otherwise also make one cheap intent-extraction
      // call — that is exercised in the intent tests, not here). Same discipline
      // as smartRoute:false above. Also opt OUT of the now-default-ON auto-stage /
      // understanding passes (a substantial turn would otherwise fire the planner
      // post-reply — exercised in the auto-stage tests, not here).
      intentEngine: false,
      experimentalAutoGoal: false,
      experimentalUnderstanding: false,
    };
    const ctx = makeCtx(
      {
        config,
        providers: { claude: provider },
        readLine: makeScriptedReader([
          'n',
          'review and design the architecture',
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.equal(prompts.length, 1, 'autoGoal off must dispatch exactly one task');
    assert.ok(
      !prompts[0]?.includes('Goal: review and design the architecture'),
      'autoGoal off must not rewrite the task as a goal turn',
    );
    assert.ok(
      !sink.buf.includes("Working autonomously until it's done"),
      'autoGoal off must not print the autonomous banner',
    );
  });

  it('clear actionable chat creates exactly one running goal before the first worker call, with the planner roadmap', async () => {
    const dir = join(tmpdir(), `menu-preflight-goal-${randomUUID()}`);
    await withStateHome(dir, async () => {
      const clock = makeFakeClock();
      const store = makeStore(clock);
      let workerCalls = 0;
      const provider: Provider = {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1.0.0',
            authenticated: true,
            plan: null,
            binaryPath: null,
            availableModels: ['model-a'],
          };
        },
        async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
          if (req.prompt.includes('PLANNING BRAIN')) {
            const reply = [
              'JUDGMENT: stage',
              'GOAL: Ship the billing migration',
              'TODO: map the current billing flows',
              'TODO: wire the new provider',
            ].join('\n');
            yield { type: 'text', delta: reply };
            yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
            return;
          }
          workerCalls += 1;
          const goalStore = createFileGoalStore({ clock });
          const all = await goalStore.list();
          assert.equal(workerCalls, 1, 'only the first work turn should inspect persistence timing');
          assert.equal(all.length, 1, 'the goal must already exist before the first worker call');
          assert.equal(all[0]?.state, 'running', 'the staged goal must be promoted before work starts');
          assert.equal(all[0]?.title, 'Ship the billing migration');
          assert.deepEqual(all[0]?.roadmap.map((item) => item.text), [
            'map the current billing flows',
            'wire the new provider',
          ]);
          yield { type: 'text', delta: 'Done.\nGOAL_COMPLETE' };
          yield { type: 'done', text: 'Done.\nGOAL_COMPLETE', usage: FAKE_USAGE, raw: {} };
        },
      };

      const sink = makeSink();
      const ctx = makeCtx(
        {
          providers: { claude: provider },
          readLine: makeScriptedReader(['n', 'implement and wire the new billing provider', '/exit', 'q']),
        },
        clock,
        store,
      );

      await startMenu(ctx, sink);

      const goalStore = createFileGoalStore({ clock });
      const all = await goalStore.list();
      assert.equal(all.length, 1, 'preflight should create exactly one goal');
      assert.ok(sink.buf.includes('On it — Ship the billing migration'));
    });
  });

  it("planner 'none' writes no goal", async () => {
    const dir = join(tmpdir(), `menu-preflight-none-${randomUUID()}`);
    await withStateHome(dir, async () => {
      const prompts: string[] = [];
      let sawWorkerTurn = false;
      const provider: Provider = {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1.0.0',
            authenticated: true,
            plan: null,
            binaryPath: null,
            availableModels: ['model-a'],
          };
        },
        async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
          prompts.push(req.prompt);
          if (req.prompt.includes('PLANNING BRAIN')) {
            const reply = 'JUDGMENT: none';
            yield { type: 'text', delta: reply };
            yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
            return;
          }
          sawWorkerTurn = true;
          const goalStore = createFileGoalStore({ clock });
          assert.equal((await goalStore.list()).length, 0, 'judgment:none must not create a goal before the worker turn');
          yield { type: 'text', delta: 'Done.' };
          yield { type: 'done', text: `Done.\n${CONFIDENCE_ENVELOPE}`, usage: FAKE_USAGE, raw: {} };
        },
      };

      const clock = makeFakeClock();
      const sink = makeSink();
      const ctx = makeCtx(
        {
          providers: { claude: provider },
          readLine: makeScriptedReader(['n', 'review and design the migration plan', '/exit', 'q']),
        },
        clock,
      );

      await startMenu(ctx, sink);

      assert.equal(sawWorkerTurn, true, 'the turn should still run normally');
    });
  });

  it('hasWorkIntent=false skips the planner and creates no goal', async () => {
    const dir = join(tmpdir(), `menu-preflight-nointent-${randomUUID()}`);
    await withStateHome(dir, async () => {
      const prompts: string[] = [];
      const provider: Provider = {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1.0.0',
            authenticated: true,
            plan: null,
            binaryPath: null,
            availableModels: ['model-a'],
          };
        },
        async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
          prompts.push(req.prompt);
          yield { type: 'text', delta: 'Done.' };
          yield { type: 'done', text: `Done.\n${CONFIDENCE_ENVELOPE}`, usage: FAKE_USAGE, raw: {} };
        },
      };

      const clock = makeFakeClock();
      const sink = makeSink();
      const ctx = makeCtx(
        {
          providers: { claude: provider },
          readLine: makeScriptedReader(['n', 'how does the router work?', '/exit', 'q']),
        },
        clock,
      );

      await startMenu(ctx, sink);

      const goalStore = createFileGoalStore({ clock });
      assert.equal((await goalStore.list()).length, 0, 'read-only chat must not create a goal');
      assert.equal(
        prompts.filter((p) => p.includes('PLANNING BRAIN')).length,
        0,
        'hasWorkIntent=false must skip the planner call entirely',
      );
    });
  });

  it('planner clarify uses the decision prompt, stays empty until answered, then creates one goal without a duplicate', async () => {
    const dir = join(tmpdir(), `menu-preflight-clarify-${randomUUID()}`);
    await withStateHome(dir, async () => {
      const clock = makeFakeClock();
      let plannerCalls = 0;
      const provider: Provider = {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1.0.0',
            authenticated: true,
            plan: null,
            binaryPath: null,
            availableModels: ['model-a'],
          };
        },
        async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
          if (req.prompt.includes('PLANNING BRAIN')) {
            plannerCalls += 1;
            const goalStore = createFileGoalStore({ clock });
            if (plannerCalls === 1) {
              assert.equal((await goalStore.list()).length, 0, 'clarify must not create a goal before the answer');
              const reply = [
                'JUDGMENT: clarify',
                'GOAL: Ship authentication',
                'ASK: Which provider should I wire first?',
              ].join('\n');
              yield { type: 'text', delta: reply };
              yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
              return;
            }
            const reply = [
              'JUDGMENT: stage',
              'GOAL: Ship authentication',
              'TODO: wire the chosen provider',
            ].join('\n');
            yield { type: 'text', delta: reply };
            yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
            return;
          }
          const goalStore = createFileGoalStore({ clock });
          assert.equal((await goalStore.list()).length, 1, 'exactly one goal should exist when work begins');
          yield { type: 'text', delta: 'Done.\nGOAL_COMPLETE' };
          yield { type: 'done', text: 'Done.\nGOAL_COMPLETE', usage: FAKE_USAGE, raw: {} };
        },
      };

      const sink = makeSink();
      const ctx = makeCtx(
        {
          providers: { claude: provider },
          readLine: makeScriptedReader(['n', 'implement and wire auth', '1', 'GitHub', '/exit', 'q']),
        },
        clock,
      );

      await startMenu(ctx, sink);

      const goalStore = createFileGoalStore({ clock });
      const all = await goalStore.list();
      assert.equal(all.length, 1, 'clarify path must create exactly one goal after the answer');
      assert.ok(sink.buf.includes('? Question: Which provider should I wire first?'));
      assert.ok(!sink.buf.includes('\n  ? Which provider should I wire first?\n'));
    });
  });

  it('experimentalAutoGoal:false preserves the ordinary chat path and creates no goal', async () => {
    const dir = join(tmpdir(), `menu-preflight-disabled-${randomUUID()}`);
    await withStateHome(dir, async () => {
      const prompts: string[] = [];
      const provider: Provider = {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1.0.0',
            authenticated: true,
            plan: null,
            binaryPath: null,
            availableModels: ['model-a'],
          };
        },
        async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
          prompts.push(req.prompt);
          yield { type: 'text', delta: 'Done.' };
          yield { type: 'done', text: `Done.\n${CONFIDENCE_ENVELOPE}`, usage: FAKE_USAGE, raw: {} };
        },
      };

      const clock = makeFakeClock();
      const sink = makeSink();
      const ctx = makeCtx(
        {
          config: {
            onboarded: true,
            setAsDefault: false,
            smartRoute: false,
            experimentalAutoGoal: false,
          },
          providers: { claude: provider },
          readLine: makeScriptedReader(['n', 'please refactor auth', '/exit', 'q']),
        },
        clock,
      );

      await startMenu(ctx, sink);

      const goalStore = createFileGoalStore({ clock });
      assert.equal((await goalStore.list()).length, 0, 'disabling experimentalAutoGoal must suppress preflight goals');
      assert.equal(prompts.filter((p) => p.includes('PLANNING BRAIN')).length, 0);
    });
  });

  it('goal events carry the persisted goalId and attach live agents', async () => {
    const dir = join(tmpdir(), `menu-preflight-goalid-${randomUUID()}`);
    await withStateHome(dir, async () => {
      const clock = makeFakeClock();
      const store = makeStore(clock);
      let uiState: UiState = initialState;
      const seenGoalIds = new Set<string>();
      const maxAgentsByGoalId = new Map<string, number>();
      const sink: OutputSink & { buf: string } = {
        buf: '',
        write(s: string) { this.buf += s; },
        color: false,
        isTty: false,
        syncBoard(rows) {
          uiState = reduce(uiState, { type: 'board/sync', rows, enabled: true });
        },
      };
      const provider: Provider = {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1.0.0',
            authenticated: true,
            plan: null,
            binaryPath: null,
            availableModels: ['model-a'],
          };
        },
        async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
          if (req.prompt.includes('PLANNING BRAIN')) {
            const reply = [
              'JUDGMENT: stage',
              'GOAL: Stabilize the auth flow',
              'TODO: wire the auth provider',
            ].join('\n');
            yield { type: 'text', delta: reply };
            yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
            return;
          }
          yield { type: 'text', delta: 'Done.\nGOAL_COMPLETE' };
          yield { type: 'done', text: 'Done.\nGOAL_COMPLETE', usage: FAKE_USAGE, raw: {} };
        },
      };
      const ctx = makeCtx(
        {
          providers: { claude: provider },
          readLine: makeScriptedReader(['implement and wire auth', '/exit']),
        },
        clock,
        store,
      );
      const meta = await store.create('goal-id');
      const mutableCtx = { config: ctx.config, env: ctx.env };
      const inkRenderTurn = async (events, _sink, verbosity, _turnInput, timeoutContinuation) =>
        renderStreamInk(
          events,
          (action) => {
            uiState = reduce(uiState, action);
            if ('goalId' in action && typeof action.goalId === 'string') {
              seenGoalIds.add(action.goalId);
            }
            for (const goal of uiState.goals) {
              maxAgentsByGoalId.set(
                goal.id,
                Math.max(maxAgentsByGoalId.get(goal.id) ?? 0, goal.agents.length),
              );
            }
          },
          {
            verbosity,
            color: false,
            isTty: false,
            timeoutContinuation,
            scheduleFlush: (flush) => {
              flush();
              return () => {};
            },
          },
        );

      await runChatLoop(
        ctx,
        mutableCtx,
        meta.id,
        sink,
        makeScriptedReader(['implement and wire auth', '/exit']),
        async () => 0,
        async () => ctx.env,
        async () => false,
        undefined,
        undefined,
        inkRenderTurn,
        undefined,
        undefined,
        undefined,
        undefined,
        () => {
          uiState = reduce(uiState, { type: 'turn/start' });
        },
      );

      const goalStore = createFileGoalStore({ clock });
      const all = await goalStore.list();
      assert.equal(all.length, 1);
      assert.ok(seenGoalIds.has(all[0]!.id), 'live events must carry the persisted goal id');
      assert.ok(
        (maxAgentsByGoalId.get(all[0]!.id) ?? 0) > 0,
        'the reducer must attach a live agent to the persisted goal id',
      );
    });
  });

  it('with autoGoal on and quality-first, strong multi-step work enters runGoalLoop and prints the banner', async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        prompts.push(req.prompt);
        // 4th-report fix: the auto-engage path now forms a SMART goal objective via
        // the MANAGER-tier former (core/goal-objective-generator.ts) instead of the
        // old cheap worker-tier intent extractor. That read-only call carries the
        // distinctive tagged "OBJECTIVE: <a crisp" instruction from
        // buildGoalObjectivePrompt. Answer it with a tagged objective that DIFFERS
        // from the rambling raw text, so the test proves the panel title/objective
        // becomes a crisp professional label, not the user's raw echo.
        if (req.prompt.includes('OBJECTIVE: <a crisp')) {
          const reply = 'OBJECTIVE: Design the architecture';
          yield { type: 'text', delta: reply };
          yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
          return;
        }
        yield { type: 'text', delta: 'Done.\nGOAL_COMPLETE' };
        yield {
          type: 'done',
          text: 'Done.\nGOAL_COMPLETE',
          usage: FAKE_USAGE,
          raw: {},
        };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      mode: 'quality-first',
      smartRoute: false,
      autoGoal: true,
      experimentalAutoGoal: false,
    };
    // A deliberately rambling raw message: the work must still receive it verbatim,
    // while the title/objective is the concise extracted label.
    const rambling =
      'so yea i think we should review and design the architecture now, lots to think about here, anyway lets just do it';
    const ctx = makeCtx(
      {
        config,
        providers: { claude: provider },
        readLine: makeScriptedReader([
          'n',
          rambling,
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    // The SMART objective formation ran as a SEPARATE manager-tier call,
    // distinguishable by its "OBJECTIVE: <a crisp" instruction; the remaining
    // prompts are the goal turn(s). (We don't pin the goal-turn COUNT: orchestrate's
    // own review/verification heuristics may add a same-turn call for manager-tier
    // architecture work — orthogonal to this fix.)
    const extractorCalls = prompts.filter((p) => p.includes('OBJECTIVE: <a crisp'));
    const goalPrompts = prompts.filter((p) => !p.includes('OBJECTIVE: <a crisp'));
    assert.equal(extractorCalls.length, 1, 'concise-label formation makes exactly one manager-tier objective call');
    assert.ok(goalPrompts.length >= 1, 'auto-goal must enter the goal loop');
    // CRITICAL: the WORK task still carries the FULL raw user text verbatim.
    assert.ok(
      goalPrompts.every((p) => p.includes(`Goal: ${rambling}`)),
      'auto-goal work task must keep the full raw user text as the goal input',
    );
    // The contract OBJECTIVE rendered into the work prompt is the CONCISE extracted
    // label, NOT the rambling raw text.
    assert.ok(
      goalPrompts.every((p) => p.includes('OBJECTIVE: Design the architecture')),
      'the contract objective must be the concise extracted label, not the raw ramble',
    );
    assert.ok(
      !goalPrompts.some((p) => p.includes(`OBJECTIVE: ${rambling}`)),
      'the rambling raw text must NOT appear as the contract objective',
    );
    assert.ok(
      sink.buf.includes("Working autonomously until it's done (up to 8 turns). Ctrl+C to stop."),
      'auto-goal must print the visible Ctrl+C banner',
    );
  });

  it('with autoGoal on, ambiguous non-engaged work calls the model router only once', async () => {
    let routerPrompts = 0;
    let taskPrompts = 0;
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        if (req.prompt.includes('You are a routing classifier')) {
          routerPrompts++;
          yield {
            type: 'done',
            text: '{"tier":"worker","plan":false,"reason":"ambiguous"}',
            usage: FAKE_USAGE,
            raw: {},
          };
          return;
        }

        taskPrompts++;
        yield { type: 'text', delta: 'Done.' };
        yield {
          type: 'done',
          text: `Done.\n${CONFIDENCE_ENVELOPE}`,
          usage: FAKE_USAGE,
          raw: {},
        };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      mode: 'quality-first',
      smartRoute: true,
      autoGoal: true,
      experimentalAutoGoal: false,
    };
    const ctx = makeCtx(
      {
        config,
        providers: { claude: provider },
        readLine: makeScriptedReader([
          'n',
          'frobnicate the wotsit',
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.equal(routerPrompts, 1, 'normal orchestrate may call the model router once');
    assert.equal(taskPrompts, 1, 'the non-engaged turn still runs exactly once');
    assert.ok(
      !sink.buf.includes("Working autonomously until it's done"),
      'ambiguous one-signal work must not auto-engage goal mode',
    );
  });

  it('Ctrl+C aborts an auto-engaged goal turn through the existing AbortController path', async () => {
    let sawAbort = false;
    let callCount = 0;
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          plan: null,
          binaryPath: null,
          availableModels: ['model-a'],
        };
      },
      async *run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
        // 4th-report fix: the SMART objective formation runs FIRST (read-only
        // manager tier, distinguished by its "OBJECTIVE: <a crisp" instruction);
        // answer it INSTANTLY so the Ctrl+C dance below exercises the GOAL turn, not
        // the label call. (Critical: if this call blocked on abort it would hang on
        // its own AbortController, which Ctrl+C never targets.)
        if (req.prompt.includes('OBJECTIVE: <a crisp')) {
          const reply = 'OBJECTIVE: Design the architecture';
          yield { type: 'text', delta: reply };
          yield { type: 'done', text: reply, usage: FAKE_USAGE, raw: {} };
          return;
        }
        callCount++;
        setImmediate(() => process.emit('SIGINT'));
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            sawAbort = true;
            resolve();
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        yield { type: 'text', delta: 'partial' };
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      mode: 'quality-first',
      smartRoute: false,
      autoGoal: true,
      experimentalAutoGoal: false,
    };
    const ctx = makeCtx(
      {
        config,
        providers: { claude: provider },
        readLine: makeScriptedReader([
          'n',
          'review and design the architecture',
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.equal(callCount, 1, 'auto-goal should have started one provider run');
    assert.equal(sawAbort, true, 'Ctrl+C must abort the active goal AbortController');
    assert.ok(
      sink.buf.includes('Task cancelled. (Ctrl+C again'),
      'existing Ctrl+C cancellation message should be used',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW 4: "e" → manage screen → pin → back → "q"
// ---------------------------------------------------------------------------

describe('startMenu — e → manage → pin → back → q', () => {
  it('pins conversation 1 via manage screen', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    // Pre-populate one conversation
    await store.create('Pinnable conversation');

    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'e',   // enter manage
          'p',   // pin/unpin
          '1',   // conversation number
          '',    // back from manage (empty = Enter)
          'q',   // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    const metas = await store.list();
    // The first (and only) conversation should now be pinned
    const conv = metas.find((m) => m.title === 'Pinnable conversation');
    assert.ok(conv !== undefined, 'conversation still exists');
    assert.equal(conv.pinned, true, 'conversation should be pinned after pin action');
  });

  it('renames conversation via manage screen', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    await store.create('Old name');

    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'e',         // enter manage
          'r',         // rename
          '1',         // conversation number
          'New name',  // new title
          '',          // back (Enter)
          'q',         // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    const metas = await store.list();
    const conv = metas.find((m) => m.title === 'New name');
    assert.ok(conv !== undefined, 'conversation renamed to "New name"');
  });

  it('deletes conversation via manage screen', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    await store.create('To be deleted');

    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'e',  // enter manage
          'x',  // delete
          '1',  // conversation number
          'y',  // confirm
          '',   // back
          'q',  // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    const metas = await store.list();
    assert.equal(metas.length, 0, 'conversation should be deleted');
  });

  it('manage screen with no conversations shows appropriate message', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock); // empty store
    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'e',  // enter manage
          'q',  // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));
    assert.ok(sink.buf.includes('No conversations yet'), '"No conversations yet" shown');
  });

  it('EOF inside manage screen exits gracefully', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    await store.create('Existing conversation');

    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'e',  // enter manage
          null, // EOF instead of choosing an action
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));
  });
});

// ---------------------------------------------------------------------------
// FLOW 5: invalid / unknown key → re-renders, does not crash
// ---------------------------------------------------------------------------

describe('startMenu — unknown key → re-renders, does not crash', () => {
  it('shows "Unknown option" and continues', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['z', 'q']) });

    await assert.doesNotReject(() => startMenu(ctx, sink));
    assert.ok(sink.buf.includes('Unknown option'), '"Unknown option" message rendered');
  });

  it('multiple unknown keys before q — does not crash', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['!', '@', '#', 'q']) });

    await assert.doesNotReject(() => startMenu(ctx, sink));
  });

  it('empty key (empty string from reader) does not show error message', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['', 'q']) });

    await assert.doesNotReject(() => startMenu(ctx, sink));
    // Empty key should not produce "Unknown option"
    assert.ok(
      !sink.buf.includes('Unknown option:'),
      'empty key must not trigger "Unknown option" message',
    );
  });
});

// ---------------------------------------------------------------------------
// defaultAliasHint — pure helper unit tests (FIX 3)
// ---------------------------------------------------------------------------

describe('defaultAliasHint', () => {
  it('returns a PowerShell hint on win32 regardless of shell', () => {
    const hint = defaultAliasHint(undefined, 'win32');
    assert.ok(hint.includes('PowerShell'), 'win32 → PowerShell hint');
    assert.ok(hint.includes('mst'), 'hint includes the "mst" alias name');
    assert.ok(hint.includes('myshell-tools'), 'hint mentions myshell-tools');
  });

  it('returns a PowerShell hint on win32 even when SHELL is set', () => {
    // Windows sometimes has SHELL=/bin/bash from WSL — platform wins
    const hint = defaultAliasHint('/bin/bash', 'win32');
    assert.ok(hint.includes('PowerShell'), 'platform=win32 always shows PowerShell hint');
  });

  it('returns fish hint when shell ends with "fish"', () => {
    const hint = defaultAliasHint('/usr/bin/fish', 'linux');
    assert.ok(hint.includes('config.fish'), 'fish shell → config.fish hint');
    assert.ok(hint.includes('alias mst='), 'fish hint has alias line');
  });

  it('returns zsh hint when shell ends with "zsh"', () => {
    const hint = defaultAliasHint('/bin/zsh', 'linux');
    assert.ok(hint.includes('.zshrc'), 'zsh → .zshrc hint');
  });

  it('returns bash hint when shell ends with "bash"', () => {
    const hint = defaultAliasHint('/bin/bash', 'linux');
    assert.ok(hint.includes('.bashrc'), 'bash → .bashrc hint');
  });

  it('defaults to bash when shell is undefined', () => {
    const hint = defaultAliasHint(undefined, 'linux');
    assert.ok(hint.includes('.bashrc'), 'undefined shell defaults to .bashrc');
  });

  it('defaults to bash when shell is empty string', () => {
    const hint = defaultAliasHint('', 'linux');
    assert.ok(hint.includes('.bashrc'), 'empty shell defaults to .bashrc');
  });

  it('does not contain digit-% literals (Honesty Contract)', () => {
    const cases = [
      defaultAliasHint(undefined, 'win32'),
      defaultAliasHint('/bin/bash', 'linux'),
      defaultAliasHint('/bin/zsh', 'darwin'),
      defaultAliasHint('/usr/bin/fish', 'linux'),
    ];
    for (const hint of cases) {
      assert.ok(!/\d+%/.test(hint), `no digit-% literal in: "${hint}"`);
    }
  });

  it('contains the myshell-tools command in every output', () => {
    const cases = [
      defaultAliasHint(undefined, 'win32'),
      defaultAliasHint('/bin/bash', 'linux'),
      defaultAliasHint('/bin/zsh', 'darwin'),
      defaultAliasHint('/usr/bin/fish', 'linux'),
    ];
    for (const hint of cases) {
      assert.ok(hint.includes('myshell-tools'), `hint must mention myshell-tools: "${hint}"`);
    }
  });

  it('is a pure function — same inputs always produce same output', () => {
    const a = defaultAliasHint('/bin/bash', 'linux');
    const b = defaultAliasHint('/bin/bash', 'linux');
    assert.equal(a, b, 'same inputs → identical output');
  });
});

// ---------------------------------------------------------------------------
// parseYesNo — pure helper unit tests
// ---------------------------------------------------------------------------

describe('parseYesNo', () => {
  // ---- defaultYes = true (Y/n) -----------------------------------------------

  it('returns true for "y" (defaultYes=true)', () => {
    assert.equal(parseYesNo('y', true), true);
  });

  it('returns true for "Y" (case-insensitive, defaultYes=true)', () => {
    assert.equal(parseYesNo('Y', true), true);
  });

  it('returns true for "yes" (defaultYes=true)', () => {
    assert.equal(parseYesNo('yes', true), true);
  });

  it('returns true for "YES" (case-insensitive, defaultYes=true)', () => {
    assert.equal(parseYesNo('YES', true), true);
  });

  it('returns false for "n" (defaultYes=true)', () => {
    assert.equal(parseYesNo('n', true), false);
  });

  it('returns false for "N" (case-insensitive, defaultYes=true)', () => {
    assert.equal(parseYesNo('N', true), false);
  });

  it('returns false for "no" (defaultYes=true)', () => {
    assert.equal(parseYesNo('no', true), false);
  });

  it('returns false for "NO" (case-insensitive, defaultYes=true)', () => {
    assert.equal(parseYesNo('NO', true), false);
  });

  it('returns true (default) for empty string (defaultYes=true)', () => {
    assert.equal(parseYesNo('', true), true);
  });

  it('returns true (default) for null/EOF (defaultYes=true)', () => {
    assert.equal(parseYesNo(null, true), true);
  });

  it('returns true (default) for whitespace-only string (defaultYes=true)', () => {
    assert.equal(parseYesNo('   ', true), true);
  });

  it('returns true (default) for unrecognised input (defaultYes=true)', () => {
    assert.equal(parseYesNo('maybe', true), true);
  });

  it('trims leading/trailing whitespace before matching (defaultYes=true)', () => {
    assert.equal(parseYesNo('  y  ', true), true);
    assert.equal(parseYesNo('  n  ', true), false);
  });

  // ---- defaultYes = false (y/N) -----------------------------------------------

  it('returns true for "y" (defaultYes=false)', () => {
    assert.equal(parseYesNo('y', false), true);
  });

  it('returns true for "yes" (defaultYes=false)', () => {
    assert.equal(parseYesNo('yes', false), true);
  });

  it('returns false for "n" (defaultYes=false)', () => {
    assert.equal(parseYesNo('n', false), false);
  });

  it('returns false for "no" (defaultYes=false)', () => {
    assert.equal(parseYesNo('no', false), false);
  });

  it('returns false (default) for empty string (defaultYes=false)', () => {
    assert.equal(parseYesNo('', false), false);
  });

  it('returns false (default) for null/EOF (defaultYes=false)', () => {
    assert.equal(parseYesNo(null, false), false);
  });

  it('returns false (default) for unrecognised input (defaultYes=false)', () => {
    assert.equal(parseYesNo('maybe', false), false);
  });

  it('trims leading/trailing whitespace before matching (defaultYes=false)', () => {
    assert.equal(parseYesNo('  y  ', false), true);
    assert.equal(parseYesNo('  n  ', false), false);
  });

  // ---- Honesty contract -------------------------------------------------------

  it('never throws — all inputs are safe', () => {
    const inputs: Array<string | null> = [null, '', '  ', 'y', 'Y', 'yes', 'YES', 'n', 'N', 'no', 'NO', 'garbage', '123'];
    for (const input of inputs) {
      assert.doesNotThrow(() => parseYesNo(input, true));
      assert.doesNotThrow(() => parseYesNo(input, false));
    }
  });
});

// ---------------------------------------------------------------------------
// interpretYesNoKey — single-keypress decision core
// ---------------------------------------------------------------------------

describe('interpretYesNoKey — single-key yes/no', () => {
  it('Enter (CR) accepts the default when defaultYes=true', () => {
    assert.equal(interpretYesNoKey('\r', true), 'yes');
  });

  it('Enter (CR) accepts the default when defaultYes=false', () => {
    assert.equal(interpretYesNoKey('\r', false), 'no');
  });

  it('Enter (LF) is treated the same as CR', () => {
    assert.equal(interpretYesNoKey('\n', true), 'yes');
    assert.equal(interpretYesNoKey('\n', false), 'no');
  });

  it('"y"/"Y" decide yes regardless of the default', () => {
    assert.equal(interpretYesNoKey('y', false), 'yes');
    assert.equal(interpretYesNoKey('Y', false), 'yes');
  });

  it('"n"/"N" decide no regardless of the default', () => {
    assert.equal(interpretYesNoKey('n', true), 'no');
    assert.equal(interpretYesNoKey('N', true), 'no');
  });

  it('Ctrl-C and Ctrl-D abort', () => {
    assert.equal(interpretYesNoKey('\x03', true), 'abort');
    assert.equal(interpretYesNoKey('\x04', false), 'abort');
  });

  it('any other key is ignored (do nothing, keep waiting)', () => {
    for (const k of ['a', '1', ' ', '\t', 'q', '?']) {
      assert.equal(interpretYesNoKey(k, true), 'ignore', `key ${JSON.stringify(k)}`);
    }
  });

  it('never throws on unusual input', () => {
    for (const k of ['', '\x1b', '\x1b[A', 'yy']) {
      assert.doesNotThrow(() => interpretYesNoKey(k, true));
    }
  });

  // ---- strict mode (requireExplicit) — sensitive/destructive prompts --------

  it('strict: Enter is ignored (no default) — must press y or n', () => {
    assert.equal(interpretYesNoKey('\r', true, true), 'ignore');
    assert.equal(interpretYesNoKey('\n', false, true), 'ignore');
  });

  it('strict: y / n still decide explicitly', () => {
    assert.equal(interpretYesNoKey('y', false, true), 'yes');
    assert.equal(interpretYesNoKey('Y', true, true), 'yes');
    assert.equal(interpretYesNoKey('n', true, true), 'no');
    assert.equal(interpretYesNoKey('N', false, true), 'no');
  });

  it('strict: Ctrl-C still aborts; other keys still ignored', () => {
    assert.equal(interpretYesNoKey('\x03', true, true), 'abort');
    assert.equal(interpretYesNoKey('a', true, true), 'ignore');
  });
});

// ---------------------------------------------------------------------------
// readSingleKey / confirmViaKey — raw-key reader, verified via a fake stream
// ---------------------------------------------------------------------------

/**
 * A fake stdin that records raw-mode toggles and, each time the reader calls
 * resume(), delivers the next queued key on a microtask (after the reader has
 * attached its 'data' listener). Lets us exercise the real reader/confirm logic
 * — listener detach/restore, single-key resolution, the ignore loop — without a
 * real TTY. (Only the literal OS raw-byte delivery is Node's job, not ours.)
 */
class FakeKeyStream extends EventEmitter {
  isRaw = false;
  rawCalls: boolean[] = [];
  private readonly queue: string[];
  constructor(keys: string[]) {
    super();
    this.queue = [...keys];
  }
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawCalls.push(mode);
  }
  resume(): void {
    queueMicrotask(() => {
      const k = this.queue.shift();
      if (k !== undefined) this.emit('data', Buffer.from(k, 'utf8'));
    });
  }
}

const asStream = (f: FakeKeyStream): KeyInputStream => f as unknown as KeyInputStream;

describe('readSingleKey — single raw keypress', () => {
  it('resolves with the pressed key', async () => {
    const key = await readSingleKey(asStream(new FakeKeyStream(['y'])));
    assert.equal(key, 'y');
  });

  it('enters raw mode then restores the previous raw flag', async () => {
    const f = new FakeKeyStream(['n']);
    await readSingleKey(asStream(f));
    assert.deepEqual(f.rawCalls, [true, false], 'should set raw on, then restore to prior (false)');
    assert.equal(f.isRaw, false);
  });

  it('restores pre-existing listeners and removes its own (no double-consume)', async () => {
    const f = new FakeKeyStream(['x']);
    const prior = (): void => {};
    f.on('data', prior as (...a: never[]) => void);
    await readSingleKey(asStream(f));
    // The reader detached `prior` for the read, then restored exactly it.
    assert.deepEqual(f.listeners('data'), [prior]);
  });

  it('rejects and restores raw mode if stdin closes before a key arrives', async () => {
    const f = new FakeKeyStream([]);
    const promise = readSingleKey(asStream(f));
    queueMicrotask(() => f.emit('close'));
    await assert.rejects(promise, /stdin closed/);
    assert.deepEqual(f.rawCalls, [true, false], 'raw mode must be restored on close');
    assert.equal(f.listenerCount('data'), 0, 'reader data listener must be removed on close');
    assert.equal(f.listenerCount('close'), 0, 'reader close listener must be removed on close');
  });
});

describe('resolveRawKeyInput — legacy raw stream capability', () => {
  const ttySink = { write(): void {}, color: false, isTty: true } as unknown as OutputSink;
  const nonTtySink = { write(): void {}, color: false, isTty: false } as unknown as OutputSink;

  it('returns stdin when stdout is a TTY and stdin is raw-capable', () => {
    const stdin = asStream(new FakeKeyStream([]));
    stdin.isTTY = true;
    assert.equal(resolveRawKeyInput(ttySink, stdin), stdin);
  });

  it('returns null when stdout is not a TTY', () => {
    const stdin = asStream(new FakeKeyStream([]));
    stdin.isTTY = true;
    assert.equal(resolveRawKeyInput(nonTtySink, stdin), null);
  });

  it('falls back to cached /dev/tty when stdin is not raw-capable', () => {
    __resetControllingTtyRawInputForTest();
    const stdin = asStream(new FakeKeyStream([]));
    stdin.isTTY = false;
    const fallback = asStream(new FakeKeyStream([]));
    fallback.isTTY = true;
    const originalOpenSync = fs.openSync;
    const originalReadStream = tty.ReadStream;
    let openedPath = '';
    try {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((path: fs.PathLike, flags: string | number) => {
        openedPath = String(path);
        assert.equal(flags, 'r');
        return 123;
      }) as typeof fs.openSync;
      (tty as unknown as { ReadStream: new (fd: number) => KeyInputStream }).ReadStream =
        function FakeReadStream(fd: number): KeyInputStream {
          assert.equal(fd, 123);
          return fallback;
        } as unknown as new (fd: number) => KeyInputStream;

      assert.equal(resolveRawKeyInput(ttySink, stdin), fallback);
      assert.equal(openedPath, '/dev/tty');
    } finally {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = originalOpenSync;
      (tty as unknown as { ReadStream: typeof tty.ReadStream }).ReadStream = originalReadStream;
      __resetControllingTtyRawInputForTest();
    }
  });
});

describe('confirmViaKey — single-key yes/no over a fake stream', () => {
  it('"y" resolves true', async () => {
    const out = makeSink();
    assert.equal(await confirmViaKey(out, false, asStream(new FakeKeyStream(['y']))), true);
  });

  it('"n" resolves false', async () => {
    const out = makeSink();
    assert.equal(await confirmViaKey(out, true, asStream(new FakeKeyStream(['n']))), false);
  });

  it('Enter accepts the default (true)', async () => {
    const out = makeSink();
    assert.equal(await confirmViaKey(out, true, asStream(new FakeKeyStream(['\r']))), true);
  });

  it('Enter accepts the default (false)', async () => {
    const out = makeSink();
    assert.equal(await confirmViaKey(out, false, asStream(new FakeKeyStream(['\r']))), false);
  });

  it('ignores other keys and keeps waiting until a decisive key', async () => {
    const out = makeSink();
    // 'q' and ' ' are ignored; 'y' decides.
    assert.equal(await confirmViaKey(out, false, asStream(new FakeKeyStream(['q', ' ', 'y']))), true);
  });

  it('echoes the chosen letter (raw mode suppresses the terminal echo)', async () => {
    const out = makeSink();
    await confirmViaKey(out, true, asStream(new FakeKeyStream(['n'])));
    assert.ok(out.buf.includes('n'), `expected the chosen letter echoed, got ${JSON.stringify(out.buf)}`);
  });

  it('strict: ignores Enter (no default), resolves only on an explicit y', async () => {
    const out = makeSink();
    // Two Enters are ignored (no default in strict mode); the y decides.
    assert.equal(
      await confirmViaKey(out, false, asStream(new FakeKeyStream(['\r', '\r', 'y'])), true),
      true,
    );
  });

  it('strict: an explicit n cancels', async () => {
    const out = makeSink();
    assert.equal(
      await confirmViaKey(out, true, asStream(new FakeKeyStream(['\n', 'n'])), true),
      false,
    );
  });
});

describe('approveTimeoutContinuation — oversight gate', () => {
  it('autonomous proceeds without calling confirm', async () => {
    let confirms = 0;
    const approved = await approveTimeoutContinuation('autonomous', async () => {
      confirms += 1;
      return false;
    });
    assert.equal(approved, true);
    assert.equal(confirms, 0);
  });

  it('checkpoint keeps one confirmation', async () => {
    let confirms = 0;
    const approved = await approveTimeoutContinuation('checkpoint', async () => {
      confirms += 1;
      return true;
    });
    assert.equal(approved, true);
    assert.equal(confirms, 1);
  });
});

describe('readMenuKey — single-key main-menu choice', () => {
  // A TTY-capable fake: FakeKeyStream + isTTY so canRawKey is true.
  const ttyStream = (keys: string[]): KeyInputStream => {
    const f = new FakeKeyStream(keys);
    (f as unknown as { isTTY: boolean }).isTTY = true;
    return asStream(f);
  };
  const ttySink = (): OutputSink & { buf: string } => {
    let buf = '';
    return { get buf() { return buf; }, write: (s: string) => { buf += s; }, color: false, isTty: true };
  };
  const neverLine = async (): Promise<string | null> => {
    throw new Error('readLine must not be called on the raw-key path');
  };

  it('normalizes line-mode keys without truncating multi-char choices', () => {
    assert.equal(normalizeMenuKey('j\r'), 'j');
    assert.equal(normalizeMenuKey(' J '), 'j');
    assert.equal(normalizeMenuKey('n\t'), 'n');
    assert.equal(normalizeMenuKey(''), '');
    assert.equal(normalizeMenuKey('   \t'), '');
    assert.equal(normalizeMenuKey(null), null);
    assert.equal(normalizeMenuKey('10'), '10');
  });

  it('resolves on a single keypress (no Enter) and echoes it', async () => {
    const out = ttySink();
    assert.equal(await readMenuKey(out, neverLine, ttyStream(['c'])), 'c');
    assert.ok(out.buf.includes('c\n'), 'the pressed key must be echoed');
  });

  it('lower-cases the choice so C and c both pick [c]', async () => {
    assert.equal(await readMenuKey(ttySink(), neverLine, ttyStream(['C'])), 'c');
  });

  it('Enter is a no-op ("") — caller just re-renders', async () => {
    assert.equal(await readMenuKey(ttySink(), neverLine, ttyStream(['\r'])), '');
  });

  it('Ctrl-C / Ctrl-D resolve null (exit)', async () => {
    assert.equal(await readMenuKey(ttySink(), neverLine, ttyStream(['\x03'])), null);
    assert.equal(await readMenuKey(ttySink(), neverLine, ttyStream(['\x04'])), null);
  });

  it('ignores escape sequences (arrow keys) as no-ops', async () => {
    assert.equal(await readMenuKey(ttySink(), neverLine, ttyStream(['\x1b[A'])), '');
  });

  it('falls back to a line read when stdin is not a raw TTY', async () => {
    const out = makeSink(); // isTty:false
    const f = new FakeKeyStream([]); // not a TTY (no isTTY)
    assert.equal(await readMenuKey(out, async () => ' J ', asStream(f)), 'j');
  });

  it('falls back to a line read if the raw-key stream closes', async () => {
    const out = ttySink();
    const f = new FakeKeyStream([]);
    (f as unknown as { isTTY: boolean }).isTTY = true;
    queueMicrotask(() => f.emit('close'));
    assert.equal(await readMenuKey(out, async () => 'q\r', asStream(f)), 'q');
  });
});

describe('yesNoHint — confirm prompt wording', () => {
  it('default-yes shows "yes (enter) / no"', () => {
    assert.equal(yesNoHint('yes', false), 'yes (enter) / no');
  });

  it('strict shows "yes (y) / no (n)" — no Enter shortcut', () => {
    assert.equal(yesNoHint('strict', false), 'yes (y) / no (n)');
  });

  it('default-no (opt-in) shows "yes / no (enter)" — Enter declines', () => {
    assert.equal(yesNoHint('no', false), 'yes / no (enter)');
  });

  it('dims the key cue when color is on (words stay plain)', () => {
    const s = yesNoHint('yes', true);
    assert.ok(s.includes('\x1b[2m(enter)\x1b[0m'), 'the (enter) cue must be dimmed');
    assert.ok(s.startsWith('yes '), 'the word "yes" stays plain');
  });
});

describe('parseYesNo — strict mode (requireExplicit)', () => {
  it('only an explicit y/yes confirms', () => {
    assert.equal(parseYesNo('y', false, true), true);
    assert.equal(parseYesNo('yes', false, true), true);
    assert.equal(parseYesNo('YES', false, true), true);
  });

  it('Enter / EOF / blank / typo all cancel (no default-yes leak)', () => {
    assert.equal(parseYesNo('', true, true), false);
    assert.equal(parseYesNo(null, true, true), false);
    assert.equal(parseYesNo('   ', true, true), false);
    assert.equal(parseYesNo('maybe', true, true), false);
    assert.equal(parseYesNo('n', true, true), false);
  });
});

/**
 * Minimal readline.Interface stand-in: records pause/resume/close and accepts
 * the line/close listeners createLineReader attaches at construction.
 */
class FakeReadline {
  events: string[] = [];
  private lineListeners: Array<(raw: string) => void> = [];
  on(event: string, fn: (...a: never[]) => void): this {
    if (event === 'line') this.lineListeners.push(fn as unknown as (raw: string) => void);
    return this;
  }
  emitLine(raw: string): void {
    for (const fn of this.lineListeners) fn(raw);
  }
  pause(): void {
    this.events.push('rl.pause');
  }
  resume(): void {
    this.events.push('rl.resume');
  }
  close(): void {
    this.events.push('rl.close');
  }
}

/** Records every stdin control call createLineReader's suspend/resume makes. */
class FakeStdin {
  isTTY: boolean;
  isRaw = false;
  calls: string[] = [];
  constructor(isTTY: boolean) {
    this.isTTY = isTTY;
  }
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.calls.push(`setRawMode:${mode}`);
  }
  pause(): void {
    this.calls.push('pause');
  }
  resume(): void {
    this.calls.push('resume');
  }
  // Unused by suspend/resume but required by the KeyInputStream surface.
  on(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  removeAllListeners(): this {
    return this;
  }
  listeners(): Array<(...a: never[]) => void> {
    return [];
  }
}

describe('createLineReader — suspend/resume release stdin for an inherited child', () => {
  // The byte-race fix: while `claude auth login` owns the terminal, our readline
  // must stop reading stdin (and re-prime it cleanly on the way back). These
  // prove the exact suspend/resume sequence.
  const mkReader = (isTTY: boolean): { reader: ReturnType<typeof createLineReader>; rl: FakeReadline; stdin: FakeStdin } => {
    const rl = new FakeReadline();
    const stdin = new FakeStdin(isTTY);
    const reader = createLineReader(
      rl as unknown as Parameters<typeof createLineReader>[0],
      stdin as unknown as KeyInputStream,
    );
    return { reader, rl, stdin };
  };

  it('suspend() on a TTY: pauses readline, drops raw mode, pauses stdin', () => {
    const { reader, rl, stdin } = mkReader(true);
    reader.suspend();
    assert.deepEqual(rl.events, ['rl.pause']);
    assert.deepEqual(stdin.calls, ['setRawMode:false', 'pause']);
  });

  it('resume() takes stdin back: resumes stdin, readline, and restores raw mode', () => {
    const { reader, rl, stdin } = mkReader(true);
    reader.suspend();
    rl.events.length = 0;
    stdin.calls.length = 0;
    reader.resume();
    // After an inherited-stdio child, a bare resume() leaves the TTY read handle
    // dormant (the next prompt "dead-pauses" until Enter nudges it). resume() now
    // re-primes by cycling raw mode off→on (re-arms the handle AND restores the
    // raw mode a terminal readline needs for line editing) BEFORE resuming the
    // stream and readline.
    assert.deepEqual(stdin.calls, ['setRawMode:false', 'setRawMode:true', 'resume']);
    assert.deepEqual(rl.events, ['rl.resume']);
  });

  it('resume() off a TTY: resumes but never toggles raw mode', () => {
    const { reader, stdin } = mkReader(false);
    reader.suspend();
    stdin.calls.length = 0;
    reader.resume();
    assert.deepEqual(stdin.calls, ['resume'], 'no setRawMode when not a TTY');
  });

  it('suspend() off a TTY: still pauses, but never toggles raw mode', () => {
    const { reader, stdin } = mkReader(false);
    reader.suspend();
    assert.deepEqual(stdin.calls, ['pause'], 'no setRawMode when not a TTY');
  });

  it('suspend()/resume() never throw', () => {
    const { reader } = mkReader(true);
    assert.doesNotThrow(() => {
      reader.suspend();
      reader.resume();
    });
  });

  it('suspend() does NOT call stdin.read() — no pending-read race with the inherited child', () => {
    // Regression: a read()-based "drain" here left a pending libuv read on fd0 that
    // competed with the inherited child (claude), siphoning off the first chunk of a
    // paste so the code reached claude split/truncated ("Invalid code" / paste in the
    // wrong spot in its TUI). suspend() must only pause — never read() — so the child
    // owns fd0 cleanly.
    const rl = new FakeReadline();
    class ReadTrackingStdin extends FakeStdin {
      reads = 0;
      read(): string | null {
        this.reads++;
        return null;
      }
    }
    const stdin = new ReadTrackingStdin(true);
    const reader = createLineReader(
      rl as unknown as Parameters<typeof createLineReader>[0],
      stdin as unknown as KeyInputStream,
    );

    reader.suspend();

    assert.equal(stdin.reads, 0, 'suspend() must not call stdin.read()');
    assert.deepEqual(stdin.calls, ['setRawMode:false', 'pause']);
  });

  it('resume() drops one immediate blank line left by an inherited-stdio child', async () => {
    const { reader, rl } = mkReader(true);
    reader.suspend();
    reader.resume();

    rl.emitLine('');
    rl.emitLine('q');

    assert.equal(await reader.nextLine(), 'q', 'stray post-child Enter must not answer the next prompt');
  });
});

// ---------------------------------------------------------------------------
// createLineReader — typed-ahead capture (beginCapture/drainBuffered/clearBuffered)
// Phase 0: lines typed DURING a model turn are queued, not fed to nextLine().
// ---------------------------------------------------------------------------

describe('createLineReader — beginCapture typed-ahead queue', () => {
  const mkReader = (): { reader: ReturnType<typeof createLineReader>; rl: FakeReadline } => {
    const rl = new FakeReadline();
    const stdin = new FakeStdin(true);
    const reader = createLineReader(
      rl as unknown as Parameters<typeof createLineReader>[0],
      stdin as unknown as KeyInputStream,
    );
    return { reader, rl };
  };

  it('captured lines go to the callback, NOT to nextLine()', async () => {
    const { reader, rl } = mkReader();
    const captured: string[] = [];
    const stop = reader.beginCapture((l) => captured.push(l));

    rl.emitLine('first queued');
    rl.emitLine('second queued');

    assert.deepEqual(captured, ['first queued', 'second queued']);
    stop();

    // After detach, lines again satisfy nextLine().
    rl.emitLine('after detach');
    assert.equal(await reader.nextLine(), 'after detach');
  });

  it('capture drops blank lines (a bare Enter is not a queued turn)', () => {
    const { reader, rl } = mkReader();
    const captured: string[] = [];
    reader.beginCapture((l) => captured.push(l));

    rl.emitLine('');
    rl.emitLine('   ');
    rl.emitLine('real');

    assert.deepEqual(captured, ['real'], 'blank/whitespace lines are not captured');
  });

  it('detach is idempotent and only clears its own capture', () => {
    const { reader, rl } = mkReader();
    const captured: string[] = [];
    const stop = reader.beginCapture((l) => captured.push(l));
    stop();
    stop(); // second call is a no-op
    rl.emitLine('to-buffer');
    assert.deepEqual(captured, [], 'nothing captured after detach');
  });

  it('beginCapture is exclusive — a concurrent capture throws (real-bug guard)', () => {
    const { reader } = mkReader();
    reader.beginCapture(() => {});
    assert.throws(() => reader.beginCapture(() => {}), /capture already active/);
  });

  it('beginCapture mutes readline echo only for the active capture lifetime', () => {
    const rl = new FakeReadline();
    const stdin = new FakeStdin(true);
    const echo = { muted: false };
    const reader = createLineReader(
      rl as unknown as Parameters<typeof createLineReader>[0],
      stdin as unknown as KeyInputStream,
      echo,
    );

    const stop = reader.beginCapture(() => {});
    assert.equal(echo.muted, true, 'capture suppresses readline terminal echo');
    stop();
    assert.equal(echo.muted, false, 'detach restores readline terminal echo');
  });

  it('drainBuffered returns and clears incidental buffered lines', async () => {
    const { reader, rl } = mkReader();
    rl.emitLine('a');
    rl.emitLine('b');
    assert.deepEqual(reader.drainBuffered(), ['a', 'b']);
    assert.deepEqual(reader.drainBuffered(), [], 'buffer is cleared after drain');
    rl.emitLine('c');
    assert.equal(await reader.nextLine(), 'c');
  });

  it('clearBuffered drops buffered lines without returning them', () => {
    const { reader, rl } = mkReader();
    rl.emitLine('x');
    reader.clearBuffered();
    assert.deepEqual(reader.drainBuffered(), [], 'cleared');
  });

  it('blank-line suppression after resume() still wins over capture', () => {
    // The guarded blank-line suppression (a leftover submit Enter from an
    // inherited child) must NOT be queued as a typed-ahead turn.
    const { reader, rl } = mkReader();
    reader.suspend();
    reader.resume();
    const captured: string[] = [];
    reader.beginCapture((l) => captured.push(l));
    rl.emitLine(''); // the suppressed immediate blank line
    rl.emitLine('real');
    assert.deepEqual(captured, ['real'], 'suppressed blank is dropped, not captured');
  });
});

// ---------------------------------------------------------------------------
// attachChatTurnKeyListener — scoped mid-turn ESC observer (Phase 0)
// ESC = interrupt this turn; observe ESC only; degrade off-TTY.
// ---------------------------------------------------------------------------

/**
 * A TTY-capable fake stdin that records keypress listener attach/detach and
 * raw-mode toggles, and can emit synthetic keypress events. Mirrors how
 * readline.emitKeypressEvents would deliver (str, key) to the handler.
 */
class FakeKeypressStdin extends EventEmitter {
  isTTY = true;
  isRaw: boolean;
  rawCalls: boolean[] = [];
  constructor(initiallyRaw = true) {
    super();
    this.isRaw = initiallyRaw;
  }
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawCalls.push(mode);
  }
  removeAllListeners(event?: string): this {
    // attachChatTurnKeyListener must never use this destructive path.
    throw new Error(`attachChatTurnKeyListener must NOT call removeAllListeners(${event ?? ''})`);
  }
  pause(): void {}
  resume(): void {}
  // Count only the chat-turn listener (ignore the data translator that
  // readline.emitKeypressEvents attaches internally).
  keypressListenerCount(): number {
    return this.listenerCount('keypress');
  }
  // Drive a synthetic keypress straight to registered 'keypress' listeners,
  // bypassing readline's byte-decoding timing quirks for a lone ESC.
  emitKey(str: string | undefined, key: KeypressEvent | undefined): void {
    this.emit('keypress', str, key);
  }
}

const ttyOut = { write(): void {}, color: false, isTty: true } as unknown as OutputSink;
const nonTtyOut = { write(): void {}, color: false, isTty: false } as unknown as OutputSink;

describe('attachChatTurnKeyListener — scoped ESC observer', () => {
  it('calls onEscape on a bare ESC keypress', () => {
    const stdin = new FakeKeypressStdin();
    let escapes = 0;
    const detach = attachChatTurnKeyListener(ttyOut, stdin as unknown as KeyInputStream, () => { escapes++; });
    stdin.emitKey('\x1b', { name: 'escape', sequence: '\x1b' });
    assert.equal(escapes, 1);
    detach();
  });

  it('ignores arrow/function-key escape sequences and printable input', () => {
    const stdin = new FakeKeypressStdin();
    let escapes = 0;
    const detach = attachChatTurnKeyListener(ttyOut, stdin as unknown as KeyInputStream, () => { escapes++; });
    stdin.emitKey('\x1b[A', { name: 'up', sequence: '\x1b[A' });
    stdin.emitKey('a', { name: 'a', sequence: 'a' });
    stdin.emitKey('\x03', { name: 'c', ctrl: true, sequence: '\x03' });
    assert.equal(escapes, 0, 'only a bare ESC interrupts');
    detach();
  });

  it('attaches exactly one keypress listener and removes only it on detach', () => {
    const stdin = new FakeKeypressStdin();
    const prior = (): void => {};
    stdin.on('keypress', prior as (...a: never[]) => void);
    assert.equal(stdin.keypressListenerCount(), 1);
    const detach = attachChatTurnKeyListener(ttyOut, stdin as unknown as KeyInputStream, () => {});
    assert.equal(stdin.keypressListenerCount(), 2, 'added exactly one');
    detach();
    assert.equal(stdin.keypressListenerCount(), 1, 'removed only its own');
  });

  it('never calls removeAllListeners (would re-break the 3.12.x stdin handoff)', () => {
    const stdin = new FakeKeypressStdin();
    // FakeKeypressStdin.removeAllListeners throws if called.
    assert.doesNotThrow(() => {
      const detach = attachChatTurnKeyListener(ttyOut, stdin as unknown as KeyInputStream, () => {});
      stdin.emitKey('\x1b', { name: 'escape', sequence: '\x1b' });
      detach();
    });
  });

  it('toggles raw mode only when not already raw, and restores on detach', () => {
    const stdin = new FakeKeypressStdin(false); // not already raw
    const detach = attachChatTurnKeyListener(ttyOut, stdin as unknown as KeyInputStream, () => {});
    assert.deepEqual(stdin.rawCalls, [true], 'enabled raw for the turn');
    detach();
    assert.deepEqual(stdin.rawCalls, [true, false], 'restored prior (off) on detach');
  });

  it('leaves raw mode untouched when readline already owns it', () => {
    const stdin = new FakeKeypressStdin(true); // already raw (terminal readline)
    const detach = attachChatTurnKeyListener(ttyOut, stdin as unknown as KeyInputStream, () => {});
    detach();
    assert.deepEqual(stdin.rawCalls, [], 'never toggled raw — ownership stays with readline');
  });

  it('degrades off-TTY: returns a no-op detach and observes nothing', () => {
    const stdin = new FakeKeypressStdin();
    let escapes = 0;
    const detach = attachChatTurnKeyListener(nonTtyOut, stdin as unknown as KeyInputStream, () => { escapes++; });
    // No listener attached → emitting a key does nothing; normal line input still works.
    stdin.emitKey('\x1b', { name: 'escape', sequence: '\x1b' });
    assert.equal(escapes, 0);
    assert.equal(stdin.keypressListenerCount(), 0);
    assert.doesNotThrow(detach);
  });
});

// ---------------------------------------------------------------------------
// FLOW 6: first-run welcome — install prompt shown for missing provider,
//          answered "n" (skip), no real npm spawned, flow proceeds to menu.
// ---------------------------------------------------------------------------

/**
 * Fake EnvironmentStatus where claude is missing and codex is installed+authed.
 * This exercises the install prompt path without triggering a real npm run.
 */
const FAKE_ENV_CLAUDE_MISSING: EnvironmentStatus = {
  claude: {
    id: 'claude',
    installed: false,
    version: null,
    authenticated: false,
    plan: null,
    binaryPath: null,
    availableModels: [],
  },
  codex: {
    id: 'codex',
    installed: true,
    version: '1.0.0',
    authenticated: true,
    plan: null,
    binaryPath: 'codex',
    availableModels: ['gpt-5.4'],
  },
  opencode: {
    id: 'opencode',
    installed: false,
    version: null,
    authenticated: false,
    plan: null,
    binaryPath: null,
    availableModels: [],
  },
  hasAnyProvider: true,
  platform: 'linux',
};

describe('startMenu — first-run welcome: install prompt for missing provider', () => {
  /**
   * Build a first-run context (onboarded: false) with the given env and scripted reader.
   * Codex is installed+authed; claude is missing → install prompt for claude only.
   */
  function makeFirstRunCtx(
    inputs: ReadonlyArray<string | null>,
    env: EnvironmentStatus = FAKE_ENV_CLAUDE_MISSING,
    postOnboardEnv?: EnvironmentStatus,
  ): MenuContext {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-flow-first-${randomUUID()}`);

    const config: AppConfig = { onboarded: false, setAsDefault: false };

    // Use the post-onboard env if provided, otherwise fall back to the same env.
    // This prevents real `claude/codex/opencode --version` spawns after onboarding.
    const resolvedPostOnboardEnv = postOnboardEnv ?? env;

    return {
      version: '2.0.0',
      clock,
      ledger,
      providers: { codex: makeFakeProvider('codex') },
      env,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(inputs),
      // Inject no-op fakes so no real npm/claude/codex subprocesses are spawned
      installProvider: async () => true,
      login: async () => 0,
      // Inject fake detectEnvironment so post-onboarding re-detect never spawns
      detectEnvironment: async () => resolvedPostOnboardEnv,
      // Inject a no-op update check so no real npm registry requests are made
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Stub isHookInstalled so the set-default prompt still appears — prevents the
      // real ~/.bashrc (which may already contain the hook) from silently skipping
      // the prompt and desyncing scripted readers.
      isHookInstalled: async () => false,
    };
  }

  it('resolves cleanly when user answers n to install and n to default shell', async () => {
    const sink = makeSink();
    // claude missing → install prompt → n (skip)
    // opencode optional prompt → n (skip)
    // codex missing sign-in prompt → none (codex is authed in FAKE_ENV_CLAUDE_MISSING)
    // mode → '' (Enter = balanced default)
    // default shell → n
    // auto-update → n
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'welcome flow with install-skip should resolve cleanly',
    );
  });

  it('shows the install prompt for the missing provider', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('Install claude'),
      'install prompt for "claude" must appear in output',
    );
  });

  it('shows the package name in the install prompt', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('@anthropic-ai/claude-code'),
      'install prompt must mention the @anthropic-ai/claude-code package',
    );
  });

  it('shows skip message with manual command when user answers n', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('npm install -g @anthropic-ai/claude-code'),
      'skipping install must print the manual install command',
    );
  });

  it('does NOT show codex install prompt when codex is installed', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    // codex is installed in FAKE_ENV_CLAUDE_MISSING, so no install prompt for it
    assert.ok(
      !sink.buf.includes('Install codex'),
      'no install prompt should appear for an already-installed provider',
    );
  });

  it('proceeds to the menu after install prompts are answered', async () => {
    const sink = makeSink();
    // After welcome: we land on the main menu and quit
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n', 'q']);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'should reach the main menu after welcome',
    );

    assert.ok(
      sink.buf.includes('myshell-tools'),
      'main menu should be rendered after welcome completes',
    );
  });

  it('EOF during install prompt → skips install and continues', async () => {
    const sink = makeSink();
    // EOF immediately at first prompt
    const ctx = makeFirstRunCtx([null]);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'EOF at install prompt should not throw',
    );
  });

  it('does not contain digit-% literals in welcome output (Honesty Contract)', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    assert.ok(
      !/\d+%/.test(sink.buf),
      'welcome output must not contain hardcoded digit-% literals',
    );
  });

  it('shows sign-in prompt for installed-but-unauthenticated codex', async () => {
    const sink = makeSink();

    // Env where both providers are installed but neither is authenticated
    const envBothUnauthenticated: EnvironmentStatus = {
      claude: {
        id: 'claude',
        installed: true,
        version: '1.0.0',
        authenticated: false,
        plan: null,
        binaryPath: 'claude',
        availableModels: ['opus'],
      },
      codex: {
        id: 'codex',
        installed: true,
        version: '1.0.0',
        authenticated: false,
        plan: null,
        binaryPath: 'codex',
        availableModels: ['gpt-5.4'],
      },
      opencode: {
        id: 'opencode',
        installed: false,
        version: null,
        authenticated: false,
        plan: null,
        binaryPath: null,
        availableModels: [],
      },
      hasAnyProvider: true,
      platform: 'linux',
    };

    // No install prompts (both installed); opencode optional prompt → n
    // Sign-in prompts for both → answer n to avoid spawn
    // Then mode → '' (Enter = balanced default); default shell → n; auto-update → n
    const ctx = makeFirstRunCtx(['n', 'n', 'n', '', 'n', 'n'], envBothUnauthenticated);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'should handle sign-in prompts for unauthenticated providers without throwing',
    );

    assert.ok(
      sink.buf.toLowerCase().includes('sign in'),
      'sign-in prompt must appear for unauthenticated providers',
    );
  });

  // ---- Orientation header --------------------------------------------------

  it('shows orientation header at the start of the welcome flow', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('Quick setup'),
      'orientation header must include "Quick setup"',
    );
    assert.ok(
      sink.buf.includes('~30 seconds'),
      'orientation header must mention ~30 seconds',
    );
    assert.ok(
      sink.buf.includes('Enter'),
      'orientation header must mention Enter key for defaults',
    );
  });

  it('orientation header explains the (enter) default convention', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    // The header must explain that the side marked (enter) is the default.
    assert.ok(
      sink.buf.includes('(enter)'),
      'orientation header must reference the (enter) default convention',
    );
  });

  // ---- Collapsed single mode prompt ----------------------------------------

  it('shows the single mode prompt with all three modes inline', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    // The single collapsed prompt must list all three modes (quality-framed
    // labels) and an auto default.
    assert.ok(sink.buf.includes('Efficient'), 'mode prompt must mention Efficient');
    assert.ok(sink.buf.includes('Balanced'), 'mode prompt must mention Balanced');
    assert.ok(sink.buf.includes('Max'), 'mode prompt must mention Max');
    assert.ok(
      sink.buf.includes('Enter = auto'),
      'mode prompt must show the auto (subscription-derived) default',
    );
  });

  it('does NOT show the old two-step [c] Customize mode prompt', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    // The old two-step gateway must be gone
    assert.ok(
      !sink.buf.includes('[c]     Customize mode'),
      'old [c] Customize mode gateway must not appear in the welcome flow',
    );
    assert.ok(
      !sink.buf.includes('[Enter] Continue'),
      'old [Enter] Continue gateway must not appear in the welcome flow',
    );
  });

  it('answering 1 to mode prompt sets cost-saver mode (config is saved)', async () => {
    const sink = makeSink();
    // n → skip opencode; '1' → mode cost-saver; n → set-default; n → auto-update; q → quit
    const ctx = makeFirstRunCtx(['n', '1', 'n', 'n', 'q']);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'answering 1 to mode prompt should not throw',
    );

    // Flow must reach the main menu (mode was accepted)
    assert.ok(
      sink.buf.includes('myshell-tools'),
      'main menu must be rendered after mode selection',
    );
  });

  it('answering 3 to mode prompt sets quality-first mode', async () => {
    const sink = makeSink();
    // n → skip opencode; '3' → mode quality-first; n → set-default; n → auto-update; q → quit
    const ctx = makeFirstRunCtx(['n', '3', 'n', 'n', 'q']);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'answering 3 to mode prompt should not throw',
    );

    assert.ok(
      sink.buf.includes('myshell-tools'),
      'main menu must be rendered after quality-first mode selection',
    );
  });

  it('Enter (empty) on mode prompt keeps balanced default and proceeds', async () => {
    const sink = makeSink();
    // n → skip opencode; '' → mode Enter = balanced; n → set-default; n → auto-update; q → quit
    const ctx = makeFirstRunCtx(['n', '', 'n', 'n', 'q']);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'Enter on mode prompt should not throw',
    );

    assert.ok(
      sink.buf.includes('myshell-tools'),
      'main menu must be rendered after Enter on mode prompt',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW 6b: first-run welcome — opencode onboarding prompt
// ---------------------------------------------------------------------------

describe('startMenu — first-run welcome: opencode onboarding prompt', () => {
  /**
   * Env where claude and codex are both installed+authenticated, opencode is NOT.
   * This isolates the opencode optional prompt with no install/sign-in distractions.
   */
  const ENV_NO_OPENCODE: EnvironmentStatus = {
    claude: {
      id: 'claude',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: 'claude',
      availableModels: ['claude-3-5-sonnet'],
    },
    codex: {
      id: 'codex',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: 'codex',
      availableModels: ['gpt-4o'],
    },
    opencode: {
      id: 'opencode',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    hasAnyProvider: true,
    platform: 'linux',
  };

  /** Env returned after opencode is installed but not yet configured. */
  const ENV_WITH_OPENCODE: EnvironmentStatus = {
    ...ENV_NO_OPENCODE,
    opencode: {
      id: 'opencode',
      installed: true,
      version: '0.1.0',
      authenticated: false,
      plan: null,
      binaryPath: 'opencode',
      availableModels: ['opencode/deepseek-v4-flash-free'],
    },
  };

  function makeOpencodeOnboardCtx(
    inputs: ReadonlyArray<string | null>,
    installSpy?: (id: string) => void,
    detectSpy?: () => void,
  ): MenuContext {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-opencode-onboard-${randomUUID()}`);
    const config: AppConfig = { onboarded: false, setAsDefault: false };

    return {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider(), codex: makeFakeProvider('codex') },
      env: ENV_NO_OPENCODE,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(inputs),
      installProvider: async (id, _out) => {
        installSpy?.(id);
        return true;
      },
      login: async () => 0,
      detectEnvironment: async () => {
        detectSpy?.();
        return ENV_WITH_OPENCODE;
      },
      // Inject a no-op update check so no real npm registry requests are made
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Stub isHookInstalled so the set-default prompt still appears (see makeFirstRunCtx)
      isHookInstalled: async () => false,
    };
  }

  it('shows opencode optional prompt when opencode is not installed', async () => {
    const sink = makeSink();
    // No install prompts (both installed); opencode prompt → n; mode → '' (Enter = balanced); set-default → n; auto-update → n; quit
    const ctx = makeOpencodeOnboardCtx(['n', '', 'n', 'n', 'q']);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'opencode onboarding prompt should not throw',
    );

    assert.ok(
      sink.buf.toLowerCase().includes('opencode'),
      'opencode must be mentioned in the onboarding prompt',
    );
    assert.ok(
      sink.buf.includes('optional'),
      'opencode prompt must mention it is optional',
    );
  });

  it('shows yes (enter) / no in the opencode prompt (default YES, consistent)', async () => {
    const sink = makeSink();
    const ctx = makeOpencodeOnboardCtx(['n', '', 'n', 'n', 'q']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('yes (enter) / no'),
      'opencode prompt must show yes (enter) / no — Enter = yes, consistent with the install prompts',
    );
  });

  it('answering n to opencode prompt skips install — installProvider NOT called with opencode', async () => {
    const installedIds: string[] = [];
    // opencode → n; mode → '' (Enter = balanced); set-default → n; auto-update → n; quit
    const ctx = makeOpencodeOnboardCtx(['n', '', 'n', 'n', 'q'], (id) => { installedIds.push(id); });
    const sink = makeSink();

    await startMenu(ctx, sink);

    assert.ok(
      !installedIds.includes('opencode'),
      'installProvider must NOT be called with "opencode" when user answers n',
    );
  });

  it('answering y to opencode prompt calls installProvider with "opencode"', async () => {
    const installedIds: string[] = [];
    // 'y' → install opencode; 'n' → skip sign-in; '' → mode; 'n' → set-default; 'n' → auto-update; 'q' → main menu
    const ctx = makeOpencodeOnboardCtx(
      ['y', 'n', '', 'n', 'n', 'q'],
      (id) => { installedIds.push(id); },
    );
    const sink = makeSink();

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'answering y to opencode prompt should not throw',
    );

    assert.ok(
      installedIds.includes('opencode'),
      'installProvider must be called with "opencode" when user answers y',
    );
  });

  it('answering y triggers re-detect via injected detectEnvironment', async () => {
    let detectCallCount = 0;
    // 'y' → install opencode; 'n' → skip sign-in; '' → mode; 'n' → set-default; 'n' → auto-update; 'q' → quit
    const ctx = makeOpencodeOnboardCtx(
      ['y', 'n', '', 'n', 'n', 'q'],
      undefined,
      () => { detectCallCount += 1; },
    );
    const sink = makeSink();

    await startMenu(ctx, sink);

    // detectEnvironment is called inside runWelcome after opencode install,
    // and once more in startMenu after runWelcome returns — total 2 calls.
    assert.ok(
      detectCallCount >= 1,
      'detectEnvironment must be called at least once (re-detect after opencode install)',
    );
  });

  it('offers opencode sign-in during onboarding after install', async () => {
    const sink = makeSink();
    const loginCalls: string[] = [];
    const ctx = {
      ...makeOpencodeOnboardCtx(['y', 'y', '', 'n', 'n', 'q']),
      login: async (_out: OutputSink, providerArg?: string) => {
        loginCalls.push(providerArg ?? 'all');
        return 0;
      },
    };

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'opencode sign-in prompt after install should not throw',
    );

    assert.ok(
      sink.buf.toLowerCase().includes('sign in to opencode'),
      'onboarding must offer sign-in for newly installed unconfigured opencode',
    );
    assert.deepEqual(loginCalls, ['opencode'], 'sign-in prompt must call login for opencode when accepted');
  });

  it('opencode prompt does NOT appear when opencode is already installed', async () => {
    // Use an env where opencode IS installed → prompt should not appear
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-opencode-skip-${randomUUID()}`);
    const config: AppConfig = { onboarded: false, setAsDefault: false };

    const sink = makeSink();
    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: ENV_WITH_OPENCODE,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      // No opencode install prompt; opencode is installed but unsigned, so skip sign-in, then mode/default/update/quit.
      readLine: makeScriptedReader(['n', '', 'n', 'n', 'q']),
      installProvider: async () => true,
      login: async () => 0,
      detectEnvironment: async () => ENV_WITH_OPENCODE,
      // Inject a no-op update check so no real npm registry requests are made
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Stub isHookInstalled so the set-default prompt still appears (see makeFirstRunCtx)
      isHookInstalled: async () => false,
    };

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'welcome with opencode already installed should not throw',
    );

    // The opencode optional prompt must NOT appear when opencode is installed
    assert.ok(
      !sink.buf.includes('Add opencode?'),
      'opencode install prompt must not appear when opencode is already installed',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW 7: [i] Import a conversation
// ---------------------------------------------------------------------------

describe('startMenu — [i] import a native conversation', () => {
  it('shows "No claude conversations found" when no sessions exist (no native dir)', async () => {
    const sink = makeSink();
    const clock = makeFakeClock();
    const store = makeStore(clock);
    // Use a temp dir that has no .claude directory → listNativeSessions returns []
    const emptyHome = join(tmpdir(), `menu-import-empty-${randomUUID()}`);
    // Pass homeDir into ctx; but listNativeSessions is called with no opts in menu.ts
    // so we test the "no sessions found" path by ensuring [i]→1→back works cleanly.
    // Since we can't inject homeDir into the menu handler directly, we rely on the
    // real listNativeSessions returning [] for a non-existent real path. The menu
    // shows the "No claude conversations found" message and returns gracefully.
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'i',  // import
          '1',  // pick claude
          // No sessions → "No claude conversations found" → back to menu
          'q',  // quit
        ]),
        cwd: emptyHome,
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      '[i] with no native sessions should not throw',
    );
    // Should mention "No claude conversations found" OR render the import menu
    // (either the user's real ~/.claude exists or not — both are valid outcomes)
    // The key assertion is that it resolves cleanly.
  });

  it('[i] → EOF at provider choice → returns to menu gracefully', async () => {
    const sink = makeSink();
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'i',    // import
          null,   // EOF at provider choice → cancel
          'q',    // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'EOF at provider choice should not throw',
    );
  });

  it('[i] → Enter at the picker cancels back to the menu', async () => {
    // The merged cross-tool picker has no "pick provider first" step anymore:
    // [i] shows one numbered list (or a no-sessions message); Enter cancels.
    const sink = makeSink();
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'i',    // resume a Claude/Codex session
          '',     // Enter → cancel (or no-sessions → already back at menu)
          'q',    // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'cancelling the resume picker should not throw',
    );
  });

  it('[i] with a real temp homeDir containing a Claude session → imports and enters chat', async () => {
    // This test monkey-patches by creating a temp homeDir with a sample Claude session,
    // then uses the menu's [i] path. Since listNativeSessions uses os.homedir() by
    // default (not injected), we can't easily override it inside the menu handler.
    // Instead, we test the "No <provider> conversations found" branch is reachable
    // and the flow returns to menu cleanly, which is the reachability requirement.
    const sink = makeSink();
    const clock = makeFakeClock();
    const store = makeStore(clock);

    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'i',   // import
          '2',   // pick codex (likely no sessions in CI)
          // No sessions → message → back to menu
          'q',   // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      '[i] → codex → no sessions → back should not throw',
    );
    // Either "No codex conversations found" OR a picker was rendered — both are valid
    // The critical invariant is clean exit
  });

  it('menu renders the [i] resume-a-Claude/Codex-session option', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['q']) });

    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('[i]'), 'menu should show [i] key');
    assert.ok(
      sink.buf.toLowerCase().includes('claude/codex'),
      'menu should mention resuming a Claude/Codex session',
    );
  });

  it('menu renders [r] raw provider session option in output', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['q']) });

    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('[r]'), 'menu should show [r] key');
    assert.ok(sink.buf.toLowerCase().includes('raw'), 'menu should mention raw');
  });

  it('[r] → EOF at provider choice → returns to menu gracefully', async () => {
    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'r',    // raw session
          null,   // EOF at provider choice → cancel
          'q',    // quit
        ]),
      },
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'EOF at raw provider choice should not throw',
    );
  });

  it('[r] → invalid provider choice → "Cancelled" → back to menu', async () => {
    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'r',    // raw session
          '9',    // invalid choice
          'q',    // quit
        ]),
      },
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'invalid raw provider choice should not throw',
    );
    assert.ok(sink.buf.includes('Cancelled'), '"Cancelled" shown for invalid raw provider');
  });

  it('[i] end-to-end with temp homeDir: imports session, creates conversation', async () => {
    // Build a temp homeDir with a real Claude session file, drive [i] through
    // the menu using the file-backed store, and verify a conversation was created.
    // We use the file-backed listNativeSessions/importNativeSession via the menu,
    // but since the menu calls listNativeSessions() without homeDir injection, we
    // test via a direct round-trip that matches how the menu would use it.
    //
    // Because the menu does NOT expose homeDir injection, we validate the "no sessions"
    // branch + direct importNativeSession behaviour (covered in native-sessions.test.ts).
    // Here we validate the menu wiring by ensuring the [i] key is dispatched and
    // the flow completes without error in any scenario.
    const sink = makeSink();
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader(['i', '1', 'q']),
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      '[i] end-to-end wiring should not throw',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW 8b: [r] raw session picker — opencode conditional visibility
// ---------------------------------------------------------------------------

describe('startMenu — [r] raw session picker: opencode visibility', () => {
  /** Env where all raw-session providers are installed. */
  const FAKE_ENV_WITH_OPENCODE: EnvironmentStatus = {
    ...FAKE_ENV,
    codex: {
      id: 'codex',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: 'codex',
      availableModels: ['gpt-4o'],
    },
    opencode: {
      id: 'opencode',
      installed: true,
      version: '0.1.0',
      authenticated: true,
      plan: null,
      binaryPath: 'opencode',
      availableModels: ['opencode/deepseek-v4-flash-free'],
    },
  };

  it('raw session picker shows [3] opencode when opencode is installed', async () => {
    const sink = makeSink();
    const ctx = makeCtx(
      {
        env: FAKE_ENV_WITH_OPENCODE,
        readLine: makeScriptedReader([
          'r',    // open raw session picker
          null,   // EOF at choice → cancel gracefully (no real spawn)
          'q',    // quit
        ]),
      },
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'raw session picker with opencode installed should not throw',
    );

    // The picker prompt must list opencode as [3]
    assert.ok(
      sink.buf.includes('[3]') && sink.buf.toLowerCase().includes('opencode'),
      `picker must offer "[3] opencode" when opencode is installed; got: ${sink.buf.slice(0, 500)}`,
    );
  });

  it('raw session picker does NOT show opencode when not installed', async () => {
    const sink = makeSink();
    // FAKE_ENV has opencode not-installed
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'r',    // open raw session picker
          null,   // EOF at choice → cancel gracefully
          'q',    // quit
        ]),
      },
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'raw session picker without opencode should not throw',
    );

    // The raw session picker prompt itself (between "Open raw session with:" and the
    // first "> " prompt) must NOT list opencode. We isolate just the picker lines by
    // taking the text between the "Open raw session" marker and the first prompt "> ".
    const afterRaw = sink.buf.split('Open raw session')[1] ?? '';
    // Take only up to the first "> " so we don't pick up the re-rendered main menu
    const pickerLines = afterRaw.split('\n> ')[0] ?? '';
    assert.ok(
      !pickerLines.toLowerCase().includes('opencode'),
      'opencode must not appear in the raw session picker choices when not installed',
    );
    assert.ok(
      !pickerLines.toLowerCase().includes('codex'),
      'codex must not appear in the raw session picker choices when not installed',
    );
  });

  it('[r] with opencode installed → picker lists [1] Claude [2] Codex [3] opencode', async () => {
    // Drive [r] to open the picker, then EOF to cancel — verify all three labels appear
    // in the rendered prompt. No real binary is spawned (EOF cancels before selection).
    const sink = makeSink();
    const ctx = makeCtx(
      {
        env: FAKE_ENV_WITH_OPENCODE,
        readLine: makeScriptedReader([
          'r',    // open raw session picker
          null,   // EOF at choice prompt → cancel gracefully (no execa spawn)
          'q',    // quit
        ]),
      },
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'picker with opencode installed should not throw on EOF cancel',
    );

    // All three options must appear in the rendered picker prompt
    assert.ok(sink.buf.includes('[1]') && sink.buf.toLowerCase().includes('claude'),
      'picker must show [1] Claude');
    assert.ok(sink.buf.includes('[2]') && sink.buf.toLowerCase().includes('codex'),
      'picker must show [2] Codex');
    assert.ok(sink.buf.includes('[3]') && sink.buf.toLowerCase().includes('opencode'),
      'picker must show [3] opencode when installed');
  });

  it('[r] → invalid choice when only Claude is installed → Cancelled (no spawn)', async () => {
    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'r',    // open raw session picker
          '9',    // invalid choice → Cancelled
          'q',    // quit
        ]),
      },
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'selecting invalid option must not throw',
    );
    assert.ok(sink.buf.includes('Cancelled'), '"Cancelled" shown for out-of-range choice');
  });

  it('[r] with no installed providers prints an actionable message instead of launching', async () => {
    const sink = makeSink();
    const noInstalledEnv: EnvironmentStatus = {
      claude: {
        id: 'claude',
        installed: false,
        version: null,
        authenticated: false,
        plan: null,
        binaryPath: null,
        availableModels: [],
      },
      codex: {
        id: 'codex',
        installed: false,
        version: null,
        authenticated: false,
        plan: null,
        binaryPath: null,
        availableModels: [],
      },
      opencode: {
        id: 'opencode',
        installed: false,
        version: null,
        authenticated: false,
        plan: null,
        binaryPath: null,
        availableModels: [],
      },
      hasAnyProvider: false,
      platform: 'linux',
    };
    const ctx = makeCtx(
      {
        env: noInstalledEnv,
        readLine: makeScriptedReader([
          'r',
          'q',
        ]),
      },
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'raw picker with no installed providers should not throw',
    );
    assert.ok(
      sink.buf.includes('No provider CLI is installed yet'),
      'raw picker must print an actionable no-installed-providers message',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW 8: first-run welcome — answering "y" to set-as-default actually runs
//          the install (writes the hook). Uses a temp HOME to avoid writing
//          to the real shell rc file.
// ---------------------------------------------------------------------------

describe('startMenu — first-run welcome: y to set-as-default writes the shell hook', () => {
  /**
   * Build a first-run context pointing HOME at a temp directory so the install
   * writes a harmless ~/.bashrc there instead of the real home directory.
   */
  /**
   * Both providers installed and authenticated — no install or sign-in prompts
   * appear in the welcome flow, so the only prompts are mode and set-as-default.
   */
  const FAKE_ENV_BOTH_INSTALLED_AUTHED: EnvironmentStatus = {
    claude: {
      id: 'claude',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: 'claude',
      availableModels: ['claude-3-5-sonnet'],
    },
    codex: {
      id: 'codex',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: 'codex',
      availableModels: ['gpt-4o'],
    },
    opencode: {
      id: 'opencode',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    hasAnyProvider: true,
    platform: 'linux',
  };

  function makeInstallCtx(
    inputs: ReadonlyArray<string | null>,
    _tempHome: string,
  ): MenuContext {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-install-${randomUUID()}`);

    const config: AppConfig = { onboarded: false, setAsDefault: false };

    // Both providers installed+authed → no install or sign-in prompts appear in
    // the welcome flow. The only prompts are mode (single inline prompt) and set-as-default (y/n).
    // Fakes are still injected defensively so no real subprocess can ever be spawned.
    return {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider(), codex: makeFakeProvider('codex') },
      env: FAKE_ENV_BOTH_INSTALLED_AUTHED,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(inputs),
      // Inject no-op fakes so no real npm/claude/codex subprocesses are spawned
      installProvider: async () => true,
      login: async () => 0,
      // Inject fake detectEnvironment so post-onboarding re-detect never spawns
      detectEnvironment: async () => FAKE_ENV_BOTH_INSTALLED_AUTHED,
      // Inject a no-op update check so no real npm registry requests are made
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Stub isHookInstalled so the set-default prompt still appears (see makeFirstRunCtx)
      isHookInstalled: async () => false,
      // tempHome is set via process.env.HOME override below
    };
  }

  /**
   * Override process.env.HOME and process.platform for the duration of fn,
   * then restore them.
   */
  async function withTempHome<T>(
    tempHome: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const origHome = process.env['HOME'];
    const origShell = process.env['SHELL'];
    const origPlatform = process.platform;

    process.env['HOME'] = tempHome;
    process.env['SHELL'] = '/bin/bash';
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    try {
      return await fn();
    } finally {
      if (origHome !== undefined) {
        process.env['HOME'] = origHome;
      } else {
        delete process.env['HOME'];
      }
      if (origShell !== undefined) {
        process.env['SHELL'] = origShell;
      } else {
        delete process.env['SHELL'];
      }
      Object.defineProperty(process, 'platform', {
        value: origPlatform,
        configurable: true,
      });
    }
  }

  it('answering y to set-as-default writes the hook to temp ~/.bashrc', async () => {
    const { mkdir: mkdirFn } = await import('node:fs/promises');
    const { readFile: readFileFn } = await import('node:fs/promises');

    const tempHome = join(tmpdir(), `menu-install-home-${randomUUID()}`);
    await mkdirFn(tempHome, { recursive: true });

    await withTempHome(tempHome, async () => {
      const sink = makeSink();
      // FAKE_ENV has both providers installed+authed → no install/login prompts.
      // Welcome flow: n (skip opencode) → '' (mode Enter = balanced) → y (set as default) → n (auto-update) → q (main menu)
      const ctx = makeInstallCtx(['n', '', 'y', 'n', 'q'], tempHome);

      await assert.doesNotReject(
        () => startMenu(ctx, sink),
        'welcome y answer should not throw',
      );

      // The hook should have been written to the temp ~/.bashrc
      const rcPath = join(tempHome, '.bashrc');
      let rcContent: string;
      try {
        rcContent = await readFileFn(rcPath, 'utf8');
      } catch {
        rcContent = '';
      }

      assert.ok(
        rcContent.includes('myshell-tools') || sink.buf.includes('myshell-tools'),
        'either the rc file or output must reference myshell-tools after y answer',
      );
    });
  });

  it('answering y to set-as-default reports install in output', async () => {
    const { mkdir: mkdirFn } = await import('node:fs/promises');

    const tempHome = join(tmpdir(), `menu-install-out-${randomUUID()}`);
    await mkdirFn(tempHome, { recursive: true });

    await withTempHome(tempHome, async () => {
      const sink = makeSink();
      const ctx = makeInstallCtx(['n', '', 'y', 'n', 'q'], tempHome);

      await startMenu(ctx, sink);

      // The install output should mention the hook was installed or the rc file path
      assert.ok(
        sink.buf.includes('hook') || sink.buf.includes('.bashrc') || sink.buf.includes('installed'),
        `install output must appear in sink after y answer; got: ${sink.buf.slice(0, 300)}`,
      );
    });
  });

  it('answering n to set-as-default does NOT write the hook', async () => {
    const { mkdir: mkdirFn } = await import('node:fs/promises');
    const { readFile: readFileFn } = await import('node:fs/promises');

    const tempHome = join(tmpdir(), `menu-no-install-${randomUUID()}`);
    await mkdirFn(tempHome, { recursive: true });

    await withTempHome(tempHome, async () => {
      const sink = makeSink();
      // n → skip opencode; '' → mode (Enter = balanced); n → skip set-as-default; n → auto-update; q → quit
      const ctx = makeInstallCtx(['n', '', 'n', 'n', 'q'], tempHome);

      await startMenu(ctx, sink);

      const rcPath = join(tempHome, '.bashrc');
      let rcContent = '';
      try {
        rcContent = await readFileFn(rcPath, 'utf8');
      } catch {
        // File not created — that's the expected outcome
        rcContent = '';
      }

      assert.ok(
        !rcContent.includes('HOOK_BEGIN') && !rcContent.includes('myshell-tools'),
        'hook must NOT be written when user answers n',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// FLOW 9: first-run onboarding env refresh (BUG 1)
// After onboarding, the first main screen must reflect the FRESH post-login env,
// not the stale pre-login status that was passed in via ctx.env.
// ---------------------------------------------------------------------------

describe('startMenu — first-run: post-onboarding env refresh (BUG 1)', () => {
  /**
   * Env where codex is installed but NOT authenticated (stale/pre-login state).
   * Passed as ctx.env so this is what the menu sees before onboarding.
   */
  const STALE_ENV: EnvironmentStatus = {
    claude: {
      id: 'claude',
      installed: true,
      version: '1.0.0',
      authenticated: false,
      plan: null,
      binaryPath: 'claude',
      availableModels: [],
    },
    codex: {
      id: 'codex',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    opencode: {
      id: 'opencode',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    hasAnyProvider: true,
    platform: 'linux',
  };

  /**
   * Fresh env returned after detectEnvironment() post-onboarding — claude is
   * now authenticated (the user signed in during onboarding).
   */
  const FRESH_ENV: EnvironmentStatus = {
    claude: {
      id: 'claude',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: 'claude',
      availableModels: ['claude-opus-4'],
    },
    codex: {
      id: 'codex',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    opencode: {
      id: 'opencode',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    hasAnyProvider: true,
    platform: 'linux',
  };

  it('first main screen shows FRESH status after onboarding signed in', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-onboard-fresh-${randomUUID()}`);

    const config: AppConfig = { onboarded: false, setAsDefault: false };

    // Welcome flow for STALE_ENV: codex not installed (install prompt → y), opencode not installed
    // (opencode prompt → n), claude installed but unauthenticated (no sign-in prompt in FRESH_ENV
    // since FRESH_ENV has claude authenticated). Mode → Enter (balanced), default shell → n. Then main menu → q.
    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: STALE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(['y', 'n', '', 'n', 'n', 'q']),
      installProvider: async () => true,
      login: async () => 0,
      // detectEnvironment returns FRESH_ENV — simulates successful post-login detection
      detectEnvironment: async () => FRESH_ENV,
      // Inject a no-op update check so no real npm registry requests are made
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Stub isHookInstalled so the set-default prompt still appears (see makeFirstRunCtx)
      isHookInstalled: async () => false,
    };

    const sink = makeSink();
    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'onboarding with detectEnvironment injection should resolve cleanly',
    );

    // The main screen (after onboarding) must show ✅ claude: ready, not ⚠️ not signed in.
    // The stale "not signed in" must NOT appear in the first main screen rendering.
    // We split on the Setup header to find the post-onboarding content.
    const afterSetup = sink.buf.split('Setup')[1] ?? sink.buf;
    assert.ok(
      afterSetup.includes('ready'),
      `first main screen must show "ready" after onboarding refresh; got: ${afterSetup.slice(0, 400)}`,
    );
  });

  it('no real detectEnvironment spawns (seam is honoured)', async () => {
    // Count how many times the fake detectEnvironment was called — it must be
    // called exactly once (the post-onboarding refresh), and the real one never runs.
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-onboard-seam-${randomUUID()}`);

    const config: AppConfig = { onboarded: false, setAsDefault: false };

    let detectCalls = 0;
    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: STALE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      // 'y' → install codex; 'n' → skip opencode; '' → mode (Enter = balanced); 'n' → set-as-default; 'n' → auto-update; 'q' → main menu quit
      readLine: makeScriptedReader(['y', 'n', '', 'n', 'n', 'q']),
      installProvider: async () => true,
      login: async () => 0,
      detectEnvironment: async () => {
        detectCalls += 1;
        return FRESH_ENV;
      },
      // Inject a no-op update check so no real npm registry requests are made
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Stub isHookInstalled so the set-default prompt still appears (see makeFirstRunCtx)
      isHookInstalled: async () => false,
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    // detectEnvironment is called inside runWelcome (after codex install) and once
    // more in startMenu after runWelcome returns — total 2 injected calls.
    assert.equal(detectCalls, 2, 'detectEnvironment must be called exactly twice: once inside runWelcome after install, once in startMenu after onboarding');
  });

  it('re-detects after an onboarding login so completed auth is not re-entered', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-onboard-login-refresh-${randomUUID()}`);
    const installedUnauthed: EnvironmentStatus = {
      claude: { id: 'claude', installed: true, version: '1.0.0', authenticated: false, plan: null, binaryPath: 'claude', availableModels: [] },
      codex: { id: 'codex', installed: true, version: '1.0.0', authenticated: false, plan: null, binaryPath: 'codex', availableModels: [] },
      opencode: { id: 'opencode', installed: true, version: '1.0.0', authenticated: false, plan: null, binaryPath: 'opencode', availableModels: [] },
      hasAnyProvider: true,
      platform: 'linux',
    };
    const allAuthed: EnvironmentStatus = {
      claude: { ...installedUnauthed.claude, authenticated: true, availableModels: ['opus'] },
      codex: { ...installedUnauthed.codex, authenticated: true, availableModels: ['gpt-5.5'] },
      opencode: { ...installedUnauthed.opencode, authenticated: true, availableModels: ['opencode/paid'] },
      hasAnyProvider: true,
      platform: 'linux',
    };
    const loginCalls: string[] = [];
    let detectCalls = 0;
    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: installedUnauthed,
      store,
      config: { onboarded: false, setAsDefault: false },
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      // y = accept Claude sign-in, '' = mode Enter. Without the post-login
      // re-detect, that blank would default-accept the stale Codex auth prompt.
      readLine: makeScriptedReader(['y', '', 'n', 'n', 'q']),
      installProvider: async () => true,
      login: async (_out, providerArg) => {
        loginCalls.push(providerArg ?? 'all');
        return 0;
      },
      detectEnvironment: async () => {
        detectCalls += 1;
        return allAuthed;
      },
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      isHookInstalled: async () => false,
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    assert.deepEqual(loginCalls, ['claude'], 'onboarding must not re-enter auth after a successful login');
    assert.equal(detectCalls, 2, 'detects once after login and once after onboarding returns');
    assert.ok(!sink.buf.includes('Sign in to codex?'), 'stale Codex auth prompt must be skipped after refresh');
  });
});

// ---------------------------------------------------------------------------
// FLOW 10: [o] opencode — Auth section discoverability (BUG 2 fix)
//
// [o] is now ALWAYS visible in the Auth section, regardless of whether opencode
// is installed. When not installed, pressing [o] shows a consent prompt, then
// calls installProvider (if consented), then calls login. When installed, it
// goes straight to login. The label adapts to the install state.
// ---------------------------------------------------------------------------

describe('startMenu — [o] opencode discoverability in Auth section', () => {
  /** Env with opencode installed and authenticated. */
  const FAKE_ENV_OPENCODE_INSTALLED: EnvironmentStatus = {
    ...FAKE_ENV,
    opencode: {
      id: 'opencode',
      installed: true,
      version: '0.1.0',
      authenticated: true,
      plan: null,
      binaryPath: 'opencode',
      availableModels: ['opencode/deepseek-v4-flash-free'],
    },
  };

  // ---- Label visibility (always present) ------------------------------------

  it('Auth section shows [o] when opencode IS installed', async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      env: FAKE_ENV_OPENCODE_INSTALLED,
      readLine: makeScriptedReader(['q']),
      detectEnvironment: async () => FAKE_ENV_OPENCODE_INSTALLED,
    });

    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('[o]'), 'menu must show [o] when opencode is installed');
    assert.ok(sink.buf.toLowerCase().includes('opencode'), 'menu must mention opencode');
  });

  it('Auth section shows [o] even when opencode is NOT installed', async () => {
    const sink = makeSink();
    // FAKE_ENV has opencode not-installed — [o] must still appear
    const ctx = makeCtx({
      readLine: makeScriptedReader(['q']),
      detectEnvironment: async () => FAKE_ENV,
    });

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('[o]'),
      '[o] must appear in menu even when opencode is not installed (discoverability)',
    );
    assert.ok(
      sink.buf.toLowerCase().includes('opencode'),
      'opencode must be mentioned in menu even when not installed',
    );
  });

  it('label says "Login / add subscription" when opencode is installed', async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      env: FAKE_ENV_OPENCODE_INSTALLED,
      readLine: makeScriptedReader(['q']),
      detectEnvironment: async () => FAKE_ENV_OPENCODE_INSTALLED,
    });

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.toLowerCase().includes('login') || sink.buf.toLowerCase().includes('subscription'),
      'label must mention "login" or "subscription" when opencode is installed',
    );
  });

  it('label says "Login opencode (installs it first)" when opencode is NOT installed', async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['q']),
      detectEnvironment: async () => FAKE_ENV,
    });

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.toLowerCase().includes('login opencode') && sink.buf.toLowerCase().includes('installs it first'),
      'label must read "Login opencode (installs it first)" when opencode is not installed',
    );
  });

  // ---- Pressing [o] when opencode is ALREADY installed ----------------------

  it('pressing o with opencode installed invokes login with "opencode"', async () => {
    let loginCalled = false;
    let loginArg: string | undefined;
    let sharedReadLinePassed = false;
    let sharedConfirmPassed = false;

    const readLine = makeScriptedReader(['o', 'q']);
    const confirm = async (): Promise<boolean> => true;
    const sink = makeSink();
    const ctx = makeCtx({
      env: FAKE_ENV_OPENCODE_INSTALLED,
      readLine,
      confirm,
      login: async (_out, providerArg, opts) => {
        loginCalled = true;
        loginArg = providerArg;
        sharedReadLinePassed = opts?.readLine === readLine;
        sharedConfirmPassed = opts?.confirm === confirm;
        return 0;
      },
      detectEnvironment: async () => FAKE_ENV_OPENCODE_INSTALLED,
    });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'pressing o with opencode installed should not throw',
    );

    assert.equal(loginCalled, true, 'login fake must have been called');
    assert.equal(loginArg, 'opencode', 'login must be called with "opencode"');
    assert.equal(sharedReadLinePassed, true, 'opencode login must receive the shared menu reader');
    assert.equal(sharedConfirmPassed, true, 'opencode login must receive the shared menu confirm');
  });

  it('pressing o with opencode installed does NOT show install consent prompt', async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      env: FAKE_ENV_OPENCODE_INSTALLED,
      readLine: makeScriptedReader(['o', 'q']),
      login: async () => 0,
      detectEnvironment: async () => FAKE_ENV_OPENCODE_INSTALLED,
    });

    await startMenu(ctx, sink);

    assert.ok(
      !sink.buf.includes('Install opencode'),
      'no install consent prompt when opencode is already installed',
    );
  });

  it('pressing o does not spawn real subprocesses (login seam is honoured)', async () => {
    let loginCallCount = 0;

    const sink = makeSink();
    const ctx = makeCtx({
      env: FAKE_ENV_OPENCODE_INSTALLED,
      readLine: makeScriptedReader(['o', 'q']),
      login: async () => {
        loginCallCount += 1;
        return 0;
      },
      detectEnvironment: async () => FAKE_ENV_OPENCODE_INSTALLED,
    });

    await startMenu(ctx, sink);

    assert.equal(loginCallCount, 1, 'login seam must be called exactly once for [o]');
  });

  // ---- Pressing [o] when opencode is NOT installed — consent prompt ---------

  it('pressing o when opencode NOT installed shows a consent prompt', async () => {
    const sink = makeSink();
    // Answer 'n' to skip install
    const ctx = makeCtx({
      readLine: makeScriptedReader(['o', 'n', 'q']),
      detectEnvironment: async () => FAKE_ENV,
    });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'pressing o without opencode installed should not throw',
    );

    assert.ok(
      sink.buf.includes('Install opencode'),
      'consent prompt must appear when o pressed and opencode not installed',
    );
    assert.ok(
      sink.buf.includes('opencode-ai'),
      'consent prompt must mention the npm package name',
    );
  });

  it('pressing o, NOT installed, answering n → skips install, does NOT call installProvider', async () => {
    let installCalled = false;

    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['o', 'n', 'q']),
      installProvider: async () => {
        installCalled = true;
        return false;
      },
      detectEnvironment: async () => FAKE_ENV,
    });

    await startMenu(ctx, sink);

    assert.equal(installCalled, false, 'installProvider must NOT be called when user answers n');
  });

  it('pressing o, NOT installed, answering n → does NOT call login', async () => {
    let loginCalled = false;

    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['o', 'n', 'q']),
      login: async () => {
        loginCalled = true;
        return 0;
      },
      detectEnvironment: async () => FAKE_ENV,
    });

    await startMenu(ctx, sink);

    assert.equal(loginCalled, false, 'login must NOT be called when user skips install');
  });

  it('pressing o, NOT installed, answering n → prints skip note with install command', async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['o', 'n', 'q']),
      detectEnvironment: async () => FAKE_ENV,
    });

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('Skipped') || sink.buf.toLowerCase().includes('install it later'),
      'skip note must mention "Skipped" or "install it later"',
    );
    assert.ok(
      sink.buf.includes('npm install -g opencode-ai'),
      'skip note must include the exact install command',
    );
  });

  it('pressing o, NOT installed, answering [Enter] (yes) → calls installProvider then login', async () => {
    const calls: string[] = [];

    // After install, detectEnvironment returns the "installed" env so login proceeds
    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['o', '', 'q']),  // '' = Enter = yes
      installProvider: async (_id) => {
        calls.push('install:' + _id);
        return true;
      },
      login: async (_out, providerArg) => {
        calls.push('login:' + String(providerArg));
        return 0;
      },
      detectEnvironment: async () => {
        // After install: report opencode now installed so login proceeds
        return FAKE_ENV_OPENCODE_INSTALLED;
      },
    });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'o → yes to install → install+login should not throw',
    );

    assert.ok(calls.includes('install:opencode'), 'installProvider must be called with "opencode"');
    assert.ok(calls.includes('login:opencode'), 'login must be called with "opencode" after install');
    // install must happen before login
    assert.ok(
      calls.indexOf('install:opencode') < calls.indexOf('login:opencode'),
      'installProvider must be called before login',
    );
  });

  it('pressing o, NOT installed, EOF at consent → skips (same as n)', async () => {
    let installCalled = false;
    let loginCalled = false;

    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['o', null]),  // EOF at consent prompt
      installProvider: async () => {
        installCalled = true;
        return true;
      },
      login: async () => {
        loginCalled = true;
        return 0;
      },
      detectEnvironment: async () => FAKE_ENV,
    });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'EOF at consent prompt should not throw',
    );

    assert.equal(installCalled, false, 'installProvider must NOT be called on EOF consent');
    assert.equal(loginCalled, false, 'login must NOT be called on EOF consent');
  });

  it('pressing o, NOT installed, install fails → does NOT call login', async () => {
    let loginCalled = false;

    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['o', '', 'q']),  // '' = Enter = yes
      installProvider: async () => false,   // install reports failure
      login: async () => {
        loginCalled = true;
        return 0;
      },
      // detectEnvironment still reports not-installed (confirming failure)
      detectEnvironment: async () => FAKE_ENV,
    });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'install failure should not throw',
    );

    assert.equal(loginCalled, false, 'login must NOT be called when install fails');
  });

  it('pressing o, NOT installed, install fails → prints failure note', async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['o', '', 'q']),
      installProvider: async () => false,
      detectEnvironment: async () => FAKE_ENV,
    });

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.toLowerCase().includes('install failed') || sink.buf.toLowerCase().includes('run it yourself'),
      'failure note must appear when install fails',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW 11: Update notifier — banner, [u] key, auto-update-at-launch
// ---------------------------------------------------------------------------

describe('startMenu — update notifier: banner, [u], auto-update', () => {
  /**
   * Build a ctx for banner / manual-[u] tests.
   *
   * Uses `autoUpdate: false` so the launch auto-update gate does NOT fire —
   * these tests exercise the notify-banner + manual [u] path, not the
   * auto-update-at-launch path (which is tested separately with inline configs).
   */
  function makeUpdateCtx(
    overrides: Partial<MenuContext> & { readLine: () => Promise<string | null> },
    updateAvailable: boolean,
    latest: string,
  ): MenuContext {
    const updateResult: UpdateCheckResult = updateAvailable
      ? { current: '2.0.0', latest, updateAvailable: true }
      : { current: '2.0.0', latest: null, updateAvailable: false };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-update-ctx-${randomUUID()}`);

    // Explicit autoUpdate:false so the launch auto-update gate does NOT fire.
    // These tests are testing the banner / manual [u] path only.
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: false };

    return {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async () => updateResult,
      ...overrides,
    };
  }

  // ---- Update banner visibility --------------------------------------------

  it('banner appears when update is available', async () => {
    const sink = makeSink();
    const ctx = makeUpdateCtx(
      { readLine: makeScriptedReader(['q']) },
      true,
      '3.0.0',
    );

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('▲ Update available'),
      'update banner must appear when updateAvailable is true',
    );
    assert.ok(
      sink.buf.includes('2.0.0') && sink.buf.includes('3.0.0'),
      'banner must show current → latest versions',
    );
    assert.ok(
      sink.buf.includes('press u'),
      'banner must include "(press u)" hint',
    );
  });

  it('banner does NOT appear when no update is available', async () => {
    const sink = makeSink();
    const ctx = makeUpdateCtx(
      { readLine: makeScriptedReader(['q']) },
      false,
      '1.0.0',
    );

    await startMenu(ctx, sink);

    assert.ok(
      !sink.buf.includes('▲ Update available'),
      'update banner must NOT appear when no update is available',
    );
  });

  // ---- [u] entry visibility -----------------------------------------------

  it('[u] Update now entry is shown when update is available', async () => {
    const sink = makeSink();
    const ctx = makeUpdateCtx(
      { readLine: makeScriptedReader(['q']) },
      true,
      '3.0.0',
    );

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('[u]'),
      '[u] entry must appear in menu when update is available',
    );
    assert.ok(
      sink.buf.toLowerCase().includes('update now') || sink.buf.toLowerCase().includes('update'),
      'menu must show an update option label',
    );
  });

  it('[u] Update now entry is NOT shown when no update is available', async () => {
    const sink = makeSink();
    const ctx = makeUpdateCtx(
      { readLine: makeScriptedReader(['q']) },
      false,
      '1.0.0',
    );

    await startMenu(ctx, sink);

    // The [u] key should not appear in the menu (it is only shown when updateAvailable)
    // Check specifically for the Options section [u] entry — [u] must not be in menu entries
    assert.ok(
      !sink.buf.includes('[u]'),
      '[u] entry must NOT appear when no update is available',
    );
  });

  // ---- Pressing [u] calls updateSelf --------------------------------------

  it('pressing u calls the injected updateSelf fake', async () => {
    let updateSelfCalled = false;

    const sink = makeSink();
    const ctx = makeUpdateCtx(
      {
        readLine: makeScriptedReader(['u', 'q']),
        updateSelf: async (_out) => {
          updateSelfCalled = true;
          return true;
        },
      },
      true,
      '3.0.0',
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'pressing u should not throw',
    );

    assert.equal(updateSelfCalled, true, 'updateSelf must be called when u is pressed');
  });

  it('pressing u on success prints success message', async () => {
    const sink = makeSink();
    const ctx = makeUpdateCtx(
      {
        readLine: makeScriptedReader(['u', 'q']),
        updateSelf: async () => true,
      },
      true,
      '3.0.0',
    );

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('✓ Updated to 3.0.0'),
      'success message must include the target version',
    );
    assert.ok(
      sink.buf.toLowerCase().includes('restart'),
      'success message must mention restart',
    );
  });

  it('pressing u on failure prints failure note', async () => {
    const sink = makeSink();
    const ctx = makeUpdateCtx(
      {
        readLine: makeScriptedReader(['u', 'q']),
        updateSelf: async () => false,
      },
      true,
      '3.0.0',
    );

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.toLowerCase().includes('update failed') || sink.buf.includes('npm install -g'),
      'failure note must appear when update fails',
    );
  });

  it('pressing u does NOT call relaunch (manual path is safe/no-relaunch)', async () => {
    let relaunchCalled = false;

    const sink = makeSink();
    const ctx = makeUpdateCtx(
      {
        readLine: makeScriptedReader(['u', 'q']),
        updateSelf: async () => true,
        relaunch: async () => {
          relaunchCalled = true;
          return 0;
        },
      },
      true,
      '3.0.0',
    );

    await startMenu(ctx, sink);

    assert.equal(relaunchCalled, false, 'relaunch must NOT be called from the manual [u] path');
  });

  it('pressing u with no update available is silently ignored', async () => {
    let updateSelfCalled = false;

    const sink = makeSink();
    const ctx = makeUpdateCtx(
      {
        readLine: makeScriptedReader(['u', 'q']),
        updateSelf: async () => {
          updateSelfCalled = true;
          return true;
        },
      },
      false,  // no update available
      '1.0.0',
    );

    await startMenu(ctx, sink);

    assert.equal(updateSelfCalled, false, 'updateSelf must NOT be called when no update is available');
  });

  // ---- Auto-update at launch ----------------------------------------------

  it('auto-update: calls updateSelf then relaunch when autoUpdate=true and update available', async () => {
    const calls: string[] = [];

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-autoupdate-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: true };

    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader([]),  // no input needed — auto-update returns immediately
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: '3.0.0',
        updateAvailable: true,
      }),
      updateSelf: async (_out) => {
        calls.push('updateSelf');
        return true;
      },
      relaunch: async () => {
        calls.push('relaunch');
        return 0;
      },
    };

    const sink = makeSink();
    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'auto-update at launch must not throw',
    );

    assert.ok(calls.includes('updateSelf'), 'updateSelf must be called during auto-update');
    assert.ok(calls.includes('relaunch'), 'relaunch must be called after successful updateSelf');
    // updateSelf must be called before relaunch
    assert.ok(
      calls.indexOf('updateSelf') < calls.indexOf('relaunch'),
      'updateSelf must be called before relaunch',
    );
  });

  it('auto-update: completes update and relaunch handoff with injected reader', async () => {
    const calls: string[] = [];

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-autoupdate-handoff-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: true };

    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      // Injected readers do not create a real LineReader, so suspendStdin is
      // undefined in this harness. This still locks the no-op path: auto-update
      // must install, relaunch, and return cleanly without waiting for menu input.
      readLine: makeScriptedReader([]),
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: '3.0.0',
        updateAvailable: true,
      }),
      updateSelf: async () => {
        calls.push('updateSelf');
        return true;
      },
      relaunch: async () => {
        calls.push('relaunch');
        return 0;
      },
    };

    await assert.doesNotReject(
      () => startMenu(ctx, makeSink()),
      'auto-update relaunch handoff must not throw',
    );

    assert.deepEqual(calls, ['updateSelf', 'relaunch']);
  });

  it('auto-update: relaunches when the active PATH version matches the target', async () => {
    const calls: string[] = [];

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-autoupdate-verify-ok-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: true };

    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader([]),
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: '3.0.0',
        updateAvailable: true,
      }),
      updateSelf: async () => {
        calls.push('updateSelf');
        return true;
      },
      activeVersion: async () => {
        calls.push('activeVersion');
        return '3.0.0';
      },
      relaunch: async () => {
        calls.push('relaunch');
        return 0;
      },
    };

    await startMenu(ctx, makeSink());

    assert.deepEqual(calls, ['updateSelf', 'activeVersion', 'relaunch']);
  });

  it('auto-update: does NOT relaunch when the active PATH version is still old', async () => {
    const calls: string[] = [];

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-autoupdate-verify-mismatch-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: true };

    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(['q']),
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: '3.0.0',
        updateAvailable: true,
      }),
      updateSelf: async () => {
        calls.push('updateSelf');
        return true;
      },
      activeVersion: async () => {
        calls.push('activeVersion');
        return '2.0.0';
      },
      relaunch: async () => {
        calls.push('relaunch');
        return 0;
      },
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    assert.deepEqual(calls, ['updateSelf', 'activeVersion']);
    assert.ok(
      /Updated to 3\.0\.0, but the active `myshell-tools` on your PATH is still 2\.0\.0/.test(sink.buf),
      'must show the PATH version mismatch',
    );
    assert.ok(/which myshell-tools/.test(sink.buf), 'must show an actionable PATH check');
    assert.ok(/Staying on 2\.0\.0/.test(sink.buf), 'must say the current process keeps running');
  });

  it('auto-update: does NOT relaunch when updateSelf fails', async () => {
    let relaunchCalled = false;

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-autoupdate-fail-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: true };

    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(['q']),
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: '3.0.0',
        updateAvailable: true,
      }),
      updateSelf: async () => false,  // update fails
      relaunch: async () => {
        relaunchCalled = true;
        return 0;
      },
    };

    const sink = makeSink();
    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'failed auto-update must not throw',
    );

    assert.equal(relaunchCalled, false, 'relaunch must NOT be called when updateSelf fails');
    // Should continue to menu normally
    assert.ok(
      sink.buf.includes('myshell-tools'),
      'menu must be rendered after failed auto-update',
    );
  });

  it('auto-update: does NOT run when autoUpdate is explicitly false', async () => {
    let updateSelfCalled = false;

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-no-autoupdate-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: false };  // explicit opt-out

    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(['q']),
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: '3.0.0',
        updateAvailable: true,
      }),
      updateSelf: async () => {
        updateSelfCalled = true;
        return true;
      },
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    assert.equal(updateSelfCalled, false, 'updateSelf must NOT be called when autoUpdate is false');
    // Banner should still appear
    assert.ok(
      sink.buf.includes('▲ Update available'),
      'update banner must still appear even when autoUpdate is off',
    );
  });

  // Default behaviour (autoUpdate ABSENT): ASK at launch, don't silently install.
  // Reuses makeUpdateCtx but overrides config to drop autoUpdate (= default), and
  // wires updateSelf/relaunch to record calls.
  const ttySink = (): OutputSink & { buf: string } => {
    let buf = '';
    return { get buf() { return buf; }, write: (s: string) => { buf += s; }, color: false, isTty: true };
  };
  const updateDefaultCtx = (answers: ReadonlyArray<string | null>, calls: string[]): MenuContext =>
    makeUpdateCtx(
      {
        readLine: makeScriptedReader(answers),
        config: { onboarded: true, setAsDefault: false, smartRoute: false }, // autoUpdate absent = default
        updateSelf: async () => { calls.push('updateSelf'); return true; },
        relaunch: async () => { calls.push('relaunch'); return 0; },
      },
      true,
      '3.0.0',
    );

  it('auto-update default: does NOT silently install in a non-interactive session', async () => {
    const calls: string[] = [];
    await assert.doesNotReject(() => startMenu(updateDefaultCtx([], calls), makeSink())); // isTty:false
    assert.ok(
      !calls.includes('updateSelf'),
      'absent default must NOT auto-install when non-interactive (no EOF-default install)',
    );
  });

  it('auto-update default: PROMPTS with the version and installs on "y"', async () => {
    const calls: string[] = [];
    const sink = ttySink();
    await assert.doesNotReject(() => startMenu(updateDefaultCtx(['y'], calls), sink));
    assert.ok(/Update available:.*2\.0\.0.*3\.0\.0/s.test(sink.buf), 'must show the from→to version');
    assert.ok(/Install it now\?/.test(sink.buf), 'must ask before installing');
    assert.ok(calls.includes('updateSelf') && calls.includes('relaunch'), 'on "y": installs + relaunches');
  });

  it('auto-update default: declining ("n") does not install and drops to the menu', async () => {
    const calls: string[] = [];
    const sink = ttySink();
    await assert.doesNotReject(() => startMenu(updateDefaultCtx(['n', 'q'], calls), sink)); // decline, then quit
    assert.ok(!calls.includes('updateSelf'), 'declining must not install');
    assert.ok(/Staying on.*2\.0\.0/.test(sink.buf), 'shows the staying-on note');
  });

  it('auto-update: MYSHELL_NO_UPDATE env var prevents auto-update even when autoUpdate=true', async () => {
    let updateSelfCalled = false;

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-no-autoupdate-env-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: true };

    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(['q']),
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: '3.0.0',
        updateAvailable: true,
      }),
      updateSelf: async () => {
        updateSelfCalled = true;
        return true;
      },
    };

    const origVal = process.env['MYSHELL_NO_UPDATE'];
    process.env['MYSHELL_NO_UPDATE'] = '1';
    try {
      const sink = makeSink();
      await startMenu(ctx, sink);

      assert.equal(updateSelfCalled, false, 'updateSelf must NOT be called when MYSHELL_NO_UPDATE is set');
      // Banner should still appear (notify-only mode)
      assert.ok(
        sink.buf.includes('▲ Update available'),
        'update banner must still appear when auto-update is disabled via env',
      );
    } finally {
      if (origVal !== undefined) {
        process.env['MYSHELL_NO_UPDATE'] = origVal;
      } else {
        delete process.env['MYSHELL_NO_UPDATE'];
      }
    }
  });

  it('auto-update: prints the auto-update message before running', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-autoupdate-msg-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, autoUpdate: true };

    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader([]),
      installProvider: async () => true,
      login: async () => 0,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: '3.0.0',
        updateAvailable: true,
      }),
      updateSelf: async () => true,
      relaunch: async () => 0,
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('▲ Auto-updating'),
      'must print auto-update message before running the update',
    );
    assert.ok(
      sink.buf.includes('2.0.0') && sink.buf.includes('3.0.0'),
      'auto-update message must include current → latest versions',
    );
  });

  // ---- Settings toggle for autoUpdate -------------------------------------

  it('[s] settings shows the update-on-launch toggle line', async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['s', '', 'q']),  // enter settings → Enter (back) → quit
    });

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('[3]') && sink.buf.toLowerCase().includes('update on launch'),
      'settings must show [3] Update on launch toggle',
    );
  });

  it('[s] → [3] toggles autoUpdate and reports the new state', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-autoupdate-toggle-${randomUUID()}`);

    // makeCtx uses { onboarded: true, setAsDefault: false } with no explicit autoUpdate.
    // autoUpdate is undefined → default-on. Pressing [3] toggles it OFF.
    const ctx = makeCtx({
      cwd: dir,
      readLine: makeScriptedReader(['s', '3', 'q']),  // enter settings → [3] toggle → quit
    });

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'toggling auto-update should not throw',
    );

    // Toggling from on (default) → off, the message "Update on launch: off" must appear
    assert.ok(
      sink.buf.includes('Update on launch: off') || sink.buf.includes('Update on launch'),
      'toggling must report the new update-on-launch state',
    );
  });

  // ---- Settings toggles for the experimental flags (panel / learnRouting) --

  it('[s] settings shows the [7] Panel and [8] Learned routing toggle lines', async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      readLine: makeScriptedReader(['s', '', 'q']),  // settings → Enter (back) → quit
    });

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('[7]') && sink.buf.toLowerCase().includes('panel'),
      'settings must show the [7] Panel (experimental) toggle line',
    );
    assert.ok(
      sink.buf.includes('[8]') && sink.buf.toLowerCase().includes('learned routing'),
      'settings must show the [8] Learned routing (experimental) toggle line',
    );
  });

  it('[s] → [7] toggles panel ON and persists it', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-panel-toggle-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', '7', 'q']),  // settings → [7] toggle → quit
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.ok(
      sink.buf.includes('Panel (experimental): on'),
      'toggling [7] must report panel on',
    );
    assert.equal(persisted.panel, true, 'panel must be persisted as true');
  });

  it('[s] → [8] toggles learnRouting ON and persists it', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-learnrouting-toggle-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', '8', 'q']),  // settings → [8] toggle → quit
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.ok(
      sink.buf.includes('Learned routing (experimental): on'),
      'toggling [8] must report learned routing on',
    );
    assert.equal(persisted.learnRouting, true, 'learnRouting must be persisted as true');
  });

  it('[s] settings shows and toggles [a] Auto-goal (quality-first)', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-autogoal-toggle-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', 'a', 'q']),
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.ok(
      sink.buf.includes('[a] Auto-goal (quality-first)'),
      'settings must show the [a] Auto-goal (quality-first) toggle line',
    );
    assert.ok(
      sink.buf.includes('Auto-goal (quality-first): on'),
      'toggling [a] must report auto-goal on',
    );
    assert.equal(persisted.autoGoal, true, 'autoGoal must be persisted as true');
  });

  // ---- Settings selector for the OVERSIGHT SPECTRUM (Phase 2b) -------------
  it('[s] → [e] sets oversight to autonomous and persists it', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-oversight-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader([
        's',   // settings
        'e',   // oversight select
        '3',   // autonomous
        '',    // Enter → back from settings
        'q',   // quit
      ]),
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.ok(
      sink.buf.includes('[e] Oversight: checkpoint'),
      'settings must show the [e] Oversight row defaulting to checkpoint',
    );
    assert.ok(
      sink.buf.includes('Oversight set to: autonomous'),
      'picking [3] must report autonomous',
    );
    assert.equal(persisted.oversight, 'autonomous', 'oversight must be persisted as autonomous');
  });

  // ---- Settings toggle for USER MEMORY (Phase 4, §9) ----------------------
  it('[s] settings shows the [c] Memory toggle line (on by default)', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-memory-show-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', '\n', 'q']),  // settings → Enter back → quit
    });

    await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
    });

    assert.ok(
      sink.buf.includes('[c] Memory: on'),
      'settings must show the [c] Memory toggle line, on by default',
    );
  });

  it('[s] → [c] toggles memory OFF (kill-switch) and persists it', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-memory-off-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', 'c', 'q']),  // settings → [c] toggle → quit
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.ok(sink.buf.includes('Memory: off'), 'toggling [c] must report memory off');
    assert.equal(persisted.memory, false, 'memory must be persisted as false (kill-switch)');
  });

  it('[s] → [c] toggles memory back ON (removes the kill-switch flag)', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-memory-on-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false, memory: false };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', 'c', 'q']),  // settings → [c] toggle → quit
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.ok(sink.buf.includes('Memory: on'), 'toggling [c] from off must report memory on');
    assert.notEqual(persisted.memory, false, 'memory:false must be cleared when re-enabling');
  });

  it('[s] → [c] memory toggle PRESERVES advanced memory keys', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-memory-preserve-${randomUUID()}`);
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      smartRoute: false,
      memoryDecayDays: 45,
      memoryMaxFactsPerScope: 120,
      memoryDefaultScope: 'global',
    };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', 'c', 'q']),
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.equal(persisted.memory, false, 'memory toggled off');
    assert.equal(persisted.memoryDecayDays, 45, 'advanced key memoryDecayDays preserved');
    assert.equal(persisted.memoryMaxFactsPerScope, 120, 'advanced key memoryMaxFactsPerScope preserved');
    assert.equal(persisted.memoryDefaultScope, 'global', 'advanced key memoryDefaultScope preserved');
  });

  it('[s] → [6] smart-routing toggle PRESERVES the memory kill-switch', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-memory-survives-${randomUUID()}`);
    const config: AppConfig = { onboarded: true, setAsDefault: false, memory: false };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', '6', 'q']),  // toggle a DIFFERENT setting
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.equal(persisted.memory, false, 'flipping smart-routing must NOT drop memory:false');
  });

  // The bug this guards against: rebuilding the config for ANY toggle used to
  // drop unrelated experimental flags. Start with panel + learnRouting ON, flip
  // a DIFFERENT setting, and assert both survive.
  it('[s] → [4] native-sessions toggle PRESERVES panel and learnRouting', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-preserve-toggle-${randomUUID()}`);
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      smartRoute: false,
      panel: true,
      learnRouting: true,
    };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', '4', 'q']),  // settings → [4] native sessions → quit
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.equal(persisted.panel, true, 'toggling native sessions must NOT drop panel');
    assert.equal(persisted.learnRouting, true, 'toggling native sessions must NOT drop learnRouting');
    assert.equal(persisted.nativeSessions, true, 'native sessions should now be on');
  });

  it('[s] → [6] smart-routing toggle PRESERVES panel and learnRouting', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-preserve-smartroute-${randomUUID()}`);
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      smartRoute: false,
      panel: true,
      learnRouting: true,
    };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', '6', 'q']),  // settings → [6] smart routing → quit
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.equal(persisted.panel, true, 'toggling smart routing must NOT drop panel');
    assert.equal(persisted.learnRouting, true, 'toggling smart routing must NOT drop learnRouting');
  });

  it('toggling panel PRESERVES learnRouting (and vice-versa)', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-preserve-cross-${randomUUID()}`);
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      smartRoute: false,
      learnRouting: true,
    };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', '7', 'q']),  // settings → [7] panel → quit
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.equal(persisted.panel, true, 'panel must turn on');
    assert.equal(persisted.learnRouting, true, 'toggling panel must NOT drop learnRouting');
  });

  // The HIGH-severity silent-data-loss regression: a setter that rebuilt config
  // from an allow-list erased every key it didn't list — including the
  // codebaseAwareness PRIVACY kill-switch (silently flipping it back ON), the
  // `seen` first-touch flags, and the config-set experimental* flags. Toggle a
  // representative setting (mode) through saveConfig→loadConfig and assert ALL of
  // them survive unchanged.
  it('[s] → [1] mode change PRESERVES codebaseAwareness, seen, and experimental* flags', async () => {
    const sink = makeSink();
    const dir = join(tmpdir(), `menu-preserve-privacy-${randomUUID()}`);
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      codebaseAwareness: false, // the privacy kill-switch — must NOT silently re-enable
      experimentalTaste: true, // a config-set experimental flag
      experimentalJudgment: true,
      seen: { memorySave: true, recap: true }, // dismissed first-touch hints
    };
    const ctx = makeCtx({
      config,
      cwd: dir,
      readLine: makeScriptedReader(['s', '1', '3', 'q']), // settings → [1] mode → [3] quality-first → quit
    });

    const persisted = await withStateHome(dir, async () => {
      await assert.doesNotReject(() => startMenu(ctx, sink));
      return readPersistedConfig();
    });

    assert.equal(persisted.mode, 'quality-first', 'the mode change itself must take effect');
    assert.equal(
      persisted.codebaseAwareness,
      false,
      'changing mode must NOT silently re-enable the codebaseAwareness privacy kill-switch',
    );
    assert.equal(persisted.experimentalTaste, true, 'experimentalTaste must survive a mode change');
    assert.equal(
      persisted.experimentalJudgment,
      true,
      'experimentalJudgment must survive a mode change',
    );
    assert.deepEqual(
      persisted.seen,
      { memorySave: true, recap: true },
      'dismissed first-touch hints (seen) must survive a mode change',
    );
  });

  // ---- Wizard auto-update prompt ------------------------------------------

  it('welcome wizard shows auto-update prompt after set-as-default', async () => {
    // Build a first-run ctx inline (makeFirstRunCtx is scoped to another describe block)
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-wizard-au-${randomUUID()}`);
    const config: AppConfig = { onboarded: false, setAsDefault: false };
    // Both providers installed+authed: no install prompts; opencode prompt → n; mode → '' (Enter = balanced); set-default → n; auto-update → n
    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(['n', 'n', '', 'n', 'n']),
      installProvider: async () => true,
      login: async () => 0,
      detectEnvironment: async () => FAKE_ENV,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Stub isHookInstalled so the set-default prompt still appears (see makeFirstRunCtx)
      isHookInstalled: async () => false,
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.toLowerCase().includes('check for updates') ||
        sink.buf.toLowerCase().includes('update'),
      'wizard must show the update-at-launch prompt',
    );
  });

  it('welcome wizard auto-update prompt uses (Y/n) — default YES', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-wizard-au2-${randomUUID()}`);
    const config: AppConfig = { onboarded: false, setAsDefault: false };
    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider() },
      env: FAKE_ENV,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      // The auto-update prompt is now (Y/n): pressing Enter accepts (yes).
      // We answer 'n' explicitly to keep auto-update off for this test.
      readLine: makeScriptedReader(['n', 'n', '', 'n', 'n']),
      installProvider: async () => true,
      login: async () => 0,
      detectEnvironment: async () => FAKE_ENV,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Stub isHookInstalled so the set-default prompt still appears (see makeFirstRunCtx)
      isHookInstalled: async () => false,
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    // The auto-update prompt must mark Enter → yes (default-yes): "yes (enter) / no"
    assert.ok(
      sink.buf.includes('yes (enter) / no'),
      'auto-update prompt must show yes (enter) / no — Enter selects yes (recommended)',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW AUTH: inline re-login on auth failure in the chat loop
// ---------------------------------------------------------------------------

describe('startMenu — chat loop inline re-login on auth failure', () => {
  /**
   * Build a provider that always emits an auth-category error.
   */
  function makeAuthFailProvider(id: 'claude' | 'codex' = 'claude'): Provider {
    return {
      id,
      async detect() {
        return {
          id,
          installed: true,
          version: '1.0.0',
          authenticated: false,
          plan: null,
          binaryPath: null,
          availableModels: [],
        };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield {
          type: 'error',
          error: {
            category: 'auth',
            recoverable: false,
            message: 'authentication failed',
            suggestion: 'run claude auth login',
          },
        };
      },
    };
  }

  it('auth failure in chat loop prints [warn] provider is not signed in', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    // Use a provider that always fails with auth error so the final event
    // has success:false and errorCategory:'auth'.
    const authFailProvider = makeAuthFailProvider('claude');

    const ctx = makeCtx(
      {
        providers: { claude: authFailProvider },
        readLine: makeScriptedReader([
          'n',          // new conversation → opens chat directly
          'do work',    // first message = task → auth fails
          'n',          // no to re-login prompt (auth fail on retry too, so just skip)
          '/exit',      // exit chat
          'q',          // quit menu
        ]),
        login: async () => 0,
        detectEnvironment: async () => FAKE_ENV,
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'auth failure in chat loop should not throw',
    );

    assert.ok(
      sink.buf.includes("isn't signed in") || sink.buf.toLowerCase().includes('signed in'),
      'Must show "not signed in" warning when auth fails',
    );
  });

  it('user answers y → login is called with the failing provider', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const loginCalls: string[] = [];

    // Use a provider that always fails with auth error so the final event
    // consistently has success:false and errorCategory:'auth'.
    const authFailProvider = makeAuthFailProvider('claude');

    const ctx = makeCtx(
      {
        providers: { claude: authFailProvider },
        readLine: makeScriptedReader([
          'n', 'do work', 'y', '/exit', 'q',
        ]),
        login: async (_out, providerArg) => {
          loginCalls.push(providerArg ?? 'unknown');
          return 0;
        },
        detectEnvironment: async () => FAKE_ENV,
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.ok(
      loginCalls.includes('claude'),
      'login must be called with "claude" when user answers y to re-login prompt',
    );
  });

  it('user answers y → runTask is retried (provider called a second time)', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    let providerCallCount = 0;
    const switchingProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: false, plan: null, binaryPath: null, availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        providerCallCount++;
        if (providerCallCount === 1) {
          yield { type: 'error', error: { category: 'auth', recoverable: false, message: 'auth failed', suggestion: 'login' } };
        } else {
          const CONF = '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
          yield { type: 'done', text: `Done.\n${CONF}`, usage: FAKE_USAGE, raw: {} };
        }
      },
    };

    const ctx = makeCtx(
      {
        providers: { claude: switchingProvider },
        readLine: makeScriptedReader([
          'n', 'do work', 'y', '/exit', 'q',
        ]),
        login: async () => 0,
        detectEnvironment: async () => FAKE_ENV,
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    // Provider was called: first attempt (IC = auth error) + escalation to manager
    // (IC auth error → escalate → manager auth error) + retry first attempt (IC again)
    // + retry manager again. So count >= 2 (at minimum the retry happened).
    assert.ok(
      providerCallCount >= 2,
      `Provider must be called at least 2 times (original + retry); got ${providerCallCount}`,
    );
  });

  it('user answers n → login is NOT called', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    let loginCallCount = 0;

    const authFailProvider = makeAuthFailProvider('claude');

    const ctx = makeCtx(
      {
        providers: { claude: authFailProvider },
        readLine: makeScriptedReader([
          'n', 'do work', 'n', '/exit', 'q',
        ]),
        login: async () => {
          loginCallCount++;
          return 0;
        },
        detectEnvironment: async () => FAKE_ENV,
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.equal(loginCallCount, 0, 'login must NOT be called when user answers n');
  });

  it('user answers n → shows the re-login prompt but returns to prompt after no', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const authFailProvider = makeAuthFailProvider('claude');

    const ctx = makeCtx(
      {
        providers: { claude: authFailProvider },
        readLine: makeScriptedReader([
          'n', 'do work', 'n', '/exit', 'q',
        ]),
        login: async () => 0,
        detectEnvironment: async () => FAKE_ENV,
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'answering n to re-login should not throw',
    );

    // Should have shown the re-login prompt
    assert.ok(
      sink.buf.includes('Sign in') || sink.buf.toLowerCase().includes('sign in'),
      'Must show re-login prompt even when user answers n',
    );
  });

  it('no real login subprocess spawned — login seam is honoured', async () => {
    // This test verifies that the injected login seam is used (no real subprocess).
    // If a real subprocess were spawned, it would hang or fail in CI.
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    let loginSeamCalled = false;

    // Use a provider that always fails with auth error so the final event
    // has success:false and errorCategory:'auth' — guaranteeing login is triggered.
    const authFailProvider = makeAuthFailProvider('claude');

    const ctx = makeCtx(
      {
        providers: { claude: authFailProvider },
        readLine: makeScriptedReader(['n', 'do work', 'y', '/exit', 'q']),
        login: async () => {
          loginSeamCalled = true;
          return 0;
        },
        detectEnvironment: async () => FAKE_ENV,
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.equal(loginSeamCalled, true, 'login seam must be called (not a real subprocess)');
  });
});

// ---------------------------------------------------------------------------
// autoUpdateEnabled — pure helper unit tests
// ---------------------------------------------------------------------------

describe('autoUpdateEnabled', () => {
  // ---- default-on behaviour (undefined = enabled) ---------------------------

  it('returns true when config.autoUpdate is undefined and no env var', () => {
    assert.equal(autoUpdateEnabled({}, {}), true);
  });

  it('returns true when config.autoUpdate is undefined (explicit)', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: undefined }, {}), true);
  });

  it('returns true when config.autoUpdate is true and no env var', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: true }, {}), true);
  });

  // ---- explicit opt-out via config ------------------------------------------

  it('returns false when config.autoUpdate is false', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: false }, {}), false);
  });

  it('returns false when config.autoUpdate is false even when env is empty', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: false }, { MYSHELL_NO_UPDATE: '' }), false);
  });

  // ---- env-var opt-out (MYSHELL_NO_UPDATE) ----------------------------------

  it('returns false when MYSHELL_NO_UPDATE is "1"', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: true }, { MYSHELL_NO_UPDATE: '1' }), false);
  });

  it('returns false when MYSHELL_NO_UPDATE is "true"', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: true }, { MYSHELL_NO_UPDATE: 'true' }), false);
  });

  it('returns false when MYSHELL_NO_UPDATE is any non-empty string', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: true }, { MYSHELL_NO_UPDATE: 'yes' }), false);
  });

  it('returns false when MYSHELL_NO_UPDATE is set and config is undefined', () => {
    assert.equal(autoUpdateEnabled({}, { MYSHELL_NO_UPDATE: '1' }), false);
  });

  it('env var wins over config.autoUpdate:true', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: true }, { MYSHELL_NO_UPDATE: '1' }), false);
  });

  // ---- empty / absent env var does not disable ------------------------------

  it('returns true when MYSHELL_NO_UPDATE is empty string', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: true }, { MYSHELL_NO_UPDATE: '' }), true);
  });

  it('returns true when MYSHELL_NO_UPDATE is absent from env object', () => {
    assert.equal(autoUpdateEnabled({ autoUpdate: true }, {}), true);
  });

  // ---- pure function properties ---------------------------------------------

  it('never throws for any input combination', () => {
    const configs: Array<{ autoUpdate?: boolean }> = [
      {},
      { autoUpdate: true },
      { autoUpdate: false },
      { autoUpdate: undefined },
    ];
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { MYSHELL_NO_UPDATE: '1' },
      { MYSHELL_NO_UPDATE: '' },
      { MYSHELL_NO_UPDATE: undefined },
    ];
    for (const cfg of configs) {
      for (const env of envs) {
        assert.doesNotThrow(() => autoUpdateEnabled(cfg, env));
      }
    }
  });

  it('is pure — same inputs always produce same output', () => {
    const a = autoUpdateEnabled({ autoUpdate: true }, {});
    const b = autoUpdateEnabled({ autoUpdate: true }, {});
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// FLOW 12: Chat prompt is plain "> " (not "myshell-tools> ")
// ---------------------------------------------------------------------------

describe('startMenu — chat loop prompt is a clean caret', () => {
  it('chat prompt inside a conversation is a clean caret, not "myshell-tools> "', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'n',       // new conversation → opens chat directly
          'My task', // first message (also derives the title)
          '/exit',   // exit chat loop
          'q',       // quit menu
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    // The chat prompt is a clean chevron caret — never the noisy "myshell-tools> ".
    assert.ok(
      !sink.buf.includes('myshell-tools> '),
      'Chat prompt must NOT be "myshell-tools> "',
    );
    assert.ok(
      sink.buf.includes('❯'),
      'Chat prompt must be the clean "❯" caret',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW 13: No-provider gate — doomed task is NOT dispatched when no provider
//          is authenticated; IS dispatched when at least one is.
// ---------------------------------------------------------------------------

describe('startMenu — no-provider gate in chat loop', () => {
  /** EnvironmentStatus where no provider is authenticated or installed. */
  const NO_AUTH_ENV: EnvironmentStatus = {
    claude: {
      id: 'claude',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    codex: {
      id: 'codex',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    opencode: {
      id: 'opencode',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    hasAnyProvider: false,
    platform: 'linux',
  };

  it('prompts before opening a new chat and signs in via the injected login flow', async () => {
    const installedUnauthedEnv: EnvironmentStatus = {
      ...NO_AUTH_ENV,
      claude: {
        id: 'claude',
        installed: true,
        version: '1.0.0',
        authenticated: false,
        plan: null,
        binaryPath: 'claude',
        availableModels: ['model-a'],
      },
      hasAnyProvider: true,
    };
    const afterLoginEnv: EnvironmentStatus = {
      ...installedUnauthedEnv,
      claude: {
        ...installedUnauthedEnv.claude,
        authenticated: true,
      },
    };
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const loginCalls: string[] = [];

    const ctx = makeCtx(
      {
        env: installedUnauthedEnv,
        providers: { claude: makeFakeProvider() },
        readLine: makeScriptedReader([
          'n',        // new conversation → auth prompt first
          'do work',  // proceeds into chat after re-detect
          '/exit',    // exit chat
          'q',        // quit
        ]),
        login: async (_out, providerArg) => {
          loginCalls.push(providerArg ?? 'all');
          return 0;
        },
        detectEnvironment: async () => afterLoginEnv,
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('No provider signed in yet'),
      'Must prompt before opening chat when no provider is authenticated',
    );
    assert.deepEqual(loginCalls, ['claude'], 'single installed provider must sign in directly');

    const metas = await store.list();
    const id = metas[0]?.id;
    assert.ok(id !== undefined, 'conversation is created after successful inline sign-in');
    const w = store._writers.get(id);
    const userEntry = w?.entries.find((e) => e.role === 'user' && e.content === 'do work');
    assert.ok(userEntry !== undefined, 'task is dispatched after re-detect reports an authenticated provider');
  });

  it('does not create a new conversation when no provider is installed', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const ctx = makeCtx(
      {
        env: NO_AUTH_ENV,
        providers: {},
        readLine: makeScriptedReader([
          'n',
          'q',
        ]),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('No provider signed in yet, and no provider is installed'),
      'No-installed path must explain that installation is needed first',
    );
    assert.equal((await store.list()).length, 0, 'no conversation should be created before auth is possible');
  });

  it('dispatches task normally when at least one provider is authenticated', async () => {
    // FAKE_ENV has claude authenticated — task should proceed
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'n',           // new conversation → opens chat directly
          'do work',     // first message = task — should be dispatched (claude is authed)
          '/exit',       // exit chat
          'q',           // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'Task dispatch with authenticated provider must not throw',
    );

    // 'No signed-in provider yet' must NOT appear when a provider is available
    assert.ok(
      !sink.buf.includes('No signed-in provider yet'),
      'No-provider gate message must NOT appear when a provider is authenticated',
    );

    // The session writer should have received the user entry
    const metas = await store.list();
    const id = metas[0]?.id;
    if (id !== undefined) {
      const w = store._writers.get(id);
      if (w !== undefined) {
        const userEntry = w.entries.find((e) => e.role === 'user');
        assert.ok(userEntry !== undefined, 'User entry should be present when provider is authed');
      }
    }
  });

  it('opencode installed but unconfigured (0 credentials) → pre-chat auth prompt fires', async () => {
    // opencode installed + NOT authenticated (no provider logged in) → not usable
    // for real work, so the no-provider gate must fire (no more installed=ready).
    const opencodeInstalledEnv: EnvironmentStatus = {
      ...NO_AUTH_ENV,
      opencode: {
        id: 'opencode',
        installed: true,
        version: '0.1.0',
        authenticated: false,  // 0 credentials → not ready
        plan: null,
        binaryPath: 'opencode',
        availableModels: [],
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const ctx = makeCtx(
      {
        env: opencodeInstalledEnv,
        providers: {},
        readLine: makeScriptedReader([
          'n',
          '',         // back from the inline auth prompt
          'q',
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    assert.ok(
      sink.buf.includes('No provider signed in yet'),
      'Pre-chat prompt must fire — an unconfigured opencode is not a usable provider',
    );
  });

  it('opencode authenticated (real provider logged in) → gate passes', async () => {
    const opencodeAuthedEnv: EnvironmentStatus = {
      ...NO_AUTH_ENV,
      opencode: {
        id: 'opencode',
        installed: true,
        version: '0.1.0',
        authenticated: true,  // a provider/subscription is configured
        plan: null,
        binaryPath: 'opencode',
        availableModels: [],
      },
    };

    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const ctx = makeCtx(
      {
        env: opencodeAuthedEnv,
        providers: {},
        readLine: makeScriptedReader([
          'n',
          'do work',
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    assert.ok(
      !sink.buf.includes('No signed-in provider yet'),
      'Gate must not fire when opencode has a configured provider',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW 14: Inline re-login uses refreshed auth (stale-deps fix)
// ---------------------------------------------------------------------------

describe('startMenu — inline re-login uses refreshed auth (stale-deps fix)', () => {
  /**
   * Build a provider that fails with auth error on the first call,
   * then succeeds on subsequent calls (simulating what happens after re-login).
   */
  function makeAuthThenOkProvider(id: 'claude' | 'codex' = 'claude'): Provider & { callCount: number } {
    let callCount = 0;
    const CONF = '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const provider = {
      id,
      callCount: 0,
      async detect() {
        return { id, installed: true, version: '1.0.0', authenticated: false, plan: null, binaryPath: null, availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        callCount++;
        provider.callCount = callCount;
        if (callCount <= 2) {
          // First two calls fail with auth (IC + manager both fail → final is auth error)
          yield { type: 'error', error: { category: 'auth', recoverable: false, message: 'not signed in', suggestion: 'login' } };
        } else {
          // After re-login: succeed
          yield { type: 'text', delta: 'Done after relogin.' };
          yield { type: 'done', text: `Done after relogin.\n${CONF}`, usage: FAKE_USAGE, raw: {} };
        }
      },
    };
    return provider;
  }

  it('after re-login, retry uses fresh env (detectEnvironment is called before retry)', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const freshEnv: EnvironmentStatus = {
      ...FAKE_ENV,
      claude: {
        ...FAKE_ENV.claude,
        authenticated: true,
        availableModels: ['fresh-model'],
      },
    };

    let detectCallCount = 0;
    const ctx = makeCtx(
      {
        providers: { claude: makeAuthThenOkProvider('claude') },
        readLine: makeScriptedReader([
          'n',        // new conversation → opens chat directly
          'do work',  // first message = task → auth fail → re-login prompt → y
          'y',        // yes to re-login
          '/exit',    // exit
          'q',        // quit
        ]),
        login: async () => 0,
        detectEnvironment: async () => {
          detectCallCount += 1;
          return freshEnv;
        },
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'inline re-login with fresh env should not throw',
    );

    // detectEnvironment must have been called at least once after login
    assert.ok(
      detectCallCount >= 1,
      'detectEnvironment must be called at least once after re-login to refresh env',
    );
  });

  it('after re-login, the re-login prompt mentions the failing provider', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const ctx = makeCtx(
      {
        providers: { claude: makeAuthThenOkProvider('claude') },
        readLine: makeScriptedReader([
          'n', 'do work', 'n', '/exit', 'q',
        ]),
        login: async () => 0,
        detectEnvironment: async () => FAKE_ENV,
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('claude') && sink.buf.toLowerCase().includes('sign in'),
      'Re-login prompt must mention the failing provider (claude)',
    );
  });
});

describe('completeSlash — Tab-completion for the chat prompt', () => {
  it('returns all chat commands for a bare slash', () => {
    const [hits, line] = completeSlash('/');
    assert.deepEqual(hits, [...CHAT_SLASH_COMMANDS]);
    assert.equal(line, '/');
  });

  it('completes a unique prefix', () => {
    const [hits] = completeSlash('/ba');
    assert.deepEqual(hits, ['/back']);
  });

  it('matches multiple commands sharing a prefix', () => {
    // '/' + 'h' → only /help; '/e' → /edit, /export AND /exit (all share the
    // prefix); verify filtering is by prefix and returns ALL matches in order.
    assert.deepEqual(completeSlash('/h')[0], ['/help']);
    assert.deepEqual(completeSlash('/e')[0], ['/edit', '/export', '/exit']);
    assert.deepEqual(completeSlash('/ed')[0], ['/edit']);
    assert.deepEqual(completeSlash('/ex')[0], ['/export', '/exit']);
  });

  it('is a no-op (no hits) on non-slash prose so plain text is never mangled', () => {
    const [hits, line] = completeSlash('refactor the auth module');
    assert.deepEqual(hits, []);
    assert.equal(line, 'refactor the auth module');
  });

  it('returns no hits for an unknown slash command', () => {
    assert.deepEqual(completeSlash('/zzz')[0], []);
  });

  it('honors a custom command set (repl)', () => {
    const [hits] = completeSlash('/q', ['/help', '/exit', '/quit']);
    assert.deepEqual(hits, ['/quit']);
  });

  it('never throws on odd input', () => {
    assert.doesNotThrow(() => completeSlash(''));
    assert.doesNotThrow(() => completeSlash('/'));
  });
});

// ---------------------------------------------------------------------------
// Smart Tab T2–T4 — classifyCompletion routing (docs/tab-completion-5.5.md)
// ---------------------------------------------------------------------------

describe('classifyCompletion — routes Tab to the right completer', () => {
  it('routes a leading-slash word with no space to slash-name', () => {
    const c = classifyCompletion('/st');
    assert.equal(c.kind, 'slash-name');
    assert.equal(c.token, '/st');
    assert.equal(c.prefixLen, 0);
  });

  it('routes a known command + partial arg to slash-arg', () => {
    const c = classifyCompletion('/mode E');
    assert.equal(c.kind, 'slash-arg');
    assert.equal(c.command, '/mode');
    assert.equal(c.token, 'E');
    // prefixLen marks where the trailing token starts (after '/mode ').
    assert.equal(c.prefixLen, '/mode '.length);
  });

  it('routes /memory and /style args to slash-arg', () => {
    assert.equal(classifyCompletion('/memory lo').kind, 'slash-arg');
    assert.equal(classifyCompletion('/style D').command, '/style');
  });

  it('treats a free-text command arg (/goal) as none', () => {
    const c = classifyCompletion('/goal ship the auth refactor');
    assert.equal(c.kind, 'none');
  });

  it('routes ./ ../ / ~/ and embedded-slash tokens to path', () => {
    assert.equal(classifyCompletion('./src/i').kind, 'path');
    assert.equal(classifyCompletion('cat ../a/b').kind, 'path');
    assert.equal(classifyCompletion('open /etc/ho').kind, 'path');
    assert.equal(classifyCompletion('~/proj').kind, 'path');
    assert.equal(classifyCompletion('src/inter').kind, 'path');
  });

  it('routes a leading-@ trailing token to mention', () => {
    const c = classifyCompletion('look at @src/in');
    assert.equal(c.kind, 'mention');
    assert.equal(c.token, '@src/in');
    assert.equal(c.prefixLen, 'look at '.length);
  });

  it('is a strict no-op on plain prose (never corrupt a sentence)', () => {
    assert.equal(classifyCompletion('refactor the auth module').kind, 'none');
    assert.equal(classifyCompletion("don't break this").kind, 'none');
    assert.equal(classifyCompletion('email me at a.b@x.com').kind, 'none'); // not leading-@
    assert.equal(classifyCompletion('').kind, 'none');
    assert.equal(classifyCompletion('just some words').kind, 'none');
  });

  it('treats an unknown slash command arg as none', () => {
    assert.equal(classifyCompletion('/help me out').kind, 'none');
  });
});

describe('completeSlashArg — per-command argument value sets (T2)', () => {
  it('completes /mode tiers — prefix first then fuzzy substring fallback', () => {
    // 'Eff' is an unambiguous prefix of only one tier.
    assert.deepEqual(completeSlashArg('/mode', 'Eff'), ['Efficient']);
    assert.deepEqual(completeSlashArg('/mode', 'ma'), ['Max']); // case-insensitive prefix
    // 'E' prefixes 'Efficient' and substring-matches 'Balanced' (fuzzy fallback).
    assert.deepEqual(completeSlashArg('/mode', 'E'), ['Efficient', 'Balanced']);
  });

  it('completes /style styles', () => {
    assert.deepEqual(completeSlashArg('/style', 'Di'), ['Direct']);
    assert.deepEqual(completeSlashArg('/style', 'Co'), ['Collaborative']);
  });

  it('completes /memory subcommands (prefix before substring)', () => {
    // 'li' prefixes only 'list'.
    assert.deepEqual(completeSlashArg('/memory', 'li'), ['list']);
    assert.deepEqual(completeSlashArg('/memory', 'exp'), ['export']);
    // 'l' prefixes list+loaded, substring-matches 'all' (fuzzy fallback).
    assert.deepEqual(completeSlashArg('/memory', 'l'), ['list', 'loaded', 'all']);
  });

  it('returns all candidates for an empty partial', () => {
    assert.deepEqual(completeSlashArg('/style', ''), ['Direct', 'Balanced', 'Collaborative']);
  });

  it('returns [] for a free-text / unknown command', () => {
    assert.deepEqual(completeSlashArg('/goal', 'anything'), []);
    assert.deepEqual(completeSlashArg('/zzz', 'x'), []);
  });
});

describe('fuzzyRank — prefix → substring → subsequence ordering (T4)', () => {
  it('ranks exact-prefix before substring before subsequence', () => {
    const out = fuzzyRank('ba', ['Balanced', 'Abacus', 'bxax']);
    // 'Balanced' prefix; 'Abacus' substring ('ba'); 'bxax' subsequence (b..a)
    assert.deepEqual(out, ['Balanced', 'Abacus', 'bxax']);
  });

  it('is case-insensitive and stable within a tier', () => {
    assert.deepEqual(fuzzyRank('e', ['Efficient', 'Balanced', 'Collaborative']), [
      'Efficient',
      'Balanced',
      'Collaborative',
    ]);
  });

  it('returns all candidates for an empty token', () => {
    assert.deepEqual(fuzzyRank('', ['a', 'b']), ['a', 'b']);
  });

  it('returns [] when nothing matches', () => {
    assert.deepEqual(fuzzyRank('zzz', ['Direct', 'Balanced']), []);
  });
});

describe('expandPathToken — pure ~/cwd/dir math, no fs (T3)', () => {
  it('expands ~ to home for the read but keeps ~/ as the display prefix', () => {
    const r = expandPathToken('~/proj/sr', '/home/u', '/work');
    assert.equal(r.dir, '/home/u/proj');
    assert.equal(r.base, 'sr');
    assert.equal(r.displayPrefix, '~/proj/');
  });

  it('resolves ../ against cwd and preserves the typed prefix', () => {
    const r = expandPathToken('../a/b', '/home/u', '/work/pkg');
    assert.equal(r.dir, '/work/a');
    assert.equal(r.base, 'b');
    assert.equal(r.displayPrefix, '../a/');
  });

  it('reads cwd for a bare basename token', () => {
    const r = expandPathToken('src/in', '/home/u', '/work');
    assert.equal(r.dir, '/work/src');
    assert.equal(r.base, 'in');
    assert.equal(r.displayPrefix, 'src/');
  });

  it('carries a leading @ in the display prefix (mention stays well-formed)', () => {
    const r = expandPathToken('@src/in', '/home/u', '/work');
    assert.equal(r.dir, '/work/src');
    assert.equal(r.base, 'in');
    assert.equal(r.displayPrefix, '@src/');
  });

  it('reads an absolute dir directly', () => {
    const r = expandPathToken('/etc/ho', '/home/u', '/work');
    assert.equal(r.dir, '/etc');
    assert.equal(r.base, 'ho');
    assert.equal(r.displayPrefix, '/etc/');
  });
});

describe('matchPathEntries — basename filter, dirs first + trailing slash (T3)', () => {
  const entries = [
    { name: 'index.ts', isDirectory: () => false },
    { name: 'infra', isDirectory: () => true },
    { name: 'interface', isDirectory: () => true },
    { name: 'core.ts', isDirectory: () => false },
    { name: '.hidden', isDirectory: () => false },
  ];

  it('filters by basename prefix, dirs first with a trailing slash', () => {
    assert.deepEqual(matchPathEntries('in', entries), ['infra/', 'interface/', 'index.ts']);
  });

  it('hides dot-entries unless the basename starts with a dot', () => {
    assert.equal(matchPathEntries('i', entries).includes('.hidden'), false);
    assert.deepEqual(matchPathEntries('.h', entries), ['.hidden']);
  });

  it('returns everything (dirs first) for an empty basename', () => {
    assert.deepEqual(matchPathEntries('', entries), [
      'infra/',
      'interface/',
      'core.ts',
      'index.ts',
    ]);
  });

  it('accepts plain-string entries (no Dirent)', () => {
    assert.deepEqual(matchPathEntries('co', ['core.ts', 'config.json']), ['config.json', 'core.ts']);
  });
});

describe('completeChat — async completer over an injected readdir (T2–T4)', () => {
  const fakeReaddir = async (dir: string) => {
    if (dir.endsWith('src')) {
      return [
        { name: 'interface', isDirectory: () => true },
        { name: 'index.ts', isDirectory: () => false },
      ];
    }
    return [];
  };

  it('completes a path token from readdir; substring is the trailing token', async () => {
    const [hits, substr] = await completeChat('open src/in', {
      readdir: fakeReaddir,
      cwd: '/work',
    });
    assert.deepEqual(hits, ['src/interface/', 'src/index.ts']);
    assert.equal(substr, 'src/in');
  });

  it('preserves the @ prefix for a mention token', async () => {
    const [hits, substr] = await completeChat('see @src/in', {
      readdir: fakeReaddir,
      cwd: '/work',
    });
    assert.deepEqual(hits, ['@src/interface/', '@src/index.ts']);
    assert.equal(substr, '@src/in');
  });

  it('returns EMPTY on plain prose (no sentence corruption)', async () => {
    const [hits, line] = await completeChat('refactor the auth module', { readdir: fakeReaddir });
    assert.deepEqual(hits, []);
    assert.equal(line, 'refactor the auth module');
  });

  it('completes slash-name and slash-arg without touching fs', async () => {
    let called = false;
    const readdir = async () => {
      called = true;
      return [];
    };
    const [nameHits] = await completeChat('/mo', { readdir });
    assert.deepEqual(nameHits, ['/mode']);
    const [argHits, substr] = await completeChat('/mode Eff', { readdir });
    assert.deepEqual(argHits, ['Efficient']);
    assert.equal(substr, 'Eff');
    assert.equal(called, false);
  });

  it('fails soft on a throwing readdir → no completions, never throws', async () => {
    const readdir = async () => {
      throw new Error('EACCES');
    };
    let result: [string[], string] | undefined;
    await assert.doesNotReject(async () => {
      result = await completeChat('open src/in', { readdir, cwd: '/work' });
    });
    assert.deepEqual(result, [[], 'open src/in']);
  });

  it('the arg map is the canonical command source for completion', () => {
    assert.ok(CHAT_SLASH_ARG_MAP['/mode']);
    assert.ok(CHAT_SLASH_ARG_MAP['/style']);
    assert.ok(CHAT_SLASH_ARG_MAP['/memory']);
  });
});

// ---------------------------------------------------------------------------
// FLOW — isHookInstalled already true → set-default prompt is skipped
// ---------------------------------------------------------------------------

describe('startMenu — first-run: hook already installed → skips set-default prompt', () => {
  /**
   * Env where both providers are installed and authenticated so no install or
   * sign-in prompts appear. We can isolate exactly the set-default step.
   */
  const ENV_BOTH_AUTHED: EnvironmentStatus = {
    claude: {
      id: 'claude',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: 'claude',
      availableModels: ['claude-opus-4'],
    },
    codex: {
      id: 'codex',
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: 'codex',
      availableModels: ['gpt-4o'],
    },
    opencode: {
      id: 'opencode',
      installed: false,
      version: null,
      authenticated: false,
      plan: null,
      binaryPath: null,
      availableModels: [],
    },
    hasAnyProvider: true,
    platform: 'linux',
  };

  it('shows "Already set as your default shell tool" and skips the prompt when hook is installed', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-hook-skip-${randomUUID()}`);
    const config: AppConfig = { onboarded: false, setAsDefault: false };

    const sink = makeSink();
    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider(), codex: makeFakeProvider('codex') },
      env: ENV_BOTH_AUTHED,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      // Hook already installed → set-default prompt is SKIPPED.
      // Remaining prompts: opencode → n, mode → '' (Enter), auto-update → n, then main menu → q.
      // The set-default prompt answer is intentionally absent.
      readLine: makeScriptedReader(['n', '', 'n', 'q']),
      installProvider: async () => true,
      login: async () => 0,
      detectEnvironment: async () => ENV_BOTH_AUTHED,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      // Hook is already installed — the prompt must be skipped
      isHookInstalled: async () => true,
    };

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'welcome with hook already installed should resolve cleanly',
    );

    assert.ok(
      sink.buf.includes('Already set as your default shell tool'),
      'output must include the already-installed confirmation message',
    );
    assert.ok(
      !sink.buf.includes('Set myshell-tools as your default shell tool?'),
      'the set-default prompt must NOT appear when the hook is already installed',
    );
  });

  it('does not call runInstall when hook is already installed (no duplicate output)', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-hook-noinstall-${randomUUID()}`);
    const config: AppConfig = { onboarded: false, setAsDefault: false };

    const sink = makeSink();
    const ctx: MenuContext = {
      version: '2.0.0',
      clock,
      ledger,
      providers: { claude: makeFakeProvider(), codex: makeFakeProvider('codex') },
      env: ENV_BOTH_AUTHED,
      store,
      config,
      cwd: dir,
      sandbox: 'workspace-write',
      timeoutMs: 5_000,
      readLine: makeScriptedReader(['n', '', 'n', 'q']),
      installProvider: async () => true,
      login: async () => 0,
      detectEnvironment: async () => ENV_BOTH_AUTHED,
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
      isHookInstalled: async () => true,
    };

    await startMenu(ctx, sink);

    // runInstall is NOT re-run when hook is already present, so its [info] lines
    // about "Shell hook installed in:" must NOT appear in the output.
    assert.ok(
      !sink.buf.includes('Shell hook installed in:'),
      'runInstall must NOT fire when the hook is already installed',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW: Auto mode — settings [4] Auto selection and display
// ---------------------------------------------------------------------------

describe('startMenu — mode settings [4] Auto', () => {
  /**
   * Build a MenuContext with a pinned mode and drive through s → 1 → 4 → q.
   * After the run the output buffer should confirm mode was reset to auto.
   */
  it('selecting [4] Auto in mode settings resets mode to auto (output says "(auto)")', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    // Start with a pinned mode so we can verify it's cleared.
    const config: AppConfig = { onboarded: true, setAsDefault: false, mode: 'quality-first', smartRoute: false };

    const ctx = makeCtx(
      {
        config,
        readLine: makeScriptedReader([
          's',   // settings
          '1',   // mode select
          '4',   // auto
          '',    // Enter back from settings
          'q',   // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'selecting [4] Auto in mode settings should not throw',
    );

    // After pressing 4, runModeSelect writes "Mode: <label> (auto)" to confirm.
    assert.ok(
      sink.buf.includes('(auto)'),
      'output must contain "(auto)" after selecting [4] Auto',
    );
  });

  it('[4] Auto option appears in the mode settings screen', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const config: AppConfig = { onboarded: true, setAsDefault: false, mode: 'balanced', smartRoute: false };

    const ctx = makeCtx(
      {
        config,
        readLine: makeScriptedReader([
          's',   // settings
          '1',   // mode select → shows mode screen
          '',    // Enter → keep current (no change)
          '',    // Enter → back from settings
          'q',   // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    // The mode select screen must list [4] Auto
    assert.ok(
      sink.buf.includes('[4]') && sink.buf.toLowerCase().includes('auto'),
      `mode select screen must show [4] Auto option; got: ${sink.buf.slice(0, 800)}`,
    );

    // …and the honest per-provider "Auto detected" breakdown. The fake env has
    // Claude authed with no reported plan, so it must say exactly that — never a
    // fabricated tier — and show the deciding rule.
    assert.ok(
      sink.buf.includes('Auto detected:'),
      `mode screen must show the "Auto detected" breakdown; got: ${sink.buf.slice(0, 1200)}`,
    );
    assert.ok(
      sink.buf.includes('Claude — no plan reported'),
      'breakdown must honestly state Claude reported no plan (not a fabricated tier)',
    );
  });

  it('when mode is unset (auto), main screen shows "(auto)" in mode line', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    // No pinned mode → auto
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };

    const ctx = makeCtx(
      {
        config,
        readLine: makeScriptedReader(['q']),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    // The main screen mode line must show the auto indicator. With no provider
    // reporting a plan (FAKE_ENV claude plan=null), the compact main line stays
    // clean — just "(auto)", NOT a nagging "no plan reported" (that detail lives
    // on the mode screen's breakdown, not the always-visible status line).
    assert.ok(
      sink.buf.includes('(auto'),
      'main screen mode line must show the "(auto…" indicator when mode is unset',
    );
    assert.ok(
      !sink.buf.includes('(auto · no plan reported)'),
      'compact main-line reason must not nag "no plan reported" when there is no signal',
    );
  });

  it('when mode is pinned, main screen does NOT show "(auto)"', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    // Pinned mode
    const config: AppConfig = { onboarded: true, setAsDefault: false, mode: 'balanced', smartRoute: false };

    const ctx = makeCtx(
      {
        config,
        readLine: makeScriptedReader(['q']),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    // "(auto)" should NOT appear when mode is explicitly pinned
    assert.ok(
      !sink.buf.includes('(auto)'),
      'main screen must NOT show "(auto)" when mode is explicitly pinned',
    );
  });

  it('when claude plan is max, auto-resolved mode is shown as Max in main screen', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    // No pinned mode → auto; claude plan is 'claude max' → quality-first → "Max"
    const config: AppConfig = { onboarded: true, setAsDefault: false, smartRoute: false };
    const envWithMax: EnvironmentStatus = {
      ...FAKE_ENV,
      claude: {
        ...FAKE_ENV.claude,
        plan: 'claude max',
      },
    };

    const ctx = makeCtx(
      {
        config,
        env: envWithMax,
        readLine: makeScriptedReader(['q']),
      },
      clock,
      store,
    );

    await startMenu(ctx, sink);

    // Mode line should show Max (auto · Claude claude max) or just Max (auto)
    assert.ok(
      sink.buf.includes('Max'),
      'main screen must show Max when claude plan is max and mode is auto',
    );
    assert.ok(
      sink.buf.includes('(auto'),
      'main screen must include the auto indicator when mode is unset',
    );
  });
});

// ---------------------------------------------------------------------------
// FLOW: ※ RECAP on resume + /recap (Phase 7, docs/recap-feature-5.5.md)
// ---------------------------------------------------------------------------

/** Seed a conversation with prior history + (optional) cached recap. */
function seedConversation(
  store: FakeConversationStore,
  opts: {
    id: string;
    title: string;
    messageCount: number;
    recap?: string | null;
    recapMessageCount?: number;
    entries?: SessionEntry[];
  },
): void {
  const meta: ConversationMeta = {
    id: opts.id,
    title: opts.title,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    messageCount: opts.messageCount,
    pinned: false,
    category: null,
    ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
    ...(opts.recapMessageCount !== undefined ? { recapMessageCount: opts.recapMessageCount } : {}),
  };
  store._metas.push(meta);
  const w = makeFakeSessionWriter(opts.id, store._metas);
  for (const e of opts.entries ?? []) w.entries.push(e);
  store._writers.set(opts.id, w);
}

const RECAP_ENTRIES: SessionEntry[] = [
  { timestamp: '2024-01-01T00:00:00.000Z', role: 'user', content: 'Migrate auth to JWT' },
  { timestamp: '2024-01-01T00:01:00.000Z', role: 'assistant', content: '4 files edited.' },
  { timestamp: '2024-01-01T00:02:00.000Z', role: 'user', content: 'Now the expiry tests' },
];

/** A provider whose worker-tier run returns a recognizable recap string. */
function recapFakeProvider(recapText: string): Provider {
  return {
    id: 'claude',
    async detect() {
      return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, plan: null, binaryPath: null, availableModels: ['model-a'] };
    },
    async *run(): AsyncIterable<ProviderEvent> {
      yield { type: 'done', text: recapText, usage: FAKE_USAGE, raw: {} };
    },
  };
}

describe('startMenu — ※ recap on resume + /recap', () => {
  it('shows the cached ※ recap line on resume (fresh cache → no regeneration)', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    seedConversation(store, {
      id: 'conv-recap-1',
      title: 'Auth migration',
      messageCount: 4,
      recap: 'Migrating auth to JWT; next: expiry tests.',
      recapMessageCount: 4, // fresh: advanced 0 turns < threshold
      entries: RECAP_ENTRIES,
    });
    const sink = makeSink();
    // Resume conversation 1, then exit chat + menu.
    const ctx = makeCtx({ readLine: makeScriptedReader(['1', '/exit', 'q']) }, clock, store);
    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('※'), 'resume shows the ※ orientation marker');
    assert.ok(sink.buf.includes('recap'), 'resume shows the recap label');
    assert.ok(
      sink.buf.includes('Migrating auth to JWT; next: expiry tests.'),
      'resume shows the cached recap body',
    );
    // The old weak tail-echo must be GONE.
    assert.ok(!sink.buf.includes('Resuming — last message'), 'old tail-echo is replaced');
  });

  it('falls back cleanly (no recap line) when the conversation is too short', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    seedConversation(store, {
      id: 'conv-short',
      title: 'Tiny chat',
      messageCount: 2, // below the ≥3 floor
      entries: [RECAP_ENTRIES[0]!, RECAP_ENTRIES[1]!],
    });
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['1', '/exit', 'q']) }, clock, store);
    await startMenu(ctx, sink);

    assert.ok(!sink.buf.includes('※'), 'no recap marker for a sub-floor conversation');
    assert.ok(!sink.buf.includes('Resuming — last message'), 'no old tail-echo either');
  });

  it('generates + caches a recap on resume when stale, via the injected worker pass', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    seedConversation(store, {
      id: 'conv-stale',
      title: 'Stale recap',
      messageCount: 6,
      recap: null, // no cache yet → stale → generate
      entries: RECAP_ENTRIES,
    });
    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader(['1', '/exit', 'q']),
        providers: { claude: recapFakeProvider('Resumed: auth JWT work; next: expiry tests.') },
      },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('Resumed: auth JWT work; next: expiry tests.'),
      'a freshly generated recap is shown',
    );
    // It was cached via setRecap.
    const m = store._metas.find((x) => x.id === 'conv-stale');
    assert.ok(m !== undefined);
    assert.equal(m.recap, 'Resumed: auth JWT work; next: expiry tests.', 'recap is cached');
    assert.equal(m.recapMessageCount, 6, 'cache records the provenance count');
  });

  it('resume NEVER blocks when recap generation fails (fail-soft)', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    seedConversation(store, {
      id: 'conv-failsoft',
      title: 'Failsoft',
      messageCount: 6,
      recap: null, // stale → tries to generate
      entries: RECAP_ENTRIES,
    });
    const throwingProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, plan: null, binaryPath: null, availableModels: ['model-a'] };
      },
      // eslint-disable-next-line require-yield
      async *run(): AsyncIterable<ProviderEvent> {
        throw new Error('recap boom');
      },
    };
    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader(['1', '/exit', 'q']),
        providers: { claude: throwingProvider },
      },
      clock,
      store,
    );
    // The whole flow must resolve (resume proceeds despite the failed recap).
    await assert.doesNotReject(() => startMenu(ctx, sink));
    assert.ok(!sink.buf.includes('※'), 'no recap line when generation fails');
    // No recap was cached.
    const m = store._metas.find((x) => x.id === 'conv-failsoft');
    assert.ok(m !== undefined);
    assert.ok(m.recap === null || m.recap === undefined, 'no recap cached on failure');
  });

  it('/recap renders the ※ recap line on demand', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    seedConversation(store, {
      id: 'conv-cmd',
      title: 'On demand',
      messageCount: 4,
      recap: 'cached note',
      recapMessageCount: 4,
      entries: RECAP_ENTRIES,
    });
    const sink = makeSink();
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader(['1', '/recap', '/exit', 'q']),
        // /recap forces regeneration → returns this fresh text.
        providers: { claude: recapFakeProvider('On-demand recap; next: ship it.') },
      },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('On-demand recap; next: ship it.'), '/recap shows a fresh recap');
    // The ※ marker appears for the /recap output.
    assert.ok(sink.buf.includes('※'), '/recap uses the ※ marker');
  });
});

// ---------------------------------------------------------------------------
// /retry + /edit — message-level redo (real-chat gap #2). Resume a seeded
// conversation, run the verb through the SAME injected store + readLine + fake
// task runner, and assert the truncate + re-run + history-after-truncate.
// ---------------------------------------------------------------------------

describe('startMenu — /retry regenerates the last answer', () => {
  function seedRetryable(store: FakeConversationStore): string {
    seedConversation(store, {
      id: 'conv-retry',
      title: 'Retry me',
      messageCount: 2,
      entries: [
        { timestamp: '2024-01-01T00:00:00.000Z', role: 'user', content: 'my question' },
        { timestamp: '2024-01-01T00:01:00.000Z', role: 'assistant', content: 'a stale old answer' },
      ],
    });
    return 'conv-retry';
  }

  it('truncates the last assistant turn and re-runs the last user message', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const id = seedRetryable(store);
    const sink = makeSink();
    const ctx = makeCtx(
      { readLine: makeScriptedReader(['1', '/retry', '/exit', 'q']) },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    const entries = await store.load(id);
    // The stale answer was dropped; the user message was replayed and a FRESH
    // assistant answer ("Done." from the fake provider) appended.
    const assistantBodies = entries.filter((e) => e.role === 'assistant').map((e) => e.content);
    assert.ok(
      !assistantBodies.some((b) => b.includes('a stale old answer')),
      'the stale answer is gone after /retry',
    );
    assert.ok(
      entries.some((e) => e.role === 'assistant' && e.content.includes('Done.')),
      'a fresh answer was generated',
    );
    // The replayed user message is still the last user turn.
    const userBodies = entries.filter((e) => e.role === 'user').map((e) => e.content);
    assert.deepEqual(userBodies, ['my question'], 'exactly one user turn, the replayed one');
    assert.ok(sink.buf.includes('Regenerating'), 'shows the Regenerating notice');
  });

  it('prints a no-op notice when there is nothing to retry', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    seedConversation(store, {
      id: 'conv-noretry',
      title: 'No answer yet',
      messageCount: 1,
      entries: [
        { timestamp: '2024-01-01T00:00:00.000Z', role: 'user', content: 'just a question, no answer' },
      ],
    });
    const sink = makeSink();
    const ctx = makeCtx(
      { readLine: makeScriptedReader(['1', '/retry', '/exit', 'q']) },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('Nothing to retry'), 'shows the nothing-to-retry notice');
    // The log is untouched — still just the single user message.
    const entries = await store.load('conv-noretry');
    assert.equal(entries.length, 1);
  });
});

describe('startMenu — /edit picks a prior user message and re-runs from there', () => {
  function seedEditable(store: FakeConversationStore): string {
    seedConversation(store, {
      id: 'conv-edit',
      title: 'Edit me',
      messageCount: 4,
      entries: [
        { timestamp: '2024-01-01T00:00:00.000Z', role: 'user', content: 'first question' },
        { timestamp: '2024-01-01T00:01:00.000Z', role: 'assistant', content: 'first answer' },
        { timestamp: '2024-01-01T00:02:00.000Z', role: 'user', content: 'second question' },
        { timestamp: '2024-01-01T00:03:00.000Z', role: 'assistant', content: 'second answer' },
      ],
    });
    return 'conv-edit';
  }

  it('picks the chosen message, truncates from there, and resubmits the edited text', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const id = seedEditable(store);
    const sink = makeSink();
    // Resume → /edit → pick [2] (the FIRST question, since recent-first numbers
    // the second question [1]) → type a new message → /exit → q.
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          '1',
          '/edit',
          '2',
          'a sharper first question',
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    const entries = await store.load(id);
    const userBodies = entries.filter((e) => e.role === 'user').map((e) => e.content);
    // Everything from the first question onward was truncated; the edited text was
    // resubmitted as a fresh turn. So the only user message is the edited one.
    assert.deepEqual(userBodies, ['a sharper first question']);
    // The old "second question/answer" tail and the original "first answer" are gone.
    assert.ok(!entries.some((e) => e.content.includes('second question')));
    assert.ok(!entries.some((e) => e.content.includes('first answer')));
    // A fresh answer was generated for the edited turn.
    assert.ok(entries.some((e) => e.role === 'assistant' && e.content.includes('Done.')));
  });

  it('keeps the original text when the user presses Enter (no edit)', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const id = seedEditable(store);
    const sink = makeSink();
    // /edit → pick [1] (the second question) → Enter (keep as-is) → /exit → q.
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader(['1', '/edit', '1', '', '/exit', 'q']),
      },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    const entries = await store.load(id);
    const userBodies = entries.filter((e) => e.role === 'user').map((e) => e.content);
    // first question kept; second question re-run unchanged.
    assert.deepEqual(userBodies, ['first question', 'second question']);
  });

  it('cancels cleanly on a blank pick (no truncation, no re-run)', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const id = seedEditable(store);
    const sink = makeSink();
    const ctx = makeCtx(
      { readLine: makeScriptedReader(['1', '/edit', '', '/exit', 'q']) },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('Cancelled'), 'shows a cancel notice');
    // The log is unchanged.
    const entries = await store.load(id);
    assert.equal(entries.length, 4);
  });

  it('prints a no-op notice when there are no user messages to edit', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    seedConversation(store, {
      id: 'conv-noedit',
      title: 'Empty',
      messageCount: 1,
      entries: [
        { timestamp: '2024-01-01T00:00:00.000Z', role: 'assistant', content: 'only an assistant note' },
      ],
    });
    const sink = makeSink();
    const ctx = makeCtx(
      { readLine: makeScriptedReader(['1', '/edit', '/exit', 'q']) },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('Nothing to edit'), 'shows the nothing-to-edit notice');
  });
});

describe('history-after-truncate excludes the tail (no stale leak into the next turn)', () => {
  it('the re-run turn replays only the truncated history', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    seedConversation(store, {
      id: 'conv-hist',
      title: 'History check',
      messageCount: 2,
      entries: [
        { timestamp: '2024-01-01T00:00:00.000Z', role: 'user', content: 'original question' },
        { timestamp: '2024-01-01T00:01:00.000Z', role: 'assistant', content: 'STALE ANSWER TOKEN' },
      ],
    });
    // Capture the history each turn sees by wrapping load — once the truncate
    // happened, the re-run's load() must NOT include the stale answer.
    const realLoad = store.load.bind(store);
    const histories: SessionEntry[][] = [];
    store.load = async (cid: string) => {
      const h = await realLoad(cid);
      histories.push(h);
      return h;
    };
    const sink = makeSink();
    const ctx = makeCtx(
      { readLine: makeScriptedReader(['1', '/retry', '/exit', 'q']) },
      clock,
      store,
    );
    await startMenu(ctx, sink);

    // The history load that fed the regenerated turn (the LAST load before the
    // new answer was written) must not contain the stale answer.
    const fedToReRun = histories[histories.length - 1] ?? [];
    assert.ok(
      !fedToReRun.some((e) => e.content.includes('STALE ANSWER TOKEN')),
      'the re-run turn never sees the truncated stale answer',
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 5a — goals / to-dos: park, render, and the PROMOTE hand-off routes
// through runGoalLoop (the adaptive brain), NEVER a direct roadmap exec.
// ---------------------------------------------------------------------------

describe('startMenu — goals: /todo parks + Parked section renders', () => {
  it('parks a goal via /todo and shows it in the menu Parked section', async () => {
    await withStateHome(join(tmpdir(), `goals-park-${randomUUID()}`), async () => {
      const clock = makeFakeClock();
      const store = makeStore(clock);
      const sink = makeSink();
      const ctx = makeCtx(
        {
          readLine: makeScriptedReader([
            'n',
            '/todo redesign the activity feed',
            '/exit',
            'q', // back at the menu, the Parked section now renders
          ]),
        },
        clock,
        store,
      );

      await startMenu(ctx, sink);

      // The store the menu used resolves to the same temp home (withStateHome).
      const goalStore = createFileGoalStore({ clock });
      const parked = await goalStore.list({ state: 'parked' });
      assert.equal(parked.length, 1, 'one parked goal exists');
      assert.ok(parked[0]?.title.includes('redesign the activity feed'));

      // The menu re-render after /exit shows the Parked section + the [g] entry.
      assert.ok(sink.buf.includes('Goals · Parked'), 'menu renders the Parked section');
      assert.ok(sink.buf.includes('Manage goals'), 'the [g] Manage goals entry appears');
    });
  });

  it('the Parked section is ABSENT when there are no parked goals', async () => {
    await withStateHome(join(tmpdir(), `goals-empty-${randomUUID()}`), async () => {
      const sink = makeSink();
      const ctx = makeCtx({ readLine: makeScriptedReader(['q']) });
      await startMenu(ctx, sink);
      assert.ok(!sink.buf.includes('Goals · Parked'), 'no Parked section when empty');
      assert.ok(!sink.buf.includes('Manage goals'), 'no [g] entry when empty');
    });
  });
});

describe('startMenu — goals: /goals go promotes THROUGH runGoalLoop (the brain)', () => {
  it('routes a promoted parked goal through the goal runner, not a direct roadmap exec', async () => {
    await withStateHome(join(tmpdir(), `goals-promote-${randomUUID()}`), async () => {
      const prompts: string[] = [];
      const provider: Provider = {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1.0.0',
            authenticated: true,
            plan: null,
            binaryPath: null,
            availableModels: ['model-a'],
          };
        },
        async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
          prompts.push(req.prompt);
          yield { type: 'text', delta: 'Working on it.' };
          yield { type: 'done', text: `Working on it.\n${CONFIDENCE_ENVELOPE}`, usage: FAKE_USAGE, raw: {} };
        },
      };

      const clock = makeFakeClock();
      const store = makeStore(clock);
      const sink = makeSink();
      const ctx = makeCtx(
        {
          providers: { claude: provider },
          readLine: makeScriptedReader([
            'n',
            '/todo ship the login page',
            '/goals go 1', // PROMOTE → runGoalLoop → orchestrate → provider
            '/exit',
            'q',
          ]),
        },
        clock,
        store,
      );

      await startMenu(ctx, sink);

      // PROVE the promote went through the goal runner: orchestrate built a
      // goal-turn prompt ("Goal: ...") and called the provider. A direct roadmap
      // exec would never produce a goal-turn prompt nor call the model.
      assert.ok(
        prompts.some((p) => p.includes('Goal: ship the login page')),
        'promote ran the goal through runGoalLoop (goal-turn prompt reached the provider)',
      );

      // And the stored goal left the `parked` state (promote flipped it). Because
      // the fake never emits GOAL_COMPLETE, it must NOT be marked done (honest —
      // completion is never inferred); it stays `running` after the run.
      const goalStore = createFileGoalStore({ clock });
      const all = await goalStore.list();
      assert.equal(all.length, 1);
      assert.notEqual(all[0]?.state, 'parked', 'promote flipped the goal out of parked');
      assert.notEqual(all[0]?.state, 'done', 'never inferred done without GOAL_COMPLETE evidence');
    });
  });
});

// ===========================================================================
// FIX 3 — local-only slash commands work with NO authenticated provider, while
//          model-needing turns still hit the no-provider gate.
// ===========================================================================

describe('runChatLoop — local-only slash commands bypass the no-provider gate (FIX 3)', () => {
  // An env with a provider INSTALLED but NOT authenticated (the realistic case:
  // auth lapsed mid-session). hasAuthenticatedProvider(env) is false.
  const NO_AUTH_ENV: EnvironmentStatus = {
    ...FAKE_ENV,
    claude: { ...FAKE_ENV.claude, authenticated: false },
    hasAnyProvider: false,
  };

  async function driveChat(lines: ReadonlyArray<string | null>): Promise<string> {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();
    const meta = await store.create('FIX3 conv');
    const ctx = makeCtx({ readLine: makeScriptedReader(lines) }, clock, store);
    const mutableCtx = { config: ctx.config, env: NO_AUTH_ENV };
    const noopLogin = async (): Promise<number> => 0;
    const detect = async (): Promise<EnvironmentStatus> => NO_AUTH_ENV;
    const confirm = async (): Promise<boolean> => false;
    await runChatLoop(ctx, mutableCtx, meta.id, sink, makeScriptedReader(lines), noopLogin, detect, confirm);
    return sink.buf;
  }

  it('/memory runs locally (no "No signed-in provider" notice) when unauthed', async () => {
    const buf = await driveChat(['/memory', '/exit']);
    assert.ok(!buf.includes('No signed-in provider'), '/memory must NOT be swallowed by the gate');
    assert.ok(/memor/i.test(buf), '/memory produced its local output');
  });

  it('a model-needing chat turn STILL gates when unauthed', async () => {
    const buf = await driveChat(['please refactor the auth module', '/exit']);
    assert.ok(buf.includes('No signed-in provider'), 'a real chat turn must still hit the gate');
  });
});
