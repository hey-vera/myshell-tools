/**
 * test/unit/route-classifier.test.ts — the live ModelClassifier adapter
 * (core/route-classifier.ts). Uses a fake Provider, so no live-model dependency:
 * it verifies the PLUMBING (request shape, parse, every failure → null), not the
 * routing quality (which can only be judged against a real model).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeRouteClassifier } from '../../src/core/route-classifier.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const SIGNAL = new AbortController().signal;

/** A fake provider whose run() yields the given events and records its request. */
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
  timeoutMs: 20_000,
});

describe('makeRouteClassifier', () => {
  it('returns null when no providers are available', async () => {
    const classify = makeRouteClassifier({ providers: {}, policy: DEFAULT_POLICY, cwd: '/x', timeoutMs: 1000 });
    assert.equal(await classify('do the thing', SIGNAL), null);
  });

  it('parses a valid JSON reply from the done event', async () => {
    const provider = fakeProvider([
      { type: 'done', text: '{"tier":"manager","plan":true,"reason":"big refactor"}', raw: {} },
    ]);
    const classify = makeRouteClassifier(baseDeps(provider));
    const s = await classify('the whole thing needs rethinking', SIGNAL);
    assert.deepEqual(s, { tier: 'manager', plan: true, reason: 'big refactor' });
  });

  it('runs worker-tier, read-only, with the router prompt embedding the task', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider([{ type: 'done', text: '{"tier":"ic","plan":false,"reason":"x"}', raw: {} }], sink);
    const classify = makeRouteClassifier(baseDeps(provider));
    await classify('please untangle the widget', SIGNAL);
    assert.ok(sink.req !== undefined, 'provider.run received a request');
    assert.equal(sink.req.sandbox, 'read-only', 'classification never writes');
    assert.equal(sink.req.timeoutMs, 20_000);
    assert.ok(sink.req.prompt.includes('please untangle the widget'), 'prompt embeds the task');
  });

  it('returns null on a garbled (unparseable) reply', async () => {
    const provider = fakeProvider([{ type: 'done', text: 'I think probably ic, idk', raw: {} }]);
    const classify = makeRouteClassifier(baseDeps(provider));
    assert.equal(await classify('hmm', SIGNAL), null);
  });

  it('returns null when the provider emits an error event', async () => {
    const provider = fakeProvider([
      { type: 'error', error: { category: 'auth', recoverable: false, message: 'nope', suggestion: 'login' } },
    ]);
    const classify = makeRouteClassifier(baseDeps(provider));
    assert.equal(await classify('hmm', SIGNAL), null);
  });

  it('returns null (never throws) when provider.run throws', async () => {
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, plan: null, binaryPath: null, availableModels: [] };
      },
      // eslint-disable-next-line require-yield
      async *run(): AsyncIterable<ProviderEvent> {
        throw new Error('spawn failed');
      },
    };
    const classify = makeRouteClassifier(baseDeps(provider));
    assert.equal(await classify('hmm', SIGNAL), null);
  });
});
