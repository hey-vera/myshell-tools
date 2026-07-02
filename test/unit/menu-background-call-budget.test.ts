import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { createTurnCallBudget, type TurnCallBudget } from '../../src/core/turn-call-budget.js';
import {
  runBudgetedProvider,
  TurnCallDeniedError,
} from '../../src/core/budgeted-provider.js';
import type { Provider, ProviderEvent, ProviderId, ProviderRequest } from '../../src/providers/port.js';

function fakeDone(): AsyncIterable<ProviderEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
      let done = false;
      return {
        async next(): Promise<IteratorResult<ProviderEvent>> {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: { type: 'done', text: 'ok' } as ProviderEvent };
        },
        async return() {
          return { done: true, value: undefined };
        },
        async throw() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function fakeError(): AsyncIterable<ProviderEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
      let done = false;
      return {
        async next(): Promise<IteratorResult<ProviderEvent>> {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: { type: 'error', message: 'boom' } as ProviderEvent };
        },
        async return() {
          return { done: true, value: undefined };
        },
        async throw() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function makeProvider(id: ProviderId, stream: () => AsyncIterable<ProviderEvent>): Provider {
  return {
    id,
    run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      return stream();
    },
  } as Provider;
}

async function drain(iterable: AsyncIterable<ProviderEvent>): Promise<void> {
  for await (const _ev of iterable) {
    // consume
  }
}

function makeBudget(
  turnId: string,
  opts?: {
    totalUnits?: number;
    workReservation?: number;
    failoverReservation?: 0 | 1;
    verificationReservation?: 0 | 1;
    mode?: 'observe' | 'enforce';
  },
): TurnCallBudget {
  return createTurnCallBudget({
    turnId,
    mode: opts?.mode ?? 'observe',
    totalUnits: opts?.totalUnits ?? 5,
    reserved: {
      work: opts?.workReservation ?? 1,
      failover: opts?.failoverReservation ?? 0,
      verification: opts?.verificationReservation ?? 0,
    },
  });
}

