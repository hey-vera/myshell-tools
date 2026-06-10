/**
 * test/unit/goal-plan-generator.test.ts — the live planning-brain pass
 * (core/goal-plan-generator.ts). Uses a fake Provider, so no live-model
 * dependency: it verifies the PLUMBING (manager-tier read-only request shape, parse
 * into a GoalPlan, every failure → null so the caller does nothing), not the plan's
 * prose quality. Twin of goal-objective-generator.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeGoalPlanner } from '../../src/core/goal-plan-generator.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const SIGNAL = new AbortController().signal;

const SUBSTANTIAL = 'build the whole billing system with stripe and invoices';

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

describe('makeGoalPlanner', () => {
  it('returns null when no providers are available', async () => {
    const gen = makeGoalPlanner({ providers: {}, policy: DEFAULT_POLICY, cwd: '/x', timeoutMs: 1000 });
    assert.equal(await gen(SUBSTANTIAL, SIGNAL), null);
  });

  it('returns null for empty input (no model touch)', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider([{ type: 'done', text: 'unused', raw: {} }], sink);
    const gen = makeGoalPlanner(baseDeps(provider));
    assert.equal(await gen('   ', SIGNAL), null);
    assert.equal(sink.req, undefined, 'never touched the provider');
  });

  it('sends a READ-ONLY request and parses a tagged stage plan', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider(
      [
        {
          type: 'done',
          text: 'JUDGMENT: stage\nGOAL: Build the billing core\nTODO: Model invoices\nTODO: Wire Stripe',
          raw: {},
        },
      ],
      sink,
    );
    const gen = makeGoalPlanner(baseDeps(provider));
    const out = await gen(SUBSTANTIAL, SIGNAL);
    assert.equal(out?.judgment, 'stage');
    assert.equal(out?.goals[0]?.title, 'Build the billing core');
    assert.deepEqual(out?.goals[0]?.todos, [{ text: 'Model invoices' }, { text: 'Wire Stripe' }]);
    assert.equal(sink.req?.sandbox, 'read-only');
    assert.ok((sink.req?.prompt ?? '').includes(SUBSTANTIAL), 'prompt carries the owner turn');
  });

  it('returns null on a provider error event (fail-soft)', async () => {
    const provider = fakeProvider([
      { type: 'error', error: { category: 'auth', recoverable: false, message: 'boom', suggestion: 'login' } },
    ]);
    const gen = makeGoalPlanner(baseDeps(provider));
    assert.equal(await gen(SUBSTANTIAL, SIGNAL), null);
  });

  it('returns null when the provider throws (fail-soft, never blocks the turn)', async () => {
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
    const gen = makeGoalPlanner(baseDeps(throwing));
    assert.equal(await gen(SUBSTANTIAL, SIGNAL), null);
  });

  it('returns null when the reply is unusable (no tags → caller does nothing)', async () => {
    const provider = fakeProvider([{ type: 'done', text: 'sounds good to me!', raw: {} }]);
    const gen = makeGoalPlanner(baseDeps(provider));
    assert.equal(await gen(SUBSTANTIAL, SIGNAL), null);
  });
});
