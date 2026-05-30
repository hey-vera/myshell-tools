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

import { startMenu, defaultAliasHint } from '../../src/interface/menu.ts';
import type { MenuContext } from '../../src/interface/menu.ts';
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

function makeFakeSessionWriter(id: string): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    entries,
    async append(entry: SessionEntry): Promise<void> {
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
        w = makeFakeSessionWriter(id);
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
  hasAnyProvider: true,
  platform: 'linux',
};

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

  const config: AppConfig = { onboarded: true, setAsDefault: false };

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

  it('startMenu resolves (not hangs)', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['q']) });

    const p = startMenu(ctx, sink);
    await assert.doesNotReject(p);
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
    // After creating the conversation, we send a real task before /exit.
    // The inputs are: 'n' (new conv) → 'My first task' (title) →
    //   'do this task' (the actual task sent to orchestrate) → '/exit' → 'q'.
    await run(['n', 'My first task', 'do this task', '/exit', 'q']);
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
          '',   // Enter to go back
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
  ): MenuContext {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ledger = makeFakeLedger();
    const dir = join(tmpdir(), `menu-flow-first-${randomUUID()}`);

    const config: AppConfig = { onboarded: false, setAsDefault: false };

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
    };
  }

  it('resolves cleanly when user answers n to install and n to default shell', async () => {
    const sink = makeSink();
    // claude missing → install prompt → n (skip)
    // codex missing sign-in prompt → none (codex is authed in FAKE_ENV_CLAUDE_MISSING)
    // mode/continue → '' (Enter)
    // default shell → n
    const ctx = makeFirstRunCtx(['n', '', 'n']);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'welcome flow with install-skip should resolve cleanly',
    );
  });

  it('shows the install prompt for the missing provider', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', '', 'n']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('Install claude'),
      'install prompt for "claude" must appear in output',
    );
  });

  it('shows the package name in the install prompt', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', '', 'n']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('@anthropic-ai/claude-code'),
      'install prompt must mention the @anthropic-ai/claude-code package',
    );
  });

  it('shows skip message with manual command when user answers n', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', '', 'n']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('npm install -g @anthropic-ai/claude-code'),
      'skipping install must print the manual install command',
    );
  });

  it('does NOT show codex install prompt when codex is installed', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', '', 'n']);

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
    const ctx = makeFirstRunCtx(['n', '', 'n', 'q']);

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
    const ctx = makeFirstRunCtx(['n', '', 'n']);

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
      hasAnyProvider: true,
      platform: 'linux',
    };

    // No install prompts (both installed); sign-in prompts for both → answer n to avoid spawn
    // Then mode/continue → '' (Enter); default shell → n
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n'], envBothUnauthenticated);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'should handle sign-in prompts for unauthenticated providers without throwing',
    );

    assert.ok(
      sink.buf.toLowerCase().includes('sign in'),
      'sign-in prompt must appear for unauthenticated providers',
    );
  });
});