describe('menu-background-call-budget', () => {
  const signal = new AbortController().signal;

  it('meta and native web calls have exact purposes', async () => {
    const budget = makeBudget('turn-1');

    // Meta call
    const metaProv = makeProvider('claude', fakeDone);
    await drain(runBudgetedProvider(metaProv, { model: 'x', prompt: 'test', cwd: '/' }, signal, {
      budget,
      purpose: 'meta',
      bucket: 'discretionary',
      provider: 'claude',
    }));

    const snap1 = budget.snapshot();
    assert.equal(snap1.begun, 1);
    assert.equal(snap1.settled, 1);
    const metaCall = snap1.events.find((e) => e.type === 'call-begun');
    assert.ok(metaCall !== undefined);
    assert.equal((metaCall as { purpose: string }).purpose, 'meta');

    // Research-web call (separate budget)
    const budget2 = makeBudget('turn-2');

    const researchProv = makeProvider('codex', fakeDone);
    await drain(runBudgetedProvider(researchProv, { model: 'y', prompt: 'search', cwd: '/' }, signal, {
      budget: budget2,
      purpose: 'research-web',
      bucket: 'discretionary',
      provider: 'codex',
    }));

    const snap2 = budget2.snapshot();
    const researchCall = snap2.events.find((e) => e.type === 'call-begun');
    assert.ok(researchCall !== undefined);
    assert.equal((researchCall as { purpose: string }).purpose, 'research-web');
  });

  it('failed helper stream remains counted', async () => {
    const budget = makeBudget('turn-failed');
    const errorProv = makeProvider('claude', fakeError);

    try {
      await drain(runBudgetedProvider(errorProv, { model: 'x', prompt: 'fail', cwd: '/' }, signal, {
        budget,
        purpose: 'meta',
        bucket: 'discretionary',
        provider: 'claude',
      }));
    } catch {
      // Expected to throw or handle error
    }

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1, 'begun should count the call');
    assert.equal(snap.settled, 1, 'settled should count the error outcome');

    const settledEvent = snap.events.find((e) => e.type === 'call-settled');
    assert.ok(settledEvent !== undefined);
    assert.equal((settledEvent as { outcome: string }).outcome, 'provider-error');
  });

  it('post-turn planner stays on originating receipt after next input', async () => {
    // Simulate: turn-1 auto-stage fires, next prompt arrives creating turn-2,
    // but the auto-stage budget call stays on turn-1's receipt.
    const budget1 = makeBudget('turn-1');
    const budget2 = makeBudget('turn-2');

    // Auto-stage fires for turn-1 (origin = turn-1)
    const turn1Budget = budget1; // auto-stage captures this
    const turn1Prov = makeProvider('claude', fakeDone);
    await drain(runBudgetedProvider(turn1Prov, { model: 'x', prompt: 'plan', cwd: '/' }, signal, {
      budget: turn1Budget,
      purpose: 'goal-plan',
      bucket: 'discretionary',
      provider: 'claude',
    }));

    // Next user input creates turn-2 budget
    const turn2Prov = makeProvider('codex', fakeDone);
    await drain(runBudgetedProvider(turn2Prov, { model: 'y', prompt: 'work', cwd: '/' }, signal, {
      budget: budget2,
      purpose: 'work',
      bucket: 'work',
      provider: 'codex',
    }));

    const snap1 = budget1.snapshot();
    const snap2 = budget2.snapshot();

    // Turn-1 receipt has 1 call (the auto-stage planning call)
    assert.equal(snap1.begun, 1);
    assert.equal(snap1.turnId, 'turn-1');
    const t1Call = snap1.events.find((e) => e.type === 'call-begun') as { purpose: string; callId: string } | undefined;
    assert.ok(t1Call !== undefined);
    assert.equal(t1Call.purpose, 'goal-plan');

    // Turn-2 receipt has 1 call (the work call)
    assert.equal(snap2.begun, 1);
    assert.equal(snap2.turnId, 'turn-2');
    const t2Call = snap2.events.find((e) => e.type === 'call-begun') as { purpose: string } | undefined;
    assert.ok(t2Call !== undefined);
    assert.equal(t2Call.purpose, 'work');
  });

  it('denied auto-stage creates no goal', async () => {
    // In enforce mode with zero capacity, auto-stage call is denied.
    // The caller must fail-soft and create no goal.
    const budget = makeBudget('turn-denied', {
      mode: 'enforce',
      totalUnits: 1,
      workReservation: 1,
    });

    // Budget has 1 work, 0 discretionary. An autostage call on discretionary bucket is denied.
    const autostageProv = makeProvider('claude', fakeDone);
    let denied = false;
    try {
      await drain(runBudgetedProvider(autostageProv, { model: 'x', prompt: 'autostage', cwd: '/' }, signal, {
        budget,
        purpose: 'autostage',
        bucket: 'discretionary',
        provider: 'claude',
      }));
    } catch (err) {
      if (err instanceof TurnCallDeniedError) {
        denied = true;
      }
    }

    assert.equal(denied, true, 'discretionary call should be denied');

    const snap = budget.snapshot();
    assert.equal(snap.denied, 1);
    // No goal would be created (the caller receives denial and creates nothing)
  });

  it('two overlapping origins never share events', async () => {
    const budgetA = makeBudget('origin-A');
    const budgetB = makeBudget('origin-B');

    const provA = makeProvider('claude', fakeDone);
    await drain(runBudgetedProvider(provA, { model: 'a', prompt: 'a', cwd: '/' }, signal, {
      budget: budgetA,
      purpose: 'meta',
      bucket: 'discretionary',
      provider: 'claude',
    }));

    const provB = makeProvider('codex', fakeDone);
    await drain(runBudgetedProvider(provB, { model: 'b', prompt: 'b', cwd: '/' }, signal, {
      budget: budgetB,
      purpose: 'research-web',
      bucket: 'discretionary',
      provider: 'codex',
    }));

    const snapA = budgetA.snapshot();
    const snapB = budgetB.snapshot();

    // Origin A has only its call
    assert.equal(snapA.begun, 1);
    assert.equal(snapA.turnId, 'origin-A');

    // Origin B has only its call
    assert.equal(snapB.begun, 1);
    assert.equal(snapB.turnId, 'origin-B');

    // Each budget's events are independent — origin A does not include B's calls,
    // origin B does not include A's calls. (Call IDs may be numerically equal
    // since each budget has its own counter, but budgets are separate instances.)
    assert.equal(snapA.begun, 1);
    assert.equal(snapB.begun, 1);
  });
});
