/**
 * test/unit/model-ghost.test.ts — budgeted model ghost adapter (P1.5).
 * Fake Provider only — verifies plumbing, not model quality.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildModelGhostPrompt,
  makeModelGhostSuggester,
  MODEL_GHOST_TIMEOUT_MS,
} from '../../src/core/model-ghost.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const SIGNAL = new AbortController().signal;

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
  timeoutMs: MODEL_GHOST_TIMEOUT_MS,
});

describe('makeModelGhostSuggester', () => {
  it('returns null when no providers are available', async () => {
    const suggest = makeModelGhostSuggester({
      providers: {},
      policy: DEFAULT_POLICY,
      cwd: '/x',
    });
    assert.equal(await suggest('test the', SIGNAL), null);
  });

  it('returns done text from the provider', async () => {
    const provider = fakeProvider([
      { type: 'done', text: ' migration path', raw: {} },
    ]);
    const suggest = makeModelGhostSuggester(baseDeps(provider));
    assert.equal(await suggest('fix the', SIGNAL), 'migration path');
  });

  it('runs worker-tier, read-only, short timeout, embeds the prefix', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider(
      [{ type: 'done', text: ' world', raw: {} }],
      sink,
    );
    const suggest = makeModelGhostSuggester(baseDeps(provider));
    await suggest('hello', SIGNAL);
    assert.ok(sink.req !== undefined);
    assert.equal(sink.req.sandbox, 'read-only');
    assert.equal(sink.req.timeoutMs, MODEL_GHOST_TIMEOUT_MS);
    assert.ok(sink.req.prompt.includes('hello'));
    assert.ok(buildModelGhostPrompt('hello').includes('hello'));
  });

  it('returns null on provider error event', async () => {
    const provider = fakeProvider([
      {
        type: 'error',
        error: {
          category: 'auth',
          recoverable: false,
          message: 'nope',
          suggestion: 'login',
        },
      },
    ]);
    const suggest = makeModelGhostSuggester(baseDeps(provider));
    assert.equal(await suggest('hmm', SIGNAL), null);
  });

  it('returns null (never throws) when provider.run throws', async () => {
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
          availableModels: [],
        };
      },
      // eslint-disable-next-line require-yield
      async *run(): AsyncIterable<ProviderEvent> {
        throw new Error('spawn failed');
      },
    };
    const suggest = makeModelGhostSuggester(baseDeps(provider));
    assert.equal(await suggest('hmm', SIGNAL), null);
  });

  it('returns null when already aborted', async () => {
    const provider = fakeProvider([
      { type: 'done', text: ' world', raw: {} },
    ]);
    const suggest = makeModelGhostSuggester(baseDeps(provider));
    const ac = new AbortController();
    ac.abort();
    assert.equal(await suggest('hello', ac.signal), null);
  });
});
