/**
 * test/ui/chat-loop-integration.test.tsx — STEP 5 end-to-end integration:
 * drive the REAL conversation loop (`runChatLoop`) through the EXACT Ink
 * adapters that `startMenu` wires when MYSHELL_INK is on, and prove a chat turn
 * renders end-to-end via Ink.
 *
 * It builds the SAME seams startMenu builds for the flag-on path:
 *   - input  via the Ink LineReader (`createInkLineReader`),
 *   - output via the Ink OutputSink (`createInkOutputSink`),
 *   - turns  via an `inkRenderTurn` that folds CoreEvents through the pure
 *     reducer (the `createTurnDriver` shape) and pushes each snapshot to the
 *     bridge — i.e. `renderStreamInk`, the Ink turn driver.
 * A fake provider supplies the CoreEvent stream (no real model). We then assert
 * the orchestrated answer is committed to the Ink transcript and that the
 * StatusBlock's reducer state reflects the turn's tokens.
 *
 * Runs under `npm run test:ui` (tsx) because it imports the .tsx Ink modules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { runChatLoop } from '../../src/interface/menu.js';
import type { MenuContext } from '../../src/interface/menu.js';
import type { TurnRenderer } from '../../src/interface/run.js';
import { createInkAppBridge } from '../../src/interface/ui/App.js';
import {
  createInkOutputSink,
  createInkLineReader,
  createInkStore,
  createTurnDriver,
} from '../../src/interface/ui/mount.js';
import {
  initialState,
  type UiState,
} from '../../src/interface/ui/index.js';
import type { Clock, LedgerWriter, SessionEntry, SessionWriter } from '../../src/core/types.js';
import type { ConversationMeta, ConversationStore } from '../../src/infra/conversation-store.js';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.js';
import type { EnvironmentStatus } from '../../src/providers/detect.js';
import type { AppConfig } from '../../src/infra/config.js';

// ---------------------------------------------------------------------------
// Minimal hermetic fakes (mirrors test/unit/menu-flow.test.ts, compacted)
// ---------------------------------------------------------------------------

function makeClock(): Clock {
  let n = 0;
  const base = 1_700_000_000_000;
  return { now: () => base, isoNow: () => new Date(base).toISOString(), uuid: () => `fake-${++n}`, random: () => 0.5 };
}

const CONFIDENCE_ENVELOPE =
  '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
const FAKE_USAGE: Usage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 };

function makeFakeProvider(answer: string): Provider {
  const events: ProviderEvent[] = [
    { type: 'text', delta: answer },
    { type: 'done', text: `${answer}\n${CONFIDENCE_ENVELOPE}`, usage: FAKE_USAGE, raw: {} },
  ];
  return {
    id: 'claude',
    async detect() {
      return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, plan: null, binaryPath: null, availableModels: ['model-a'] };
    },
    async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    },
  };
}

function makeStore(clock: Clock): ConversationStore {
  const metas: ConversationMeta[] = [];
  const writers = new Map<string, SessionWriter & { entries: SessionEntry[] }>();
  return {
    async list() {
      return [...metas].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async create(title: string) {
      const iso = clock.isoNow();
      const meta: ConversationMeta = { id: clock.uuid(), title, createdAt: iso, updatedAt: iso, messageCount: 0, pinned: false, category: null };
      metas.push(meta);
      return meta;
    },
    async load(id: string) {
      const w = writers.get(id);
      return w ? [...w.entries] : [];
    },
    async rename(id, title) {
      const i = metas.findIndex((m) => m.id === id);
      if (i >= 0) { const m = metas[i]; if (m) metas[i] = { ...m, title }; }
    },
    async remove(id) {
      const i = metas.findIndex((m) => m.id === id);
      if (i >= 0) metas.splice(i, 1);
    },
    writer(id) {
      let w = writers.get(id);
      if (!w) { const e: SessionEntry[] = []; w = { id, entries: e, async append(entry) { e.push(entry); } }; writers.set(id, w); }
      return w;
    },
    async setPinned() {},
    async setCategory() {},
    async setRecap() {},
    async truncateAfter() { return 0; },
  };
}

const FAKE_ENV: EnvironmentStatus = {
  claude: { id: 'claude', installed: true, version: '1.0.0', authenticated: true, plan: null, binaryPath: null, availableModels: ['model-a'] },
  codex: { id: 'codex', installed: false, version: null, authenticated: false, plan: null, binaryPath: null, availableModels: [] },
  opencode: { id: 'opencode', installed: false, version: null, authenticated: false, plan: null, binaryPath: null, availableModels: [] },
  hasAnyProvider: true,
  platform: 'linux',
};

function makeLedger(): LedgerWriter {
  return { async record() {} };
}

// ---------------------------------------------------------------------------
// Build the Ink adapters EXACTLY as startMenu's flag-on path does.
// ---------------------------------------------------------------------------

/** Wrap the PRODUCTION createTurnDriver (persistent InkStore) as a TurnRenderer
 *  so the test exercises the exact flag-on path startMenu wires — ONE persistent
 *  state spanning chrome + turns, never a per-turn fold. */
