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
    async setIntensity() {},
    async setActivation() {},
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

// ---------------------------------------------------------------------------
// BUG 2: resume must enable input IMMEDIATELY and resolve the recap CONCURRENTLY,
// never blocking the composer on the (up-to-8s, MANAGER-tier) recap model call.
// ---------------------------------------------------------------------------

test('BUG 2: resume enables the chat composer BEFORE the recap model call resolves', async () => {
  const clock = makeClock();

  // A conversation that IS recap-eligible (messageCount >= 3) with NO cached recap
  // → resolveRecap(false) will treat it as stale and make a model call. We seed the
  // store directly so the resume path hits the slow-recap branch.
  const convId = 'resume-conv';
  const seededEntries: SessionEntry[] = [
    { timestamp: clock.isoNow(), role: 'user', content: 'first question' },
    { timestamp: clock.isoNow(), role: 'assistant', content: 'first answer' },
    { timestamp: clock.isoNow(), role: 'user', content: 'second question' },
    { timestamp: clock.isoNow(), role: 'assistant', content: 'second answer' },
  ];
  const meta: ConversationMeta = {
    id: convId, title: 'first question', createdAt: clock.isoNow(), updatedAt: clock.isoNow(),
    messageCount: 4, pinned: false, category: null, recap: null,
  };
  const store: ConversationStore = {
    async list() { return [meta]; },
    async create() { return meta; },
    async load() { return [...seededEntries]; },
    async rename() {},
    async remove() {},
    writer() { return { id: convId, async append() {} }; },
    async setPinned() {},
    async setCategory() {},
    async setRecap() {},
    async setIntensity() {},
    async setActivation() {},
    async truncateAfter() { return 0; },
  };

  // A recap provider whose run() BLOCKS on a gate we control — modelling the slow,
  // up-to-8s MANAGER-tier recap call. Until released, the recap promise stays pending.
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const slowProvider: Provider = {
    id: 'claude',
    async detect() {
      return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, plan: null, binaryPath: null, availableModels: ['model-a'] };
    },
    async *run(): AsyncIterable<ProviderEvent> {
      await gate; // block until the test releases it
      yield { type: 'done', text: 'recap: we discussed X and Y.', usage: FAKE_USAGE, raw: {} };
    },
  };

  const ctx: MenuContext = {
    version: '2.0.0', clock, ledger: makeLedger(), providers: { claude: slowProvider },
    env: FAKE_ENV, store,
    config: { onboarded: true, setAsDefault: false, smartRoute: false } as AppConfig,
    cwd: join(tmpdir(), `ink-resume-${randomUUID()}`), sandbox: 'workspace-write', timeoutMs: 5_000,
    installProvider: async () => true, login: async () => 0,
  };
  const mutableCtx = { config: ctx.config, env: ctx.env };

  const bridge = createInkAppBridge();
  const inkStore = createInkStore(bridge);
  const out = createInkOutputSink(inkStore, { color: false, isTty: true });
  const reader = createInkLineReader(bridge);
  const inkRenderTurn = makeInkTurn(inkStore, () => {});

  // Record the ORDER of chat-active activation vs recap completion.
  const events: string[] = [];
  const inkSetChatActive = (active: boolean): void => {
    if (active) events.push('chat-active');
  };

  // The user immediately leaves (/back) — no chat turn — so the ONLY model call on
  // this path is the (gated) recap. readLine waits until input is "enabled", then
  // returns /back. By the time readLine is invoked, the composer must already be live.
  let inputOffered = false;
  const readLine = async (): Promise<string | null> => {
    inputOffered = true;
    // The composer must have been enabled BEFORE input is offered — proving resume
    // did not block on the still-pending recap.
    assert.ok(events.includes('chat-active'), 'chat composer enabled before input is offered');
    assert.ok(!events.includes('recap-done'), 'input offered while the recap is still pending (not blocked)');
    return '/back';
  };

  const loopPromise = runChatLoop(
    ctx, mutableCtx, convId, out, readLine, ctx.login!, async () => ctx.env,
    async () => false, undefined, reader, inkRenderTurn,
    undefined, undefined, undefined, inkSetChatActive,
  );

  // Let microtasks flush so the loop reaches readLine. The recap is STILL gated.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(inputOffered, 'input was offered without waiting for the recap to resolve');

  // Now release the gate; the concurrent recap resolves and the loop settles.
  events.push('recap-done');
  releaseGate();
  const result = await loopPromise;
  assert.equal(result, 'menu', '/back returns control to the menu');

  // The composer was enabled FIRST (instant input), before the recap completed.
  assert.equal(events[0], 'chat-active', 'chat-active fired first');
  assert.ok(events.indexOf('chat-active') < events.indexOf('recap-done'), 'input enabled before recap done');
});
