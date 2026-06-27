/**
 * test/unit/understanding-generator.test.ts — the live WHOLE-PICTURE UNDERSTANDING
 * pass (core/understanding-generator.ts, Elite-partner Part 2). Uses a fake
 * Provider, so no live-model dependency: it verifies the PLUMBING (manager-tier
 * READ-ONLY request shape, repoContext threaded, parse into a SystemModel, every
 * failure → null so the caller plans ungrounded) plus the webSearch contract
 * (set ONLY for high-stakes work AND a web-capable provider, i.e. Codex). Twin of
 * goal-plan-generator.test.ts.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeUnderstandingPass } from '../../src/core/understanding-generator.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderId, ProviderRequest } from '../../src/providers/port.ts';
import type { Clock, LedgerWriter, LedgerEntry } from '../../src/core/types.ts';

const SIGNAL = new AbortController().signal;
const TASK = 'migrate the auth token refresh path to the new oauth flow';

function makeFakeClock(): Clock & { tick(ms: number): void } {
  let now = 1_000_000;
  let uuidCounter = 0;
  return {
    now(): number { return now; },
    isoNow(): string { return new Date(now).toISOString(); },
    uuid(): string { uuidCounter++; return `fake-uuid-${uuidCounter}`; },
    random(): number { return 0.42; },
    tick(ms: number): void { now += ms; },
  };
}

const GOOD = [
  'SUMMARY: auth lives in core/oauth, refreshed in infra/token-store',
  'MODULE: core/oauth — owns refresh',
  'CONSTRAINT: subscription-OAuth only, no metered API',
].join('\n');

function fakeProvider(
  id: ProviderId,
  events: ProviderEvent[],
  sink?: { req?: ProviderRequest },
): Provider {
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
        availableModels: [],
      };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (sink) sink.req = req;
      for (const ev of events) yield ev;
    },
  };
}

describe('makeUnderstandingPass', () => {
  it('returns null when no providers are available', async () => {
    const pass = makeUnderstandingPass({ providers: {}, policy: DEFAULT_POLICY, cwd: '/x', timeoutMs: 1000 });
    assert.equal(await pass(TASK, SIGNAL), null);
  });

  it('returns null for empty input (no model touch)', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider('claude', [{ type: 'done', text: GOOD, raw: {} }], sink);
    const pass = makeUnderstandingPass({ providers: { claude: provider }, policy: DEFAULT_POLICY, cwd: '/p', timeoutMs: 8000 });
    assert.equal(await pass('   ', SIGNAL), null);
    assert.equal(sink.req, undefined, 'never touched the provider');
  });

  it('sends a READ-ONLY request, threads repoContext, and parses a SystemModel', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider('claude', [{ type: 'done', text: GOOD, raw: {} }], sink);
    const pass = makeUnderstandingPass({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/p',
      timeoutMs: 8000,
      repoContext: 'src/core/oauth.ts',
    });
    const out = await pass(TASK, SIGNAL);
    assert.ok(out !== null);
    assert.equal(out.modules[0], 'core/oauth — owns refresh');
    assert.equal(sink.req?.sandbox, 'read-only');
    assert.ok((sink.req?.prompt ?? '').includes(TASK), 'prompt carries the task');
    assert.ok((sink.req?.prompt ?? '').includes('src/core/oauth.ts'), 'prompt carries the repo context');
  });

  it('returns null on a provider error event (fail-soft → ungrounded planner)', async () => {
    const provider = fakeProvider('claude', [
      { type: 'error', error: { category: 'auth', recoverable: false, message: 'boom', suggestion: 'login' } },
    ]);
    const pass = makeUnderstandingPass({ providers: { claude: provider }, policy: DEFAULT_POLICY, cwd: '/p', timeoutMs: 8000 });
    assert.equal(await pass(TASK, SIGNAL), null);
  });

  it('returns null when the provider throws (fail-soft, never blocks)', async () => {
    const throwing: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, plan: null, binaryPath: null, availableModels: [] };
      },
      // eslint-disable-next-line require-yield -- throws before yielding, by design
      async *run(): AsyncIterable<ProviderEvent> {
        throw new Error('network down');
      },
    };
    const pass = makeUnderstandingPass({ providers: { claude: throwing }, policy: DEFAULT_POLICY, cwd: '/p', timeoutMs: 8000 });
    assert.equal(await pass(TASK, SIGNAL), null);
  });

  it('returns null when the reply has no grounding (caller plans ungrounded)', async () => {
    const provider = fakeProvider('claude', [{ type: 'done', text: 'here is what I think you should do', raw: {} }]);
    const pass = makeUnderstandingPass({ providers: { claude: provider }, policy: DEFAULT_POLICY, cwd: '/p', timeoutMs: 8000 });
    assert.equal(await pass(TASK, SIGNAL), null);
  });

  it('does NOT set webSearch on a non-Codex provider even when high-stakes', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider('claude', [{ type: 'done', text: GOOD, raw: {} }], sink);
    const pass = makeUnderstandingPass({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/p',
      timeoutMs: 8000,
      highStakes: true,
    });
    await pass(TASK, SIGNAL);
    assert.equal(sink.req?.webSearch, undefined, 'Claude never honours webSearch → flag omitted');
  });

  it('does NOT set webSearch on Codex when NOT high-stakes', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider('codex', [{ type: 'done', text: GOOD, raw: {} }], sink);
    const pass = makeUnderstandingPass({
      providers: { codex: provider },
      policy: DEFAULT_POLICY,
      cwd: '/p',
      timeoutMs: 8000,
      highStakes: false,
    });
    await pass(TASK, SIGNAL);
    assert.equal(sink.req?.webSearch, undefined, 'low-stakes → no web search');
  });

  it('sets webSearch=true ONLY for high-stakes work on Codex (the web-capable provider)', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider('codex', [{ type: 'done', text: GOOD, raw: {} }], sink);
    const pass = makeUnderstandingPass({
      providers: { codex: provider },
      policy: DEFAULT_POLICY,
      cwd: '/p',
      timeoutMs: 8000,
      highStakes: true,
    });
    await pass(TASK, SIGNAL);
    assert.equal(sink.req?.webSearch, true, 'high-stakes + Codex → native web search opt-in');
  });

  describe('account aux', () => {
    let ledger: LedgerEntry[];
    let clock: ReturnType<typeof makeFakeClock>;
    const fakeLedger: LedgerWriter = { record: async (e) => { ledger.push(e); } };

    beforeEach(() => {
      ledger = [];
      clock = makeFakeClock();
    });

    it('accountAux on records understanding stage', async () => {
      const provider = fakeProvider('claude', [
        { type: 'done', text: GOOD, raw: {}, usage: { inputTokens: 500, outputTokens: 200 } },
      ]);
      const pass = makeUnderstandingPass({
        providers: { claude: provider },
        policy: DEFAULT_POLICY,
        cwd: '/p',
        timeoutMs: 8000,
        accountAux: true,
        ledger: fakeLedger,
        clock,
        sessionId: 'sess-understanding',
      });
      const result = await pass(TASK, SIGNAL);
      assert.notEqual(result, null);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.stage, 'understanding');
    });
  });
});
