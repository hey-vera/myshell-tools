/**
 * test/unit/intent-extractor.test.ts — the live IntentExtractor adapter
 * (core/intent-extractor.ts). Uses a fake Provider, so no live-model dependency:
 * it verifies the PLUMBING (request shape, parse, every failure → null), not the
 * extraction quality. Twin of route-classifier.test.ts.
 */

import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { makeIntentExtractor } from '../../src/core/intent-extractor.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';
import type { Clock, LedgerWriter, LedgerEntry } from '../../src/core/types.ts';

const SIGNAL = new AbortController().signal;

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

function fakeProvider(events: ProviderEvent[], sink?: { req?: ProviderRequest }): Provider {
  return {
    id: 'claude',
    async detect() {
      return {
        id: 'claude',
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

const baseDeps = (provider: Provider) => ({
  providers: { claude: provider },
  policy: DEFAULT_POLICY,
  cwd: '/tmp/project',
  timeoutMs: 8_000,
});

describe('makeIntentExtractor', () => {
  it('returns null when no providers are available', async () => {
    const extract = makeIntentExtractor({ providers: {}, policy: DEFAULT_POLICY, cwd: '/x', timeoutMs: 1000 });
    assert.equal(await extract('build the thing', SIGNAL), null);
  });

  it('parses a valid frame from the done event', async () => {
    const provider = fakeProvider([
      {
        type: 'done',
        text: '{"goal":"ship the API","kind":"coding","confidence":"high"}',
        raw: {},
      },
    ]);
    const extract = makeIntentExtractor(baseDeps(provider));
    const f = await extract('please ship the API', SIGNAL);
    assert.ok(f !== null);
    assert.equal(f.goal, 'ship the API');
    assert.equal(f.kind, 'coding');
    assert.equal(f.source, 'model');
  });

  it('runs worker-tier, read-only, with the intent prompt embedding the task', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider(
      [{ type: 'done', text: '{"goal":"x","confidence":"low"}', raw: {} }],
      sink,
    );
    const extract = makeIntentExtractor(baseDeps(provider));
    await extract('untangle the widget', SIGNAL);
    assert.ok(sink.req !== undefined);
    assert.equal(sink.req.sandbox, 'read-only', 'extraction never writes');
    assert.equal(sink.req.timeoutMs, 8_000);
    assert.ok(sink.req.prompt.includes('untangle the widget'), 'prompt embeds the task');
  });

  it('returns null on a garbled (unparseable) reply', async () => {
    const provider = fakeProvider([{ type: 'done', text: 'no json here', raw: {} }]);
    const extract = makeIntentExtractor(baseDeps(provider));
    assert.equal(await extract('hmm', SIGNAL), null);
  });

  it('returns null when the provider emits an error event', async () => {
    const provider = fakeProvider([
      { type: 'error', error: { category: 'auth', recoverable: false, message: 'nope', suggestion: 'login' } },
    ]);
    const extract = makeIntentExtractor(baseDeps(provider));
    assert.equal(await extract('hmm', SIGNAL), null);
  });

  it('returns null (never throws) when provider.run throws', async () => {
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, plan: null, binaryPath: null, availableModels: [] };
      },
      // eslint-disable-next-line require-yield
      async *run(): AsyncIterable<ProviderEvent> {
        throw new Error('boom');
      },
    };
    const extract = makeIntentExtractor(baseDeps(provider));
    assert.equal(await extract('hmm', SIGNAL), null);
  });

  describe('account aux', () => {
    let ledger: LedgerEntry[];
    let clock: ReturnType<typeof makeFakeClock>;
    const fakeLedger: LedgerWriter = { record: async (e) => { ledger.push(e); } };

    beforeEach(() => {
      ledger = [];
      clock = makeFakeClock();
    });

    it('MYSHELL_ACCOUNT_AUX on records intent stage with usage', async () => {
      const provider = fakeProvider(
        [{ type: 'done', text: '{"goal":"ship it","kind":"coding","confidence":"high"}', raw: {}, usage: { inputTokens: 200, outputTokens: 100 }, costUsd: 0.005 }],
      );
      const extract = makeIntentExtractor({
        providers: { claude: provider },
        policy: DEFAULT_POLICY,
        cwd: '/tmp/project',
        timeoutMs: 8_000,
        accountAux: true,
        ledger: fakeLedger,
        clock,
        sessionId: 'sess-aux',
      });
      const f = await extract('ship the feature', SIGNAL, { stage: 'intent', intentVersionId: 'ver-2' });
      assert.notEqual(f, null);
      assert.equal(ledger.length, 1);
      const e = ledger[0]!;
      assert.equal(e.stage, 'intent');
      assert.equal(e.intentVersionId, 'ver-2');
    });

    it('intent extractor records caller-provided reextract stage', async () => {
      const provider = fakeProvider(
        [{ type: 'done', text: '{"goal":"debug","kind":"debug","confidence":"medium"}', raw: {} }],
      );
      const extract = makeIntentExtractor({
        providers: { claude: provider },
        policy: DEFAULT_POLICY,
        cwd: '/tmp/project',
        timeoutMs: 8_000,
        accountAux: true,
        ledger: fakeLedger,
        clock,
        sessionId: 'sess-reextract',
      });
      await extract('debug after findings', SIGNAL, { stage: 'reextract-web', intentVersionId: 'ver-3' });
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.stage, 'reextract-web');
    });
  });
});