function makeInkTurn(
  store: ReturnType<typeof createInkStore>,
  onState: (s: UiState) => void,
): TurnRenderer {
  const drive = createTurnDriver(store, { color: false, isTty: true });
  return (events, _sink, verbosity) => {
    const p = drive(events, { verbosity });
    onState(store.getState());
    return p.then((r) => { onState(store.getState()); return r; });
  };
}

function makeCtx(store: ConversationStore, clock: Clock, answer: string): MenuContext {
  return {
    version: '2.0.0',
    clock,
    ledger: makeLedger(),
    providers: { claude: makeFakeProvider(answer) },
    env: FAKE_ENV,
    store,
    config: { onboarded: true, setAsDefault: false, smartRoute: false } as AppConfig,
    cwd: join(tmpdir(), `ink-chat-${randomUUID()}`),
    sandbox: 'workspace-write',
    timeoutMs: 5_000,
    installProvider: async () => true,
    login: async () => 0,
  };
}

// ---------------------------------------------------------------------------
// TEST: a real chat turn renders end-to-end via Ink.
// ---------------------------------------------------------------------------

test('runChatLoop drives a chat turn end-to-end through the Ink adapters', async () => {
  const clock = makeClock();
  const store = makeStore(clock);
  const conv = await store.create('');
  const answer = 'The Ink path works.';
  const ctx = makeCtx(store, clock, answer);
  const mutableCtx = { config: ctx.config, env: ctx.env };

  // The Ink rendering+input layer (the production adapters): ONE persistent store
  // shared by the OutputSink chrome and the streaming turn driver.
  const bridge = createInkAppBridge();
  const inkStore = createInkStore(bridge);
  const out = createInkOutputSink(inkStore, { color: false, isTty: true });
  const reader = createInkLineReader(bridge);

  let lastState: UiState = initialState;
  bridge._setUiState = (s) => { lastState = s; };
  const inkRenderTurn = makeInkTurn(inkStore, (s) => { lastState = s; });

  // readLine resolves with the user's submissions: one message, then /back.
  const reads = [answer === '' ? 'hi' : 'please answer', '/back'];
  let ri = 0;
  const readLine = async (): Promise<string | null> => (ri < reads.length ? reads[ri++]! : null);

  const result = await runChatLoop(
    ctx,
    mutableCtx,
    conv.id,
    out,
    readLine,
    ctx.login!,
    async () => ctx.env,
    async () => false, // confirm
    undefined, // suspendStdin
    reader, // the Ink LineReader (typed-ahead capture, currentLine, …)
    inkRenderTurn,
  );

  assert.equal(result, 'menu', '/back returns control to the menu');

  // (a) The orchestrated answer was committed to the Ink reducer transcript.
  const proseText = lastState.committed.map((l) => l.text).join('\n');
  assert.ok(
    proseText.includes(answer),
    `expected the answer prose in the Ink transcript, got:\n${proseText}`,
  );

  // (b) The StatusBlock's reducer state reflects the turn's tokens (measured,
  //     not fabricated): the fake usage is 100+50 input/output → session>0.
  assert.ok(
    lastState.tokens.session > 0,
    `expected StatusBlock token state > 0 after the turn, got ${lastState.tokens.session}`,
  );

  // (c) The conversation was persisted (user message + assistant answer).
  const entries = await store.load(conv.id);
  assert.ok(entries.some((e) => e.role === 'user'), 'user message persisted');
  assert.ok(
    entries.some((e) => e.role === 'assistant' && e.content.includes(answer)),
    'assistant answer persisted',
  );

  // (d) FIX 2: the legacy idle input prompt (renderInputPrompt — a caret or a
  //     box-bordered string with embedded cursor escapes) is NEVER committed to
  //     the Ink transcript. On the Ink path the real <InputBox> renders the
  //     prompt; writing the legacy string would accumulate broken <Static> chrome.
  const allCommitted = lastState.committed.map((l) => l.text).join('\n');
  assert.ok(!allCommitted.includes('❯'), 'no legacy caret prompt in the Ink transcript');
  assert.ok(!/[╭╰│]/.test(allCommitted), 'no legacy input-box borders in the Ink transcript');
  assert.ok(!allCommitted.includes('\x1b[1A'), 'no legacy cursor-move escapes in the Ink transcript');
});

// ---------------------------------------------------------------------------
// TEST: the Ink turn renderer commits prose via the SAME renderStreamInk path
// (sanity that the adapter shape used above is faithful to mount.tsx).
// ---------------------------------------------------------------------------

test('inkRenderTurn (createTurnDriver shape) folds CoreEvents into the transcript', async () => {
  const bridge = createInkAppBridge();
  const store = createInkStore(bridge);
  let last: UiState = initialState;
  const renderTurn = makeInkTurn(store, (s) => { last = s; });

  async function* stream() {
    yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 } as const;
    yield { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Hello ' } } as const;
    yield { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'world.' } } as const;
    yield { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 1 } as const;
    yield { type: 'final', success: true, output: 'Hello world.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 } as const;
  }

  const r = await renderTurn(stream(), undefined as never, 'normal');
  assert.equal(r.success, true);
  const text = last.committed.map((l) => l.text).join('\n');
  assert.ok(text.includes('Hello world.'), `expected committed prose, got:\n${text}`);
});
