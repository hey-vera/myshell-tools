/**
 * test/unit/goal-objective-generator.test.ts — the live goal-objective former
 * (core/goal-objective-generator.ts). Uses a fake Provider, so no live-model
 * dependency: it verifies the PLUMBING (manager-tier request shape, parse into a
 * crisp objective, every failure → null so goal-start degrades fail-soft), not the
 * objective's prose quality. Twin of recap-generator.test.ts.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { makeGoalObjectiveGenerator } from '../../src/core/goal-objective-generator.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const SIGNAL = new AbortController().signal;

const RAMBLY =
  'so yea i think the frontend is a decent skeleton to build into, like 2010 youtube but better in rust for millions of users';

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
  timeoutMs: 6_000,
});

describe('makeGoalObjectiveGenerator', () => {
  it('returns null when no providers are available', async () => {
    const gen = makeGoalObjectiveGenerator({ providers: {}, policy: DEFAULT_POLICY, cwd: '/x', timeoutMs: 1000 });
    assert.equal(await gen(RAMBLY, SIGNAL), null);
  });

  it('returns null for empty raw text (no model touch)', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider([{ type: 'done', text: 'unused', raw: {} }], sink);
    const gen = makeGoalObjectiveGenerator(baseDeps(provider));
    assert.equal(await gen('   ', SIGNAL), null);
    assert.equal(sink.req, undefined, 'never touched the provider');
  });

  it('sends a READ-ONLY request and parses a tagged reply into a crisp objective', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider(
      [{ type: 'done', text: 'OBJECTIVE: heyvera — YouTube-scale video platform in Rust', raw: {} }],
      sink,
    );
    const gen = makeGoalObjectiveGenerator(baseDeps(provider));
    const out = await gen(RAMBLY, SIGNAL);
    assert.equal(out, 'Heyvera — YouTube-scale video platform in Rust');
    assert.notEqual(out, RAMBLY, 'NOT the raw user text');
    assert.equal(sink.req?.sandbox, 'read-only');
    assert.ok((sink.req?.prompt ?? '').includes(RAMBLY), 'prompt carries the raw request');
  });

  it('returns null on a provider error event (fail-soft → caller degrades)', async () => {
    const provider = fakeProvider([
      { type: 'error', error: { category: 'auth', recoverable: false, message: 'boom', suggestion: 'login' } },
    ]);
    const gen = makeGoalObjectiveGenerator(baseDeps(provider));
    assert.equal(await gen(RAMBLY, SIGNAL), null);
  });

  it('returns null when the provider throws (fail-soft, never blocks goal start)', async () => {
    const throwing: Provider = {
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
      // eslint-disable-next-line require-yield -- throws before yielding, by design
      async *run(): AsyncIterable<ProviderEvent> {
        throw new Error('network down');
      },
    };
    const gen = makeGoalObjectiveGenerator(baseDeps(throwing));
    assert.equal(await gen(RAMBLY, SIGNAL), null);
  });

  it('returns null when the reply is unusable (vacuous → caller falls back)', async () => {
    const provider = fakeProvider([{ type: 'done', text: 'OBJECTIVE:', raw: {} }]);
    const gen = makeGoalObjectiveGenerator(baseDeps(provider));
    assert.equal(await gen(RAMBLY, SIGNAL), null);
  });
});
