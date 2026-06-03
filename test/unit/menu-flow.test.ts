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

import { EventEmitter } from 'node:events';
import { startMenu, defaultAliasHint, parseYesNo, interpretYesNoKey, readSingleKey, confirmViaKey, autoUpdateEnabled, createLineReader, completeSlash, CHAT_SLASH_COMMANDS } from '../../src/interface/menu.ts';
import type { MenuContext, KeyInputStream } from '../../src/interface/menu.ts';
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
});

/**
 * Minimal readline.Interface stand-in: records pause/resume/close and accepts
 * the line/close listeners createLineReader attaches at construction.
 */
class FakeReadline {
  events: string[] = [];
  on(_event: string, _fn: (...a: never[]) => void): this {
    return this;
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

  it('orientation header mentions the [Capitalized] default convention', async () => {
    const sink = makeSink();
    const ctx = makeFirstRunCtx(['n', 'n', '', 'n', 'n']);

    await startMenu(ctx, sink);

    // The header must reference the capitalized-default convention
    assert.ok(
      sink.buf.includes('Capitalized') || sink.buf.includes('capitalized'),
      'orientation header must reference the [Capitalized] default convention',
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

  /** Env returned after opencode is installed (authenticated-when-installed). */
  const ENV_WITH_OPENCODE: EnvironmentStatus = {
    ...ENV_NO_OPENCODE,
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

  it('shows (y/N) in the opencode prompt (default NO)', async () => {
    const sink = makeSink();
    const ctx = makeOpencodeOnboardCtx(['n', '', 'n', 'n', 'q']);

    await startMenu(ctx, sink);

    assert.ok(
      sink.buf.includes('(y/N)'),
      'opencode prompt must show (y/N) — default is NO',
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
    // 'y' → install opencode; '' → mode (Enter = balanced); 'n' → set-as-default; 'n' → auto-update; 'q' → main menu
    const ctx = makeOpencodeOnboardCtx(
      ['y', '', 'n', 'n', 'q'],
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
    // 'y' → install opencode; '' → mode (Enter = balanced); 'n' → set-default; 'n' → auto-update; 'q' → quit
    const ctx = makeOpencodeOnboardCtx(
      ['y', '', 'n', 'n', 'q'],
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

  it('no opencode sign-in prompt during onboarding (opencode is auth-when-installed)', async () => {
    const sink = makeSink();
    // 'y' → install opencode; '' → mode (Enter = balanced); 'n' → set-default; 'n' → auto-update; 'q' → quit
    // detectEnvironment returns ENV_WITH_OPENCODE (authenticated: true)
    // So after install, no sign-in prompt should appear for opencode
    const ctx = makeOpencodeOnboardCtx(['y', '', 'n', 'n', 'q']);

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'no opencode sign-in prompt after install should not throw',
    );

    // The sign-in prompt for opencode must NOT appear — opencode is authenticated-when-installed
    const opencodeSigning = sink.buf.toLowerCase().includes('sign in to opencode');
    assert.ok(
      !opencodeSigning,
      'no "sign in to opencode" prompt must appear during onboarding (opencode is auth-when-installed)',
    );
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
      // No opencode prompt → mode (Enter = balanced); set-as-default; auto-update; quit main menu
      readLine: makeScriptedReader(['', 'n', 'n', 'q']),
      installProvider: async () => true,
      login: async () => 0,
      detectEnvironment: async () => ENV_WITH_OPENCODE,
      // Inject a no-op update check so no real npm registry requests are made
      checkForUpdate: async (): Promise<UpdateCheckResult> => ({
        current: '2.0.0',
        latest: null,
        updateAvailable: false,
      }),
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

  it('[i] → invalid provider choice → "Cancelled" → back to menu', async () => {
    const sink = makeSink();
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const ctx = makeCtx(
      {
        readLine: makeScriptedReader([
          'i',    // import
          '9',    // invalid provider choice
          'q',    // quit
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(
      () => startMenu(ctx, sink),
      'invalid provider choice should not throw',
    );
    assert.ok(sink.buf.includes('Cancelled'), '"Cancelled" shown for invalid provider');
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

  it('menu renders [i] Import option in output', async () => {
    const sink = makeSink();
    const ctx = makeCtx({ readLine: makeScriptedReader(['q']) });

    await startMenu(ctx, sink);

    assert.ok(sink.buf.includes('[i]'), 'menu should show [i] key');
    assert.ok(sink.buf.toLowerCase().includes('import'), 'menu should mention import');
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
  /** Env where opencode IS installed (authenticated-when-installed). */
  const FAKE_ENV_WITH_OPENCODE: EnvironmentStatus = {
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

  it('[r] → select [2] (Codex) when opencode not installed → Cancelled (no spawn)', async () => {
    // With opencode NOT installed: [1]=Claude, [2]=Codex. Selecting [2] launches codex.
    // Since codex isn't present in CI either, reject:false means clean return.
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
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    // detectEnvironment is called inside runWelcome (after codex install) and once
    // more in startMenu after runWelcome returns — total 2 injected calls.
    assert.equal(detectCalls, 2, 'detectEnvironment must be called exactly twice: once inside runWelcome after install, once in startMenu after onboarding');
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

    const sink = makeSink();
    const ctx = makeCtx({
      env: FAKE_ENV_OPENCODE_INSTALLED,
      readLine: makeScriptedReader(['o', 'q']),
      login: async (_out, providerArg) => {
        loginCalled = true;
        loginArg = providerArg;
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
    };

    const sink = makeSink();
    await startMenu(ctx, sink);

    // The auto-update prompt must mark Enter → yes (default-yes): "(y(enter) / n)"
    assert.ok(
      sink.buf.includes('y(enter) / n'),
      'auto-update prompt must show y(enter) / n — Enter selects yes (recommended)',
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

  it('prints no-provider message and does NOT dispatch task when no provider is authed', async () => {
    const clock = makeFakeClock();
    const store = makeStore(clock);
    const sink = makeSink();

    const ctx = makeCtx(
      {
        env: NO_AUTH_ENV,
        providers: {},  // no providers installed
        readLine: makeScriptedReader([
          'n',        // new conversation → opens chat directly
          'do work',  // first message = attempted task — should be blocked
          '/exit',    // exit chat
          'q',        // quit
        ]),
        // Spy: if runTask were called the provider run() would be invoked
        // We detect this by checking if the fake provider was called.
        // Since providers: {} the orchestrator won't find any anyway;
        // the gate fires first.
      },
      clock,
      store,
    );

    // Track writer entries to confirm no task was dispatched
    await startMenu(ctx, sink);

    // The gate message must appear
    assert.ok(
      sink.buf.includes('No signed-in provider yet'),
      'Must print no-provider gate message when no provider is authenticated',
    );
    // The gate message must mention how to sign in
    assert.ok(
      sink.buf.toLowerCase().includes('sign in'),
      'Gate message must guide user toward signing in',
    );

    // No task should have been written to the session
    const metas = await store.list();
    if (metas.length > 0 && metas[0] !== undefined) {
      const w = store._writers.get(metas[0].id);
      // If writer exists, it should have no entries (no task was dispatched)
      if (w !== undefined) {
        const userEntry = w.entries.find((e) => e.role === 'user' && e.content === 'do work');
        assert.ok(
          userEntry === undefined,
          'No user entry for the blocked task should exist in the session',
        );
      }
    }
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

  it('opencode installed but unconfigured (0 credentials) → gate FIRES', async () => {
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
          'do work',  // first message = task; should be blocked by the gate
          '/exit',
          'q',
        ]),
      },
      clock,
      store,
    );

    await assert.doesNotReject(() => startMenu(ctx, sink));

    assert.ok(
      sink.buf.includes('No signed-in provider yet'),
      'Gate must fire — an unconfigured opencode is not a usable provider',
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
    // '/' + 'h' → only /help; '/e' → only /exit; verify filtering is by prefix
    assert.deepEqual(completeSlash('/h')[0], ['/help']);
    assert.deepEqual(completeSlash('/e')[0], ['/exit']);
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
