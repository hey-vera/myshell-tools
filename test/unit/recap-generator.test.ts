/**
 * test/unit/recap-generator.test.ts — the live RecapGenerator adapter
 * (core/recap-generator.ts). Uses a fake Provider, so no live-model dependency:
 * it verifies the PLUMBING (request shape, parse, every failure → null, fail-soft
 * never blocks), not recap quality. Twin of intent-extractor.test.ts.
 */

import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { makeRecapGenerator } from '../../src/core/recap-generator.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';
import type { SessionEntry } from '../../src/core/types.ts';
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

const HISTORY: SessionEntry[] = [
  { timestamp: '2024-01-01T00:00:00.000Z', role: 'user', content: 'Migrate auth to JWT' },
  { timestamp: '2024-01-01T00:01:00.000Z', role: 'assistant', content: '4 files edited.' },
  { timestamp: '2024-01-01T00:02:00.000Z', role: 'user', content: 'Now the expiry tests' },
];

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

describe('makeRecapGenerator', () => {
  it('returns null when no providers are available', async () => {
    const gen = makeRecapGenerator({ providers: {}, policy: DEFAULT_POLICY, cwd: '/x', timeoutMs: 1000 });
    assert.equal(await gen(HISTORY, SIGNAL), null);
  });

  it('returns null when history is empty (no model touch)', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider([{ type: 'done', text: 'unused', raw: {} }], sink);
    const gen = makeRecapGenerator(baseDeps(provider));
    assert.equal(await gen([], SIGNAL), null);
    assert.equal(sink.req, undefined, 'never calls the provider on empty history');
  });

  it('parses + normalises the structured {title, recap} from the done event', async () => {
    const provider = fakeProvider([
      {
        type: 'done',
        text: 'TITLE: Auth → JWT migration\nSTATE: Migrating auth to JWT; next: expiry tests.',
        raw: {},
      },
    ]);
    const gen = makeRecapGenerator(baseDeps(provider));
    const out = await gen(HISTORY, SIGNAL);
    assert.deepEqual(out, {
      title: 'Auth → JWT migration',
      recap: 'Migrating auth to JWT; next: expiry tests.',
    });
  });

  it('runs read-only, with the recap prompt embedding the transcript', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider([{ type: 'done', text: 'STATE: ok now; next: keep going.', raw: {} }], sink);
    const gen = makeRecapGenerator(baseDeps(provider));
    await gen(HISTORY, SIGNAL);
    assert.ok(sink.req !== undefined);
    assert.equal(sink.req.sandbox, 'read-only', 'recap never writes');
    assert.equal(sink.req.timeoutMs, 8_000);
    assert.ok(sink.req.prompt.includes('Migrate auth to JWT'), 'prompt embeds the transcript');
  });

  it('returns null on an empty/whitespace reply (fail-soft)', async () => {
    const provider = fakeProvider([{ type: 'done', text: '   ', raw: {} }]);
    const gen = makeRecapGenerator(baseDeps(provider));
    assert.equal(await gen(HISTORY, SIGNAL), null);
  });

  it('returns null when the provider emits an error event', async () => {
    const provider = fakeProvider([
      { type: 'error', error: { category: 'auth', recoverable: false, message: 'nope', suggestion: 'login' } },
    ]);
    const gen = makeRecapGenerator(baseDeps(provider));
    assert.equal(await gen(HISTORY, SIGNAL), null);
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
    const gen = makeRecapGenerator(baseDeps(provider));
    assert.equal(await gen(HISTORY, SIGNAL), null);
  });

  describe('account aux', () => {
    let ledger: LedgerEntry[];
    let clock: ReturnType<typeof makeFakeClock>;
    const fakeLedger: LedgerWriter = { record: async (e) => { ledger.push(e); } };

    beforeEach(() => {
      ledger = [];
      clock = makeFakeClock();
    });

    it('accountAux on records recap stage', async () => {
      const provider = fakeProvider([
        { type: 'done', text: 'TITLE: Hello\nSTATE: doing things.', raw: {}, usage: { inputTokens: 100, outputTokens: 50 } },
      ]);
      const gen = makeRecapGenerator({
        providers: { claude: provider },
        policy: DEFAULT_POLICY,
        cwd: '/tmp/project',
        timeoutMs: 8_000,
        accountAux: true,
        ledger: fakeLedger,
        clock,
        sessionId: 'sess-recap',
      });
      const result = await gen(HISTORY, SIGNAL);
      assert.notEqual(result, null);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.stage, 'recap');
    });

    it('accountAux off records no recap entry', async () => {
      const provider = fakeProvider([
        { type: 'done', text: 'TITLE: Hello\nSTATE: doing things.', raw: {} },
      ]);
      const gen = makeRecapGenerator({
        providers: { claude: provider },
        policy: DEFAULT_POLICY,
        cwd: '/tmp/project',
        timeoutMs: 8_000,
      });
      const result = await gen(HISTORY, SIGNAL);
      assert.notEqual(result, null);
      assert.equal(ledger.length, 0, 'no ledger entry when aux is off');
    });
  });
});
