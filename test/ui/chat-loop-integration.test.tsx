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
import { createInkOutputSink, createInkLineReader } from '../../src/interface/ui/mount.js';
import {
  reduce,
  initialState,
  renderStreamInk,
  type Action,
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

/** The createTurnDriver shape from mount.tsx, inlined so the test owns the
 * reducer state and can assert the final snapshot. Mirrors production 1:1. */
function makeInkTurn(
  bridge: ReturnType<typeof createInkAppBridge>,
  onState: (s: UiState) => void,
): TurnRenderer {
  return (events, _sink, verbosity) => {
    let state: UiState = initialState;
    bridge.pushState(state);
    onState(state);
    const dispatch = (a: Action): void => {
      state = reduce(state, a);
      bridge.pushState(state);
      onState(state);
    };
    return renderStreamInk(events, dispatch, { color: false, isTty: true, verbosity });
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

  // The Ink rendering+input layer (the production adapters).
  const bridge = createInkAppBridge();
  const out = createInkOutputSink(bridge, { color: false, isTty: true });
  const reader = createInkLineReader(bridge);
  const committed: string[] = [];
  // Capture committed transcript lines the OutputSink pushes (menu/chat chrome).
  bridge._setLines = (fn) => { const next = fn([]); const last = next[next.length - 1]; if (typeof last === 'string') committed.push(last); };

  let lastState: UiState = initialState;
  const inkRenderTurn = makeInkTurn(bridge, (s) => { lastState = s; });

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
});

// ---------------------------------------------------------------------------
// TEST: the Ink turn renderer commits prose via the SAME renderStreamInk path
// (sanity that the adapter shape used above is faithful to mount.tsx).
// ---------------------------------------------------------------------------

test('inkRenderTurn (createTurnDriver shape) folds CoreEvents into the transcript', async () => {
  const bridge = createInkAppBridge();
  let last: UiState = initialState;
  const renderTurn = makeInkTurn(bridge, (s) => { last = s; });

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
